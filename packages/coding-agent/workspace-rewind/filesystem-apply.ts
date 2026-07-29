// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { waitForChildProcess } from "../tools/_child-process";
import { WorkspaceCheckpointInternalLimits } from "./internal-limits";
import { classifyLivePath, inspectLivePath, type LiveCapturedPathState } from "./live-path-state";
import type { CapturedPathStateV1 } from "./types";

export interface WorkspacePathApplyProgress {
    operationId: string;
    createdParentDirectories: Set<string>;
    onParentDirectoryCreated?(path: string): Promise<void>;
    onPathReplaced(path: string): Promise<void>;
}

export type WorkspaceFilesystemApplyStep =
    | "exclusive-temp"
    | "write"
    | "chmod"
    | "file-fsync"
    | "quarantine-cas"
    | "exclusive-install"
    | "parent-fsync";

export type WorkspaceFilesystemApplyFault =
    | "before-install"
    | "file-fsync"
    | "parent-fsync"
    | "after-progress"
    | "malformed-stdout-after-progress";

export interface WorkspaceFilesystemApplyTestHooks {
    faultAt?: WorkspaceFilesystemApplyFault;
    onWorkerStep?(step: WorkspaceFilesystemApplyStep): Promise<void>;
    swapLeafAfterCheck?: Buffer;
    swapLeafBeforeValidation?: Buffer;
    rewriteLeafSameInodeAfterCheck?: Buffer;
    replaceAncestorWithSymlinkToSameInode?: boolean;
    pauseAfterQuarantineCas?: boolean;
    platform?: NodeJS.Platform;
    createLeafBeforeQuarantineRestore?: Buffer;
    caseInsensitiveExistingName?: string;
    createUnmanagedChildBeforeFailure?: boolean;
}

export interface WorkspaceApplyArtifactPaths {
    preparedFile: string;
    preparedSymlink: string;
    quarantine: string;
}

export class WorkspacePathApplyError extends Error {
    readonly pathSideEffect: boolean;
    readonly pathDurable: boolean;
    readonly createdParentDirectories: readonly string[];
    readonly retainedArtifacts: readonly string[];
    readonly artifactPaths: readonly string[];

    constructor(
        message: string,
        progress: {
            pathSideEffect?: boolean;
            pathDurable?: boolean;
            createdParentDirectories?: readonly string[];
            retainedArtifacts?: readonly string[];
            artifactPaths?: readonly string[];
        } = {},
        options?: { cause?: unknown }
    ) {
        super(message, options);
        this.name = "WorkspacePathApplyError";
        this.pathSideEffect = progress.pathSideEffect ?? false;
        this.pathDurable = progress.pathDurable ?? false;
        this.createdParentDirectories = [...(progress.createdParentDirectories ?? [])];
        this.retainedArtifacts = [...(progress.retainedArtifacts ?? [])];
        this.artifactPaths = [...(progress.artifactPaths ?? [])];
    }
}

type WorkspaceFilesystemPlatformSupport =
    | { supported: true }
    | { supported: false; code: "windows-reparse-unsupported" };

interface WorkerProgressState {
    pathSideEffect: boolean;
    pathDurable: boolean;
    createdParentDirectories: string[];
    retainedArtifacts: string[];
    artifactPaths: string[];
}

interface WorkerEventCreatedParent {
    type: "created-parent";
    path: string;
}

interface WorkerEventStep {
    type: "step";
    step: WorkspaceFilesystemApplyStep;
}

interface WorkerEventSideEffect {
    type: "side-effect";
}

interface WorkerEventPathDurable {
    type: "path-durable";
}

interface WorkerEventResult {
    type: "result";
}

interface WorkerEventError extends WorkerProgressState {
    type: "error";
    message: string;
}

type WorkerEvent =
    | WorkerEventCreatedParent
    | WorkerEventStep
    | WorkerEventSideEffect
    | WorkerEventPathDurable
    | WorkerEventResult
    | WorkerEventError;

const WorkerProtocolLimit = 1024 * 1024;

export function deriveWorkspaceApplyArtifactPaths(input: {
    operationId: string;
    path: string;
}): WorkspaceApplyArtifactPaths {
    validateOperationId(input.operationId);
    validateCanonicalRelativePath(input.path);
    const digest = createHash("sha256")
        .update("crest-workspace-apply-artifact-v1\0")
        .update(input.operationId)
        .update("\0")
        .update(input.path)
        .digest("hex")
        .slice(0, 40);
    const segments = input.path.split("/");
    segments.pop();
    const parent = segments.join("/");
    const artifact = (kind: string) => {
        const name = `.crest-rewind-v1-${kind}-${digest}`;
        return parent ? `${parent}/${name}` : name;
    };
    return {
        preparedFile: artifact("prepared-file"),
        preparedSymlink: artifact("prepared-symlink"),
        quarantine: artifact("quarantine"),
    };
}

export function workspaceFilesystemApplyPlatformSupport(
    platform: NodeJS.Platform = process.platform
): WorkspaceFilesystemPlatformSupport {
    if (platform === "win32") {
        return { supported: false, code: "windows-reparse-unsupported" };
    }
    return { supported: true };
}

export async function applyCapturedPath(input: {
    root: string;
    path: string;
    expectedCurrent: CapturedPathStateV1;
    target: CapturedPathStateV1;
    readBlob: (oid: string) => Promise<Buffer>;
    progress: WorkspacePathApplyProgress;
    testHooks?: WorkspaceFilesystemApplyTestHooks;
}): Promise<void> {
    if (input.testHooks && process.env.NODE_ENV !== "test") {
        throw new Error("Workspace filesystem apply test hooks are unavailable outside tests");
    }
    const target = input.target;
    if (target.state === "excluded") {
        throw new Error("Programming error: excluded workspace paths cannot be applied");
    }
    const expectedCurrent = input.expectedCurrent;
    if (expectedCurrent.state === "excluded") {
        throw new Error("Programming error: excluded workspace paths cannot be an apply precondition");
    }
    validateTargetState(target);
    validateTargetState(expectedCurrent);
    validateProgress(input.progress);
    const canonicalRoot = resolve(input.root);
    validateRelativePath(canonicalRoot, input.path);
    const artifactPaths = deriveWorkspaceApplyArtifactPaths({
        operationId: input.progress.operationId,
        path: input.path,
    });
    const artifactPathList = Object.values(artifactPaths);
    try {
        await applyCapturedPathOperational(
            { ...input, target, expectedCurrent },
            canonicalRoot,
            artifactPaths,
            artifactPathList
        );
    } catch (error) {
        throw withArtifactScope(error, artifactPathList);
    }
}

