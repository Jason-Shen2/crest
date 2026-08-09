// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, SessionTreeEntry } from "@crest/agent/harness/types";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { RewindConfirmationRegistry } from "./confirmation-token";
import { WorkspaceGitRunner } from "./git-runner";
import { PendingWorkspaceRestoreStore } from "./pending-restore-store";
import type { RestorePlanV1, RestoreTargetV1 } from "./restore-plan";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import { WorkspaceControlCustomTypes, type CapturedPathStateV1, type WorkspaceSnapshotRefV1 } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import { WorkspaceRecovery } from "./workspace-recovery";
import { WorkspaceRestoreExecutor, type WorkspaceRestoreCommitStrategy } from "./workspace-restore-executor";

const CleanupRoots: string[] = [];

function linkedOperation(operationId: string) {
    const snapshot = (id: string): WorkspaceSnapshotRefV1 => ({
        id,
        workspaceIdentity: "1".repeat(64),
        workspaceIncarnation: "2".repeat(64),
        tree: "3".repeat(40),
        scopeManifest: "4".repeat(40),
    });
    return { operationId, sourceSnapshot: snapshot("5".repeat(40)), currentSnapshot: snapshot("6".repeat(40)) };
}

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("executes a result-commit restore without any restore-time workspace capture", async () => {
    const fixture = await makeFixture();
    const capture = vi.spyOn(fixture.store, "capture");
    const coverage = vi.spyOn(fixture.store, "computeIncrementalSnapshotCoverage");
    const onCommitted = vi.fn(async () => {});
    const executor = makeExecutor(fixture, { onCommitted });

    const result = await execute(executor, fixture, fixture.plan);

    expect(capture).not.toHaveBeenCalled();
    expect(coverage).toHaveBeenCalledWith(fixture.source, [{ path: "file.txt", state: fixture.target }]);
    expect(await readFile(join(fixture.workspace.canonicalRoot, "file.txt"), "utf8")).toBe("planned\n");
    const head = await fixture.store.mutationLog.readHead();
    expect(head).toBeDefined();
    const mutation = await fixture.store.mutationLog.read(head!);
    expect(mutation).toMatchObject({
        parent: fixture.source.id,
        metadata: {
            kind: "turn-undo",
            sessionid: "session-1",
            operationid: "operation-1",
            turnid: "turn-1",
        },
    });
    await expect(fixture.store.mutationLog.changedPaths(head!)).resolves.toEqual(["file.txt"]);
    await expect(new PendingWorkspaceRestoreStore(fixture.store).readCandidate()).resolves.toEqual({ kind: "none" });
    const marker = fixture.entries.at(-1) as Extract<SessionTreeEntry, { type: "custom" }>;
    expect(marker).toMatchObject({
        customType: WorkspaceControlCustomTypes.state,
        data: { kind: "turn-undo", currentSnapshot: { id: head }, sourceTurnId: "turn-1" },
    });
    expect(result).toMatchObject({ semanticLeafId: marker.id, displayLeafId: "current-leaf" });
    expect(onCommitted).toHaveBeenCalledWith("session-1", "operation-1");
}, 30_000);

test.each([
    { target: { kind: "rewind", targetTurnId: "turn-1" }, expectedTurn: "turn-1" },
    {
        target: {
            kind: "redo",
            sourceRewindOperationId: "rewind-1",
            linkedOperation: linkedOperation("rewind-1"),
        },
        expectedTurn: undefined,
    },
    { target: { kind: "turn-undo", sourceTurnId: "turn-1" }, expectedTurn: "turn-1" },
    {
        target: {
            kind: "turn-redo",
            sourceTurnId: "turn-1",
            undoOperationId: "undo-1",
            linkedOperation: linkedOperation("undo-1"),
        },
        expectedTurn: "turn-1",
    },
] satisfies Array<{ target: RestoreTargetV1; expectedTurn: string | undefined }>)(
    "prepares authoritative $target.kind result metadata",
    async ({ target, expectedTurn }) => {
        const fixture = await makeFixture();
        const executor = makeExecutor(fixture);
        const operationId = `operation-${target.kind}`;

        const result = await executor.prepareResultCommit(
            { ...executionInput(fixture, { ...fixture.plan, target }), plan: { ...fixture.plan, target } },
            operationId,
            fixture.plan.paths
        );

        const mutation = await fixture.store.mutationLog.read(result.prepared.commit);
        expect(mutation.parent).toBe(fixture.source.id);
        expect(mutation.metadata).toMatchObject({
            kind: target.kind,
            sessionid: "session-1",
            operationid: operationId,
            ...(expectedTurn ? { turnid: expectedTurn } : {}),
        });
        expect(mutation.metadata.turnid).toBe(expectedTurn);
        expect(mutation.metadata.sourceoperationid).toBe(
            target.kind === "redo"
                ? target.sourceRewindOperationId
                : target.kind === "turn-redo"
                  ? target.undoOperationId
                  : undefined
        );
        expect(mutation.metadata.linkedresultcommitid).toBe(
            target.kind === "redo" || target.kind === "turn-redo"
                ? target.linkedOperation.currentSnapshot.id
                : undefined
        );
        await expect(fixture.store.mutationLog.changedPaths(result.prepared.commit)).resolves.toEqual(["file.txt"]);
    },
    30_000
);

