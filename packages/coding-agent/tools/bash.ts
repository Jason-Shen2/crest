// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// bash — execute a shell command in the pane's cwd. Ported from pi's
// packages/coding-agent/src/core/tools/bash.ts (earendil-works/pi, MIT)
// with the pi-tui render layer stripped. Replaces crest's hand-written
// shell_exec; the key upgrade is process-tree kill on abort/timeout —
// the child is spawned `detached` so it leads its own process group, and
// killProcessTree signals the whole group (shell_exec only signalled the
// top shell and orphaned grandchildren like npm / make).
//
// Output streams through an OutputAccumulator: a bounded rolling tail is
// kept for the result (tail-truncated so errors at the end survive), and
// the full output spills to a temp file when it exceeds the limits.

import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { spawn } from "node:child_process";
import { type Static, Type } from "typebox";

import type { AgentTool } from "@crest/agent/types";
import { waitForChildProcess } from "./_child-process";
import { OutputAccumulator } from "./_output-accumulator";
import {
    getShellConfig,
    getShellEnv,
    killProcessTree,
    trackDetachedChildPid,
    untrackDetachedChildPid,
} from "./_shell";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./_truncate";

const bashSchema = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
    truncation?: TruncationResult;
    fullOutputPath?: string;
}

export interface BashOperations {
    exec: (
        command: string,
        cwd: string,
        options: {
            onData: (data: Buffer) => void;
            signal?: AbortSignal;
            timeout?: number;
            env?: NodeJS.ProcessEnv;
        },
    ) => Promise<{ exitCode: number | null }>;
}

/** Local-shell exec backend with process-tree kill on abort/timeout. */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
    return {
        exec: async (command, cwd, { onData, signal, timeout, env }) => {
            const shellConfig = getShellConfig(options?.shellPath);
            try {
                await fsAccess(cwd, constants.F_OK);
            } catch {
                throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
            }
            if (signal?.aborted) throw new Error("aborted");

            // Legacy WSL bash needs the command on stdin (bash -s); every
            // other shell takes it as the final argv entry (bash -c <cmd>).
            const commandFromStdin = shellConfig.commandTransport === "stdin";
            const child = spawn(
                shellConfig.shell,
                commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
                {
                    cwd,
                    detached: process.platform !== "win32",
                    env: env ?? getShellEnv(),
                    stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
                    windowsHide: true,
                },
            );
            if (commandFromStdin) {
                child.stdin?.on("error", () => {});
                child.stdin?.end(command);
            }
            if (child.pid) trackDetachedChildPid(child.pid);
            let timedOut = false;
            let timeoutHandle: NodeJS.Timeout | undefined;
            const onAbort = () => {
                if (child.pid) killProcessTree(child.pid);
            };

            try {
                if (timeout !== undefined && timeout > 0) {
                    timeoutHandle = setTimeout(() => {
                        timedOut = true;
                        if (child.pid) killProcessTree(child.pid);
                    }, timeout * 1000);
                }
                child.stdout?.on("data", onData);
                child.stderr?.on("data", onData);
                if (signal) {
                    if (signal.aborted) onAbort();
                    else signal.addEventListener("abort", onAbort, { once: true });
                }
                const exitCode = await waitForChildProcess(child);
                if (signal?.aborted) throw new Error("aborted");
                if (timedOut) throw new Error(`timeout:${timeout}`);
                return { exitCode };
            } finally {
                if (child.pid) untrackDetachedChildPid(child.pid);
                if (timeoutHandle) clearTimeout(timeoutHandle);
                if (signal) signal.removeEventListener("abort", onAbort);
            }
        },
    };
}

export interface BashToolOptions {
    operations?: BashOperations;
    /** Command prefix prepended to every command (e.g. shell setup). */
    commandPrefix?: string;
    /** Explicit shell path (from settings). */
    shellPath?: string;
}

const BASH_UPDATE_THROTTLE_MS = 100;