export async function recoverInterruptedCapturedPathArtifact(input: {
    root: string;
    path: string;
    expected: CapturedPathStateV1;
    operationId: string;
    onPathRecovered(): Promise<void>;
}): Promise<void> {
    if (input.expected.state === "excluded" || input.expected.state === "absent") {
        throw new Error("Interrupted workspace artifact requires a file or symlink pre-state");
    }
    validateTargetState(input.expected);
    validateOperationId(input.operationId);
    const canonicalRoot = resolve(input.root);
    validateRelativePath(canonicalRoot, input.path);
    const rootState = await lstat(canonicalRoot, { bigint: true });
    if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
        throw new WorkspacePathApplyError("Workspace root is not a stable directory");
    }
    const artifactPaths = deriveWorkspaceApplyArtifactPaths({
        operationId: input.operationId,
        path: input.path,
    });
    const progress: WorkerProgressState = {
        pathSideEffect: false,
        pathDurable: false,
        createdParentDirectories: [],
        retainedArtifacts: [],
        artifactPaths: Object.values(artifactPaths),
    };
    await runApplyWorker({
        root: canonicalRoot,
        rootIdentity: directoryIdentity(rootState),
        path: input.path,
        target: input.expected,
        expectedLive: { state: "absent" },
        operationId: input.operationId,
        artifactPaths,
        blob: Buffer.alloc(0),
        recoverQuarantine: true,
        progress,
        onCreatedParent: async () => {
            throw new Error("Interrupted artifact recovery cannot create parent directories");
        },
        onPathDurable: input.onPathRecovered,
    });
    await verifyCapturedPath({
        root: canonicalRoot,
        path: input.path,
        expected: input.expected,
    });
}

export async function reconcileInterruptedCapturedPathArtifacts(input: {
    root: string;
    path: string;
    live: Exclude<CapturedPathStateV1, { state: "excluded" }>;
    desired: Exclude<CapturedPathStateV1, { state: "excluded" }>;
    alternate: Exclude<CapturedPathStateV1, { state: "excluded" }>;
    operationId: string;
    onPathRecovered(): Promise<void>;
}): Promise<void> {
    validateTargetState(input.desired);
    validateTargetState(input.alternate);
    validateOperationId(input.operationId);
    const canonicalRoot = resolve(input.root);
    validateRelativePath(canonicalRoot, input.path);
    const rootState = await lstat(canonicalRoot, { bigint: true });
    if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
        throw new WorkspacePathApplyError("Workspace root is not a stable directory");
    }
    const artifactPaths = deriveWorkspaceApplyArtifactPaths({
        operationId: input.operationId,
        path: input.path,
    });
    const progress: WorkerProgressState = {
        pathSideEffect: false,
        pathDurable: false,
        createdParentDirectories: [],
        retainedArtifacts: [],
        artifactPaths: Object.values(artifactPaths),
    };
    await runApplyWorker({
        root: canonicalRoot,
        rootIdentity: directoryIdentity(rootState),
        path: input.path,
        target: input.desired,
        expectedLive: input.live,
        operationId: input.operationId,
        artifactPaths,
        artifactAlternateTarget: input.alternate,
        blob: Buffer.alloc(0),
        reconcileArtifacts: true,
        progress,
        onCreatedParent: async () => {
            throw new Error("Interrupted artifact reconciliation cannot create parent directories");
        },
        onPathDurable: input.onPathRecovered,
    });
}

async function applyCapturedPathOperational(
    input: {
        root: string;
        path: string;
        expectedCurrent: Exclude<CapturedPathStateV1, { state: "excluded" }>;
        target: Exclude<CapturedPathStateV1, { state: "excluded" }>;
        readBlob: (oid: string) => Promise<Buffer>;
        progress: WorkspacePathApplyProgress;
        testHooks?: WorkspaceFilesystemApplyTestHooks;
    },
    canonicalRoot: string,
    artifactPaths: WorkspaceApplyArtifactPaths,
    artifactPathList: string[]
): Promise<void> {
    const support = workspaceFilesystemApplyPlatformSupport(input.testHooks?.platform);
    if ("code" in support) {
        throw new WorkspacePathApplyError(`Workspace apply is blocked: ${support.code}`);
    }
    const inspectionPath = input.testHooks?.caseInsensitiveExistingName
        ? replaceLeaf(input.path, input.testHooks.caseInsensitiveExistingName)
        : input.path;
    validateRelativePath(canonicalRoot, inspectionPath);
    const live = await inspectLivePath(canonicalRoot, inspectionPath);
    assertPreflightAllowed(live, input.expectedCurrent, artifactPathList);
    const blob = input.target.state === "absent" ? Buffer.alloc(0) : await input.readBlob(input.target.oid);
    validateBlob(input.target, blob);
    const rootState = await lstat(canonicalRoot, { bigint: true });
    if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
        throw new WorkspacePathApplyError("Workspace root is not a stable directory", {
            artifactPaths: artifactPathList,
        });
    }
    const workerProgress: WorkerProgressState = {
        pathSideEffect: false,
        pathDurable: false,
        createdParentDirectories: [],
        retainedArtifacts: [],
        artifactPaths: artifactPathList,
    };
    try {
        await runApplyWorker({
            root: canonicalRoot,
            rootIdentity: directoryIdentity(rootState),
            path: input.path,
            target: input.target,
            expectedLive: input.expectedCurrent,
            operationId: input.progress.operationId,
            artifactPaths,
            blob,
            testHooks: input.testHooks,
            progress: workerProgress,
            onCreatedParent: async (path) => {
                input.progress.createdParentDirectories.add(path);
                await input.progress.onParentDirectoryCreated?.(path);
            },
            onStep: input.testHooks?.onWorkerStep,
            onPathDurable: async () => {
                await input.progress.onPathReplaced(input.path);
            },
        });
    } catch (error) {
        for (const path of workerProgress.createdParentDirectories) {
            input.progress.createdParentDirectories.add(path);
        }
        if (error instanceof WorkspacePathApplyError) {
            throw error;
        }
        throw new WorkspacePathApplyError(
            error instanceof Error ? error.message : "Workspace filesystem apply failed",
            workerProgress,
            { cause: error }
        );
    }
    try {
        await verifyCapturedPath({
            root: canonicalRoot,
            path: input.path,
            expected: input.target,
        });
    } catch (cause) {
        throw new WorkspacePathApplyError(
            cause instanceof Error ? cause.message : "Workspace path verification failed",
            workerProgress,
            { cause }
        );
    }
}

function withArtifactScope(error: unknown, artifactPaths: readonly string[]): WorkspacePathApplyError {
    if (
        error instanceof WorkspacePathApplyError &&
        error.artifactPaths.length === artifactPaths.length &&
        error.artifactPaths.every((path, index) => path === artifactPaths[index])
    ) {
        return error;
    }
    const progress =
        error instanceof WorkspacePathApplyError
            ? {
                  pathSideEffect: error.pathSideEffect,
                  pathDurable: error.pathDurable,
                  createdParentDirectories: error.createdParentDirectories,
                  retainedArtifacts: error.retainedArtifacts,
                  artifactPaths,
              }
            : { artifactPaths };
    return new WorkspacePathApplyError(
        error instanceof Error ? error.message : "Workspace filesystem apply failed",
        progress,
        { cause: error }
    );
}

