// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Session } from "@crest/agent/harness/session/session";
import { SqliteSessionStorage } from "@crest/agent/harness/session/sqlite-storage";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { link, mkdir, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { RewindConfirmationRegistry } from "../confirmation-token";
import { writeDurableJson } from "../durability";
import { applyCapturedPath, deriveWorkspaceApplyArtifactPaths } from "../filesystem-apply";
import { WorkspaceGitRunner } from "../git-runner";
import { inspectLivePaths } from "../live-path-state";
import { PendingWorkspaceRestoreStore } from "../pending-restore-store";
import type { RestorePlanV1, RestoreTargetV1 } from "../restore-plan";
import { WorkspaceSnapshotStore } from "../snapshot-store";
import { WorkspaceControlCustomTypes, type CapturedPathStateV1 } from "../types";
import type { CanonicalWorkspaceIdentity, WorkspaceDirectoryIdentityToken } from "../workspace-identity";
import { WorkspaceRecovery } from "../workspace-recovery";
import { WorkspaceRestoreExecutor, workspaceStateFromPending } from "../workspace-restore-executor";

export type RestoreCrashBoundary =
    | "before-pending-publish"
    | "after-pending-publish"
    | `path-replace-before-${number}`
    | `path-replace-after-${number}`
    | "before-result-snapshot"
    | "after-result-snapshot"
    | "sqlite-marker-before"
    | "sqlite-marker-after"
    | "pending-remove-before"
    | "pending-remove-after";

export type RestoreCrashOperationKind = "conversation-rewind" | "conversation-redo" | "turn-undo" | "turn-redo";

const Identity = "1".repeat(64);
const Incarnation = "2".repeat(64);
const OperationId = "operation-1";
const OperationEntryId = "operation-leaf";
const SessionId = "session-1";
const Paths = ["first.txt", "second.txt", "created/parent/third.txt"] as const;
const BeforeContents = [Buffer.from("before first"), Buffer.from("before second")] as const;
const TargetContents = [
    Buffer.from("target first"),
    Buffer.from("target second"),
    Buffer.from("target third"),
] as const;

async function main(): Promise<void> {
    const [root, boundaryValue, kindValue, scenarioValue = "normal"] = process.argv.slice(2);
    if (!root || !isBoundary(boundaryValue) || !isOperationKind(kindValue) || !isScenario(scenarioValue)) {
        throw new Error("restore crash worker arguments are invalid");
    }
    const boundary = boundaryValue;
    const operationKind = kindValue;
    const scenario = scenarioValue;
    const workspaceRoot = join(root, "workspace");
    const dataRoot = join(root, "data");
    const sessionPath = join(root, "session.db");
    await mkdir(workspaceRoot, { recursive: true });
    const canonicalRoot = await realpath(workspaceRoot);
    const identity: CanonicalWorkspaceIdentity = {
        canonicalRoot,
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        storeKey: "restore-crash-store",
        ancestorIdentityChain: await captureAncestorIdentityChain(canonicalRoot),
    };
    const pause = async (value: RestoreCrashBoundary) => {
        if (boundary !== value) return;
        process.send?.("ready");
        await new Promise(() => {});
    };
    const store = await WorkspaceSnapshotStore.open({
        dataRoot,
        identity,
        git: new WorkspaceGitRunner(),
        processOwner: {
            pid: process.pid,
            processStartToken: "restore-crash-worker",
            nonce: "3".repeat(64),
        },
    });
    for (let index = 0; index < TargetContents.length; index++) {
        await durableWrite(join(canonicalRoot, Paths[index]!), TargetContents[index]!);
    }
    const targetSnapshot = (await store.capture({ profile: "terminal" })).ref;
    for (let index = 0; index < BeforeContents.length; index++) {
        await durableWrite(join(canonicalRoot, Paths[index]!), BeforeContents[index]!);
    }
    await rm(join(canonicalRoot, "created"), { recursive: true });
    const beforeSnapshot = (await store.capture({ profile: "terminal" })).ref;
    const planPaths = await Promise.all(
        Paths.map(async (path) => {
            const before = await store.readPathState(beforeSnapshot, path);
            const target = await store.readPathState(targetSnapshot, path);
            return { path, before, target };
        })
    );
    const storage = SqliteSessionStorage.create(sessionPath, { cwd: canonicalRoot, sessionId: SessionId });
    const session = new Session(storage);
    await session.appendEntries(initialSessionEntries());
    storage.createEntryId = async () => OperationEntryId;
    const pending = new PendingWorkspaceRestoreStore(store);
    const recovery = new WorkspaceRecovery({
        workspace: identity,
        store,
        pending,
        locateSession: async (sessionId, requestedPath) =>
            sessionId === SessionId && requestedPath === sessionPath ? session : undefined,
        verifyWorkspace: async () => {},
    });
    await writeDurableJson(join(root, "fixture.json"), {
        identity,
        dataRoot,
        sessionPath,
        operationKind,
        paths: planPaths,
    });

    const originalPublish = pending.publishLocked.bind(pending);
    pending.publishLocked = async (record) => {
        await pause("before-pending-publish");
        await originalPublish(record);
        await prepareCrashScenario(scenario, canonicalRoot, record.paths);
        await pause("after-pending-publish");
    };
    const originalRemove = pending.removeLocked.bind(pending);
    pending.removeLocked = async (operationId) => {
        await pause("pending-remove-before");
        await originalRemove(operationId);
        await pause("pending-remove-after");
    };
    const originalAppend = storage.appendEntries.bind(storage);
    storage.appendEntries = async (entries, options) => {
        const marker = entries.some(
            (entry) => entry.type === "custom" && entry.customType === WorkspaceControlCustomTypes.state
        );
        if (marker) await pause("sqlite-marker-before");
        await originalAppend(entries, options);
        if (marker) await pause("sqlite-marker-after");
    };
    const originalCapture = store.capture.bind(store);
    let executionCaptureCount = 0;
    store.capture = async (options) => {
        executionCaptureCount++;
        const resultSnapshot = executionCaptureCount === 2;
        if (resultSnapshot) await pause("before-result-snapshot");
        const result = await originalCapture(options);
        if (resultSnapshot) await pause("after-result-snapshot");
        return result;
    };
    const live = await inspectLivePaths(
        canonicalRoot,
        planPaths.map((path) => path.path)
    );
    const plan: RestorePlanV1 = {
        target: restoreTarget(operationKind),
        sessionId: SessionId,
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        semanticLeafId: "old-leaf",
        commitParentId: operationKind === "conversation-rewind" ? "target-boundary" : "old-leaf",
        paths: planPaths.map((path) => ({
            path: path.path,
            operation: path.before.state === "absent" ? "create" : "write",
            target: path.target,
            expectedCurrent: path.before,
            liveFingerprint: live.get(path.path)!.fingerprint,
            conflict: "none",
        })),
        coverageWarnings: [],
        forceRequired: false,
        hardBlocked: false,
    };
    const confirmations = new RewindConfirmationRegistry();
    const executor = new WorkspaceRestoreExecutor({
        store,
        pending,
        recovery,
        createOperationId: () => OperationId,
        applyPath: async (input) => {
            const index = planPaths.findIndex((path) => path.path === input.path);
            await pause(`path-replace-before-${index}`);
            await applyCapturedPath({
                ...input,
                progress: {
                    ...input.progress,
                    onPathReplaced: async (path) => {
                        await input.progress.onPathReplaced(path);
                        await pause(`path-replace-after-${index}`);
                    },
                },
            });
        },
    });
    await executor.execute({
        session,
        workspace: identity,
        plan,
        confirmation: confirmations.take(confirmations.issue(plan)),
        mode: "normal",
        commit: {
            makeWorkspaceState: workspaceStateFromPending,
            makeResult: ({ entries, folded, sessionMetadata }) => ({
                sessionMetadata,
                semanticLeafId: folded.semanticLeafId,
                displayLeafId: folded.displayLeafId,
                entries,
            }),
        } as never,
    });
    process.send?.("completed");
}

async function prepareCrashScenario(
    scenario: "normal" | "artifacts",
    workspaceRoot: string,
    paths: Array<{ path: string; before: CapturedPathStateV1; target: CapturedPathStateV1 }>
): Promise<void> {
    if (scenario !== "artifacts") return;
    const renamed = paths.find((path) => path.path === "first.txt")!;
    const renamedArtifacts = deriveWorkspaceApplyArtifactPaths({ operationId: OperationId, path: renamed.path });
    await writeFile(join(workspaceRoot, renamedArtifacts.preparedFile), TargetContents[0]!, { mode: 0o600 });
    await mkdir(join(workspaceRoot, renamedArtifacts.quarantine), { mode: 0o700 });
    await rename(join(workspaceRoot, renamed.path), join(workspaceRoot, renamedArtifacts.quarantine, "entry"));

    const installed = paths.find((path) => path.path === "second.txt")!;
    const installedArtifacts = deriveWorkspaceApplyArtifactPaths({ operationId: OperationId, path: installed.path });
    await mkdir(join(workspaceRoot, installedArtifacts.quarantine), { mode: 0o700 });
    await rename(join(workspaceRoot, installed.path), join(workspaceRoot, installedArtifacts.quarantine, "entry"));
    await writeFile(join(workspaceRoot, installedArtifacts.preparedFile), TargetContents[1]!, { mode: 0o600 });
    await link(join(workspaceRoot, installedArtifacts.preparedFile), join(workspaceRoot, installed.path));
    await rm(join(workspaceRoot, installedArtifacts.preparedFile));
}

function restoreTarget(kind: RestoreCrashOperationKind): RestoreTargetV1 {
    if (kind === "conversation-rewind") return { kind: "rewind", targetTurnId: "target-turn" };
    if (kind === "conversation-redo") return { kind: "redo" };
    if (kind === "turn-undo") return { kind: "turn-undo", sourceTurnId: "source-turn" };
    return { kind: "turn-redo", sourceTurnId: "source-turn", undoOperationId: "undo-operation" };
}

function isBoundary(value: string | undefined): value is RestoreCrashBoundary {
    return (
        value === "before-pending-publish" ||
        value === "after-pending-publish" ||
        /^path-replace-(before|after)-\d+$/.test(value ?? "") ||
        value === "before-result-snapshot" ||
        value === "after-result-snapshot" ||
        value === "sqlite-marker-before" ||
        value === "sqlite-marker-after" ||
        value === "pending-remove-before" ||
        value === "pending-remove-after"
    );
}

function isOperationKind(value: string | undefined): value is RestoreCrashOperationKind {
    return ["conversation-rewind", "conversation-redo", "turn-undo", "turn-redo"].includes(value ?? "");
}

function isScenario(value: string): value is "normal" | "artifacts" {
    return value === "normal" || value === "artifacts";
}

function initialSessionEntries(): SessionTreeEntry[] {
    const timestamp = new Date(0).toISOString();
    return [
        { type: "custom", id: "target-boundary", parentId: null, timestamp, customType: "fixture", data: {} },
        { type: "custom", id: "old-leaf", parentId: "target-boundary", timestamp, customType: "fixture", data: {} },
    ];
}

async function durableWrite(path: string, bytes: Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "w", 0o600);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function captureAncestorIdentityChain(path: string): Promise<WorkspaceDirectoryIdentityToken[]> {
    const paths = [path];
    while (true) {
        const parent = dirname(paths[0]!);
        if (parent === paths[0]) break;
        paths.unshift(parent);
    }
    return Promise.all(
        paths.map(async (absolutePath) => {
            const metadata = await stat(absolutePath, { bigint: true });
            return {
                absolutePath,
                dev: metadata.dev.toString(),
                ino: metadata.ino.toString(),
                birthtimeNs: metadata.birthtimeNs.toString(),
            };
        })
    );
}

void main().catch((error) => {
    process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
});
