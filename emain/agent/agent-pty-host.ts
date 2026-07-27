// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as nodePty from "node-pty";
import * as crypto from "node:crypto";

import type { AgentExecutionContext } from "./agent-execution-context";
import { AgentPtyRingBuffer } from "./agent-pty-ring-buffer";
import { AgentPtyScreen, type AgentPtyCursor, type AgentPtyScreenRow } from "./agent-pty-screen";
import { getShellConfig, getShellEnv, killProcessTree } from "./tools/_shell";

const DefaultCols = 80;
const DefaultRows = 24;
export const MaxAgentPtyCols = 500;
export const MaxAgentPtyRows = 200;
const DefaultMaxBytes = 64 * 1024;
const DefaultMaxLines = 1000;
const DefaultMaxCompletedCommands = 50;
const DefaultStopTimeoutMs = 2000;

export interface AgentPtySnapshot {
    commandId: string;
    command: string;
    cwd: string;
    tail: string;
    screen: {
        rows: AgentPtyScreenRow[];
        cursor: AgentPtyCursor;
        isAltScreenActive: boolean;
    };
    running: boolean;
    exitCode?: number;
    cols: number;
    rows: number;
    needsUserInput: boolean;
}

export interface AgentPtyCommandPort {
    commandId: string;
    read(): AgentPtySnapshot;
    write(input: string): Promise<void>;
    resize(cols: number, rows: number): void;
    requestUserInput(reason: string): void;
    stop(): Promise<void>;
}

export interface AgentPtyHostOptions {
    cols?: number;
    rows?: number;
    maxBytes?: number;
    maxLines?: number;
    maxCompletedCommands?: number;
    stopTimeoutMs?: number;
    killProcessTree?: (pid: number) => void;
    onUpdate?: (snapshot: AgentPtySnapshot) => void;
}

interface AgentPtyEntry {
    commandId: string;
    command: string;
    cwd: string;
    pty: nodePty.IPty;
    tail: AgentPtyRingBuffer;
    screen: AgentPtyScreen;
    running: boolean;
    exitCode?: number;
    cols: number;
    rows: number;
    needsUserInput: boolean;
    disposeData?: { dispose: () => void };
    disposeExit?: { dispose: () => void };
    exitPromise: Promise<void>;
    resolveExit: () => void;
    completedSequence?: number;
}

function makeCommandId(): string {
    return crypto.randomUUID();
}

export function normalizeAgentPtySize(cols: number, rows: number): { cols: number; rows: number } {
    return {
        cols: Math.min(MaxAgentPtyCols, Math.max(1, Math.floor(cols))),
        rows: Math.min(MaxAgentPtyRows, Math.max(1, Math.floor(rows))),
    };
}

export class AgentPtyHost {
    private entries = new Map<string, AgentPtyEntry>();
    private cols: number;
    private rows: number;
    private maxBytes: number;
    private maxLines: number;
    private maxCompletedCommands: number;
    private stopTimeoutMs: number;
    private completedSequence = 0;
    private killProcessTree: (pid: number) => void;
    private onUpdate?: (snapshot: AgentPtySnapshot) => void;

    constructor(options: AgentPtyHostOptions = {}) {
        const initialSize = normalizeAgentPtySize(options.cols ?? DefaultCols, options.rows ?? DefaultRows);
        this.cols = initialSize.cols;
        this.rows = initialSize.rows;
        this.maxBytes = options.maxBytes ?? DefaultMaxBytes;
        this.maxLines = options.maxLines ?? DefaultMaxLines;
        this.maxCompletedCommands = options.maxCompletedCommands ?? DefaultMaxCompletedCommands;
        this.stopTimeoutMs = options.stopTimeoutMs ?? DefaultStopTimeoutMs;
        this.killProcessTree = options.killProcessTree ?? killProcessTree;
        this.onUpdate = options.onUpdate;
    }

    async start(command: string, context: AgentExecutionContext): Promise<AgentPtySnapshot> {
        const commandId = makeCommandId();
        const shell = getShellConfig();
        const screen = new AgentPtyScreen({
            cols: this.cols,
            rows: this.rows,
            respond: (bytes) => {
                const entry = this.entries.get(commandId);
                if (entry?.running) {
                    entry.pty.write(bytes);
                }
            },
        });
        const tail = new AgentPtyRingBuffer({ maxBytes: this.maxBytes, maxLines: this.maxLines });
        let pty: nodePty.IPty;
        const commandFromStdin = shell.commandTransport === "stdin";
        try {
            pty = nodePty.spawn(shell.shell, commandFromStdin ? shell.args : [...shell.args, command], {
                name: "xterm-256color",
                cwd: context.workspaceDir,
                env: { ...getShellEnv(), ...context.environment, TERM: "xterm-256color" },
                cols: this.cols,
                rows: this.rows,
            });
        } catch (err) {
            this.entries.delete(commandId);
            throw err;
        }
        let resolveExit!: () => void;
        const exitPromise = new Promise<void>((resolve) => {
            resolveExit = resolve;
        });
        const entry: AgentPtyEntry = {
            commandId,
            command,
            cwd: context.workspaceDir,
            pty,
            tail,
            screen,
            running: true,
            cols: this.cols,
            rows: this.rows,
            needsUserInput: false,
            exitPromise,
            resolveExit,
        };
        entry.disposeData = pty.onData((data) => {
            entry.tail.append(data);
            entry.screen.feed(data);
            this.emitUpdate(entry);
        });
        entry.disposeExit = pty.onExit((event) => {
            if (!entry.running) return;
            entry.running = false;
            entry.exitCode = event.exitCode;
            entry.completedSequence = ++this.completedSequence;
            this.emitUpdate(entry);
            this.cleanupEntryListeners(entry);
            entry.resolveExit();
            this.pruneCompletedEntries();
        });
        this.entries.set(commandId, entry);
        if (commandFromStdin) {
            entry.pty.write(`${command}\n`);
        }
        return this.snapshot(entry);
    }

