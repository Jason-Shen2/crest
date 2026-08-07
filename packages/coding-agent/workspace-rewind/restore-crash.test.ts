// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { expect, test, vi } from "vitest";

import type { PendingWorkspaceRestoreV2, ScannedPendingWorkspaceRestore } from "./pending-restore-store";
import type { CapturedPathStateV1, WorkspaceSnapshotRefV1 } from "./types";
import { WorkspaceRecovery } from "./workspace-recovery";

const SourceCommit = "1".repeat(40);
const PlannedCommit = "2".repeat(40);
const UnknownCommit = "3".repeat(40);
const Identity = "4".repeat(64);
const Incarnation = "5".repeat(64);
const Source = { state: "file", oid: "6".repeat(40), executable: false } as const;
const Planned = { state: "file", oid: "7".repeat(40), executable: false } as const;

test("crash before pending publication has no recovery work", async () => {
    const fixture = crashFixture({ pending: false, head: SourceCommit, live: Source });

    await expect(fixture.recovery.resolvePending()).resolves.toEqual({ state: "none" });

    expect(fixture.applyPath).not.toHaveBeenCalled();
    expect(fixture.appendEntries).not.toHaveBeenCalled();
});

test("crash with source head and partially applied paths restores source", async () => {
    const fixture = crashFixture({ pending: true, head: SourceCommit, live: Planned });

    await expect(fixture.recovery.resolvePending()).resolves.toEqual({
        state: "not-committed",
        operationId: "operation-1",
    });

    expect(fixture.applyPath).toHaveBeenCalledOnce();
    expect(fixture.removeLocked).toHaveBeenCalledOnce();
});

test("crash with planned head and leaf pending completes the exact leaf CAS", async () => {
    const fixture = crashFixture({ pending: true, head: PlannedCommit, live: Planned });

    await expect(fixture.recovery.resolvePending()).resolves.toEqual({
        state: "committed",
        operationId: "operation-1",
    });

    expect(fixture.appendEntries).toHaveBeenCalledOnce();
    expect(fixture.removeLocked).toHaveBeenCalledOnce();
});

test.each([
    { head: UnknownCommit, live: Planned as CapturedPathStateV1 },
    { head: SourceCommit, live: "unknown" as const },
])("unknown post-crash fact state is diagnostic-only", async ({ head, live }) => {
    const fixture = crashFixture({ pending: true, head, live });

    await expect(fixture.recovery.resolvePending()).resolves.toMatchObject({
        state: "needs-user",
        view: { allowedActions: ["retry"] },
    });

    expect(fixture.applyPath).not.toHaveBeenCalled();
    expect(fixture.appendEntries).not.toHaveBeenCalled();
    expect(fixture.removeLocked).not.toHaveBeenCalled();
});

function crashFixture(input: {
    pending: boolean;
    head: string;
    live: CapturedPathStateV1 | "unknown";
}) {
    const record = pendingRecord();
    let active = input.pending;
    let live = structuredClone(input.live);
    let leaf = "old-leaf";
    const entries = new Map<string, SessionTreeEntry>();
    const candidate = (): ScannedPendingWorkspaceRestore =>
        active ? { kind: "valid", record } : { kind: "none" };
    const removeLocked = vi.fn(async () => {
        active = false;
    });
    const pending = {
        readCandidate: vi.fn(async () => candidate()),
        readLocked: vi.fn(async () => candidate()),
        removeLocked,
    };
    const source = snapshot(SourceCommit, "8".repeat(40));
    const planned = snapshot(PlannedCommit, "9".repeat(40));
    const store = {
        storeRoot: "/private/tmp/crest-crash-store",
        identity: {
            canonicalRoot: "/private/tmp/crest-crash-workspace",
            workspaceIdentity: Identity,
            workspaceIncarnation: Incarnation,
            storeKey: "store",
            ancestorIdentityChain: [],
        },
        mutationLog: { readHead: vi.fn(async () => input.head) },
        readCommitSnapshot: vi.fn(async (commit: string) => (commit === SourceCommit ? source : planned)),
        readPathState: vi.fn(async (ref: WorkspaceSnapshotRefV1) => (ref.id === SourceCommit ? Source : Planned)),
        readBlob: vi.fn(),
        withWorkspaceLock: vi.fn(async (operation: () => Promise<unknown>) => operation()),
    };
    const appendEntries = vi.fn(async (next: SessionTreeEntry[], options: { expectedLeafId: string | null }) => {
        if (leaf !== options.expectedLeafId) throw new Error("leaf CAS failed");
        for (const entry of next) entries.set(entry.id, structuredClone(entry));
        leaf = next.at(-1)!.id;
    });
    const session = {
        getLeafId: vi.fn(async () => leaf),
        getEntry: vi.fn(async (id: string) => entries.get(id)),
        appendEntries,
    };
    const applyPath = vi.fn(async ({ target }: { target: CapturedPathStateV1 }) => {
        live = structuredClone(target);
    });
    const recovery = new WorkspaceRecovery({
        workspace: store.identity,
        store: store as never,
        pending: pending as never,
        locateSession: async () => session,
        inspectPath: async () => structuredClone(live),
        applyPath: applyPath as never,
        verifyWorkspace: async () => {},
        withSessionMutation: async (_path, operation) => operation(),
        writerLeases: { acquire: async () => ({ release() {} }) } as never,
    });
    return { recovery, applyPath, appendEntries, removeLocked };
}

function pendingRecord(): PendingWorkspaceRestoreV2 {
    return {
        schemaVersion: 2,
        operationId: "operation-1",
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        sessionId: "session-1",
        sessionPath: "/sessions/session-1.db",
        target: { kind: "turn-undo", sourceTurnId: "turn-1" },
        applyMode: "normal",
        forcedPaths: [],
        expectedSemanticLeafId: "old-leaf",
        commitParentId: "old-leaf",
        workspaceStateEntryId: "workspace-state-1",
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
        scopeManifest: "a".repeat(40),
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
    };
}
