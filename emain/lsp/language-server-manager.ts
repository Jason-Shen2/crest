// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

type SpawnFn = typeof nodeSpawn;

type LanguageServerInput = {
    workspaceRoot: string;
    language: string;
};

type LanguageServerCommand = {
    command: string;
    args: string[];
};

export class LanguageServerManager {
    private readonly spawn: SpawnFn;
    private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

    constructor(deps: { spawn?: SpawnFn } = {}) {
        this.spawn = deps.spawn ?? nodeSpawn;
    }

    resolveCommand(language: string): LanguageServerCommand | null {
        if (language === "typescript" || language === "javascript") {
            return { command: "typescript-language-server", args: ["--stdio"] };
        }
        return null;
    }

    getOrStart(input: LanguageServerInput): ChildProcessWithoutNullStreams {
        const key = `${input.workspaceRoot}\u0000${input.language}`;
        const existing = this.processes.get(key);
        if (existing) return existing;
        const command = this.resolveCommand(input.language);
        if (!command) {
            throw new Error(`No language server configured for ${input.language}`);
        }
        const child = this.spawn(command.command, command.args, {
            cwd: input.workspaceRoot,
            stdio: "pipe",
        });
        child.on("exit", () => this.processes.delete(key));
        child.on("error", () => this.processes.delete(key));
        this.processes.set(key, child);
        return child;
    }

    stop(input: LanguageServerInput): void {
        const key = `${input.workspaceRoot}\u0000${input.language}`;
        const child = this.processes.get(key);
        if (!child) return;
        child.kill();
        this.processes.delete(key);
    }

    stopAll(): void {
        for (const child of this.processes.values()) {
            child.kill();
        }
        this.processes.clear();
    }
}
