// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { SqliteSessionRepo } from "@crest/agent/harness/session/sqlite-repo";
import type { SessionTreeEntry } from "@crest/agent/harness/types";

import { writeDurableJson } from "./durability";
import { scanPendingBoundaryRecords, type PendingWorkspaceBoundaryV1 } from "./pending-boundary-store";
import { PendingWorkspaceRestoreStore } from "./pending-restore-store";
import type { RestoreTargetV1 } from "./restore-plan";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import { WorkspaceControlCustomTypes, type WorkspaceSnapshotRefV1 } from "./types";
import { decodeWorkspaceCheckpointV1, decodeWorkspaceStateV1 } from "./validation";

export const SnapshotRetentionLimits = {
    orphanGraceMs: 7 * 24 * 60 * 60 * 1000,
} as const;

interface OrphanGraceLedgerV1 {
    schemaversion: 1;
    firstseenbyref: Record<string, number>;
}

interface SnapshotOwners {
    snapshots: Map<string, WorkspaceSnapshotRefV1>;
    refs: Set<string>;
    pending: PendingWorkspaceBoundaryV1[];
}

export interface SnapshotReconcileReport {
    removedRefs: string[];
    failClosedReason?: string;
}

export async function reconcileSnapshotRefs(input: {
    store: WorkspaceSnapshotStore;
    sessionsRoot: string;
}): Promise<SnapshotReconcileReport> {
    return input.store.withWorkspaceLock(() => reconcileSnapshotRefsLocked(input));
}

export async function reconcileSnapshotRefsLocked(input: {
    store: WorkspaceSnapshotStore;
    sessionsRoot: string;
}): Promise<SnapshotReconcileReport> {
    let owners: SnapshotOwners;
    try {
        owners = await scanOwners(input);
    } catch (error) {
        return {
            removedRefs: [],
            failClosedReason: `Unable to scan owner source: ${errorMessage(error)}`,
        };
    }

    try {
        for (const snapshot of owners.snapshots.values()) {
            await input.store.verify(snapshot);
        }
        for (const snapshot of owners.snapshots.values()) {
            await input.store.anchorSnapshot(snapshot);
        }
        for (const record of owners.pending) {
            await input.store.anchorPending(record);
        }
        const refs = await input.store.listCrestRefs();
        const ledgerPath = join(input.store.storeRoot, "journal", "orphan-grace.json");
        const ledger = await readLedger(ledgerPath);
        const now = Date.now();
        const liveRefNames = new Set(owners.refs);
        for (const id of owners.snapshots.keys()) {
            liveRefNames.add(`refs/crest/snapshots/${id}`);
        }
        const removedRefs: string[] = [];
        const expiredRefs: Array<{ name: string; oid: string }> = [];
        const next: Record<string, number> = {};
        for (const ref of refs) {
            if (liveRefNames.has(ref.name)) {
                continue;
            }
            const firstSeen = ledger.firstseenbyref[ref.name];
            if (firstSeen == null) {
                next[ref.name] = now;
                continue;
            }
            if (now - firstSeen <= SnapshotRetentionLimits.orphanGraceMs) {
                next[ref.name] = firstSeen;
                continue;
            }
            expiredRefs.push(ref);
        }
        await mkdir(join(input.store.storeRoot, "journal"), { recursive: true, mode: 0o700 });
        await writeDurableJson(ledgerPath, { schemaversion: 1, firstseenbyref: next });
        await input.store.deleteCrestRefs(expiredRefs);
        removedRefs.push(...expiredRefs.map((ref) => ref.name));
        try {
            await input.store.git.run(["reflog", "expire", "--expire=now", "--all"], {
                gitDir: input.store.storeRoot,
                timeoutMs: 30_000,
            });
            await input.store.git.run(["gc", "--prune=now"], {
                gitDir: input.store.storeRoot,
                timeoutMs: 30_000,
            });
            await input.store.reconcileQuotaAccountingAssumingLock();
        } catch (error) {
            return {
                removedRefs,
                failClosedReason: `Snapshot refs removed but Git cleanup failed: ${errorMessage(error)}`,
            };
        }
        return { removedRefs };
    } catch (error) {
        return {
            removedRefs: [],
            failClosedReason: `Snapshot retention failed closed: ${errorMessage(error)}`,
        };
    }
}

