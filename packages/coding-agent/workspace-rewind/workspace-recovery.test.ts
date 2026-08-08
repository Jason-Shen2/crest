// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { link, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { encodeDurableJson } from "./durability";
import {
    PendingWorkspaceRestoreStore,
    type PendingWorkspaceRestoreV2,
    type ScannedPendingWorkspaceRestore,
} from "./pending-restore-store";
import { WorkspaceControlCustomTypes, type CapturedPathStateV1, type WorkspaceSnapshotRefV1 } from "./types";
import { WorkspaceRecovery, classifyWorkspaceRecoveryPath } from "./workspace-recovery";
import { deriveWorkspaceRestoreState } from "./workspace-restore-state";

const Identity = "1".repeat(64);
const Incarnation = "2".repeat(64);
const SourceCommit = "3".repeat(40);
const PlannedCommit = "4".repeat(40);
const OtherCommit = "5".repeat(40);
const Source = { state: "file", oid: "a".repeat(40), executable: false } as const;
const Planned = { state: "file", oid: "b".repeat(40), executable: false } as const;
const CleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("source head rolls partial application back without locating the owning Session", async () => {
    const fixture = makeFixture({ head: SourceCommit, live: Planned, sessionMissing: true });

    await expect(fixture.recovery.resolvePending()).resolves.toEqual({
        state: "not-committed",
        operationId: fixture.record.operationId,
    });

    expect(fixture.locateSession).not.toHaveBeenCalled();
    expect(fixture.withSessionMutation).not.toHaveBeenCalled();
    expect(fixture.acquireWriter).toHaveBeenCalledOnce();
    expect(fixture.applyPath).toHaveBeenCalledWith({
        operationId: fixture.record.operationId,
        path: "file.txt",
        expectedCurrent: Planned,
        target: Source,
    });
    expect(fixture.removeLocked).toHaveBeenCalledWith(fixture.record.operationId);
});

test("inspectPending and an unknown head perform no restore writes", async () => {
    const fixture = makeFixture({ head: OtherCommit, live: Planned });

    const decision = await fixture.recovery.inspectPending();

    expect(decision).toMatchObject({ state: "needs-user" });
    expect(fixture.withSessionMutation).not.toHaveBeenCalled();
    expect(fixture.acquireWriter).not.toHaveBeenCalled();
    expect(fixture.applyPath).not.toHaveBeenCalled();
    expect(fixture.removeLocked).not.toHaveBeenCalled();
    expect(fixture.locateSession).not.toHaveBeenCalled();
    expect(fixture.inspectLocked).toHaveBeenCalledOnce();
    expect(fixture.readLocked).not.toHaveBeenCalled();
});

test("inspectPending leaves an interrupted linked publication untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "crest-recovery-pure-inspect-"));
    CleanupRoots.push(root);
    const workspace = join(root, "workspace");
    const storeRoot = join(root, "store");
    const journalRoot = join(storeRoot, "journal", "restore");
    await Promise.all([mkdir(workspace), mkdir(journalRoot, { recursive: true, mode: 0o700 })]);
    const record = { ...pendingRecord(), sessionPath: join(root, "session.db") };
    const source = snapshot(SourceCommit, "6".repeat(40));
    const planned = snapshot(PlannedCommit, "7".repeat(40));
    const store = {
        storeRoot,
        identity: {
            canonicalRoot: workspace,
            workspaceIdentity: Identity,
            workspaceIncarnation: Incarnation,
            storeKey: "store",
            ancestorIdentityChain: [],
        },
        mutationLog: {
            readHead: vi.fn(async () => OtherCommit),
            changedPaths: vi.fn(async () => ["file.txt"]),
            read: vi.fn(async (commit: string) => {
                if (commit !== PlannedCommit) throw new Error("unexpected mutation commit");
                return {
                    parent: SourceCommit,
                    tree: planned.tree,
                    metadata: {
                        schemaversion: 1 as const,
                        workspaceidentity: Identity,
                        workspaceincarnation: Incarnation,
                        kind: "rewind" as const,
                        sessionid: record.sessionId,
                        operationid: record.operationId,
                        turnid: "turn-1",
                    },
                };
            }),
        },
        readCommitSnapshot: vi.fn(async (commit: string) => {
            if (commit === SourceCommit) return source;
            if (commit === PlannedCommit) return planned;
            throw new Error("unexpected snapshot commit");
        }),
        readPathState: vi.fn(async (ref: WorkspaceSnapshotRefV1) =>
            structuredClone(ref.id === SourceCommit ? Source : Planned)
        ),
        readBlob: vi.fn(),
        withWorkspaceLock: async (operation: () => Promise<unknown>) => operation(),
    };
    const pending = new PendingWorkspaceRestoreStore(store as never);
    const destination = join(journalRoot, "pending.json");
    const temporary = join(journalRoot, ".pending.json.publish.tmp");
    await writeFile(destination, encodeDurableJson(record), { mode: 0o600 });
    await link(destination, temporary);
    const recovery = new WorkspaceRecovery({
        workspace: store.identity,
        store: store as never,
        pending,
        locateSession: async () => undefined,
        inspectPath: async () => structuredClone(Planned),
        verifyWorkspace: async () => {},
    });

    await expect(recovery.inspectPending()).resolves.toMatchObject({ state: "needs-user" });

    await expect(lstat(temporary)).resolves.toMatchObject({ nlink: 2 });
    await expect(lstat(destination)).resolves.toMatchObject({ nlink: 2 });
});

