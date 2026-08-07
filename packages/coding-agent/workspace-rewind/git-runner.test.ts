// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { WorkspaceGitRunner, WorkspaceGitRunnerError, WorkspaceGitRunnerLimits } from "./git-runner";

const FakeGitSource = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const commands = new Set(["report", "stdin", "exit", "wait", "stdout", "stderr", "exit-immediate"]);
const commandIndex = argv.findIndex((value) => commands.has(value));
const command = argv[commandIndex];
const commandArgs = argv.slice(commandIndex + 1);

if (command === "report") {
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^git_/i.test(key)));
    process.stdout.write(JSON.stringify({ argv, cwd: process.cwd(), gitEnv, lcAll: process.env.LC_ALL }));
} else if (command === "stdin") {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => process.stdout.write(Buffer.concat(chunks)));
} else if (command === "exit") {
    process.stdout.write(commandArgs[1] ?? "");
    process.stderr.write(commandArgs[2] ?? "");
    process.exit(Number(commandArgs[0]));
} else if (command === "wait") {
    writeFileSync(commandArgs[0], String(process.pid));
    setInterval(() => {}, 1_000);
} else if (command === "stdout") {
    process.stdout.write(Buffer.alloc(Number(commandArgs[0]), "o"));
} else if (command === "stderr") {
    process.stderr.write(Buffer.alloc(Number(commandArgs[0]), "e"));
} else if (command === "exit-immediate") {
    process.exit(0);
} else {
    process.stderr.write("unknown fake command");
    process.exit(91);
}
`;

const TestSha1 = "f".repeat(40);

interface Report {
    argv: string[];
    cwd: string;
    gitEnv: Record<string, string>;
    lcAll: string;
}

describe.sequential("WorkspaceGitRunner", () => {
    let root: string;
    let executable: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "crest-git-runner-"));
        executable = join(root, "fake-git.mjs");
        await writeFile(executable, FakeGitSource);
        await chmod(executable, 0o755);
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    test("passes unmodified argv without shell interpolation and isolates shadow Git state", async () => {
        const runner = new WorkspaceGitRunner(executable);
        const gitDir = join(root, "shadow.git");
        const workTree = join(root, "worktree");
        const indexFile = join(root, "private-index");
        const shellMarker = join(root, "shell-expanded");
        const originalArgs = [
            "hash-object",
            "report",
            "-leading",
            "tab\tpath",
            "line\npath",
            ":(glob)**/*.ts",
            "*.md",
            `;touch ${shellMarker}`,
        ];
        const inherited = {
            GIT_DIR: process.env.GIT_DIR,
            GIT_WORK_TREE: process.env.GIT_WORK_TREE,
            GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
            GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,
            GIT_ALTERNATE_OBJECT_DIRECTORIES: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
            GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
            GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
            GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
            GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS,
            GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
            GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
            GIT_GLOB_PATHSPECS: process.env.GIT_GLOB_PATHSPECS,
            GIT_NOGLOB_PATHSPECS: process.env.GIT_NOGLOB_PATHSPECS,
            GIT_ICASE_PATHSPECS: process.env.GIT_ICASE_PATHSPECS,
            GIT_CUSTOM_PATHSPECS: process.env.GIT_CUSTOM_PATHSPECS,
            Git_MIXED_PATHSPECS: process.env.Git_MIXED_PATHSPECS,
        };

        Object.assign(process.env, {
            GIT_DIR: "/user/repo.git",
            GIT_WORK_TREE: "/user/worktree",
            GIT_INDEX_FILE: "/user/index",
            GIT_OBJECT_DIRECTORY: "/user/objects",
            GIT_ALTERNATE_OBJECT_DIRECTORIES: "/user/alternates",
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "core.fsmonitor",
            GIT_CONFIG_VALUE_0: "malicious",
            GIT_CONFIG_PARAMETERS: "'alias.pwn=!touch pwned'",
            GIT_CONFIG_GLOBAL: "/user/global-config",
            GIT_CONFIG_SYSTEM: "/user/system-config",
            GIT_GLOB_PATHSPECS: "1",
            GIT_NOGLOB_PATHSPECS: "1",
            GIT_ICASE_PATHSPECS: "1",
            GIT_CUSTOM_PATHSPECS: "1",
            Git_MIXED_PATHSPECS: "1",
        });

        try {
            const result = await runner.run(originalArgs, {
                cwd: root,
                gitDir,
                workTree,
                indexFile,
                timeoutMs: 10_000,
            });
            const report = JSON.parse(result.stdout.toString()) as Report;

            expect(report.argv.slice(-originalArgs.length)).toEqual(originalArgs);
            expect(report.argv).toContain(`--git-dir=${gitDir}`);
            expect(report.argv).toContain(`--work-tree=${workTree}`);
            expect(report.cwd).toBe(await realpath(root));
            expect(report.gitEnv).not.toMatchObject({
                GIT_DIR: "/user/repo.git",
                GIT_WORK_TREE: "/user/worktree",
                GIT_OBJECT_DIRECTORY: "/user/objects",
                GIT_ALTERNATE_OBJECT_DIRECTORIES: "/user/alternates",
            });
            expect(report.gitEnv.GIT_INDEX_FILE).toBe(indexFile);
            expect(report.gitEnv.GIT_CONFIG_COUNT).toBeUndefined();
            expect(report.gitEnv.GIT_CONFIG_KEY_0).toBeUndefined();
            expect(report.gitEnv.GIT_CONFIG_VALUE_0).toBeUndefined();
            expect(report.gitEnv.GIT_CONFIG_PARAMETERS).toBeUndefined();
            expect(report.gitEnv.GIT_CONFIG_GLOBAL).not.toBe("/user/global-config");
            expect(isAbsolute(report.gitEnv.GIT_CONFIG_GLOBAL)).toBe(true);
            expect(report.gitEnv.GIT_CONFIG_NOSYSTEM).toBe("1");
            expect(report.gitEnv.GIT_GLOB_PATHSPECS).toBeUndefined();
            expect(report.gitEnv.GIT_NOGLOB_PATHSPECS).toBeUndefined();
            expect(report.gitEnv.GIT_ICASE_PATHSPECS).toBeUndefined();
            expect(report.gitEnv.GIT_CUSTOM_PATHSPECS).toBeUndefined();
            expect(report.gitEnv.Git_MIXED_PATHSPECS).toBeUndefined();
            expect(report.gitEnv.GIT_TERMINAL_PROMPT).toBe("0");
            expect(report.gitEnv.GIT_LITERAL_PATHSPECS).toBe("1");
            expect(report.lcAll).toBe("C");
            await expect(stat(shellMarker)).rejects.toMatchObject({ code: "ENOENT" });
            await expect(stat(report.gitEnv.GIT_CONFIG_GLOBAL)).resolves.toMatchObject({ size: 0 });
        } finally {
            for (const [key, value] of Object.entries(inherited)) {
                if (value == null) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    });

    test("discovery disables locks, fsmonitor, hooks, and autocrlf with a reusable private path", async () => {
        const runner = new WorkspaceGitRunner(executable);
        const first = await runner.run(["rev-parse", "report"], { cwd: root, timeoutMs: 2_000 });
        const second = await runner.run(["rev-parse", "report"], { cwd: root, timeoutMs: 2_000 });
        const firstReport = JSON.parse(first.stdout.toString()) as Report;
        const secondReport = JSON.parse(second.stdout.toString()) as Report;
        const hooksConfigIndex = firstReport.argv.findIndex((value) => value.startsWith("core.hooksPath="));
        const hooksPath = firstReport.argv[hooksConfigIndex].slice("core.hooksPath=".length);
        const globalConfigPath = firstReport.gitEnv.GIT_CONFIG_GLOBAL;
        const secureRoot = dirname(hooksPath);
        const hooksStat = await stat(hooksPath);
        const globalConfigStat = await stat(globalConfigPath);
        const secureRootStat = await stat(secureRoot);

        expect(firstReport.gitEnv.GIT_OPTIONAL_LOCKS).toBe("0");
        expect(firstReport.argv).toContain("core.fsmonitor=false");
        expect(firstReport.argv).toContain("core.autocrlf=false");
        expect(isAbsolute(hooksPath)).toBe(true);
        expect(isAbsolute(globalConfigPath)).toBe(true);
        expect(hooksPath.startsWith(root)).toBe(false);
        expect(globalConfigPath.startsWith(root)).toBe(false);
        expect(secondReport.argv).toContain(`core.hooksPath=${hooksPath}`);
        expect(secondReport.gitEnv.GIT_CONFIG_GLOBAL).toBe(globalConfigPath);
        expect(dirname(globalConfigPath)).toBe(secureRoot);
        expect(hooksStat.isDirectory()).toBe(true);
        expect(globalConfigStat.isFile()).toBe(true);
        expect(globalConfigStat.size).toBe(0);
        expect(secureRootStat.isDirectory()).toBe(true);
        if (process.platform !== "win32") {
            expect(secureRootStat.mode & 0o777).toBe(0o700);
            expect(hooksStat.mode & 0o777).toBe(0o700);
            expect(globalConfigStat.mode & 0o777).toBe(0o600);
        }
    });

    test("uses a runner-owned commit identity instead of ambient Git identity", async () => {
        const runner = new WorkspaceGitRunner();
        const gitDir = join(root, "identity.git");
        await runner.run(["init", "--bare", gitDir], { cwd: root, timeoutMs: 5_000 });
        await runner.run(["config", "--local", "user.name", "Ambient Local"], {
            gitDir,
            timeoutMs: 5_000,
        });
        await runner.run(["config", "--local", "user.email", "ambient-local@example.test"], {
            gitDir,
            timeoutMs: 5_000,
        });
        await runner.run(["config", "--local", "author.name", "Ambient Config Author"], {
            gitDir,
            timeoutMs: 5_000,
        });
        await runner.run(["config", "--local", "author.email", "author-config@example.test"], {
            gitDir,
            timeoutMs: 5_000,
        });
        await runner.run(["config", "--local", "committer.name", "Ambient Config Committer"], {
            gitDir,
            timeoutMs: 5_000,
        });
        await runner.run(["config", "--local", "committer.email", "committer-config@example.test"], {
            gitDir,
            timeoutMs: 5_000,
        });
        const tree = (await runner.run(["mktree"], { gitDir, stdin: Buffer.alloc(0), timeoutMs: 5_000 })).stdout
            .toString("ascii")
            .trim();
        const inherited = {
            GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
            GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
            GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
            GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
        };
        Object.assign(process.env, {
            GIT_AUTHOR_NAME: "Ambient Author",
            GIT_AUTHOR_EMAIL: "ambient-author@example.test",
            GIT_COMMITTER_NAME: "Ambient Committer",
            GIT_COMMITTER_EMAIL: "ambient-committer@example.test",
        });

        try {
            const commit = (
                await runner.run(["commit-tree", tree], {
                    gitDir,
                    stdin: Buffer.from("{}"),
                    timeoutMs: 5_000,
                })
            ).stdout
                .toString("ascii")
                .trim();
            const stored = (await runner.run(["cat-file", "-p", commit], { gitDir, timeoutMs: 5_000 })).stdout.toString(
                "utf8"
            );

            expect(stored).toMatch(/^author Crest Workspace <workspace@crest\.invalid> /m);
            expect(stored).toMatch(/^committer Crest Workspace <workspace@crest\.invalid> /m);
            expect(stored).not.toContain("Ambient");
            expect(stored).not.toContain("ambient-");
        } finally {
            for (const [key, value] of Object.entries(inherited)) {
                if (value == null) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    });

    test("uses current commit dates instead of ambient Git dates", async () => {
        const runner = new WorkspaceGitRunner();
        const gitDir = join(root, "identity-dates.git");
        await runner.run(["init", "--bare", gitDir], { cwd: root, timeoutMs: 5_000 });
        const tree = (await runner.run(["mktree"], { gitDir, stdin: Buffer.alloc(0), timeoutMs: 5_000 })).stdout
            .toString("ascii")
            .trim();
        const inherited = {
            GIT_AUTHOR_DATE: process.env.GIT_AUTHOR_DATE,
            GIT_COMMITTER_DATE: process.env.GIT_COMMITTER_DATE,
        };
        Object.assign(process.env, {
            GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
            GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        });

        try {
            const startedAt = Date.now();
            const commit = (
                await runner.run(["commit-tree", tree], {
                    gitDir,
                    stdin: Buffer.from("{}"),
                    timeoutMs: 5_000,
                })
            ).stdout
                .toString("ascii")
                .trim();
            const finishedAt = Date.now();
            const stored = (await runner.run(["cat-file", "-p", commit], { gitDir, timeoutMs: 5_000 })).stdout.toString(
                "utf8"
            );
            const authorTimestamp = /^author .* (\d+) [+-]\d{4}$/m.exec(stored)?.[1];
            const committerTimestamp = /^committer .* (\d+) [+-]\d{4}$/m.exec(stored)?.[1];

            expect(authorTimestamp).toBeDefined();
            expect(committerTimestamp).toBeDefined();
            for (const timestamp of [authorTimestamp, committerTimestamp]) {
                const milliseconds = Number(timestamp) * 1_000;
                expect(milliseconds).toBeGreaterThanOrEqual(startedAt - 60_000);
                expect(milliseconds).toBeLessThanOrEqual(finishedAt + 60_000);
            }
        } finally {
            for (const [key, value] of Object.entries(inherited)) {
                if (value == null) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    });

    test.each([
        ["leading -c", ["-c", "core.hooksPath=/user/hooks", "rev-parse"]],
        ["leading --config-env=", ["--config-env=core.hooksPath=ATTACKER", "rev-parse"]],
        ["leading --config-env", ["--config-env", "core.hooksPath=ATTACKER", "rev-parse"]],
        ["leading --git-dir=", ["--git-dir=/user/repo.git", "rev-parse"]],
        ["leading --git-dir", ["--git-dir", "/user/repo.git", "rev-parse"]],
        ["leading --work-tree=", ["--work-tree=/user/worktree", "rev-parse"]],
        ["leading --work-tree", ["--work-tree", "/user/worktree", "rev-parse"]],
        ["leading -C", ["-C", "/user/repo", "rev-parse"]],
        ["leading -Cpath", ["-C/user/repo", "rev-parse"]],
        ["unapproved helper", ["credential-steal"]],
    ])("rejects %s before spawning", async (_name, args) => {
        const runner = new WorkspaceGitRunner(join(root, "missing-executable"));

        await expect(runner.run(args, { timeoutMs: 100 })).rejects.toMatchObject({
            code: "invalid_options",
        });
    });

    test.each([
        "init",
        "config",
        "rev-parse",
        "ls-files",
        "hash-object",
        "mktree",
        "cat-file",
        "diff",
        "diff-tree",
        "update-ref",
        "for-each-ref",
        "rev-list",
        "show-ref",
        "count-objects",
        "fsck",
        "gc",
        "reflog",
    ])("allows approved builtin %s through validation", async (subcommand) => {
        const runner = new WorkspaceGitRunner(join(root, "missing-executable"));

        await expect(runner.run([subcommand], { timeoutMs: 100 })).rejects.toMatchObject({
            code: "spawn_failed",
        });
    });

    test.each([
        ["commit-tree", ["commit-tree", TestSha1], false, false],
        ["write-tree", ["write-tree"], true, false],
        ["read-tree", ["read-tree", TestSha1], true, false],
        ["update-index", ["update-index", "-z", "--index-info"], true, true],
        ["ls-tree", ["ls-tree", "-r", TestSha1], false, false],
        ["status", ["status", "--porcelain=v2", "-z"], false, false],
        ["log", ["log", "--format=%H", `${TestSha1}..${TestSha1}`, "--", "shared.txt"], false, false],
    ] as const)("allows secure %s form through validation", async (_name, args, withIndex, withStdin) => {
        const runner = new WorkspaceGitRunner(join(root, "missing-executable"));

        await expect(
            runner.run(args, {
                ...(withIndex ? { indexFile: join(root, "private-index") } : {}),
                ...(withStdin ? { stdin: Buffer.alloc(0) } : {}),
                timeoutMs: 100,
            })
        ).rejects.toMatchObject({ code: "spawn_failed" });
    });

    test.each([
        ["commit-tree without a tree", () => ["commit-tree"], false],
        ["commit signing", () => ["commit-tree", TestSha1, "-S"], true],
        ["write-tree without a private index", () => ["write-tree"], false],
        ["read-tree without a tree", () => ["read-tree"], true],
        ["read-tree worktree update", () => ["read-tree", "--reset", "-u", TestSha1], true],
        [
            "read-tree alternate index output",
            () => ["read-tree", `--index-output=${join(root, "victim")}`, TestSha1],
            true,
        ],
        ["read-tree without a private index", () => ["read-tree", TestSha1], false],
        ["update-index without an index operation", () => ["update-index"], true],
        ["update-index worktree refresh", () => ["update-index", "--refresh"], true],
        ["ls-tree without a tree", () => ["ls-tree"], false],
        ["log external diff", () => ["log", "-p", "--ext-diff"], false],
        ["log signature verification", () => ["log", "--show-signature"], false],
    ] as const)("rejects unsafe %s before spawning", async (_name, makeArgs, withIndex) => {
        const runner = new WorkspaceGitRunner(join(root, "missing-executable"));

        await expect(
            runner.run(makeArgs(), {
                ...(withIndex
                    ? {
                          gitDir: join(root, "shadow.git"),
                          workTree: join(root, "worktree"),
                          indexFile: join(root, "private-index"),
                      }
                    : {}),
                timeoutMs: 100,
            })
        ).rejects.toMatchObject({ code: "invalid_options" });
    });

    test("supports only the NUL-delimited check-ignore stdin form without Git literal pathspec injection", async () => {
        const repository = join(root, "repository");
        await mkdir(repository);
        const runner = new WorkspaceGitRunner();
        await runner.run(["init"], { cwd: repository, timeoutMs: 5_000 });
        await writeFile(join(repository, ".gitignore"), "*.secret\n");
        const paths = Buffer.from("literal[1].secret\0-leading.secret\0plain.txt\0");

        const result = await runner.run(["check-ignore", "-z", "--stdin"], {
            cwd: repository,
            stdin: paths,
            timeoutMs: 5_000,
        });

        expect(result.stdout).toEqual(Buffer.from("literal[1].secret\0-leading.secret\0"));
        await expect(
            runner.run(["check-ignore", "plain.txt"], { cwd: repository, timeoutMs: 5_000 })
        ).rejects.toMatchObject({ code: "invalid_options" });
    });

    test.each(["checkout-index", "reset", "clean"])(
        "rejects forbidden builtin %s before spawning",
        async (subcommand) => {
            const runner = new WorkspaceGitRunner(join(root, "missing-executable"));

            await expect(runner.run([subcommand], { timeoutMs: 100 })).rejects.toMatchObject({
                code: "invalid_options",
            });
        }
    );

    test.each([
        ["relative gitDir", { gitDir: "relative.git" }],
        ["relative workTree", { workTree: "relative-worktree" }],
        ["relative indexFile", { indexFile: "relative-index" }],
    ])("rejects %s before spawning", async (_name, invalidOptions) => {
        const runner = new WorkspaceGitRunner(join(root, "missing-executable"));

        await expect(
            runner.run(["rev-parse", "report"], {
                ...invalidOptions,
                timeoutMs: 100,
            })
        ).rejects.toMatchObject({ code: "invalid_options" });
    });

    test.each([
        ["negative stdout", { maxStdoutBytes: -1 }],
        ["fractional stdout", { maxStdoutBytes: 1.5 }],
        ["unsafe stdout", { maxStdoutBytes: Number.MAX_SAFE_INTEGER + 1 }],
        ["over-cap stdout", { maxStdoutBytes: WorkspaceGitRunnerLimits.maxStdoutBytes + 1 }],
        ["negative stderr", { maxStderrBytes: -1 }],
        ["fractional stderr", { maxStderrBytes: 1.5 }],
        ["unsafe stderr", { maxStderrBytes: Number.MAX_SAFE_INTEGER + 1 }],
        ["over-cap stderr", { maxStderrBytes: WorkspaceGitRunnerLimits.maxStderrBytes + 1 }],
    ])("rejects invalid limit: %s", async (_name, invalidOptions) => {
        const runner = new WorkspaceGitRunner(join(root, "missing-executable"));

        await expect(
            runner.run(["rev-parse", "report"], {
                ...invalidOptions,
                timeoutMs: 100,
            })
        ).rejects.toMatchObject({ code: "invalid_options" });
    });

    test.each([-1, 1.5, Number.NaN, 2 ** 31])("rejects invalid timeout %s before spawning", async (timeoutMs) => {
        const runner = new WorkspaceGitRunner(join(root, "missing-executable"));

        await expect(runner.run(["rev-parse", "report"], { timeoutMs })).rejects.toMatchObject({
            code: "invalid_options",
        });
    });

    test("rejects a pre-aborted signal without spawning", async () => {
        const controller = new AbortController();
        controller.abort();
        const runner = new WorkspaceGitRunner(join(root, "missing-executable"));

        await expect(
            runner.run(["rev-parse", "report"], {
                timeoutMs: 100,
                signal: controller.signal,
            })
        ).rejects.toMatchObject({ code: "aborted" });
    });

    test("maps executable spawn errors", async () => {
        const runner = new WorkspaceGitRunner(join(root, "missing-executable"));

        await expect(runner.run(["rev-parse", "report"], { timeoutMs: 100 })).rejects.toMatchObject({
            code: "spawn_failed",
        });
    });

    test("retains bounded output and exit code for nonzero exits", async () => {
        const runner = new WorkspaceGitRunner(executable);

        const error = await runner
            .run(["hash-object", "exit", "23", "diagnostic-out", "diagnostic-err"], { timeoutMs: 2_000 })
            .catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(WorkspaceGitRunnerError);
        expect(error).toMatchObject({
            code: "nonzero_exit",
            exitCode: 23,
            stdout: Buffer.from("diagnostic-out"),
            stderr: Buffer.from("diagnostic-err"),
        });
    });

    test("times out and waits for the child to terminate", async () => {
        const runner = new WorkspaceGitRunner(executable);
        const pidPath = join(root, "timeout.pid");

        await expect(runner.run(["hash-object", "wait", pidPath], { timeoutMs: 1_000 })).rejects.toMatchObject({
            code: "timeout",
        });

        const pid = Number(await readFile(pidPath, "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
    });

    test("aborts in-flight and waits for the child to terminate", async () => {
        const runner = new WorkspaceGitRunner(executable);
        const pidPath = join(root, "abort.pid");
        const controller = new AbortController();
        const runPromise = runner.run(["hash-object", "wait", pidPath], {
            timeoutMs: 2_000,
            signal: controller.signal,
        });

        await expect(readPidEventually(pidPath)).resolves.toBeGreaterThan(0);
        controller.abort();
        await expect(runPromise).rejects.toMatchObject({ code: "aborted" });

        const pid = Number(await readFile(pidPath, "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
    });

    test.each([
        ["stdout", "stdout_overflow", "maxStdoutBytes"],
        ["stderr", "stderr_overflow", "maxStderrBytes"],
    ] as const)("rejects %s overflow without retaining an over-limit chunk", async (stream, code, limitKey) => {
        const runner = new WorkspaceGitRunner(executable);

        const error = await runner
            .run(["hash-object", stream, "9"], {
                timeoutMs: 2_000,
                [limitKey]: 8,
            })
            .catch((cause: unknown) => cause);

        if (!(error instanceof WorkspaceGitRunnerError)) {
            throw error;
        }
        expect(error).toBeInstanceOf(WorkspaceGitRunnerError);
        expect(error).toMatchObject({ code });
        expect(error.stdout.length).toBeLessThanOrEqual(8);
        expect(error.stderr.length).toBeLessThanOrEqual(8);
    });

    test.each([
        ["stdout", "maxStdoutBytes"],
        ["stderr", "maxStderrBytes"],
    ] as const)("allows %s exactly at its cap", async (stream, limitKey) => {
        const runner = new WorkspaceGitRunner(executable);

        const result = await runner.run(["hash-object", stream, "8"], {
            timeoutMs: 2_000,
            [limitKey]: 8,
        });

        expect(result[stream].length).toBe(8);
    });

    test.each([
        ["stdout", "stdout_overflow", "maxStdoutBytes"],
        ["stderr", "stderr_overflow", "maxStderrBytes"],
    ] as const)("treats nonempty %s with a zero cap as overflow", async (stream, code, limitKey) => {
        const runner = new WorkspaceGitRunner(executable);

        await expect(
            runner.run(["hash-object", stream, "1"], {
                timeoutMs: 2_000,
                [limitKey]: 0,
            })
        ).rejects.toMatchObject({ code });
    });

    test("writes and ends stdin", async () => {
        const runner = new WorkspaceGitRunner(executable);

        await expect(
            runner.run(["hash-object", "stdin"], {
                stdin: Buffer.from("bytes"),
                timeoutMs: 2_000,
            })
        ).resolves.toEqual({
            stdout: Buffer.from("bytes"),
            stderr: Buffer.alloc(0),
        });
        await expect(runner.run(["hash-object", "stdin"], { timeoutMs: 2_000 })).resolves.toEqual({
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
        });
    });

    test("handles child stdin EPIPE without an unhandled error", async () => {
        const runner = new WorkspaceGitRunner(executable);

        await expect(
            runner.run(["hash-object", "exit-immediate"], {
                stdin: Buffer.alloc(1024 ** 2),
                timeoutMs: 2_000,
            })
        ).resolves.toEqual({
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
        });
    });

    test("maps unexpected child stdin errors and terminates the child", async () => {
        const child = makeMockChild();
        const kill = vi.spyOn(child, "kill");
        vi.resetModules();
        vi.doMock("node:child_process", () => ({
            spawn: vi.fn(() => child),
        }));

        try {
            const { WorkspaceGitRunner: MockedWorkspaceGitRunner } = await import("./git-runner");
            const runner = new MockedWorkspaceGitRunner("fake-git");
            const runPromise = runner.run(["hash-object"], { timeoutMs: 1_000 });
            const stdinError = Object.assign(new Error("stdin denied"), { code: "EACCES" });

            child.stdin.emit("error", stdinError);

            await expect(runPromise).rejects.toMatchObject({
                code: "spawn_failed",
                cause: stdinError,
            });
            expect(kill).toHaveBeenCalledWith("SIGKILL");
        } finally {
            vi.doUnmock("node:child_process");
            vi.resetModules();
        }
    });

    test("registers one process exit cleanup across isolated module instances", async () => {
        const before = process.listenerCount("exit");
        for (let index = 0; index < 12; index++) {
            vi.resetModules();
            const isolated = await import("./git-runner");
            await new isolated.WorkspaceGitRunner().run(["hash-object", "--stdin"], {
                stdin: Buffer.from(String(index)),
                timeoutMs: 2_000,
            });
        }

        expect(process.listenerCount("exit") - before).toBeLessThanOrEqual(1);
    });
});

async function readPidEventually(path: string): Promise<number> {
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            return Number(await readFile(path, "utf8"));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
    throw new Error("fake Git did not write its pid");
}

function makeMockChild(): ChildProcessWithoutNullStreams {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout,
        stderr,
        pid: 12345,
        exitCode: null,
        signalCode: null,
        killed: false,
        kill(signal: NodeJS.Signals) {
            child.killed = true;
            child.signalCode = signal;
            queueMicrotask(() => {
                stdout.end();
                stderr.end();
                child.emit("exit", null, signal);
                child.emit("close", null, signal);
            });
            return true;
        },
    });
    return child as unknown as ChildProcessWithoutNullStreams;
}
