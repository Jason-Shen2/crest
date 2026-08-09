// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { waitForChildProcess } from "../tools/_child-process";

export const WorkspaceGitRunnerLimits = {
    maxStdoutBytes: 64 * 1024 ** 2,
    maxStderrBytes: 4 * 1024 ** 2,
} as const;

export type WorkspaceGitRunnerErrorCode =
    | "invalid_options"
    | "spawn_failed"
    | "nonzero_exit"
    | "timeout"
    | "aborted"
    | "stdout_overflow"
    | "stderr_overflow";

export interface GitRunOptions {
    cwd?: string;
    gitDir?: string;
    workTree?: string;
    indexFile?: string;
    stdin?: Buffer;
    timeoutMs: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    signal?: AbortSignal;
    fsmonitor?: "builtin";
    pathspecMode?: "literal-magic";
}

export interface GitRunResult {
    stdout: Buffer;
    stderr: Buffer;
}

export interface GitObjectClosureImportOptions {
    sourceRoot: string;
    sourceTree: string;
    destinationGitDir: string;
    maxPackBytes: number;
    timeoutMs: number;
    signal?: AbortSignal;
}

export class WorkspaceGitRunnerError extends Error {
    readonly code: WorkspaceGitRunnerErrorCode;
    readonly exitCode?: number | null;
    readonly stdout: Buffer;
    readonly stderr: Buffer;

    constructor(
        code: WorkspaceGitRunnerErrorCode,
        message: string,
        stdout: Buffer = Buffer.alloc(0),
        stderr: Buffer = Buffer.alloc(0),
        exitCode?: number | null,
        cause?: unknown
    ) {
        super(message, cause == null ? undefined : { cause });
        this.name = "WorkspaceGitRunnerError";
        this.code = code;
        this.exitCode = exitCode;
        this.stdout = stdout;
        this.stderr = stderr;
    }
}

const MaxTimeoutMs = 2 ** 31 - 1;
const InternalCommitIdentity = {
    GIT_AUTHOR_NAME: "Crest Workspace",
    GIT_AUTHOR_EMAIL: "workspace@crest.invalid",
    GIT_COMMITTER_NAME: "Crest Workspace",
    GIT_COMMITTER_EMAIL: "workspace@crest.invalid",
} as const;
const ApprovedGitSubcommands = new Set([
    "init",
    "config",
    "rev-parse",
    "ls-files",
    "check-ignore",
    "hash-object",
    "mktree",
    "commit-tree",
    "write-tree",
    "read-tree",
    "update-index",
    "cat-file",
    "ls-tree",
    "status",
    "log",
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
]);

interface SecureGitPaths {
    root: string;
    hooks: string;
    globalConfig: string;
}

interface SecureGitProcessState {
    paths?: SecureGitPaths;
    cleanupRegistered: boolean;
}

const SecureGitStateKey = Symbol.for("crest.workspace-rewind.git-runner.secure-paths");
const SecureGitState = getSecureGitProcessState();

export class WorkspaceGitRunner {
    constructor(readonly executable = "git") {}