test("resolvePending leaves unknown head and path facts untouched", async () => {
    const fixture = makeFixture({ head: OtherCommit, live: "unknown" });

    const decision = await fixture.recovery.resolvePending();

    expect(decision).toMatchObject({
        state: "needs-user",
        view: { allowedActions: ["retry"] },
    });
    expect(fixture.applyPath).not.toHaveBeenCalled();
    expect(fixture.removeLocked).not.toHaveBeenCalled();
    expect(fixture.locateSession).not.toHaveBeenCalled();
});

test("planned head releases discovery writer before taking Session then reacquires writer", async () => {
    const fixture = makeFixture({ head: PlannedCommit, live: Planned, leaf: "old-leaf" });

    await expect(fixture.recovery.resolvePending()).resolves.toEqual({
        state: "committed",
        operationId: fixture.record.operationId,
    });

    expect(fixture.appendEntries).toHaveBeenCalledOnce();
    expect(fixture.appendEntries.mock.calls[0]?.[1]).toEqual({ expectedLeafId: "old-leaf" });
    const [entry] = fixture.appendEntries.mock.calls[0]?.[0] ?? [];
    expect(entry).toMatchObject({
        type: "custom",
        id: fixture.record.workspaceStateEntryId,
        parentId: fixture.record.commitParentId,
        timestamp: fixture.record.workspaceStateTimestamp,
        customType: WorkspaceControlCustomTypes.state,
    });
    const writerIndexes = fixture.order.flatMap((item, index) => (item === "writer" ? [index] : []));
    expect(writerIndexes).toHaveLength(2);
    expect(writerIndexes[0]).toBeLessThan(fixture.order.indexOf("session-mutation"));
    expect(fixture.order.indexOf("session-mutation")).toBeLessThan(writerIndexes[1]!);
    expect(fixture.removeLocked).toHaveBeenCalledWith(fixture.record.operationId);
});

test("durable pending commit facts are revalidated before any recovery write", async () => {
    const fixture = makeFixture({ head: SourceCommit, live: Planned, invalidCommitFacts: true });

    await expect(fixture.recovery.resolvePending()).rejects.toThrow(/invalid durable commit facts/i);

    expect(fixture.validateCommitFacts).toHaveBeenCalledOnce();
    expect(fixture.applyPath).not.toHaveBeenCalled();
    expect(fixture.removeLocked).not.toHaveBeenCalled();
});

test("planned head with the exact existing marker clears pending idempotently", async () => {
    const fixture = makeFixture({ head: PlannedCommit, live: Planned, leaf: "workspace-state" });
    fixture.entry = await exactMarker(fixture.store, fixture.record);

    await expect(fixture.recovery.resolvePending()).resolves.toMatchObject({ state: "committed" });

    expect(fixture.appendEntries).not.toHaveBeenCalled();
    expect(fixture.removeLocked).toHaveBeenCalledOnce();
});

