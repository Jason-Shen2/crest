// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

type SpawnFn = typeof nodeSpawn;
type CommandExistsFn = (path: string) => boolean;

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
    private readonly appRoot: string;
    private readonly commandExists: CommandExistsFn;
    private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

    constructor(deps: { appRoot?: string; commandExists?: CommandExistsFn; spawn?: SpawnFn } = {}) {
        this.appRoot = deps.appRoot ?? process.cwd();
        this.commandExists = deps.commandExists ?? existsSync;
        this.spawn = deps.spawn ?? nodeSpawn;
    }

    resolveCommand(language: string): LanguageServerCommand | null {
        if (language === "typescript" || language === "javascript") {
            return { command: this.resolveAppBinCommand("typescript-language-server"), args: ["--stdio"] };
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

    private getAppRootCandidates(): string[] {
        const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
        const candidates = [
            this.appRoot,
            process.cwd(),
            resourcesPath ? path.join(resourcesPath, "app") : null,
            resourcesPath ? path.join(resourcesPath, "app.asar.unpacked") : null,
            path.resolve(import.meta.dirname, "..", ".."),
            path.resolve(import.meta.dirname, "..", "..", ".."),
        ];
        return Array.from(new Set(candidates.filter((candidate) => candidate != null)));
    }
}
