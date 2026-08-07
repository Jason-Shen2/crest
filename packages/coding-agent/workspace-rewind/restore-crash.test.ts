// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { SqliteSessionRepo } from "@crest/agent/harness/session/sqlite-repo";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { deriveWorkspaceApplyArtifactPaths } from "./filesystem-apply";
import { WorkspaceGitRunner } from "./git-runner";
import { PendingWorkspaceRestoreStore, type PendingWorkspaceRestoreV2 } from "./pending-restore-store";
import type { RestoreTargetV1 } from "./restore-plan";
import { ShadowWorkspaceIndex } from "./shadow-workspace-index";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import { WorkspaceControlCustomTypes, type WorkspaceSnapshotRefV1 } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import { WorkspaceRecovery } from "./workspace-recovery";
import { deriveWorkspaceRestoreState } from "./workspace-restore-state";

const CleanupRoots: string[] = [];
const SourceBytes = { "a.txt": "source-a\n", "b.txt": "source-b\n" } as const;
const PlannedBytes = { "a.txt": "planned-a\n", "b.txt": "planned-b\n" } as const;

afterEach(async () => {
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.each([
    {
        target: { kind: "rewind", targetTurnId: "turn-1" } as const,
        applyPaths: ["a.txt"],
        publishHead: false,
        appendMarker: false,
        leaveArtifact: "a.txt",
        expectedDecision: "not-committed",
    },
    {
        target: { kind: "redo", sourceRewindOperationId: "rewind-operation" } as const,
        applyPaths: ["a.txt", "b.txt"],
        publishHead: true,
        appendMarker: false,
        expectedDecision: "committed",
    },
    {
        target: { kind: "turn-undo", sourceTurnId: "turn-1" } as const,
        applyPaths: ["a.txt", "b.txt"],
        publishHead: true,
        appendMarker: true,
        expectedDecision: "committed",
    },
    {
        target: { kind: "turn-redo", sourceTurnId: "turn-1", undoOperationId: "undo-operation" } as const,
        applyPaths: ["a.txt"],
        publishHead: false,
        appendMarker: false,
        leaveArtifact: "a.txt",
        expectedDecision: "not-committed",
    },
] satisfies Array<{
    target: RestoreTargetV1;
    applyPaths: string[];
    publishHead: boolean;
    appendMarker: boolean;
    leaveArtifact?: string;
    expectedDecision: "committed" | "not-committed";
}>)(
    "$target.kind recovery survives a real child-process crash without phase state",
    async (scenario) => {
        const fixture = await makeFixture(scenario.target);
        await crashChild({
            dataRoot: fixture.dataRoot,
            sessionsRoot: fixture.sessionsRoot,
            workspace: fixture.workspace,
            record: fixture.record,
            applyPaths: scenario.applyPaths,
            publishHead: scenario.publishHead,
            appendMarker: scenario.appendMarker,
            ...(scenario.leaveArtifact ? { leaveArtifact: scenario.leaveArtifact } : {}),
        });

        const pending = new PendingWorkspaceRestoreStore(fixture.store);
        await expect(pending.readCandidate()).resolves.toEqual({ kind: "valid", record: fixture.record });
        expect(await fixture.store.mutationLog.readHead()).toBe(
            scenario.publishHead ? fixture.record.plannedCommit : fixture.record.sourceCommit
        );

        const repo = new SqliteSessionRepo({ sessionsRoot: fixture.sessionsRoot });
        const metadata = (await repo.scanAllMetadata()).find((candidate) => candidate.id === fixture.record.sessionId)!;
        const session = await repo.open(metadata);
        const recovery = new WorkspaceRecovery({
            workspace: fixture.workspace,
            store: fixture.store,
            pending,
            locateSession: async () => session,
            withSessionMutation: async (_sessionPath, operation) => operation(),
        });
        try {
            await expect(recovery.resolvePending()).resolves.toEqual({
                state: scenario.expectedDecision,
                operationId: fixture.record.operationId,
            });

            const expectedBytes = scenario.publishHead ? PlannedBytes : SourceBytes;
            await expect(readWorkspaceFiles(fixture.workspace.canonicalRoot)).resolves.toEqual(expectedBytes);
            await expect(pending.readCandidate()).resolves.toEqual({ kind: "none" });
            expect(await fixture.store.mutationLog.readHead()).toBe(
                scenario.publishHead ? fixture.record.plannedCommit : fixture.record.sourceCommit
            );
            const entries = await session.getEntries();
            const markers = entries.filter(
                (entry): entry is Extract<SessionTreeEntry, { type: "custom" }> =>
                    entry.type === "custom" && entry.customType === WorkspaceControlCustomTypes.state
            );
            if (scenario.publishHead) {
                expect(markers).toHaveLength(1);
                expect(markers[0]!.id).toBe(fixture.record.workspaceStateEntryId);
                const expected = await deriveWorkspaceRestoreState(fixture.store, fixture.record);
                expect(markers[0]!.data).toEqual(expected.markerState);
            } else {
                expect(markers).toEqual([]);
            }
            if (scenario.leaveArtifact) {
                const artifact = deriveWorkspaceApplyArtifactPaths({
                    operationId: fixture.record.operationId,
                    path: scenario.leaveArtifact,
                }).preparedFile;
                await expect(access(join(fixture.workspace.canonicalRoot, artifact))).rejects.toMatchObject({
                    code: "ENOENT",
                });
            }
        } finally {
            session.close();
        }
    },
    120_000
);

interface CrashConfiguration {
    dataRoot: string;
    sessionsRoot: string;
    workspace: CanonicalWorkspaceIdentity;
    record: PendingWorkspaceRestoreV2;
    applyPaths: string[];
    publishHead: boolean;
    appendMarker: boolean;
    leaveArtifact?: string;
}

interface Fixture {
    dataRoot: string;
    sessionsRoot: string;
    workspace: CanonicalWorkspaceIdentity;
    store: WorkspaceSnapshotStore;
    record: PendingWorkspaceRestoreV2;
}

async function makeFixture(target: RestoreTargetV1): Promise<Fixture> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "crest-real-restore-crash-")));
    CleanupRoots.push(root);
    const workspaceRoot = join(root, "workspace");
    const sessionsRoot = join(root, "sessions");
    const dataRoot = join(root, "data");
    await Promise.all([mkdir(workspaceRoot), mkdir(sessionsRoot)]);
    await writeWorkspaceFiles(workspaceRoot, SourceBytes);
    const workspace: CanonicalWorkspaceIdentity = {
        canonicalRoot: workspaceRoot,
        workspaceIdentity: "1".repeat(64),
        workspaceIncarnation: "2".repeat(64),
        storeKey: "workspace",
        ancestorIdentityChain: await ancestorIdentityChain(workspaceRoot),
    };
    const store = await WorkspaceSnapshotStore.open({
        dataRoot,
        identity: workspace,
        git: new WorkspaceGitRunner(),
        processOwner: { pid: process.pid, processStartToken: "parent", nonce: "a".repeat(64) },
    });
    const source = await appendExternal(store, (await store.capture({ profile: "terminal" })).ref);
    await writeWorkspaceFiles(workspaceRoot, PlannedBytes);
    const targetCapture = (await store.capture({ profile: "terminal" })).ref;
    const planned = await prepareResultCommit(store, source, targetCapture, target, "operation-1");
    await writeWorkspaceFiles(workspaceRoot, SourceBytes);

    const repo = new SqliteSessionRepo({ sessionsRoot });
    const session = await repo.create({ cwd: workspaceRoot, id: "session-1" });
    const leaf = await session.appendMessage({
        role: "user",
        content: [{ type: "text", text: "change both files" }],
        timestamp: Date.now(),
    } as never);
    const metadata = await session.getMetadata();
    const workspaceStateEntryId = await session.getStorage().createEntryId();
    session.close();
    const record: PendingWorkspaceRestoreV2 = {
        schemaVersion: 2,
        operationId: "operation-1",
        workspaceIdentity: workspace.workspaceIdentity,
        workspaceIncarnation: workspace.workspaceIncarnation,
        sessionId: metadata.id,
        sessionPath: metadata.path,
        target,
        applyMode: "normal",
        forcedPaths: [],
        expectedSemanticLeafId: leaf,
        commitParentId: leaf,
        workspaceStateEntryId,
        workspaceStateTimestamp: "2026-08-08T00:00:00.000Z",
        sourceCommit: source.id,
        plannedCommit: planned.id,
        affectedPaths: ["a.txt", "b.txt"],
    };
    return { dataRoot, sessionsRoot, workspace, store, record };
}