test("planned head with an unrelated leaf freezes without overwriting conversation state", async () => {
    const fixture = makeFixture({ head: PlannedCommit, live: Planned, leaf: "unrelated-leaf" });

    const decision = await fixture.recovery.resolvePending();

    expect(decision).toMatchObject({ state: "needs-user", view: { allowedActions: ["retry"] } });
    expect(fixture.appendEntries).not.toHaveBeenCalled();
    expect(fixture.removeLocked).not.toHaveBeenCalled();
});

test("corrupt pending is diagnostic-only and exposes Retry as the sole action", async () => {
    const fixture = makeFixture({ head: SourceCommit, live: Source, corrupt: true });

    const decision = await fixture.recovery.resolvePending();

    expect(decision).toMatchObject({
        state: "needs-user",
        view: { corrupt: true, allowedActions: ["retry"] },
    });
    expect(fixture.withSessionMutation).not.toHaveBeenCalled();
    expect(fixture.applyPath).not.toHaveBeenCalled();
    expect(fixture.removeLocked).not.toHaveBeenCalled();
});

test("classifies only exact source and planned states", () => {
    expect(classifyWorkspaceRecoveryPath(Source, Source, Planned)).toBe("before");
    expect(classifyWorkspaceRecoveryPath(Planned, Source, Planned)).toBe("target");
    expect(
        classifyWorkspaceRecoveryPath({ state: "file", oid: "c".repeat(40), executable: false }, Source, Planned)
    ).toBe("unknown");
    expect(classifyWorkspaceRecoveryPath("unknown", Source, Planned)).toBe("unknown");
});

interface Fixture {
    record: PendingWorkspaceRestoreV2;
    recovery: WorkspaceRecovery;
    store: ReturnType<typeof makeStore>;
    order: string[];
    locateSession: ReturnType<typeof vi.fn>;
    withSessionMutation: ReturnType<typeof vi.fn>;
    acquireWriter: ReturnType<typeof vi.fn>;
    applyPath: ReturnType<typeof vi.fn>;
    appendEntries: ReturnType<typeof vi.fn>;
    removeLocked: ReturnType<typeof vi.fn>;
    inspectLocked: ReturnType<typeof vi.fn>;
    readLocked: ReturnType<typeof vi.fn>;
    validateCommitFacts: ReturnType<typeof vi.fn>;
    entry?: SessionTreeEntry;
}

function makeFixture(input: {
    head: string;
    live: CapturedPathStateV1 | "unknown";
    leaf?: string | null;
    sessionMissing?: boolean;
    corrupt?: boolean;
    invalidCommitFacts?: boolean;
}): Fixture {
    const record = pendingRecord();
    const order: string[] = [];
    let active = true;
    let live = structuredClone(input.live);
    let leaf = input.leaf ?? "old-leaf";
    const fixture = {} as Fixture;
    const candidate = (): ScannedPendingWorkspaceRestore => {
        if (!active) return { kind: "none" };
        if (input.corrupt) {
            return {
                kind: "corrupt",
                operationId: record.operationId,
                message: "corrupt pending",
                bytes: Buffer.from("{"),
            };
        }
        return { kind: "valid", record: structuredClone(record) };
    };
    const removeLocked = vi.fn(async () => {
        order.push("remove");
        active = false;
    });
    const inspectLocked = vi.fn(async () => candidate());
    const readLocked = vi.fn(async () => candidate());
    const pending = {
        readCandidate: vi.fn(async () => candidate()),
        inspectLocked,
        readLocked,
        validateCommitFacts: vi.fn(async () => {
            if (input.invalidCommitFacts) throw new Error("invalid durable commit facts");
        }),
        removeLocked,
    };
    const store = makeStore(input.head, order);
    const appendEntries = vi.fn(async (entries: SessionTreeEntry[], options: { expectedLeafId: string | null }) => {
        if (leaf !== options.expectedLeafId) throw new Error("leaf CAS failed");
        fixture.entry = entries[0];
        leaf = entries[0]!.id;
    });
    const session = {
        getLeafId: vi.fn(async () => leaf),
        getEntry: vi.fn(async (id: string) => (fixture.entry?.id === id ? fixture.entry : undefined)),
        appendEntries,
    };
    const locateSession = vi.fn(async () => (input.sessionMissing ? undefined : session));
    const applyPath = vi.fn(async ({ target }: { target: CapturedPathStateV1 }) => {
        order.push("apply");
        live = structuredClone(target);
    });
    const withSessionMutation = vi.fn(async (_sessionPath: string, operation: () => Promise<unknown>) => {
        order.push("session-mutation");
        return operation();
    });
    const acquireWriter = vi.fn(async () => {
        order.push("writer");
        return { release: () => order.push("writer-release") };
    });
    const recovery = new WorkspaceRecovery({
        workspace: store.identity,
        store: store as never,
        pending: pending as never,
        locateSession,
        inspectPath: vi.fn(async () => structuredClone(live)),
        applyPath: applyPath as never,
        verifyWorkspace: async () => {},
        withSessionMutation: withSessionMutation as never,
        writerLeases: { acquire: acquireWriter as never },
    });
    Object.assign(fixture, {
        record,
        recovery,
        store,
        order,
        locateSession,
        withSessionMutation,
        acquireWriter,
        applyPath,
        appendEntries,
        removeLocked,
        inspectLocked,
        readLocked,
        validateCommitFacts: pending.validateCommitFacts,
    });
    return fixture;
}