    async importObjectClosure(options: GitObjectClosureImportOptions): Promise<{ packBytes: number }> {
        validateObjectClosureImportOptions(options);
        if (options.signal?.aborted) throw makeError("aborted");
        let securePaths: SecureGitPaths;
        try {
            securePaths = getSecureGitPaths();
        } catch (cause) {
            throw makeError("spawn_failed", Buffer.alloc(0), Buffer.alloc(0), undefined, cause);
        }
        const commonArgs = [
            "-c",
            "core.fsmonitor=false",
            "-c",
            `core.hooksPath=${securePaths.hooks}`,
            "-c",
            "core.autocrlf=false",
        ];
        const env = {
            ...makeIsolatedEnv(true, securePaths.globalConfig, true, undefined, false),
            GIT_NO_LAZY_FETCH: "1",
        };
        let source;
        let destination;
        try {
            source = spawn(
                this.executable,
                [
                    "--no-replace-objects",
                    ...commonArgs,
                    "pack-objects",
                    "--stdout",
                    "--revs",
                    "--delta-base-offset",
                ],
                {
                    cwd: options.sourceRoot,
                    env,
                    shell: false,
                    stdio: ["pipe", "pipe", "pipe"],
                    windowsHide: true,
                }
            );
            destination = spawn(
                this.executable,
                [
                    ...commonArgs,
                    `--git-dir=${options.destinationGitDir}`,
                    "index-pack",
                    "--stdin",
                    "--strict",
                    `--max-input-size=${options.maxPackBytes}`,
                ],
                {
                    env,
                    shell: false,
                    stdio: ["pipe", "pipe", "pipe"],
                    windowsHide: true,
                }
            );
        } catch (cause) {
            source?.kill("SIGKILL");
            destination?.kill("SIGKILL");
            throw makeError("spawn_failed", Buffer.alloc(0), Buffer.alloc(0), undefined, cause);
        }

        const sourceStderr = makeBoundedCapture(WorkspaceGitRunnerLimits.maxStderrBytes);
        const destinationStderr = makeBoundedCapture(WorkspaceGitRunnerLimits.maxStderrBytes);
        const destinationStdout = makeBoundedCapture(1024);
        let packBytes = 0;
        let terminalError: WorkspaceGitRunnerError | undefined;
        const terminate = (error: WorkspaceGitRunnerError) => {
            terminalError ??= error;
            source.kill("SIGKILL");
            destination.kill("SIGKILL");
        };
        source.stderr.on("data", (chunk: Buffer) => {
            if (!sourceStderr.push(chunk)) terminate(makeError("stderr_overflow"));
        });
        destination.stderr.on("data", (chunk: Buffer) => {
            if (!destinationStderr.push(chunk)) terminate(makeError("stderr_overflow"));
        });
        destination.stdout.on("data", (chunk: Buffer) => {
            if (!destinationStdout.push(chunk)) terminate(makeError("stdout_overflow"));
        });
        source.stdout.on("data", (chunk: Buffer) => {
            packBytes += chunk.length;
            if (packBytes > options.maxPackBytes) {
                terminate(makeError("stdout_overflow"));
                return;
            }
            if (!destination.stdin.write(chunk)) source.stdout.pause();
        });
        destination.stdin.on("drain", () => source.stdout.resume());
        source.stdout.on("end", () => destination.stdin.end());
        const onAbort = () => terminate(makeError("aborted"));
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => terminate(makeError("timeout")), options.timeoutMs);
        source.stdin.on("error", (cause: NodeJS.ErrnoException) => {
            if (cause.code !== "EPIPE") terminate(makeError("spawn_failed", Buffer.alloc(0), Buffer.alloc(0), undefined, cause));
        });
        destination.stdin.on("error", (cause: NodeJS.ErrnoException) => {
            if (cause.code !== "EPIPE") terminate(makeError("spawn_failed", Buffer.alloc(0), Buffer.alloc(0), undefined, cause));
        });
        source.stdin.end(Buffer.from(`${options.sourceTree}\n`));
        try {
            const settled = await Promise.allSettled([waitForChildProcess(source), waitForChildProcess(destination)]);
            if (terminalError) throw terminalError;
            const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
            if (rejected) {
                throw makeError("spawn_failed", Buffer.alloc(0), Buffer.alloc(0), undefined, rejected.reason);
            }
            const [sourceResult, destinationResult] = settled as [PromiseFulfilledResult<number>, PromiseFulfilledResult<number>];
            if (sourceResult.value !== 0) {
                throw makeError("nonzero_exit", Buffer.alloc(0), sourceStderr.bytes(), sourceResult.value);
            }
            if (destinationResult.value !== 0) {
                throw makeError(
                    "nonzero_exit",
                    destinationStdout.bytes(),
                    destinationStderr.bytes(),
                    destinationResult.value
                );
            }
            return { packBytes };
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
        }
    }

    async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
        const limits = validateOptions(args, options);
        const checkIgnoreStdin = isCheckIgnoreStdin(args);
        if (options.signal?.aborted) {
            throw makeError("aborted");
        }

        let securePaths: SecureGitPaths;
        try {
            securePaths = getSecureGitPaths();
        } catch (cause) {
            throw makeError("spawn_failed", Buffer.alloc(0), Buffer.alloc(0), undefined, cause);
        }
        const commandArgs = [
            "-c",
            `core.fsmonitor=${options.fsmonitor === "builtin" ? "true" : "false"}`,
            "-c",
            `core.hooksPath=${securePaths.hooks}`,
            "-c",
            "core.autocrlf=false",
            ...(options.gitDir == null ? [] : [`--git-dir=${options.gitDir}`]),
            ...(options.workTree == null ? [] : [`--work-tree=${options.workTree}`]),
            ...args,
        ];
        const env = makeIsolatedEnv(
            options.gitDir == null,
            securePaths.globalConfig,
            !checkIgnoreStdin && options.pathspecMode !== "literal-magic",
            options.indexFile,
            args[0] === "commit-tree"
        );
        let child;

        try {
            child = spawn(this.executable, commandArgs, {
                cwd: options.cwd,
                env,
                shell: false,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            });
        } catch (cause) {
            throw makeError("spawn_failed", Buffer.alloc(0), Buffer.alloc(0), undefined, cause);
        }

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let terminalError: WorkspaceGitRunnerError | undefined;

        const snapshot = (): GitRunResult => ({
            stdout: Buffer.concat(stdoutChunks, stdoutBytes),
            stderr: Buffer.concat(stderrChunks, stderrBytes),
        });
        const terminate = (code: WorkspaceGitRunnerErrorCode) => {
            if (terminalError) {
                return;
            }
            const output = snapshot();
            terminalError = makeError(code, output.stdout, output.stderr);
            child.kill("SIGKILL");
        };
        const onStdout = (chunk: Buffer | string) => {
            if (terminalError) {
                return;
            }
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (stdoutBytes + buffer.length > limits.maxStdoutBytes) {
                terminate("stdout_overflow");
                return;
            }
            stdoutChunks.push(buffer);
            stdoutBytes += buffer.length;
        };
        const onStderr = (chunk: Buffer | string) => {
            if (terminalError) {
                return;
            }
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (stderrBytes + buffer.length > limits.maxStderrBytes) {
                terminate("stderr_overflow");
                return;
            }
            stderrChunks.push(buffer);
            stderrBytes += buffer.length;
        };
        const onAbort = () => terminate("aborted");
        const onStdinError = (cause: NodeJS.ErrnoException) => {
            if (
                terminalError ||
                child.exitCode != null ||
                child.signalCode != null ||
                cause.code === "EPIPE" ||
                cause.code === "ERR_STREAM_DESTROYED"
            ) {
                return;
            }
            const output = snapshot();
            terminalError = makeError("spawn_failed", output.stdout, output.stderr, undefined, cause);
            child.kill("SIGKILL");
        };

        child.stdout.on("data", onStdout);
        child.stderr.on("data", onStderr);
        child.stdin.on("error", onStdinError);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) {
            onAbort();
        }
        const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);

        try {
            try {
                child.stdin.end(options.stdin);
            } catch (cause) {
                const output = snapshot();
                terminalError = makeError("spawn_failed", output.stdout, output.stderr, undefined, cause);
                child.kill("SIGKILL");
            }

            let exitCode: number | null;
            try {
                exitCode = await waitForChildProcess(child);
            } catch (cause) {
                if (terminalError) {
                    throw terminalError;
                }
                const output = snapshot();
                throw makeError("spawn_failed", output.stdout, output.stderr, undefined, cause);
            }

            if (terminalError) {
                throw terminalError;
            }
            const output = snapshot();
            if (exitCode !== 0) {
                throw makeError("nonzero_exit", output.stdout, output.stderr, exitCode);
            }
            return output;
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
            options.signal?.removeEventListener("abort", onAbort);
            child.stdout.removeListener("data", onStdout);
            child.stderr.removeListener("data", onStderr);
            child.stdin.removeListener("error", onStdinError);
        }
    }
}