async function prepareResultCommit(
    store: WorkspaceSnapshotStore,
    source: WorkspaceSnapshotRefV1,
    targetSnapshot: WorkspaceSnapshotRefV1,
    target: RestoreTargetV1,
    operationId: string
): Promise<WorkspaceSnapshotRefV1> {
    const indexFile = join(store.storeRoot, "journal", `crash-index-${target.kind}`);
    const index = new ShadowWorkspaceIndex({ git: store.git, gitDir: store.storeRoot, indexFile });
    try {
        await index.load(source.tree);
        await index.apply(
            await Promise.all(
                ["a.txt", "b.txt"].map(async (path) => ({
                    path,
                    state: await store.readPathState(targetSnapshot, path),
                }))
            )
        );
        const prepared = await store.mutationLog.prepare({
            expectedHead: source.id,
            tree: await index.writeTree(),
            metadata: {
                schemaversion: 1,
                workspaceidentity: store.identity.workspaceIdentity,
                workspaceincarnation: store.identity.workspaceIncarnation,
                kind: target.kind,
                sessionid: "session-1",
                operationid: operationId,
                ...(turnIdFor(target) ? { turnid: turnIdFor(target) } : {}),
                ...(sourceOperationIdFor(target) ? { sourceoperationid: sourceOperationIdFor(target) } : {}),
            },
        });
        const metadata = await store.readSnapshotMetadata(source);
        return await store.publishCommitSnapshot({ commit: prepared.commit, ...metadata });
    } finally {
        await Promise.all([rm(indexFile, { force: true }), rm(`${indexFile}.lock`, { force: true })]);
    }
}

