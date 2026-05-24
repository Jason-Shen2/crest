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
        if (existsSync(customShellPath)) return { shell: customShellPath, args: ["-c"] };
        throw new Error(`Custom shell path not found: ${customShellPath}`);
    }

    if (process.platform === "win32") {
        const paths: string[] = [];
        const programFiles = process.env.ProgramFiles;
        if (programFiles) paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
        const programFilesX86 = process.env["ProgramFiles(x86)"];
        if (programFilesX86) paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
        for (const path of paths) {
            if (existsSync(path)) return { shell: path, args: ["-c"] };
        }
        const bashOnPath = findBashOnPath();
        if (bashOnPath) return { shell: bashOnPath, args: ["-c"] };
        throw new Error(
            "No bash shell found. Install Git for Windows (https://git-scm.com/download/win), add bash to PATH, or set shellPath in settings.",
        );
    }

    if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
    const bashOnPath = findBashOnPath();
    if (bashOnPath) return { shell: bashOnPath, args: ["-c"] };
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