function makeStore(head: string, order: string[]) {
    const source = snapshot(SourceCommit, "6".repeat(40));
    const planned = snapshot(PlannedCommit, "7".repeat(40));
    let workspaceLockHeld = false;
    return {
        storeRoot: "/private/tmp/crest-recovery-store",
        identity: {
            canonicalRoot: "/private/tmp/crest-recovery-workspace",
            workspaceIdentity: Identity,
            workspaceIncarnation: Incarnation,
            storeKey: "store",
            ancestorIdentityChain: [],
        },
        mutationLog: { readHead: vi.fn(async () => head) },
        readCommitSnapshot: vi.fn(async (commit: string) => {
            if (workspaceLockHeld) throw new Error("commit association read held the workspace lock");
            if (commit === SourceCommit) return source;
            if (commit === PlannedCommit) return planned;
            throw new Error("unknown commit");
        }),
        readPathState: vi.fn(async (ref: WorkspaceSnapshotRefV1) => {
            if (workspaceLockHeld) throw new Error("path derivation held the workspace lock");
            return ref.id === SourceCommit ? Source : Planned;
        }),
        readBlob: vi.fn(),
        withWorkspaceLock: vi.fn(async (operation: () => Promise<unknown>) => {
            order.push("workspace-lock");
            workspaceLockHeld = true;
            try {
                return await operation();
            } finally {
                workspaceLockHeld = false;
            }
        }),
    };
}

async function exactMarker(
    store: ReturnType<typeof makeStore>,
    record: PendingWorkspaceRestoreV2
): Promise<SessionTreeEntry> {
    const derived = await deriveWorkspaceRestoreState(store as never, record);
    return {
        type: "custom",
        id: record.workspaceStateEntryId,
        parentId: record.commitParentId,
        timestamp: record.workspaceStateTimestamp,
        customType: WorkspaceControlCustomTypes.state,
        data: derived.markerState,
    };
}

function pendingRecord(): PendingWorkspaceRestoreV2 {
    return {
        schemaVersion: 2,
        operationId: "operation-1",
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        sessionId: "session-1",
        sessionPath: "/sessions/session-1.db",
        target: { kind: "rewind", targetTurnId: "turn-1" },
        applyMode: "normal",
        forcedPaths: [],
        expectedSemanticLeafId: "old-leaf",
        commitParentId: "commit-parent",
        workspaceStateEntryId: "workspace-state",
        workspaceStateTimestamp: "2026-08-08T00:00:00.000Z",
        sourceCommit: SourceCommit,
        plannedCommit: PlannedCommit,
        affectedPaths: ["file.txt"],
    };
}

function snapshot(id: string, tree: string): WorkspaceSnapshotRefV1 {
    return {
        id,
        tree,
        scopeManifest: "8".repeat(40),
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
    };
}