    read(commandId: string): AgentPtySnapshot {
        return this.snapshot(this.requireEntry(commandId));
    }

    async write(commandId: string, input: string): Promise<void> {
        const entry = this.requireEntry(commandId);
        if (!entry.running) {
            throw new Error("hosted PTY command is not running");
        }
        entry.pty.write(input);
    }

    resize(commandId: string, cols: number, rows: number): void {
        const entry = this.requireEntry(commandId);
        const size = normalizeAgentPtySize(cols, rows);
        entry.cols = size.cols;
        entry.rows = size.rows;
        entry.screen.resize(entry.cols, entry.rows);
        if (entry.running) {
            entry.pty.resize(entry.cols, entry.rows);
        }
        this.emitUpdate(entry);
    }

    requestUserInput(commandId: string, _reason: string): void {
        const entry = this.requireEntry(commandId);
        entry.needsUserInput = true;
        this.emitUpdate(entry);
    }

    async stop(commandId: string): Promise<void> {
        const entry = this.requireEntry(commandId);
        await this.terminateEntry(entry);
    }

    getCommandPort(commandId: string): AgentPtyCommandPort {
        this.requireEntry(commandId);
        return {
            commandId,
            read: () => this.read(commandId),
            write: (input) => this.write(commandId, input),
            resize: (cols, rows) => this.resize(commandId, cols, rows),
            requestUserInput: (reason) => this.requestUserInput(commandId, reason),
            stop: () => this.stop(commandId),
        };
    }

    snapshots(): AgentPtySnapshot[] {
        return Array.from(this.entries.values(), (entry) => this.snapshot(entry));
    }

    hasRunningCommands(): boolean {
        return Array.from(this.entries.values()).some((entry) => entry.running);
    }

    async dispose(): Promise<void> {
        const entries = Array.from(this.entries.values());
        await Promise.all(entries.map((entry) => this.terminateEntry(entry)));
        this.entries.clear();
    }

    commandCount(): number {
        return this.entries.size;
    }

    getBackingRowCounts(commandId: string): { primary: number; alt: number } {
        const entry = this.requireEntry(commandId);
        return { primary: entry.screen.primaryRowCount(), alt: entry.screen.altRowCount() };
    }

    private requireEntry(commandId: string): AgentPtyEntry {
        const entry = this.entries.get(commandId);
        if (!entry) {
            throw new Error("unknown hosted PTY command");
        }
        return entry;
    }

    private snapshot(entry: AgentPtyEntry): AgentPtySnapshot {
        return {
            commandId: entry.commandId,
            command: entry.command,
            cwd: entry.cwd,
            tail: entry.tail.text(),
            screen: entry.screen.snapshot(),
            running: entry.running,
            exitCode: entry.exitCode,
            cols: entry.cols,
            rows: entry.rows,
            needsUserInput: entry.needsUserInput,
        };
    }

    private emitUpdate(entry: AgentPtyEntry): void {
        this.onUpdate?.(this.snapshot(entry));
    }

    private async terminateEntry(entry: AgentPtyEntry): Promise<void> {
        if (!entry.running) {
            return;
        }
        const pid = typeof entry.pty.pid === "number" ? entry.pty.pid : undefined;
        if (pid && pid > 0) {
            this.killProcessTree(pid);
        }
        try {
            entry.pty.kill();
        } catch {
            // already dead
        }
        const exited = await Promise.race([entry.exitPromise.then(() => true), this.stopTimeout().then(() => false)]);
        if (!exited && entry.running) {
            entry.running = false;
            entry.completedSequence = ++this.completedSequence;
            this.emitUpdate(entry);
            this.pruneCompletedEntries();
        }
        this.cleanupEntryListeners(entry);
    }

    private stopTimeout(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, this.stopTimeoutMs));
    }

    private cleanupEntryListeners(entry: AgentPtyEntry): void {
        entry.disposeData?.dispose();
        entry.disposeExit?.dispose();
        entry.disposeData = undefined;
        entry.disposeExit = undefined;
    }

    private pruneCompletedEntries(): void {
        const completed = Array.from(this.entries.values())
            .filter((entry) => !entry.running)
            .sort((a, b) => (a.completedSequence ?? 0) - (b.completedSequence ?? 0));
        const overflow = completed.length - this.maxCompletedCommands;
        if (overflow <= 0) return;
        for (const entry of completed.slice(0, overflow)) {
            this.cleanupEntryListeners(entry);
            this.entries.delete(entry.commandId);
        }
    }
}