function validateOptions(
    args: readonly string[],
    options: GitRunOptions
): Pick<Required<GitRunOptions>, "maxStdoutBytes" | "maxStderrBytes"> {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
        throw makeError("invalid_options");
    }
    if (!ApprovedGitSubcommands.has(args[0])) {
        throw makeError("invalid_options");
    }
    if (args[0] === "check-ignore" && !isCheckIgnoreStdin(args)) {
        throw makeError("invalid_options");
    }
    if (options == null || !isNonnegativeSafeInteger(options.timeoutMs) || options.timeoutMs > MaxTimeoutMs) {
        throw makeError("invalid_options");
    }
    if (options.cwd != null && typeof options.cwd !== "string") {
        throw makeError("invalid_options");
    }
    if (options.gitDir != null && (typeof options.gitDir !== "string" || !isAbsolute(options.gitDir))) {
        throw makeError("invalid_options");
    }
    if (options.workTree != null && (typeof options.workTree !== "string" || !isAbsolute(options.workTree))) {
        throw makeError("invalid_options");
    }
    if (options.indexFile != null && (typeof options.indexFile !== "string" || !isAbsolute(options.indexFile))) {
        throw makeError("invalid_options");
    }
    if (options.fsmonitor != null && options.fsmonitor !== "builtin") {
        throw makeError("invalid_options");
    }
    if (options.stdin != null && !Buffer.isBuffer(options.stdin)) {
        throw makeError("invalid_options");
    }
    if (options.pathspecMode != null && (options.pathspecMode !== "literal-magic" || args[0] !== "ls-tree")) {
        throw makeError("invalid_options");
    }
    if (isCheckIgnoreStdin(args) && !isValidNulDelimitedPaths(options.stdin)) {
        throw makeError("invalid_options");
    }
    if (!isSafeApprovedInvocation(args, options)) {
        throw makeError("invalid_options");
    }

    const maxStdoutBytes = options.maxStdoutBytes ?? WorkspaceGitRunnerLimits.maxStdoutBytes;
    const maxStderrBytes = options.maxStderrBytes ?? WorkspaceGitRunnerLimits.maxStderrBytes;
    if (
        !isValidLimit(maxStdoutBytes, WorkspaceGitRunnerLimits.maxStdoutBytes) ||
        !isValidLimit(maxStderrBytes, WorkspaceGitRunnerLimits.maxStderrBytes)
    ) {
        throw makeError("invalid_options");
    }
    return { maxStdoutBytes, maxStderrBytes };
}

function isNonnegativeSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

function validateObjectClosureImportOptions(options: GitObjectClosureImportOptions): void {
    if (
        !options ||
        !isAbsolute(options.sourceRoot) ||
        !isAbsolute(options.destinationGitDir) ||
        !isSha1(options.sourceTree) ||
        !Number.isSafeInteger(options.maxPackBytes) ||
        options.maxPackBytes <= 0 ||
        !Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs <= 0 ||
        options.timeoutMs > MaxTimeoutMs
    ) {
        throw makeError("invalid_options");
    }
}

function makeBoundedCapture(limit: number): { push(chunk: Buffer): boolean; bytes(): Buffer } {
    const chunks: Buffer[] = [];
    let length = 0;
    return {
        push(chunk) {
            if (length + chunk.length > limit) return false;
            chunks.push(chunk);
            length += chunk.length;
            return true;
        },
        bytes() {
            return Buffer.concat(chunks, length);
        },
    };
}

function isValidLimit(value: number, hardCap: number): boolean {
    return isNonnegativeSafeInteger(value) && value <= hardCap;
}

function isCheckIgnoreStdin(args: readonly string[]): boolean {
    return args.length === 3 && args[0] === "check-ignore" && args[1] === "-z" && args[2] === "--stdin";
}

function isValidNulDelimitedPaths(value: Buffer | undefined): boolean {
    if (!value || value.length === 0 || value.at(-1) !== 0) return false;
    let previous = -1;
    for (let index = 0; index < value.length; index++) {
        if (value[index] !== 0) continue;
        if (index === previous + 1) return false;
        previous = index;
    }
    return true;
}