test("rolls a partially applied file back when verification fails before head publication", async () => {
    const fixture = await makeFixture();
    const executor = makeExecutor(fixture, {
        verifyPath: vi.fn(async () => {
            throw new Error("verification failed");
        }) as never,
    });

    await expect(execute(executor, fixture, fixture.plan)).rejects.toThrow("verification failed");

    expect(await readFile(join(fixture.workspace.canonicalRoot, "file.txt"), "utf8")).toBe("source\n");
    expect(await fixture.store.mutationLog.readHead()).toBe(fixture.source.id);
    await expect(new PendingWorkspaceRestoreStore(fixture.store).readCandidate()).resolves.toEqual({ kind: "none" });
}, 30_000);

test("completes the exact leaf marker after result head publication if the first leaf CAS throws", async () => {
    const fixture = await makeFixture({ failFirstAppend: true });
    const executor = makeExecutor(fixture);

    await expect(execute(executor, fixture, fixture.plan)).resolves.toMatchObject({
        semanticLeafId: "workspace-state-1",
    });

    expect(fixture.appendEntries).toHaveBeenCalledTimes(2);
    expect(await fixture.store.mutationLog.readHead()).not.toBe(fixture.source.id);
    await expect(new PendingWorkspaceRestoreStore(fixture.store).readCandidate()).resolves.toEqual({ kind: "none" });
}, 30_000);

interface Fixture {
    workspace: CanonicalWorkspaceIdentity;
    store: WorkspaceSnapshotStore;
    source: WorkspaceSnapshotRefV1;
    target: CapturedPathStateV1;
    plan: RestorePlanV1;
    session: never;
    entries: SessionTreeEntry[];
    appendEntries: ReturnType<typeof vi.fn>;
}