export async function verifyCapturedPath(input: {
    root: string;
    path: string;
    expected: CapturedPathStateV1;
}): Promise<void> {
    if (input.expected.state === "excluded") {
        throw new Error("Programming error: excluded workspace paths cannot be verified");
    }
    validateTargetState(input.expected);
    const canonicalRoot = resolve(input.root);
    validateRelativePath(canonicalRoot, input.path);
    const live = await inspectLivePath(canonicalRoot, input.path);
    const classification = classifyLivePath({
        live,
        expected: input.expected,
        target: input.expected,
    });
    if (classification.conflict === "none") {
        return;
    }
    throw new WorkspacePathApplyError(`Workspace path verification failed for ${input.path}: ${classification.reason}`);
}

function validateProgress(progress: WorkspacePathApplyProgress): void {
    if (
        !progress ||
        !(progress.createdParentDirectories instanceof Set) ||
        typeof progress.onPathReplaced !== "function"
    ) {
        throw new Error("Workspace apply progress is invalid");
    }
    validateOperationId(progress.operationId);
}

function replaceLeaf(path: string, leaf: string): string {
    const segments = path.split("/");
    segments[segments.length - 1] = leaf;
    return segments.join("/");
}

function validateRelativePath(root: string, path: string): void {
    validateCanonicalRelativePath(path);
    const segments = path.split("/");
    const absolute = resolve(root, ...segments);
    const fromRoot = relative(root, absolute);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        throw new Error("Workspace path escapes the workspace root");
    }
}

function validateOperationId(operationId: string): void {
    if (typeof operationId !== "string" || operationId.length === 0 || operationId.length > 128) {
        throw new Error("Workspace apply progress operation id is invalid");
    }
}

function validateCanonicalRelativePath(path: string): void {
    if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
        throw new Error("Workspace path is not a canonical workspace-relative path");
    }
    if (path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error("Workspace path is not a canonical workspace-relative path");
    }
}

function assertPreflightAllowed(
    live: LiveCapturedPathState,
    expectedCurrent: Exclude<CapturedPathStateV1, { state: "excluded" }>,
    artifactPaths: readonly string[]
): void {
    const progress = { artifactPaths };
    if (live.state === "blocked") {
        throw new WorkspacePathApplyError(`Workspace path is blocked: ${live.reason}`, progress);
    }
    if (live.state === "unsafe") {
        throw new WorkspacePathApplyError(`Workspace path has unsafe live kind: ${live.kind}`, progress);
    }
    if (live.state === "directory") {
        throw new WorkspacePathApplyError("Workspace path has a file-directory collision", progress);
    }
    const classification = classifyLivePath({
        live,
        expected: expectedCurrent,
        target: expectedCurrent,
    });
    if (classification.conflict !== "none") {
        throw new WorkspacePathApplyError(
            `Workspace path changed from its caller-confirmed current state: ${classification.reason}`,
            progress
        );
    }
}

function validateBlob(target: Exclude<CapturedPathStateV1, { state: "excluded" }>, blob: Buffer): void {
    if (target.state === "absent") {
        return;
    }
    if (!Buffer.isBuffer(blob)) {
        throw new Error("Workspace object reader returned a non-buffer value");
    }
    if (blob.length > WorkspaceCheckpointInternalLimits.maxSingleFileBytes) {
        throw new Error("Workspace object exceeds the single-file apply limit");
    }
    const actual = createHash("sha1")
        .update(Buffer.from(`blob ${blob.length}\0`))
        .update(blob)
        .digest("hex");
    if (actual !== target.oid) {
        throw new Error(`Workspace object ${target.oid} failed integrity verification`);
    }
    if (target.state === "symlink" && blob.includes(0)) {
        throw new Error("Workspace symlink target contains a NUL byte");
    }
}

function validateTargetState(target: Exclude<CapturedPathStateV1, { state: "excluded" }>): void {
    if (target.state === "absent") {
        return;
    }
    if ((target.state !== "file" && target.state !== "symlink") || !/^[0-9a-f]{40}$/.test(target.oid)) {
        throw new Error("Workspace object id must be a 40-character Git SHA-1");
    }
    if (target.state === "file" && typeof target.executable !== "boolean") {
        throw new Error("Workspace captured file mode is invalid");
    }
}

function directoryIdentity(state: BigIntStats): Record<string, string> {
    return {
        dev: state.dev.toString(),
        ino: state.ino.toString(),
        birthtimeNs: state.birthtimeNs.toString(),
    };
}