export function createBashTool(
    cwd: string,
    options?: BashToolOptions,
): AgentTool<typeof bashSchema, BashToolDetails | undefined> {
    const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
    const commandPrefix = options?.commandPrefix;
    return {
        name: "bash",
        label: "bash",
        description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); if truncated, the full output is saved to a temp file. Optionally provide a timeout in seconds.`,
        promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
        parameters: bashSchema,
        async execute(_toolCallId, { command, timeout }, signal, onUpdate) {
            const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
            const output = new OutputAccumulator({ tempFilePrefix: "crest-bash" });
            let updateTimer: NodeJS.Timeout | undefined;
            let updateDirty = false;
            let lastUpdateAt = 0;

            const emitOutputUpdate = () => {
                if (!onUpdate || !updateDirty) return;
                updateDirty = false;
                lastUpdateAt = Date.now();
                const snapshot = output.snapshot({ persistIfTruncated: true });
                onUpdate({
                    content: [{ type: "text", text: snapshot.content || "" }],
                    details: {
                        truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
                        fullOutputPath: snapshot.fullOutputPath,
                    },
                });
            };

            const clearUpdateTimer = () => {
                if (updateTimer) {
                    clearTimeout(updateTimer);
                    updateTimer = undefined;
                }
            };

            const scheduleOutputUpdate = () => {
                if (!onUpdate) return;
                updateDirty = true;
                const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
                if (delay <= 0) {
                    clearUpdateTimer();
                    emitOutputUpdate();
                    return;
                }
                updateTimer ??= setTimeout(() => {
                    updateTimer = undefined;
                    emitOutputUpdate();
                }, delay);
            };

            if (onUpdate) onUpdate({ content: [], details: undefined });

            const handleData = (data: Buffer) => {
                output.append(data);
                scheduleOutputUpdate();
            };

            const finishOutput = async () => {
                output.finish();
                clearUpdateTimer();
                emitOutputUpdate();
                const snapshot = output.snapshot({ persistIfTruncated: true });
                await output.closeTempFile();
                return snapshot;
            };

            const formatOutput = (
                snapshot: Awaited<ReturnType<typeof finishOutput>>,
                emptyText = "(no output)",
            ): { text: string; details: BashToolDetails | undefined } => {
                const truncation = snapshot.truncation;
                let text = snapshot.content || emptyText;
                let details: BashToolDetails | undefined;
                if (truncation.truncated) {
                    details = { truncation, fullOutputPath: snapshot.fullOutputPath };
                    const startLine = truncation.totalLines - truncation.outputLines + 1;
                    const endLine = truncation.totalLines;
                    if (truncation.lastLinePartial) {
                        const lastLineSize = formatSize(output.getLastLineBytes());
                        text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
                    } else if (truncation.truncatedBy === "lines") {
                        text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
                    } else {
                        text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
                    }
                }
                return { text, details };
            };

            const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

            try {
                let exitCode: number | null;
                try {
                    const result = await ops.exec(resolvedCommand, cwd, {
                        onData: handleData,
                        signal,
                        timeout,
                        env: getShellEnv(),
                    });
                    exitCode = result.exitCode;
                } catch (err) {
                    const snapshot = await finishOutput();
                    const { text } = formatOutput(snapshot, "");
                    if (err instanceof Error && err.message === "aborted") {
                        throw new Error(appendStatus(text, "Command aborted"));
                    }
                    if (err instanceof Error && err.message.startsWith("timeout:")) {
                        const timeoutSecs = err.message.split(":")[1];
                        throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
                    }
                    throw err;
                }

                const snapshot = await finishOutput();
                const { text: outputText, details } = formatOutput(snapshot);
                if (exitCode !== 0 && exitCode !== null) {
                    throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
                }
                return { content: [{ type: "text", text: outputText }], details };
            } finally {
                clearUpdateTimer();
            }
        },
    };
}