async function scanOwners(input: { store: WorkspaceSnapshotStore; sessionsRoot: string }): Promise<SnapshotOwners> {
    const snapshots = new Map<string, WorkspaceSnapshotRefV1>();
    const refs = new Set<string>();
    const repo = new SqliteSessionRepo({ sessionsRoot: input.sessionsRoot });
    const sessions = await repo.scanAllMetadata();
    for (const metadata of sessions) {
        const session = await repo.open(metadata);
        try {
            const entries = await session.getEntries();
            collectSessionOwners(entries, input.store, snapshots);
        } finally {
            session.close();
        }
    }
    const pending = await scanPendingBoundaryRecords(input.store);
    for (const record of pending) {
        assertOwnerIdentity(record.workspaceIdentity, record.workspaceIncarnation, input.store);
        addOwned(record.before, input.store, snapshots);
        if (record.after) {
            addOwned(record.after, input.store, snapshots);
        }
        refs.add(input.store.pendingRefName(record));
    }
    const activeRestore = await new PendingWorkspaceRestoreStore(input.store).readLocked();
    if (activeRestore.kind === "corrupt") {
        throw new Error(`Invalid active pending workspace restore: ${activeRestore.message}`);
    }
    if (activeRestore.kind === "valid") {
        assertOwnerIdentity(
            activeRestore.record.workspaceIdentity,
            activeRestore.record.workspaceIncarnation,
            input.store
        );
        addOwned(await input.store.readCommitSnapshot(activeRestore.record.sourceCommit), input.store, snapshots);
        addOwned(await input.store.readCommitSnapshot(activeRestore.record.plannedCommit), input.store, snapshots);
        const linked = linkedOperation(activeRestore.record.target);
        if (linked) {
            addOwned(linked.sourceSnapshot, input.store, snapshots);
            addOwned(linked.currentSnapshot, input.store, snapshots);
        }
    }
    const workspaceHead = await input.store.mutationLog.readHead();
    if (workspaceHead) {
        addOwned(await input.store.readCommitSnapshot(workspaceHead), input.store, snapshots);
    }
    return { snapshots, refs, pending };
}

function collectSessionOwners(
    entries: SessionTreeEntry[],
    store: Pick<WorkspaceSnapshotStore, "identity">,
    owned: Map<string, WorkspaceSnapshotRefV1>
): void {
    for (const entry of entries) {
        if (entry.type !== "custom") {
            continue;
        }
        if (entry.customType === WorkspaceControlCustomTypes.checkpoint) {
            const checkpoint = decodeWorkspaceCheckpointV1(entry.data);
            if (!checkpoint) {
                throw new Error("Invalid workspace checkpoint owner");
            }
            if (checkpoint.status === "available") {
                addOwned(checkpoint.before, store, owned);
                addOwned(checkpoint.after, store, owned);
            }
            continue;
        }
        if (entry.customType === WorkspaceControlCustomTypes.state) {
            const state = decodeWorkspaceStateV1(entry.data);
            if (!state) {
                throw new Error("Invalid workspace state owner");
            }
            addOwned(state.sourceSnapshot, store, owned);
            addOwned(state.currentSnapshot, store, owned);
            if (state.kind === "redo" || state.kind === "turn-redo") {
                addOwned(state.linkedOperation.sourceSnapshot, store, owned);
                addOwned(state.linkedOperation.currentSnapshot, store, owned);
            }
        }
    }
}

function linkedOperation(target: RestoreTargetV1) {
    return target.kind === "redo" || target.kind === "turn-redo" ? target.linkedOperation : undefined;
}

export function collectSessionSnapshotOwners(
    entries: SessionTreeEntry[],
    store: Pick<WorkspaceSnapshotStore, "identity">
): WorkspaceSnapshotRefV1[] {
    const owned = new Map<string, WorkspaceSnapshotRefV1>();
    collectSessionOwners(entries, store, owned);
    return [...owned.values()];
}

function addOwned(
    snapshot: WorkspaceSnapshotRefV1,
    store: Pick<WorkspaceSnapshotStore, "identity">,
    owned: Map<string, WorkspaceSnapshotRefV1>
): void {
    if (
        snapshot.workspaceIdentity !== store.identity.workspaceIdentity ||
        snapshot.workspaceIncarnation !== store.identity.workspaceIncarnation
    ) {
        return;
    }
    const existing = owned.get(snapshot.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot)) {
        throw new Error("Conflicting workspace snapshot descriptor");
    }
    owned.set(snapshot.id, snapshot);
}

async function readLedger(path: string): Promise<OrphanGraceLedgerV1> {
    let value: unknown;
    try {
        value = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return { schemaversion: 1, firstseenbyref: {} };
        }
        throw error;
    }
    if (!isRecord(value) || value.schemaversion !== 1 || !isRecord(value.firstseenbyref)) {
        throw new Error("Invalid orphan grace ledger");
    }
    const firstseenbyref: Record<string, number> = {};
    for (const [refName, firstSeen] of Object.entries(value.firstseenbyref)) {
        if (
            !isCrestRetentionRef(refName) ||
            typeof firstSeen !== "number" ||
            !Number.isSafeInteger(firstSeen) ||
            firstSeen < 0
        ) {
            throw new Error("Invalid orphan grace ledger entry");
        }
        firstseenbyref[refName] = firstSeen;
    }
    return { schemaversion: 1, firstseenbyref };
}

function isCrestRetentionRef(value: string): boolean {
    return /^refs\/crest\/(?:snapshots\/[0-9a-f]{40}|pending\/[0-9a-f]{64}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}|ops\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.test(
        value
    );
}

function assertOwnerIdentity(
    workspaceIdentity: string,
    workspaceIncarnation: string,
    store: WorkspaceSnapshotStore
): void {
    if (
        workspaceIdentity !== store.identity.workspaceIdentity ||
        workspaceIncarnation !== store.identity.workspaceIncarnation
    ) {
        throw new Error("Owner source belongs to another workspace incarnation");
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
