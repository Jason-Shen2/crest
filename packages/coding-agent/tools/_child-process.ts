// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// waitForChildProcess — ported from pi's
// packages/coding-agent/src/utils/child-process.ts (earendil-works/pi,
// MIT). pi's spawnProcess/spawnProcessSync wrappers (which pull in
// cross-spawn) are left out — bash uses node's spawn directly and only
// needs this terminate-without-hanging helper.

import type { ChildProcess } from "node:child_process";

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for a child process to terminate without hanging on inherited
 * stdio handles. On Windows, daemonized descendants can inherit the
 * child's stdout/stderr pipes; the child emits `exit` but `close` can
 * hang forever. We wait briefly for stdio to end after exit, then
 * forcibly stop tracking the inherited handles.
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let exited = false;
        let exitCode: number | null = null;
        let postExitTimer: NodeJS.Timeout | undefined;
        let stdoutEnded = child.stdout === null;
        let stderrEnded = child.stderr === null;

        const cleanup = () => {
            if (postExitTimer) {
                clearTimeout(postExitTimer);
                postExitTimer = undefined;
            }
            child.removeListener("error", onError);
            child.removeListener("exit", onExit);
            child.removeListener("close", onClose);
            child.stdout?.removeListener("end", onStdoutEnd);
            child.stderr?.removeListener("end", onStderrEnd);
        };

        const finalize = (code: number | null) => {
            if (settled) return;
            settled = true;
            cleanup();
            child.stdout?.destroy();
            child.stderr?.destroy();
            resolve(code);
        };

        const maybeFinalizeAfterExit = () => {
            if (!exited || settled) return;
            if (stdoutEnded && stderrEnded) finalize(exitCode);
        };

        const onStdoutEnd = () => {
            stdoutEnded = true;
            maybeFinalizeAfterExit();
        };
        const onStderrEnd = () => {
            stderrEnded = true;
            maybeFinalizeAfterExit();
        };
        const onError = (err: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        };
        const onExit = (code: number | null) => {
            exited = true;
            exitCode = code;
            maybeFinalizeAfterExit();
            if (!settled) postExitTimer = setTimeout(() => finalize(code), EXIT_STDIO_GRACE_MS);
        };
        const onClose = (code: number | null) => finalize(code);

        child.stdout?.once("end", onStdoutEnd);
        child.stderr?.once("end", onStderrEnd);
        child.once("error", onError);
        child.once("exit", onExit);
        child.once("close", onClose);
    });
}
