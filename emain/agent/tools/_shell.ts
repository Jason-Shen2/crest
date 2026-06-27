// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shell utilities for the bash tool, ported from pi's
// packages/coding-agent/src/utils/shell.ts (earendil-works/pi, MIT).
// Trimmed to what bash needs: shell resolution, process-tree kill, and
// detached-child tracking. pi's getShellEnv prepended a tool-download
// bin dir to PATH (for its fd/ripgrep downloader); crest doesn't vendor
// that downloader, so getShellEnv here just passes process.env through.
// The render-only sanitizeBinaryOutput helper is left out.

import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

export interface ShellConfig {
    shell: string;
    args: string[];
    /**
     * How the command reaches the shell. "argv" appends it as a final
     * argument (the normal `bash -c "<cmd>"` form); "stdin" writes it to
     * the child's stdin (`bash -s`). Legacy WSL bash
     * (windows\system32\bash.exe) mishandles the argv form, so it uses
     * stdin. Defaults to argv when omitted.
     */
    commandTransport?: "argv" | "stdin";
}

/**
 * Legacy WSL bash (C:\Windows\System32\bash.exe and the sysnative
 * variant) launches the default WSL distro's bash but mangles commands
 * passed via `-c`. Detect it so we can switch to stdin transport.
 */
function isLegacyWslBashPath(path: string): boolean {
    const normalized = path.replace(/\//g, "\\").toLowerCase();
    return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

/** Build a ShellConfig for a resolved bash path, picking stdin transport for legacy WSL bash. */
export function getBashShellConfig(shell: string): ShellConfig {
    return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

function findBashOnPath(): string | null {
    if (process.platform === "win32") {
        try {
            const result = spawnSync("where", ["bash.exe"], {
                encoding: "utf-8",
                timeout: 5000,
                windowsHide: true,
            });
            if (result.status === 0 && result.stdout) {
                const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
                if (firstMatch && existsSync(firstMatch)) return firstMatch;
            }
        } catch {
            // ignore
        }
        return null;
    }
    try {
        const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
        if (result.status === 0 && result.stdout) {
            const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
            if (firstMatch) return firstMatch;
        }
    } catch {
        // ignore
    }
    return null;
}

/**
 * Resolve shell config: user-specified path, then Git Bash (Windows) /
 * /bin/bash (Unix), then bash on PATH, then plain sh.
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
    if (customShellPath) {
        if (existsSync(customShellPath)) return getBashShellConfig(customShellPath);
        throw new Error(`Custom shell path not found: ${customShellPath}`);
    }

    if (process.platform === "win32") {
        const paths: string[] = [];
        const programFiles = process.env.ProgramFiles;
        if (programFiles) paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
        const programFilesX86 = process.env["ProgramFiles(x86)"];
        if (programFilesX86) paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
        for (const path of paths) {
            if (existsSync(path)) return getBashShellConfig(path);
        }
        const bashOnPath = findBashOnPath();
        if (bashOnPath) return getBashShellConfig(bashOnPath);
        throw new Error(
            "No bash shell found. Install Git for Windows (https://git-scm.com/download/win), add bash to PATH, or set shellPath in settings.",
        );
    }

    if (existsSync("/bin/bash")) return getBashShellConfig("/bin/bash");
    const bashOnPath = findBashOnPath();
    if (bashOnPath) return getBashShellConfig(bashOnPath);
    return { shell: "sh", args: ["-c"] };
}

export function getShellEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
}

const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
    trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
    trackedDetachedChildPids.delete(pid);
}

/** Kill any still-tracked detached children — wire to app shutdown. */
export function killTrackedDetachedChildren(): void {
    for (const pid of trackedDetachedChildPids) killProcessTree(pid);
    trackedDetachedChildPids.clear();
}

/**
 * Kill a process and all its children. On Unix this kills the whole
 * process group (the child is spawned `detached`, so it leads its own
 * group); on Windows it uses taskkill /T. This is the key win over the
 * old shell_exec, which only signalled the top shell and orphaned any
 * grandchildren (npm, make, etc.).
 */
export function killProcessTree(pid: number): void {
    if (process.platform === "win32") {
        try {
            spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
                stdio: "ignore",
                detached: true,
                windowsHide: true,
            });
        } catch {
            // ignore
        }
        return;
    }
    try {
        process.kill(-pid, "SIGKILL");
    } catch {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // already dead
        }
    }
}