function isSafeApprovedInvocation(args: readonly string[], options: GitRunOptions): boolean {
    const commandArgs = args.slice(1);
    switch (args[0]) {
        case "commit-tree":
            return isSafeCommitTreeArgs(commandArgs);
        case "write-tree":
            return commandArgs.length === 0 && options.indexFile != null;
        case "read-tree":
            return isSafeReadTreeArgs(commandArgs, options.indexFile);
        case "update-index":
            return isSafeUpdateIndexArgs(commandArgs, options.indexFile, options.stdin);
        case "ls-tree":
            return isSafeLsTreeArgs(commandArgs, options.pathspecMode);
        case "status":
            return isSafeStatusArgs(commandArgs, options);
        case "log":
            return isSafeLogArgs(commandArgs);
        default:
            return true;
    }
}

function isSafeCommitTreeArgs(args: readonly string[]): boolean {
    if (!isSha1(args[0])) return false;
    return args.length === 1 || (args.length === 3 && args[1] === "-p" && isSha1(args[2]));
}

function isSafeReadTreeArgs(args: readonly string[], indexFile?: string): boolean {
    return indexFile != null && args.length === 1 && (args[0] === "--empty" || isSha1(args[0]));
}

function isSafeUpdateIndexArgs(args: readonly string[], indexFile?: string, stdin?: Buffer): boolean {
    if (indexFile == null || !Buffer.isBuffer(stdin)) return false;
    return (
        (args.length === 1 && args[0] === "--index-info") ||
        (args.length === 2 && args.includes("-z") && args.includes("--index-info"))
    );
}

function isSafeLsTreeArgs(args: readonly string[], pathspecMode?: GitRunOptions["pathspecMode"]): boolean {
    const safeOptions = new Set([
        "-r",
        "-d",
        "-t",
        "-l",
        "--long",
        "-z",
        "--name-only",
        "--name-status",
        "--object-only",
        "--full-name",
        "--full-tree",
        "--abbrev",
    ]);
    let sawTree = false;
    let paths = false;
    for (const arg of args) {
        if (paths) {
            if (
                pathspecMode === "literal-magic"
                    ? !arg.startsWith(":(literal)") || !isSafeLiteralArgument(arg.slice(10))
                    : !isSafeLiteralArgument(arg)
            ) {
                return false;
            }
            continue;
        }
        if (arg === "--") {
            if (!sawTree) return false;
            paths = true;
            continue;
        }
        if (!sawTree && (safeOptions.has(arg) || /^--abbrev=\d+$/.test(arg) || arg.startsWith("--format="))) {
            continue;
        }
        if (!sawTree && !arg.startsWith("-") && isSafeLiteralArgument(arg)) {
            sawTree = true;
            continue;
        }
        return false;
    }
    return sawTree && (pathspecMode !== "literal-magic" || paths);
}

function isSafeStatusArgs(args: readonly string[], options: GitRunOptions): boolean {
    if ((options.gitDir != null || options.workTree != null) && options.indexFile == null) return false;
    const safeOptions = new Set([
        "--porcelain",
        "--short",
        "-s",
        "--branch",
        "-b",
        "--show-stash",
        "--ahead-behind",
        "--no-ahead-behind",
        "-z",
        "--null",
        "--untracked-files",
        "-uno",
        "-unormal",
        "-uall",
        "--ignored",
        "--ignore-submodules",
        "--renames",
        "--no-renames",
    ]);
    let paths = false;
    for (const arg of args) {
        if (paths) {
            if (!isSafeLiteralArgument(arg)) return false;
            continue;
        }
        if (arg === "--") {
            paths = true;
            continue;
        }
        if (
            safeOptions.has(arg) ||
            /^--porcelain=(?:v1|v2)$/.test(arg) ||
            /^--untracked-files=(?:no|normal|all)$/.test(arg) ||
            /^--ignored=(?:traditional|matching|no)$/.test(arg) ||
            /^--ignore-submodules=(?:none|untracked|dirty|all)$/.test(arg) ||
            /^--find-renames(?:=\d+%?)?$/.test(arg)
        ) {
            continue;
        }
        return false;
    }
    return true;
}