async function appendExternal(
    store: WorkspaceSnapshotStore,
    captured: WorkspaceSnapshotRefV1
): Promise<WorkspaceSnapshotRefV1> {
    const prepared = await store.mutationLog.prepare({
        tree: captured.tree,
        metadata: {
            schemaversion: 1,
            workspaceidentity: store.identity.workspaceIdentity,
            workspaceincarnation: store.identity.workspaceIncarnation,
            kind: "external",
        },
    });
    const metadata = await store.readSnapshotMetadata(captured);
    const source = await store.publishCommitSnapshot({ commit: prepared.commit, ...metadata });
    await store.mutationLog.publishPrepared(prepared);
    return source;
}

async function crashChild(configuration: CrashConfiguration): Promise<void> {
    const root = dirname(configuration.workspace.canonicalRoot);
    const configurationPath = join(root, `crash-${configuration.record.target.kind}.json`);
    await writeFile(configurationPath, JSON.stringify(configuration), { mode: 0o600 });
    const executable = join(process.cwd(), "node_modules", ".bin", "tsx");
    const child = spawn(executable, ["-e", CrashWorkerSource], {
        cwd: process.cwd(),
        env: { ...process.env, CREST_CRASH_CONFIGURATION: configurationPath },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const killed = result.signal === "SIGKILL" || result.code === 137;
    if (!killed || !stdout.includes("CREST_CRASH_READY")) {
        throw new Error(`Crash worker did not reach the crash point (${result.code ?? result.signal}): ${stderr}`);
    }
}

async function writeWorkspaceFiles(root: string, values: Record<string, string>): Promise<void> {
    await Promise.all(Object.entries(values).map(([path, bytes]) => writeFile(join(root, path), bytes)));
}

async function readWorkspaceFiles(root: string): Promise<Record<string, string>> {
    return Object.fromEntries(
        await Promise.all(
            ["a.txt", "b.txt"].map(async (path) => [path, await readFile(join(root, path), "utf8")] as const)
        )
    );
}

function turnIdFor(target: RestoreTargetV1): string | undefined {
    if (target.kind === "rewind") return target.targetTurnId;
    if (target.kind === "turn-undo" || target.kind === "turn-redo") return target.sourceTurnId;
    return undefined;
}

function sourceOperationIdFor(target: RestoreTargetV1): string | undefined {
    if (target.kind === "redo") return target.sourceRewindOperationId;
    if (target.kind === "turn-redo") return target.undoOperationId;
    return undefined;
}

async function ancestorIdentityChain(path: string): Promise<CanonicalWorkspaceIdentity["ancestorIdentityChain"]> {
    const paths: string[] = [];
    let cursor = path;
    while (true) {
        paths.unshift(cursor);
        const parent = dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
    }
    return Promise.all(
        paths.map(async (absolutePath) => {
            const stats = await lstat(absolutePath, { bigint: true });
            return {
                absolutePath,
                dev: stats.dev.toString(),
                ino: stats.ino.toString(),
                birthtimeNs: stats.birthtimeNs.toString(),
            };
        })
    );
}

const CrashWorkerSource = String.raw`
import { SqliteSessionRepo } from "@crest/agent/harness/session/sqlite-repo";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyCapturedPath, deriveWorkspaceApplyArtifactPaths } from "./packages/coding-agent/workspace-rewind/filesystem-apply";
import { WorkspaceGitRunner } from "./packages/coding-agent/workspace-rewind/git-runner";
import { PendingWorkspaceRestoreStore } from "./packages/coding-agent/workspace-rewind/pending-restore-store";
import { makeProcessOwnerIdentity } from "./packages/coding-agent/workspace-rewind/process-owner";
import { WorkspaceSnapshotStore } from "./packages/coding-agent/workspace-rewind/snapshot-store";
import { WorkspaceControlCustomTypes } from "./packages/coding-agent/workspace-rewind/types";
import { deriveWorkspaceRestoreState } from "./packages/coding-agent/workspace-rewind/workspace-restore-state";

void (async () => {
const configuration = JSON.parse(await readFile(process.env.CREST_CRASH_CONFIGURATION, "utf8"));
const store = await WorkspaceSnapshotStore.open({
    dataRoot: configuration.dataRoot,
    identity: configuration.workspace,
    git: new WorkspaceGitRunner(),
    processOwner: await makeProcessOwnerIdentity(),
});
const pending = new PendingWorkspaceRestoreStore(store);
await store.withWorkspaceLock(() => pending.publishLocked(configuration.record));
const source = await store.readCommitSnapshot(configuration.record.sourceCommit);
const planned = await store.readCommitSnapshot(configuration.record.plannedCommit);
for (const path of configuration.applyPaths) {
    const expectedCurrent = await store.readPathState(source, path);
    const target = await store.readPathState(planned, path);
    await applyCapturedPath({
        root: configuration.workspace.canonicalRoot,
        path,
        expectedCurrent,
        target,
        readBlob: (oid) => store.readBlob(oid),
        progress: {
            operationId: configuration.record.operationId,
            createdParentDirectories: new Set(),
            onPathReplaced: async () => {},
        },
    });
}
if (configuration.leaveArtifact) {
    const target = await store.readPathState(planned, configuration.leaveArtifact);
    if (target.state !== "file") throw new Error("Crash artifact fixture requires a file target");
    const relative = deriveWorkspaceApplyArtifactPaths({
        operationId: configuration.record.operationId,
        path: configuration.leaveArtifact,
    }).preparedFile;
    const absolute = join(configuration.workspace.canonicalRoot, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, await store.readBlob(target.oid), { mode: target.executable ? 0o700 : 0o600 });
}
if (configuration.publishHead) {
    await store.git.run(
        ["update-ref", "--no-deref", "refs/crest/workspace-head", configuration.record.plannedCommit, configuration.record.sourceCommit],
        { gitDir: store.storeRoot, timeoutMs: 30_000, maxStdoutBytes: 0 }
    );
}
if (configuration.appendMarker) {
    const repo = new SqliteSessionRepo({ sessionsRoot: configuration.sessionsRoot });
    const metadata = (await repo.scanAllMetadata()).find((candidate) => candidate.id === configuration.record.sessionId);
    if (!metadata) throw new Error("Crash fixture Session is missing");
    const session = await repo.open(metadata);
    try {
        const derived = await deriveWorkspaceRestoreState(store, configuration.record);
        await session.appendEntries(
            [{
                type: "custom",
                id: configuration.record.workspaceStateEntryId,
                parentId: configuration.record.commitParentId,
                timestamp: configuration.record.workspaceStateTimestamp,
                customType: WorkspaceControlCustomTypes.state,
                data: derived.markerState,
            }],
            { expectedLeafId: configuration.record.expectedSemanticLeafId }
        );
    } finally {
        session.close();
    }
}
await new Promise((resolve) => process.stdout.write("CREST_CRASH_READY\n", resolve));
process.kill(process.pid, "SIGKILL");
})();
`;
