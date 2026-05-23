// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// shell_exec — run a shell command, return stdout/stderr/exitCode.
// Runs in the pane's cwd via the AgentHarness's env (caller passes a
// resolved cwd). v1 is "headless" — output is captured and returned
// to the LLM, not displayed in a terminal block. A future block-tied
// variant (the dropped Go headless_shell_exec.go) can be added when
// the renderer / wavesrv-bridged tools land.
//
// Caveats:
//   - Output is capped at OUTPUT_CAP_BYTES per stream to keep the
//     model's context budget reasonable. Long-running tools that
//     stream a lot should be wrapped (e.g. `cmd | tail -n 200`).
//   - Aborts via SIGTERM (then SIGKILL after a grace) on signal abort.

import { spawn } from "node:child_process";
import { Type, type Static } from "typebox";

import type { AgentTool } from "../types";

const NAME = "shell_exec";
const DEFAULT_TIMEOUT_MS = 60_000;
const OUTPUT_CAP_BYTES = 64 * 1024; // per stream — stdout and stderr each
const KILL_GRACE_MS = 2_000;

const ShellExecSchema = Type.Object({
    command: Type.String({
        description:
            "Shell command line to execute. Runs through /bin/sh -c so pipes / redirects / globs work.",
    }),
    cwd: Type.Optional(
        Type.String({
            description:
                "Optional working directory. Defaults to the pane's cwd (the harness's env.cwd).",
        }),
    ),
    timeoutMs: Type.Optional(
        Type.Number({ description: `Per-command timeout. Defaults to ${DEFAULT_TIMEOUT_MS}ms.` }),
    ),
});

export interface ShellExecDetails {
    command: string;
    cwd: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdoutBytes: number;
    stderrBytes: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    timedOut: boolean;
}

function appendCapped(
    chunks: Buffer[],
    totalRef: { bytes: number },
    next: Buffer,
): boolean {
    // returns true if append truncated (cap reached)
    const remaining = OUTPUT_CAP_BYTES - totalRef.bytes;
    if (remaining <= 0) return true;
    if (next.byteLength <= remaining) {
        chunks.push(next);
        totalRef.bytes += next.byteLength;
        return false;
    }
    chunks.push(next.subarray(0, remaining));
    totalRef.bytes += remaining;
    return true;
}

export const shellExecTool: AgentTool<typeof ShellExecSchema, ShellExecDetails> = {
    name: NAME,
    label: "Run Shell",
    description:
        "Run a shell command. Output (stdout + stderr) and exit code are returned to the model. Long-running commands should pipe through head/tail/grep to fit the response budget.",
    parameters: ShellExecSchema,
    executionMode: "sequential", // sequential to avoid concurrent state-mutating commands
    async execute(_toolCallId, params, signal): Promise<{
        content: [{ type: "text"; text: string }];
        details: ShellExecDetails;
    }> {
        const cwd = params.cwd ?? process.cwd();
        const timeoutMs = Math.max(1_000, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        const stdoutRef = { bytes: 0 };
        const stderrRef = { bytes: 0 };
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let timedOut = false;

        return new Promise((resolve, reject) => {
            const child = spawn("/bin/sh", ["-c", params.command], { cwd });
            const timeoutTimer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                setTimeout(() => {
                    if (!child.killed) child.kill("SIGKILL");
                }, KILL_GRACE_MS);
            }, timeoutMs);

            const onAbort = () => {
                child.kill("SIGTERM");
                setTimeout(() => {
                    if (!child.killed) child.kill("SIGKILL");
                }, KILL_GRACE_MS);
            };
            signal?.addEventListener("abort", onAbort);

            child.stdout?.on("data", (chunk: Buffer) => {
                if (appendCapped(stdoutChunks, stdoutRef, chunk)) stdoutTruncated = true;
            });
            child.stderr?.on("data", (chunk: Buffer) => {
                if (appendCapped(stderrChunks, stderrRef, chunk)) stderrTruncated = true;
            });
            child.on("error", (err) => {
                clearTimeout(timeoutTimer);
                signal?.removeEventListener("abort", onAbort);
                reject(err);
            });
            child.on("close", (exitCode, exitSignal) => {
                clearTimeout(timeoutTimer);
                signal?.removeEventListener("abort", onAbort);
                const stdout = Buffer.concat(stdoutChunks).toString("utf8");
                const stderr = Buffer.concat(stderrChunks).toString("utf8");
                const lines: string[] = [];
                lines.push(`$ ${params.command}`);
                lines.push(`(exit ${exitCode ?? "?"}${exitSignal ? `, signal ${exitSignal}` : ""}${timedOut ? ", TIMED OUT" : ""})`);
                if (stdout) lines.push("--- stdout ---", stdout + (stdoutTruncated ? "\n[stdout truncated]" : ""));
                if (stderr) lines.push("--- stderr ---", stderr + (stderrTruncated ? "\n[stderr truncated]" : ""));
                if (!stdout && !stderr) lines.push("(no output)");
                resolve({
                    content: [{ type: "text", text: lines.join("\n") }],
                    details: {
                        command: params.command,
                        cwd,
                        exitCode,
                        signal: exitSignal,
                        stdoutBytes: stdoutRef.bytes,
                        stderrBytes: stderrRef.bytes,
                        stdoutTruncated,
                        stderrTruncated,
                        timedOut,
                    },
                });
            });
        });
    },
};

type _Static = Static<typeof ShellExecSchema>;
