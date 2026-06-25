// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { getLanguageServerDefinition } from "./language-server-registry";

type SpawnFn = typeof nodeSpawn;
type CommandExistsFn = (path: string) => boolean;
type CommandAvailableFn = (command: string, args: string[]) => boolean;

type LanguageServerInput = {
    workspaceRoot: string;
    language: string;
    serverId: string;
};

type LanguageServerCommand = {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
};

type CachedLanguageServer = {
    child: ChildProcessWithoutNullStreams;
    refCount: number;
};

export class LanguageServerManager {
    private readonly spawn: SpawnFn;
    private readonly appRoot: string;
    private readonly commandAvailable: CommandAvailableFn;
    private readonly commandExists: CommandExistsFn;
    private readonly nodeCommand: string;
    private readonly resourcesPath: string;
    private readonly processes = new Map<string, CachedLanguageServer>();

    constructor(
        deps: {
            appRoot?: string;
            commandAvailable?: CommandAvailableFn;
            commandExists?: CommandExistsFn;
            nodeCommand?: string;
            resourcesPath?: string;
            spawn?: SpawnFn;
        } = {}
    ) {
        this.appRoot = deps.appRoot ?? process.cwd();
        this.commandAvailable = deps.commandAvailable ?? defaultCommandAvailable;
        this.commandExists = deps.commandExists ?? existsSync;
        this.nodeCommand = deps.nodeCommand ?? process.execPath;
        this.resourcesPath = deps.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? "";
        this.spawn = deps.spawn ?? nodeSpawn;
    }

    resolveCommand(input: LanguageServerInput): LanguageServerCommand {
        const definition = getLanguageServerDefinition(input.serverId, input.language);
        if (definition.serverId === "typescript-language-server") {
            return this.resolvePackagedCommand("typescript-language-server") ?? {
                command: this.resolveAppBinCommand("typescript-language-server"),
                args: ["--stdio"],
            };
        }
        if (
            definition.availabilityCheck &&
            !this.commandAvailable(definition.availabilityCheck.command, definition.availabilityCheck.args)
        ) {
            throw new Error(`LSP unavailable: ${definition.availabilityCheck.unavailableMessage}`);
        }
        return {
            command: definition.command,
            args: definition.args,
        };
    }

    getOrStart(input: LanguageServerInput): ChildProcessWithoutNullStreams {
        this.validateInput(input);
        const key = this.cacheKey(input);
        const existing = this.processes.get(key);
        if (existing) return existing.child;
        return this.createCachedProcess(key, input).child;
    }

    acquire(input: LanguageServerInput): ChildProcessWithoutNullStreams {
        this.validateInput(input);
        const key = this.cacheKey(input);
        const entry = this.processes.get(key) ?? this.createCachedProcess(key, input);
        entry.refCount += 1;
        return entry.child;
    }

    release(input: LanguageServerInput): void {
        this.validateInput(input);
        const key = this.cacheKey(input);
        const entry = this.processes.get(key);
        if (!entry || entry.refCount <= 0) return;
        entry.refCount -= 1;
        if (entry.refCount > 0) return;
        entry.child.kill();
        this.processes.delete(key);
    }

    startSession(input: LanguageServerInput): ChildProcessWithoutNullStreams {
        return this.spawnProcess(input);
    }

    stop(input: LanguageServerInput): void {
        const key = this.cacheKey(input);
        const entry = this.processes.get(key);
        if (!entry) return;
        entry.child.kill();
        this.processes.delete(key);
    }

    stopAll(): void {
        for (const entry of this.processes.values()) {
            entry.child.kill();
        }
        this.processes.clear();
    }

    private resolveAppBinCommand(command: string): string {
        const binName = process.platform === "win32" ? `${command}.cmd` : command;
        for (const appRoot of this.getAppRootCandidates()) {
            const candidate = path.join(appRoot, "node_modules", ".bin", binName);
            if (this.commandExists(candidate)) {
                return candidate;
            }
        }
        return command;
    }

    private spawnProcess(input: LanguageServerInput): ChildProcessWithoutNullStreams {
        const command = this.resolveCommand(input);
        return this.spawn(command.command, command.args, {
            cwd: input.workspaceRoot,
            env: command.env ? { ...process.env, ...command.env } : process.env,
            stdio: "pipe",
        });
    }

    private createCachedProcess(key: string, input: LanguageServerInput): CachedLanguageServer {
        const child = this.spawnProcess(input);
        const entry = { child, refCount: 0 };
        child.on("exit", () => this.deleteCachedProcess(key, child));
        child.on("error", () => this.deleteCachedProcess(key, child));
        this.processes.set(key, entry);
        return entry;
    }

    private deleteCachedProcess(key: string, child: ChildProcessWithoutNullStreams): void {
        const entry = this.processes.get(key);
        if (entry?.child === child) {
            this.processes.delete(key);
        }
    }

    private resolvePackagedCommand(command: string): LanguageServerCommand | null {
        if (!this.resourcesPath) return null;
        const candidate = path.join(this.resourcesPath, "app.asar.unpacked", "node_modules", command, "lib", "cli.mjs");
        if (!this.commandExists(candidate)) return null;
        return {
            command: this.nodeCommand,
            args: [candidate, "--stdio"],
            env: { ELECTRON_RUN_AS_NODE: "1" },
        };
    }

    private getAppRootCandidates(): string[] {
        const candidates = [
            this.appRoot,
            process.cwd(),
            this.resourcesPath ? path.join(this.resourcesPath, "app") : null,
            this.resourcesPath ? path.join(this.resourcesPath, "app.asar.unpacked") : null,
            path.resolve(import.meta.dirname, "..", ".."),
            path.resolve(import.meta.dirname, "..", "..", ".."),
        ];
        return Array.from(new Set(candidates.filter((candidate) => candidate != null)));
    }

    private cacheKey(input: LanguageServerInput): string {
        return `${input.workspaceRoot}\u0000${input.serverId}`;
    }

    private validateInput(input: LanguageServerInput): void {
        getLanguageServerDefinition(input.serverId, input.language);
    }
}

function defaultCommandAvailable(command: string, args: string[]): boolean {
    const result = spawnSync(command, args, { stdio: "ignore" });
    return result.status === 0;
}