async function makeFixture(options: { failFirstAppend?: boolean } = {}): Promise<Fixture> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "crest-restore-executor-v2-")));
    CleanupRoots.push(root);
    const workspaceRoot = join(root, "workspace");
    const sessionsRoot = join(root, "sessions");
    await mkdir(workspaceRoot);
    await mkdir(sessionsRoot);
    await writeFile(join(workspaceRoot, "file.txt"), "source\n");
    const workspace: CanonicalWorkspaceIdentity = {
        canonicalRoot: workspaceRoot,
        workspaceIdentity: "1".repeat(64),
        workspaceIncarnation: "2".repeat(64),
        storeKey: "workspace",
        ancestorIdentityChain: await ancestorIdentityChain(workspaceRoot),
    };
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: join(root, "data"),
        identity: workspace,
        git: new WorkspaceGitRunner(),
        processOwner: { pid: process.pid, processStartToken: "test-start", nonce: "a".repeat(64) },
    });
    const sourceCaptured = await store.capture({ profile: "terminal" });
    const source = await appendExternal(store, sourceCaptured.ref);
    await writeFile(join(workspaceRoot, "file.txt"), "planned\n");
    const plannedCaptured = await store.capture({ profile: "terminal" });
    const target = await store.readPathState(plannedCaptured.ref, "file.txt");
    if (target.state === "excluded") throw new Error("test path unexpectedly excluded");
    await writeFile(join(workspaceRoot, "file.txt"), "source\n");
    const expectedCurrent = await store.readPathState(source, "file.txt");
    if (expectedCurrent.state === "excluded") throw new Error("test path unexpectedly excluded");
    const plan: RestorePlanV1 = {
        target: { kind: "turn-undo", sourceTurnId: "turn-1" },
        sessionId: "session-1",
        workspaceIdentity: workspace.workspaceIdentity,
        workspaceIncarnation: workspace.workspaceIncarnation,
        semanticLeafId: "current-leaf",
        commitParentId: "current-leaf",
        paths: [
            {
                path: "file.txt",
                operation: "write",
                target,
                expectedCurrent,
                liveFingerprint: fingerprint(expectedCurrent),
                conflict: "none",
            },
        ],
        coverageWarnings: [],
        forceRequired: false,
        hardBlocked: false,
    };
    const metadata: JsonlSessionMetadata = {
        id: "session-1",
        cwd: workspaceRoot,
        path: join(sessionsRoot, "session-1.db"),
        createdAt: "2026-08-08T00:00:00.000Z",
    };
    const entries: SessionTreeEntry[] = [
        {
            type: "message",
            id: "current-leaf",
            parentId: null,
            timestamp: "2026-08-08T00:00:00.000Z",
            message: { role: "user", content: "change", timestamp: 0 },
        } as SessionTreeEntry,
    ];
    let leaf: string | null = "current-leaf";
    let failed = false;
    const appendEntries = vi.fn(async (next: SessionTreeEntry[], input: { expectedLeafId: string | null }) => {
        if (leaf !== input.expectedLeafId) throw new Error("leaf CAS failed");
        if (options.failFirstAppend && !failed) {
            failed = true;
            throw new Error("first leaf append failed");
        }
        entries.push(...structuredClone(next));
        leaf = next.at(-1)!.id;
    });
    const session = {
        getMetadata: vi.fn(async () => metadata),
        getEntries: vi.fn(async () => structuredClone(entries)),
        getLeafId: vi.fn(async () => leaf),
        getEntry: vi.fn(async (id: string) => entries.find((entry) => entry.id === id)),
        getStorage: vi.fn(() => ({ createEntryId: vi.fn(async () => "workspace-state-1") })),
        appendEntries,
    };
    return { workspace, store, source, target, plan, session: session as never, entries, appendEntries };
}

function makeExecutor(
    fixture: Fixture,
    options: {
        verifyPath?: ConstructorParameters<typeof WorkspaceRestoreExecutor>[0]["verifyPath"];
        onCommitted?: (sessionId: string, operationId: string) => Promise<void>;
    } = {}
): WorkspaceRestoreExecutor {
    const pending = new PendingWorkspaceRestoreStore(fixture.store);
    const recovery = new WorkspaceRecovery({
        workspace: fixture.workspace,
        store: fixture.store,
        pending,
        locateSession: async () => fixture.session,
    });
    return new WorkspaceRestoreExecutor({
        store: fixture.store,
        pending,
        recovery,
        createOperationId: () => "operation-1",
        now: () => new Date("2026-08-08T00:00:01.000Z"),
        ...(options.verifyPath ? { verifyPath: options.verifyPath } : {}),
        ...(options.onCommitted ? { onCommitted: options.onCommitted } : {}),
    });
}

async function execute(executor: WorkspaceRestoreExecutor, fixture: Fixture, plan: RestorePlanV1) {
    return executor.execute(executionInput(fixture, plan));
}

function executionInput(fixture: Fixture, plan: RestorePlanV1) {
    const confirmations = new RewindConfirmationRegistry();
    return {
        session: fixture.session,
        workspace: fixture.workspace,
        source: fixture.source,
        plan,
        confirmation: confirmations.take(confirmations.issue(plan)),
        mode: "normal" as const,
        commit: strategy(),
    };
}

function strategy(): WorkspaceRestoreCommitStrategy {
    return {
        makeResult: ({ folded, sessionMetadata }) => ({
            sessionMetadata,
            semanticLeafId: folded.semanticLeafId,
            displayLeafId: folded.displayLeafId,
        }),
    };
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
    const source = await store.publishCommitSnapshot({
        commit: prepared.commit,
        scope: metadata.scope,
        coverage: metadata.coverage,
    });
    await store.mutationLog.publishPrepared(prepared);
    return source;
}

function fingerprint(state: Exclude<CapturedPathStateV1, { state: "excluded" }>): string {
    const value =
        state.state === "absent"
            ? ["absent"]
            : state.state === "file"
              ? ["file", state.oid, state.executable]
              : ["symlink", state.oid];
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