function isSafeLogArgs(args: readonly string[]): boolean {
    const safeOptions = new Set([
        "--format=%H",
        "--pretty=%H",
        "--no-decorate",
        "--first-parent",
        "--reverse",
        "--topo-order",
        "--date-order",
        "--author-date-order",
        "--ancestry-path",
        "--full-history",
        "--simplify-merges",
        "--no-walk",
        "--no-walk=sorted",
        "--no-walk=unsorted",
        "-z",
    ]);
    let paths = false;
    let countValue = false;
    for (const arg of args) {
        if (countValue) {
            if (!/^\d+$/.test(arg)) return false;
            countValue = false;
            continue;
        }
        if (paths) {
            if (!isSafeLiteralArgument(arg)) return false;
            continue;
        }
        if (arg === "--") {
            paths = true;
            continue;
        }
        if (arg === "-n") {
            countValue = true;
            continue;
        }
        if (
            safeOptions.has(arg) ||
            /^--(?:max-count|skip)=\d+$/.test(arg) ||
            /^-n\d+$/.test(arg) ||
            /^--format=(?:format:|tformat:)?%H(?:%x00)?$/.test(arg)
        ) {
            continue;
        }
        if (!arg.startsWith("-") && isSafeLiteralArgument(arg)) continue;
        return false;
    }
    return !countValue;
}

function isSafeLiteralArgument(value: string): boolean {
    return value.length > 0 && !value.includes("\0");
}

function isSha1(value: string): boolean {
    return /^[0-9a-f]{40}$/.test(value);
}

function makeIsolatedEnv(
    discovery: boolean,
    globalConfigPath: string,
    literalPathspecs: boolean,
    indexFile: string | undefined,
    commitTree: boolean
): NodeJS.ProcessEnv {
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))
    );
    return {
        ...env,
        GIT_TERMINAL_PROMPT: "0",
        ...(literalPathspecs ? { GIT_LITERAL_PATHSPECS: "1" } : {}),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: globalConfigPath,
        GIT_ATTR_NOSYSTEM: "1",
        ...(indexFile == null ? {} : { GIT_INDEX_FILE: indexFile }),
        ...(commitTree ? InternalCommitIdentity : {}),
        ...(discovery ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
        LC_ALL: "C",
    };
}

function getSecureGitPaths(): SecureGitPaths {
    if (SecureGitState.paths) {
        return SecureGitState.paths;
    }

    const root = mkdtempSync(join(tmpdir(), "crest-workspace-git-runner-"));
    try {
        chmodSync(root, 0o700);
        const hooks = join(root, "hooks");
        mkdirSync(hooks, { mode: 0o700 });
        chmodSync(hooks, 0o700);
        const globalConfig = join(root, "global.gitconfig");
        const configFd = openSync(globalConfig, "wx", 0o600);
        closeSync(configFd);
        chmodSync(globalConfig, 0o600);
        SecureGitState.paths = { root, hooks, globalConfig };
        if (!SecureGitState.cleanupRegistered) {
            SecureGitState.cleanupRegistered = true;
            process.once("exit", cleanupSecureGitPaths);
        }
        return SecureGitState.paths;
    } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
    }
}

function cleanupSecureGitPaths(): void {
    if (!SecureGitState.paths) {
        return;
    }
    try {
        rmSync(SecureGitState.paths.root, { recursive: true, force: true });
        SecureGitState.paths = undefined;
    } catch {
        return;
    }
}

function getSecureGitProcessState(): SecureGitProcessState {
    const processGlobal = globalThis as typeof globalThis & {
        [SecureGitStateKey]?: SecureGitProcessState;
    };
    processGlobal[SecureGitStateKey] ??= { cleanupRegistered: false };
    return processGlobal[SecureGitStateKey];
}

function makeError(
    code: WorkspaceGitRunnerErrorCode,
    stdout: Buffer = Buffer.alloc(0),
    stderr: Buffer = Buffer.alloc(0),
    exitCode?: number | null,
    cause?: unknown
): WorkspaceGitRunnerError {
    return new WorkspaceGitRunnerError(code, `Workspace Git runner failed: ${code}`, stdout, stderr, exitCode, cause);
}