async function runApplyWorker(input: {
    root: string;
    rootIdentity: Record<string, string>;
    path: string;
    target: Exclude<CapturedPathStateV1, { state: "excluded" }>;
    expectedLive: Exclude<CapturedPathStateV1, { state: "excluded" }>;
    operationId: string;
    artifactPaths: WorkspaceApplyArtifactPaths;
    blob: Buffer;
    testHooks?: WorkspaceFilesystemApplyTestHooks;
    progress: WorkerProgressState;
    onCreatedParent(path: string): Promise<void>;
    onStep?(step: WorkspaceFilesystemApplyStep): Promise<void>;
    onPathDurable(): Promise<void>;
    recoverQuarantine?: boolean;
    reconcileArtifacts?: boolean;
    artifactAlternateTarget?: Exclude<CapturedPathStateV1, { state: "excluded" }>;
}): Promise<void> {
    const serializedHooks = input.testHooks
        ? {
              faultAt: input.testHooks.faultAt,
              traceSteps: Boolean(input.testHooks.onWorkerStep),
              swapLeafAfterCheckBase64: input.testHooks.swapLeafAfterCheck?.toString("base64"),
              swapLeafBeforeValidationBase64: input.testHooks.swapLeafBeforeValidation?.toString("base64"),
              rewriteLeafSameInodeAfterCheckBase64: input.testHooks.rewriteLeafSameInodeAfterCheck?.toString("base64"),
              replaceAncestorWithSymlinkToSameInode: input.testHooks.replaceAncestorWithSymlinkToSameInode,
              pauseAfterQuarantineCas: input.testHooks.pauseAfterQuarantineCas,
              createLeafBeforeQuarantineRestoreBase64:
                  input.testHooks.createLeafBeforeQuarantineRestore?.toString("base64"),
              caseInsensitiveExistingName: input.testHooks.caseInsensitiveExistingName,
              createUnmanagedChildBeforeFailure: input.testHooks.createUnmanagedChildBeforeFailure,
          }
        : undefined;
    const header = Buffer.from(
        JSON.stringify({
            rootIdentity: input.rootIdentity,
            path: input.path,
            target: input.target,
            expectedLive: input.expectedLive,
            operationId: input.operationId,
            artifactPaths: input.artifactPaths,
            blobLength: input.blob.length,
            recoverQuarantine: input.recoverQuarantine ?? false,
            reconcileArtifacts: input.reconcileArtifacts ?? false,
            artifactAlternateTarget: input.artifactAlternateTarget,
            testHooks: serializedHooks,
        })
    );
    if (header.length > WorkerProtocolLimit) {
        throw new WorkspacePathApplyError("Workspace filesystem worker input exceeded its limit");
    }
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32BE(header.length, 0);
    prefix.writeUInt32BE(input.blob.length, 4);
    const child = spawn(process.execPath, ["-e", ApplyWorkerSource], {
        cwd: input.root,
        env: {
            ELECTRON_RUN_AS_NODE: "1",
            LC_ALL: "C",
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let stdoutBytes = 0;
    let stdoutBuffer = Buffer.alloc(0);
    let protocolError: Error | undefined;
    let workerError: WorkerEventError | undefined;
    let sawResult = false;
    let eventChain = Promise.resolve();
    const enqueueEvent = (line: Buffer) => {
        eventChain = eventChain.then(async () => {
            const event = parseWorkerEvent(line);
            if (event.type === "created-parent") {
                input.progress.createdParentDirectories.push(event.path);
                await input.onCreatedParent(event.path);
                return;
            }
            if (event.type === "step") {
                await input.onStep?.(event.step);
                return;
            }
            if (event.type === "side-effect") {
                input.progress.pathSideEffect = true;
                return;
            }
            if (event.type === "path-durable") {
                input.progress.pathSideEffect = true;
                input.progress.pathDurable = true;
                await input.onPathDurable();
                return;
            }
            if (event.type === "error") {
                workerError = event;
                mergeWorkerProgress(input.progress, event);
                return;
            }
            sawResult = true;
        });
        eventChain.catch((error) => {
            protocolError ??= error instanceof Error ? error : new Error("Workspace worker event handling failed");
            child.kill("SIGKILL");
        });
    };
    child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > WorkerProtocolLimit) {
            protocolError ??= new Error("Workspace filesystem worker output exceeded its limit");
            child.kill("SIGKILL");
            return;
        }
        stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
        let newline;
        while ((newline = stdoutBuffer.indexOf(0x0a)) >= 0) {
            const line = stdoutBuffer.subarray(0, newline);
            stdoutBuffer = stdoutBuffer.subarray(newline + 1);
            enqueueEvent(line);
        }
    });
    child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= WorkerProtocolLimit) {
            stderr.push(chunk);
        }
    });
    child.stdin.on("error", () => {});
    child.stdin.write(prefix);
    child.stdin.write(header);
    child.stdin.end(input.blob);
    const exitCode = await waitForChildProcess(child);
    if (stdoutBuffer.length > 0) {
        protocolError ??= new Error("Workspace filesystem worker returned a truncated event");
    }
    try {
        await eventChain;
    } catch (error) {
        protocolError ??= error instanceof Error ? error : new Error("Workspace worker event handling failed");
    }
    if (protocolError) {
        throw new WorkspacePathApplyError(protocolError.message, input.progress, { cause: protocolError });
    }
    if (workerError) {
        throw new WorkspacePathApplyError(workerError.message, input.progress);
    }
    if (exitCode !== 0) {
        const diagnostic = Buffer.concat(stderr, Math.min(stderrBytes, WorkerProtocolLimit)).toString("utf8");
        throw new WorkspacePathApplyError(
            diagnostic || `Workspace filesystem worker exited ${exitCode}`,
            input.progress
        );
    }
    if (!sawResult) {
        throw new WorkspacePathApplyError("Workspace filesystem worker did not return a result", input.progress);
    }
}

function mergeWorkerProgress(target: WorkerProgressState, source: WorkerProgressState): void {
    target.pathSideEffect ||= source.pathSideEffect;
    target.pathDurable ||= source.pathDurable;
    for (const path of source.createdParentDirectories) {
        if (!target.createdParentDirectories.includes(path)) {
            target.createdParentDirectories.push(path);
        }
    }
    target.retainedArtifacts = [...source.retainedArtifacts];
    target.artifactPaths = [...source.artifactPaths];
}

function parseWorkerEvent(line: Buffer): WorkerEvent {
    if (line.length === 0 || line.length > WorkerProtocolLimit) {
        throw new Error("Workspace filesystem worker returned an invalid event");
    }
    let value: unknown;
    try {
        value = JSON.parse(line.toString("utf8"));
    } catch (cause) {
        throw new Error("Workspace filesystem worker returned malformed progress", { cause });
    }
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Workspace filesystem worker returned an invalid event");
    }
    const event = value as Record<string, unknown>;
    if (event.type === "created-parent" && typeof event.path === "string") {
        return { type: "created-parent", path: event.path };
    }
    if (
        event.type === "step" &&
        [
            "exclusive-temp",
            "write",
            "chmod",
            "file-fsync",
            "quarantine-cas",
            "exclusive-install",
            "parent-fsync",
        ].includes(event.step as string)
    ) {
        return { type: "step", step: event.step as WorkspaceFilesystemApplyStep };
    }
    if (event.type === "side-effect" || event.type === "path-durable" || event.type === "result") {
        return { type: event.type };
    }
    if (
        event.type === "error" &&
        typeof event.message === "string" &&
        typeof event.pathSideEffect === "boolean" &&
        typeof event.pathDurable === "boolean" &&
        Array.isArray(event.createdParentDirectories) &&
        event.createdParentDirectories.every((path) => typeof path === "string") &&
        Array.isArray(event.retainedArtifacts) &&
        event.retainedArtifacts.every((path) => typeof path === "string") &&
        Array.isArray(event.artifactPaths) &&
        event.artifactPaths.every((path) => typeof path === "string")
    ) {
        return event as unknown as WorkerEventError;
    }
    throw new Error("Workspace filesystem worker returned an invalid event");
}

const ApplyWorkerSource = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const chunks = [];
let inputBytes = 0;
const operation = {
    pathSideEffect: false,
    pathDurable: false,
    createdParentDirectories: [],
    retainedArtifacts: [],
    artifactPaths: []
};

process.stdin.on("data", (chunk) => {
    inputBytes += chunk.length;
    if (inputBytes > ${WorkspaceCheckpointInternalLimits.maxSingleFileBytes + WorkerProtocolLimit + 8}) {
        process.stderr.write("filesystem worker input exceeded its limit");
        process.exit(2);
    }
    chunks.push(chunk);
});
process.stdin.on("end", () => {
    main(Buffer.concat(chunks, inputBytes)).then(
        () => emit({ type: "result" }),
        (error) => {
            emit({
                type: "error",
                message: String(error && error.message ? error.message : error),
                ...operation
            });
            process.exitCode = 1;
        }
    );
});

function emit(value) {
    process.stdout.write(JSON.stringify(value) + "\n");
}

function identity(stat) {
    return {
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        birthtimeNs: stat.birthtimeNs.toString()
    };
}

function sameIdentity(stat, expected) {
    const actual = identity(stat);
    return Object.keys(expected).every((key) => actual[key] === expected[key]);
}

function entryIdentity(stat) {
    return {
        ...identity(stat),
        mode: stat.mode.toString(),
        nlink: stat.nlink.toString(),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString()
    };
}

function sameEntry(stat, expected) {
    const actual = entryIdentity(stat);
    return Object.keys(expected).every((key) => actual[key] === expected[key]);
}

function sameQuarantinedEntry(stat, expected) {
    const actual = entryIdentity(stat);
    return ["dev", "ino", "birthtimeNs", "mode", "nlink", "size", "mtimeNs"]
        .every((key) => actual[key] === expected[key]);
}

async function lstatOptional(name) {
    try {
        return await fsp.lstat(name, { bigint: true });
    } catch (error) {
        if (error && error.code === "ENOENT") return undefined;
        throw error;
    }
}

function tempName(operationId, suffix) {
    const safeOperation = operationId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "operation";
    return ".crest-rewind-" + safeOperation + "-" + crypto.randomBytes(12).toString("hex") + suffix;
}

function validateInput(packet) {
    if (packet.length < 8) throw new Error("invalid filesystem worker packet");
    const headerLength = packet.readUInt32BE(0);
    const blobLength = packet.readUInt32BE(4);
    if (headerLength > ${WorkerProtocolLimit} || blobLength > ${WorkspaceCheckpointInternalLimits.maxSingleFileBytes} ||
        packet.length !== 8 + headerLength + blobLength) {
        throw new Error("invalid filesystem worker packet lengths");
    }
    const header = JSON.parse(packet.subarray(8, 8 + headerLength).toString("utf8"));
    const blob = packet.subarray(8 + headerLength);
    if (!header || typeof header !== "object" || typeof header.path !== "string" ||
        typeof header.operationId !== "string" || header.operationId.length > 128 ||
        header.blobLength !== blob.length || !header.rootIdentity || !header.target || !header.expectedLive ||
        typeof header.recoverQuarantine !== "boolean" || typeof header.reconcileArtifacts !== "boolean" ||
        !header.artifactPaths || typeof header.artifactPaths.preparedFile !== "string" ||
        typeof header.artifactPaths.preparedSymlink !== "string" ||
        typeof header.artifactPaths.quarantine !== "string") {
        throw new Error("invalid filesystem worker input");
    }
    const segments = header.path.split("/");
    if (!header.path || header.path.includes("\0") || header.path.includes("\\") ||
        header.path.startsWith("/") || /^[A-Za-z]:/.test(header.path) ||
        segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error("invalid workspace-relative path");
    }
    if (!["absent", "file", "symlink"].includes(header.target.state)) {
        throw new Error("invalid captured target state");
    }
    return { ...header, segments, blob, testHooks: header.testHooks || {} };
}

async function main(packet) {
    const input = validateInput(packet);
    operation.artifactPaths = Object.values(input.artifactPaths);
    const root = await fsp.lstat(".", { bigint: true });
    if (!root.isDirectory() || !sameIdentity(root, input.rootIdentity)) {
        throw new Error("workspace root identity changed");
    }
    const directoryStack = [{ name: "", identity: identity(root), created: false, path: "" }];
    let parentRelativePath = "";
    let temporary;
    let quarantine;
    let quarantineDirectory;
    let quarantineIdentity;
    let quarantineOwned = false;
    let originalName;
    let installed = false;
    try {
        for (const segment of input.segments.slice(0, -1)) {
            const existing = await lstatOptional(segment);
            let created = false;
            let before = existing;
            if (!before) {
                if (input.expectedLive.state !== "absent") {
                    throw new Error("workspace path disappeared before apply");
                }
                if (input.target.state === "absent") return;
                await fsp.mkdir(segment, { mode: 0o700 });
                before = await fsp.lstat(segment, { bigint: true });
                created = true;
                const parentPath = directoryStack.at(-1).path;
                const relativePath = parentPath ? parentPath + "/" + segment : segment;
                operation.createdParentDirectories.push(relativePath);
                emit({ type: "created-parent", path: relativePath });
                await syncCurrentDirectory();
            }
            if (!before.isDirectory() || before.isSymbolicLink()) {
                throw new Error("workspace path ancestor is not a no-follow directory");
            }
            const expected = identity(before);
            process.chdir(segment);
            const anchored = await fsp.lstat(".", { bigint: true });
            if (!anchored.isDirectory() || !sameIdentity(anchored, expected)) {
                throw new Error("workspace path ancestor identity changed");
            }
            const anchoredParent = await fsp.lstat("..", { bigint: true });
            const expectedParent = directoryStack.at(-1).identity;
            const namedFromParent = await fsp.lstat("../" + segment, { bigint: true });
            if (!anchoredParent.isDirectory() || !sameIdentity(anchoredParent, expectedParent) ||
                !namedFromParent.isDirectory() || namedFromParent.isSymbolicLink() ||
                !sameIdentity(namedFromParent, expected)) {
                throw new Error("workspace path ancestor anchor changed");
            }
            const parentPath = directoryStack.at(-1).path;
            const relativePath = parentPath ? parentPath + "/" + segment : segment;
            directoryStack.push({ name: segment, identity: expected, created, path: relativePath });
        }
        parentRelativePath = directoryStack.at(-1).path;
        await verifyAnchorChain(directoryStack);

        const leaf = input.segments.at(-1);
        originalName = input.testHooks.caseInsensitiveExistingName || leaf;
        if (!originalName || originalName === "." || originalName === ".." || /[\/\\\0]/.test(originalName)) {
            throw new Error("invalid case-insensitive test leaf");
        }
        if (input.testHooks.swapLeafBeforeValidationBase64) {
            await replaceLeafForTest(
                originalName,
                input.operationId,
                input.testHooks.swapLeafBeforeValidationBase64
            );
        }
        const initial = await lstatOptional(originalName);
        if (input.reconcileArtifacts) {
            await reconcileArtifacts(input, originalName, initial);
            return;
        }
        validateLeaf(initial);
        await verifyExpectedLive(initial, originalName, input.expectedLive);
        const initialIdentity = initial ? entryIdentity(initial) : undefined;

        if (input.recoverQuarantine) {
            if (initial) throw new Error("workspace leaf was recreated before artifact recovery");
            quarantineDirectory = artifactLeaf(input.artifactPaths.quarantine);
            quarantine = quarantineDirectory + "/entry";
            const quarantineParent = await fsp.lstat(quarantineDirectory, { bigint: true });
            if (!quarantineParent.isDirectory() || quarantineParent.isSymbolicLink()) {
                throw new Error("workspace quarantine artifact is unsafe");
            }
            const displaced = await fsp.lstat(quarantine, { bigint: true });
            validateLeaf(displaced);
            quarantineIdentity = entryIdentity(displaced);
            await verifyExpectedLive(displaced, quarantine, input.target);
            const restored = await restoreQuarantine(
                quarantine,
                quarantineDirectory,
                originalName,
                quarantineIdentity
            );
            if (!restored) throw new Error("workspace quarantine artifact could not be restored");
            quarantine = undefined;
            quarantineDirectory = undefined;
            await verifyAnchorChain(directoryStack);
            await syncCurrentDirectory();
            operation.pathSideEffect = true;
            operation.pathDurable = true;
            emit({ type: "side-effect" });
            emit({ type: "path-durable" });
            return;
        }

        if (input.testHooks.swapLeafAfterCheckBase64) {
            await replaceLeafForTest(originalName, input.operationId, input.testHooks.swapLeafAfterCheckBase64);
        }
        if (input.testHooks.rewriteLeafSameInodeAfterCheckBase64) {
            await rewriteLeafSameInodeForTest(
                originalName,
                initial,
                input.testHooks.rewriteLeafSameInodeAfterCheckBase64
            );
        }
        if (input.testHooks.replaceAncestorWithSymlinkToSameInode) {
            await replaceAncestorWithSymlinkToSameInodeForTest(directoryStack);
        }
        await verifyAnchorChain(directoryStack);
        if (input.target.state === "absent" && !initial && !input.testHooks.swapLeafAfterCheckBase64) {
            return;
        }

        if (input.target.state === "file") {
            temporary = await prepareFile(input, artifactLeaf(input.artifactPaths.preparedFile));
        } else if (input.target.state === "symlink") {
            temporary = await prepareSymlink(input, artifactLeaf(input.artifactPaths.preparedSymlink));
        }

        if (initial) {
            quarantineDirectory = artifactLeaf(input.artifactPaths.quarantine);
            await fsp.mkdir(quarantineDirectory, { mode: 0o700 });
            quarantineOwned = true;
            quarantine = quarantineDirectory + "/entry";
            await fsp.rename(originalName, quarantine);
            operation.pathSideEffect = true;
            emit({ type: "side-effect" });
            const displaced = await fsp.lstat(quarantine, { bigint: true });
            quarantineIdentity = entryIdentity(displaced);
            let quarantineMatches = sameQuarantinedEntry(displaced, initialIdentity);
            try {
                await verifyExpectedLive(displaced, quarantine, input.expectedLive);
            } catch {
                quarantineMatches = false;
            }
            if (!quarantineMatches) {
                if (input.testHooks.createLeafBeforeQuarantineRestoreBase64) {
                    await fsp.writeFile(
                        originalName,
                        Buffer.from(input.testHooks.createLeafBeforeQuarantineRestoreBase64, "base64"),
                        { flag: "wx", mode: 0o600 }
                    );
                    await syncCurrentDirectory();
                }
                const restored = await restoreQuarantine(
                    quarantine,
                    quarantineDirectory,
                    originalName,
                    quarantineIdentity
                );
                if (restored) {
                    quarantine = undefined;
                    quarantineDirectory = undefined;
                    quarantineOwned = false;
                }
                throw new Error("workspace leaf changed during CAS quarantine");
            }
            step(input, "quarantine-cas");
            if (input.testHooks.pauseAfterQuarantineCas) {
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        }

        if (input.testHooks.createUnmanagedChildBeforeFailure) {
            await fsp.writeFile("unmanaged", "external", { flag: "wx" });
        }
        fault(input, "before-install");

        if (input.target.state === "absent") {
            const unexpected = await lstatOptional(leaf);
            if (unexpected) {
                throw new Error("workspace leaf was recreated during deletion");
            }
            if (quarantine) {
                await verifyQuarantine(quarantine, quarantineIdentity, input.expectedLive);
                await fsp.unlink(quarantine);
                quarantine = undefined;
                await fsp.rmdir(quarantineDirectory);
                quarantineDirectory = undefined;
                quarantineOwned = false;
                operation.pathSideEffect = true;
                emit({ type: "side-effect" });
            }
        } else {
            const prepared = await lstatOptional(temporary.path);
            if (!prepared || !sameEntry(prepared, temporary.identity)) {
                throw new Error("workspace temporary identity changed");
            }
            await verifyExpectedLive(prepared, temporary.path, input.target);
            if (input.target.state === "symlink") {
                const symlinkBytes = await fsp.readlink(temporary.path, { encoding: "buffer" });
                await fsp.symlink(symlinkBytes, leaf);
            } else {
                await fsp.link(temporary.path, leaf);
            }
            await fsp.unlink(temporary.path);
            temporary = undefined;
            installed = true;
            operation.pathSideEffect = true;
            emit({ type: "side-effect" });
            step(input, "exclusive-install");
            if (quarantine) {
                await verifyQuarantine(quarantine, quarantineIdentity, input.expectedLive);
                await fsp.unlink(quarantine);
                quarantine = undefined;
                await fsp.rmdir(quarantineDirectory);
                quarantineDirectory = undefined;
                quarantineOwned = false;
            }
        }

        fault(input, "parent-fsync");
        await syncCurrentDirectory();
        step(input, "parent-fsync");
        operation.pathDurable = true;
        emit({ type: "path-durable" });
        fault(input, "after-progress");
        if (input.testHooks.faultAt === "malformed-stdout-after-progress") {
            process.stdout.write("{malformed\n");
        }
    } catch (error) {
        if (!installed && quarantine && quarantineIdentity && originalName) {
            const restored = await restoreQuarantine(
                quarantine,
                quarantineDirectory,
                originalName,
                quarantineIdentity
            );
            if (restored) {
                quarantine = undefined;
                quarantineDirectory = undefined;
                quarantineOwned = false;
            }
        }
        if (temporary) {
            const currentTemporary = await lstatOptional(temporary.path);
            if (currentTemporary && sameEntry(currentTemporary, temporary.identity)) {
                await fsp.unlink(temporary.path);
            } else if (currentTemporary) {
                operation.retainedArtifacts.push(joinRelative(parentRelativePath, temporary.path));
            }
            temporary = undefined;
        }
        if (quarantineOwned && quarantineDirectory && (!quarantine || !(await lstatOptional(quarantine)))) {
            await fsp.rmdir(quarantineDirectory).catch((cleanupError) => {
                if (!cleanupError || !["ENOENT", "ENOTEMPTY"].includes(cleanupError.code)) throw cleanupError;
            });
        }
        if (quarantineOwned && quarantineDirectory && await lstatOptional(quarantineDirectory)) {
            operation.retainedArtifacts.push(joinRelative(parentRelativePath, quarantineDirectory));
        }
        await rollbackCreatedDirectories(directoryStack);
        throw error;
    }
}

function validateLeaf(stat) {
    if (!stat) return;
    if (stat.isSymbolicLink()) return;
    if (stat.isFile() && stat.nlink === 1n) return;
    if (stat.isDirectory()) throw new Error("workspace path has a file-directory collision");
    if (stat.isFile()) throw new Error("hard-linked workspace file is unsafe to replace");
    throw new Error("workspace path has an unsafe live kind");
}

async function replaceLeafForTest(name, operationId, bytesBase64) {
    const swap = tempName(operationId, "-swap");
    await fsp.writeFile(swap, Buffer.from(bytesBase64, "base64"), {
        flag: "wx",
        mode: 0o600
    });
    await fsp.rename(swap, name);
    await syncCurrentDirectory();
}

async function rewriteLeafSameInodeForTest(name, initial, bytesBase64) {
    if (!initial || !initial.isFile()) throw new Error("same-inode rewrite requires an existing file");
    const bytes = Buffer.from(bytesBase64, "base64");
    if (BigInt(bytes.length) !== initial.size) throw new Error("same-inode rewrite must preserve file length");
    const handle = await fsp.open(name, "r+");
    try {
        await handle.write(bytes, 0, bytes.length, 0);
        await handle.sync();
    } finally {
        await handle.close();
    }
    await fsp.utimes(name, Number(initial.atimeNs) / 1e9, Number(initial.mtimeNs) / 1e9);
}

async function replaceAncestorWithSymlinkToSameInodeForTest(stack) {
    if (stack.length < 2) throw new Error("ancestor replacement requires a nested path");
    const current = stack.at(-1);
    const heldName = "held-" + current.name;
    await fsp.rename("../" + current.name, "../" + heldName);
    await fsp.symlink(heldName, "../" + current.name);
    const parent = await fsp.open("..", fs.constants.O_RDONLY);
    try {
        await parent.sync();
    } finally {
        await parent.close();
    }
}

async function verifyAnchorChain(stack) {
    const deepest = stack.length - 1;
    for (let index = deepest; index > 0; index--) {
        const ascents = deepest - index;
        const currentPath = ascents === 0 ? "." : Array(ascents).fill("..").join("/");
        const parentPath = currentPath + "/..";
        const namedPath = parentPath + "/" + stack[index].name;
        const current = await fsp.lstat(currentPath, { bigint: true });
        const parent = await fsp.lstat(parentPath, { bigint: true });
        const named = await fsp.lstat(namedPath, { bigint: true });
        if (!current.isDirectory() || !sameIdentity(current, stack[index].identity) ||
            !parent.isDirectory() || !sameIdentity(parent, stack[index - 1].identity) ||
            !named.isDirectory() || named.isSymbolicLink() ||
            !sameIdentity(named, stack[index].identity)) {
            throw new Error("workspace path ancestor anchor changed");
        }
    }
    const rootPath = deepest === 0 ? "." : Array(deepest).fill("..").join("/");
    const root = await fsp.lstat(rootPath, { bigint: true });
    if (!root.isDirectory() || !sameIdentity(root, stack[0].identity)) {
        throw new Error("workspace root anchor changed");
    }
}

async function verifyExpectedLive(stat, name, expected) {
    if (expected.state === "absent") {
        if (stat) throw new Error("workspace leaf changed after preflight");
        return;
    }
    if (!stat) throw new Error("workspace leaf disappeared after preflight");
    if (expected.state === "symlink") {
        if (!stat.isSymbolicLink()) throw new Error("workspace leaf kind changed after preflight");
        const bytes = await fsp.readlink(name, { encoding: "buffer" });
        const after = await fsp.lstat(name, { bigint: true });
        if (!sameEntry(after, entryIdentity(stat)) || gitBlobOid(bytes) !== expected.oid) {
            throw new Error("workspace symlink changed after preflight");
        }
        return;
    }
    if (!stat.isFile() || stat.nlink !== 1n) throw new Error("workspace file kind changed after preflight");
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    const handle = await fsp.open(name, flags);
    try {
        const opened = await handle.stat({ bigint: true });
        if (!sameEntry(opened, entryIdentity(stat))) throw new Error("workspace file changed after preflight");
        const bytes = await handle.readFile();
        const after = await handle.stat({ bigint: true });
        const leafAfter = await fsp.lstat(name, { bigint: true });
        if (!sameEntry(after, entryIdentity(stat)) || !sameEntry(leafAfter, entryIdentity(stat)) ||
            gitBlobOid(bytes) !== expected.oid || ((after.mode & 73n) !== 0n) !== expected.executable) {
            throw new Error("workspace file changed after preflight");
        }
    } finally {
        await handle.close();
    }
}

async function matchesExpectedLive(stat, name, expected) {
    try {
        await verifyExpectedLive(stat, name, expected);
        return true;
    } catch {
        return false;
    }
}

async function matchesArtifactExpected(stat, name, expected) {
    if (expected.state !== "file" || !stat || !stat.isFile()) {
        return matchesExpectedLive(stat, name, expected);
    }
    try {
        const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
        const handle = await fsp.open(name, flags);
        try {
            const opened = await handle.stat({ bigint: true });
            if (!sameEntry(opened, entryIdentity(stat))) return false;
            const bytes = await handle.readFile();
            const after = await handle.stat({ bigint: true });
            const named = await fsp.lstat(name, { bigint: true });
            return sameEntry(after, entryIdentity(stat)) &&
                sameEntry(named, entryIdentity(stat)) &&
                gitBlobOid(bytes) === expected.oid &&
                (((after.mode & 73n) !== 0n) === expected.executable);
        } finally {
            await handle.close();
        }
    } catch {
        return false;
    }
}

async function reconcileArtifacts(input, originalName, initial) {
    const desired = input.target;
    const alternate = input.artifactAlternateTarget;
    if (!alternate || !["absent", "file", "symlink"].includes(alternate.state)) {
        throw new Error("invalid interrupted artifact alternate state");
    }
    const preparedNames = [
        artifactLeaf(input.artifactPaths.preparedFile),
        artifactLeaf(input.artifactPaths.preparedSymlink),
    ];
    const prepared = [];
    for (const name of preparedNames) {
        const state = await lstatOptional(name);
        if (!state) continue;
        if (state.isDirectory() || (!state.isFile() && !state.isSymbolicLink())) {
            throw new Error("workspace prepared artifact has an unsafe kind");
        }
        if (state.isFile() && state.nlink !== 1n) {
            if (state.nlink !== 2n || !initial || !initial.isFile() || !sameIdentity(state, identity(initial))) {
                throw new Error("workspace prepared artifact has unsafe hard links");
            }
        }
        const desiredMatch = await matchesArtifactExpected(state, name, desired);
        const alternateMatch = await matchesArtifactExpected(state, name, alternate);
        if (!desiredMatch && !alternateMatch) {
            throw new Error("workspace prepared artifact is unknown");
        }
        prepared.push({ name, state, desiredMatch, alternateMatch });
    }
    if (prepared.length > 1) {
        throw new Error("multiple workspace prepared artifacts are ambiguous");
    }
    const quarantineDirectory = artifactLeaf(input.artifactPaths.quarantine);
    const quarantineState = await lstatOptional(quarantineDirectory);
    let quarantine;
    if (quarantineState) {
        if (!quarantineState.isDirectory() || quarantineState.isSymbolicLink()) {
            throw new Error("workspace quarantine artifact is unsafe");
        }
        const names = await fsp.readdir(quarantineDirectory);
        if (names.length !== 1 || names[0] !== "entry") {
            throw new Error("workspace quarantine artifact contains unknown entries");
        }
        const name = quarantineDirectory + "/entry";
        const state = await fsp.lstat(name, { bigint: true });
        validateLeaf(state);
        const desiredMatch = await matchesExpectedLive(state, name, desired);
        const alternateMatch = await matchesExpectedLive(state, name, alternate);
        if (!desiredMatch && !alternateMatch) {
            throw new Error("workspace quarantine artifact is unknown");
        }
        quarantine = { name, state, desiredMatch, alternateMatch };
    }
    if (initial && (initial.isDirectory() || (!initial.isFile() && !initial.isSymbolicLink()))) {
        throw new Error("workspace live path has an unsafe kind during artifact reconciliation");
    }
    if (initial?.isFile() && initial.nlink !== 1n) {
        const linkedPrepared = prepared.some(
            (item) => item.state.isFile() && sameIdentity(item.state, identity(initial))
        );
        if (initial.nlink !== 2n || !linkedPrepared) {
            throw new Error("hard-linked workspace file is unsafe to reconcile");
        }
    }
    if (!(await matchesArtifactExpected(initial, originalName, input.expectedLive))) {
        throw new Error("workspace live path changed before artifact reconciliation");
    }
    if (!quarantine && prepared.length === 0) {
        return;
    }
    const initialDesired = await matchesArtifactExpected(initial, originalName, desired);
    const initialAlternate = await matchesArtifactExpected(initial, originalName, alternate);
    if (quarantine && quarantine.desiredMatch) {
        if (initialDesired && initial) {
            throw new Error("workspace quarantine duplicates the desired live path");
        }
        if (initialAlternate && initial) {
            await fsp.unlink(originalName);
            await syncCurrentDirectory();
        } else if (!initialDesired && initial) {
            throw new Error("workspace live path conflicts with quarantine recovery");
        }
        if (!initial || initialAlternate) {
            await fsp.rename(quarantine.name, originalName);
            await fsp.rmdir(quarantineDirectory);
            await syncCurrentDirectory();
            operation.pathSideEffect = true;
            operation.pathDurable = true;
            emit({ type: "side-effect" });
            emit({ type: "path-durable" });
        }
    } else if (quarantine) {
        if (!initial || !initialDesired) {
            const desiredPrepared = prepared.find((item) => item.desiredMatch);
            if (desired.state === "absent") {
                if (initial) throw new Error("workspace live path conflicts with absent recovery");
            } else if (!initial && desiredPrepared) {
                if (desired.state === "file") {
                    await fsp.link(desiredPrepared.name, originalName);
                } else {
                    const bytes = await fsp.readlink(desiredPrepared.name, { encoding: "buffer" });
                    await fsp.symlink(bytes, originalName);
                }
                await fsp.unlink(desiredPrepared.name);
                await syncCurrentDirectory();
                operation.pathSideEffect = true;
                operation.pathDurable = true;
                emit({ type: "side-effect" });
                emit({ type: "path-durable" });
            } else {
                throw new Error("workspace rollback artifact is incomplete");
            }
        }
        await fsp.unlink(quarantine.name);
        await fsp.rmdir(quarantineDirectory);
        await syncCurrentDirectory();
    }
    if (!quarantine && !initialDesired && !initialAlternate) {
        const desiredPrepared = prepared.find((item) => item.desiredMatch);
        if (!initial && desiredPrepared && desired.state !== "absent" && alternate.state === "absent") {
            if (desired.state === "file") {
                await fsp.link(desiredPrepared.name, originalName);
            } else {
                const bytes = await fsp.readlink(desiredPrepared.name, { encoding: "buffer" });
                await fsp.symlink(bytes, originalName);
            }
            await fsp.unlink(desiredPrepared.name);
            await syncCurrentDirectory();
            operation.pathSideEffect = true;
            operation.pathDurable = true;
            emit({ type: "side-effect" });
            emit({ type: "path-durable" });
        } else if (!(initial === undefined && desired.state === "absent")) {
            throw new Error("workspace live path is unknown during artifact reconciliation");
        }
    }
    for (const item of prepared) {
        const remaining = await lstatOptional(item.name);
        if (remaining) {
            await fsp.unlink(item.name);
            await syncCurrentDirectory();
        }
    }
}

function gitBlobOid(bytes) {
    return crypto.createHash("sha1")
        .update(Buffer.from("blob " + bytes.length + "\0"))
        .update(bytes)
        .digest("hex");
}

async function prepareFile(input, temporary) {
    const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW;
    const handle = await fsp.open(temporary, flags, 0o600);
    step(input, "exclusive-temp");
    try {
        await handle.writeFile(input.blob);
        step(input, "write");
        await handle.chmod(input.target.executable ? 0o755 : 0o644);
        step(input, "chmod");
        fault(input, "file-fsync");
        await handle.sync();
        step(input, "file-fsync");
        const state = await fsp.lstat(temporary, { bigint: true });
        return { path: temporary, identity: entryIdentity(state) };
    } catch (error) {
        await handle.close();
        await fsp.unlink(temporary).catch(() => {});
        throw error;
    } finally {
        await handle.close().catch(() => {});
    }
}

async function prepareSymlink(input, temporary) {
    await fsp.symlink(input.blob, temporary);
    step(input, "exclusive-temp");
    const state = await fsp.lstat(temporary, { bigint: true });
    return { path: temporary, identity: entryIdentity(state) };
}

async function restoreQuarantine(quarantine, quarantineDirectory, originalName, expectedIdentity) {
    const current = await lstatOptional(quarantine);
    if (!current || !sameEntry(current, expectedIdentity)) return false;
    if (await lstatOptional(originalName)) return false;
    try {
        if (current.isSymbolicLink()) {
            const symlinkBytes = await fsp.readlink(quarantine, { encoding: "buffer" });
            await fsp.symlink(symlinkBytes, originalName);
        } else {
            await fsp.link(quarantine, originalName);
        }
    } catch (error) {
        if (error && error.code === "EEXIST") return false;
        throw error;
    }
    await fsp.unlink(quarantine);
    await fsp.rmdir(quarantineDirectory);
    await syncCurrentDirectory();
    return true;
}

async function verifyQuarantine(quarantine, expectedIdentity, expectedLive) {
    const current = await lstatOptional(quarantine);
    if (!current || !expectedIdentity || !sameEntry(current, expectedIdentity)) {
        throw new Error("workspace quarantine identity changed");
    }
    await verifyExpectedLive(current, quarantine, expectedLive);
}

function step(input, value) {
    if (input.testHooks.traceSteps) emit({ type: "step", step: value });
}

function fault(input, value) {
    if (input.testHooks.faultAt === value) {
        throw new Error("injected filesystem worker fault at " + value);
    }
}

function joinRelative(parent, name) {
    return parent ? parent + "/" + name : name;
}

function artifactLeaf(path) {
    return path.split("/").at(-1);
}

async function syncCurrentDirectory() {
    const directory = await fsp.open(".", fs.constants.O_RDONLY);
    try {
        await directory.sync();
    } finally {
        await directory.close();
    }
}

async function rollbackCreatedDirectories(stack) {
    for (let index = stack.length - 1; index > 0; index--) {
        const current = stack[index];
        process.chdir("..");
        const parent = await fsp.lstat(".", { bigint: true });
        const expectedParent = stack[index - 1].identity;
        if (!parent.isDirectory() || !sameIdentity(parent, expectedParent)) return;
        if (!current.created) continue;
        const child = await lstatOptional(current.name);
        if (!child || !child.isDirectory() || !sameIdentity(child, current.identity)) continue;
        try {
            await fsp.rmdir(current.name);
            await syncCurrentDirectory();
        } catch (error) {
            if (!error || !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
        }
    }
}

`;
