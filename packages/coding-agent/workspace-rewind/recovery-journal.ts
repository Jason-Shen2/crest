// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { encodeDurableJson, removeDurableFile } from "./durability";
import {
    readAnchoredJournalDirectory,
    removeAnchoredJournalEntry,
    renameAnchoredJournalEntry,
    writeAnchoredJournalEntry,
    type AnchoredJournalDirectoryIdentity,
    type AnchoredJournalEntry,
} from "./journal-directory";
import type { WorkspaceOperationOwnerV1 } from "./pending-boundary-store";
import type { RestoreTargetV1 } from "./restore-plan";
import type { CapturedPathStateV1, WorkspaceCoverageReason, WorkspaceSnapshotRefV1 } from "./types";
import { decodeWorkspaceSnapshotRefV1 } from "./validation";

export type WorkspaceOperationPhase =
    | "prepared"
    | "applying_files"
    | "files_verified"
    | "committing_session"
    | "completed";

export interface WorkspaceOperationPathV1 {
    path: string;
    target: CapturedPathStateV1;
    preState: CapturedPathStateV1;
    expectedCurrent: CapturedPathStateV1;
    confirmedLiveFingerprint: string;
    createdParentDirectories: string[];
}

export interface WorkspaceOperationJournalV1 {
    schemaVersion: 1;
    phase: WorkspaceOperationPhase;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    sessionId: string;
    sessionPath: string;
    operationId: string;
    target: RestoreTargetV1;
    commitParentId: string | null;
    applyMode: "normal" | "force-drift";
    expectedSemanticLeafId: string | null;
    safetySnapshot: WorkspaceSnapshotRefV1;
    confirmedConflictFingerprints: Array<{ path: string; fingerprint: string }>;
    paths: WorkspaceOperationPathV1[];
    workspaceStateEntryId: string;
    resultSnapshot?: WorkspaceSnapshotRefV1;
}

export interface WorkspaceRecoveryJournalStore {
    storeRoot: string;
    identity: {
        workspaceIdentity: string;
        workspaceIncarnation: string;
    };
    anchorOperation(record: WorkspaceOperationOwnerV1): Promise<void>;
    deleteCrestRef(refName: string): Promise<void>;
    scanOperationOwners?(): Promise<WorkspaceOperationOwnerV1[]>;
    deleteOperationOwnerRecord?(operationId: string): Promise<void>;
    withWorkspaceLock?<T>(operation: () => Promise<T>): Promise<T>;
}

export type WorkspaceRecoveryJournalBoundary =
    | `before-${WorkspaceOperationPhase}`
    | `after-${WorkspaceOperationPhase}`
    | "before-journal-remove"
    | "after-journal-remove"
    | "after-operation-ref-remove"
    | "after-operation-owner-remove";

export interface WorkspaceRecoveryJournalTestHooks {
    onDurableBoundary?(boundary: WorkspaceRecoveryJournalBoundary): Promise<void>;
}

export interface ScannedWorkspaceOperationJournal {
    operationId: string;
    corrupt: boolean;
    record?: WorkspaceOperationJournalV1;
    message?: string;
}

const TokenPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IdentityPattern = /^[0-9a-f]{64}$/;
const FingerprintPattern = /^[0-9a-f]{64}$/;
const MaximumJournalBytes = 64 * 1024 * 1024;
const MaximumJournalDirectoryBytes = 64 * 1024 * 1024;
const MaximumJournalEntries = 4_096;
const MaximumJournalPaths = 4_096;
const PhaseOrder: readonly WorkspaceOperationPhase[] = [
    "prepared",
    "applying_files",
    "files_verified",
    "committing_session",
    "completed",
];
const CoverageReasons = new Set([
    "ignored",
    "nested-repository",
    "oversized-untracked",
    "non-utf8-path",
    "hard-linked",
    "special-entry",
    "capture-budget",
]);

export class WorkspaceRecoveryJournal {
    readonly store: WorkspaceRecoveryJournalStore;
    readonly root: string;
    readonly resolvedRoot: string;
    readonly testHooks?: WorkspaceRecoveryJournalTestHooks;
    readonly corruptSources = new Map<string, string>();
    journalRootIdentity?: AnchoredJournalDirectoryIdentity;
    resolvedRootIdentity?: AnchoredJournalDirectoryIdentity;

    constructor(store: WorkspaceRecoveryJournalStore, testHooks?: WorkspaceRecoveryJournalTestHooks) {
        if (!isAbsolute(store.storeRoot)) {
            throw new Error("Recovery journal store root must be absolute");
        }
        this.store = store;
        this.root = join(store.storeRoot, "journal", "restores");
        this.resolvedRoot = join(store.storeRoot, "journal", "resolved");
        this.testHooks = testHooks;
    }

    async begin(record: WorkspaceOperationJournalV1): Promise<void> {
        await this.withWorkspaceLock(() => this.beginUnlocked(record));
    }

    async beginUnlocked(record: WorkspaceOperationJournalV1): Promise<void> {
        const decoded = decodeWorkspaceOperationJournalV1(record);
        if (!decoded || decoded.phase !== "prepared") {
            throw new Error("Invalid prepared workspace operation journal");
        }
        this.assertIdentity(decoded);
        await makePrivateDirectory(this.root);
        const existing = await this.readIfPresent(decoded.operationId);
        if (existing) {
            if (!encodeDurableJson(existing).equals(encodeDurableJson(decoded))) {
                throw new Error("Workspace recovery operation id already exists");
            }
            return;
        }
        const owner = ownerFromJournal(decoded);
        await this.store.anchorOperation(owner);
        await this.writePhase(decoded);
    }

    async transition(
        operationId: string,
        phase: WorkspaceOperationPhase,
        patch: Pick<WorkspaceOperationJournalV1, "resultSnapshot"> = {}
    ): Promise<WorkspaceOperationJournalV1> {
        return this.withWorkspaceLock(() => this.transitionUnlocked(operationId, phase, patch));
    }

    async transitionUnlocked(
        operationId: string,
        phase: WorkspaceOperationPhase,
        patch: Pick<WorkspaceOperationJournalV1, "resultSnapshot">
    ): Promise<WorkspaceOperationJournalV1> {
        const current = await this.read(operationId);
        const currentIndex = PhaseOrder.indexOf(current.phase);
        const nextIndex = PhaseOrder.indexOf(phase);
        if (nextIndex < 0 || (nextIndex !== currentIndex && nextIndex !== currentIndex + 1)) {
            throw new Error(`Invalid workspace recovery phase transition: ${current.phase} -> ${phase}`);
        }
        const next: WorkspaceOperationJournalV1 = {
            ...current,
            phase,
            ...(patch.resultSnapshot == null ? {} : { resultSnapshot: patch.resultSnapshot }),
        };
        if (
            (phase === "files_verified" || phase === "committing_session" || phase === "completed") &&
            !next.resultSnapshot
        ) {
            throw new Error(`${phase} workspace operation requires a result snapshot`);
        }
        if ((phase === "prepared" || phase === "applying_files") && next.resultSnapshot) {
            throw new Error("Result snapshot is valid only after files are verified");
        }
        const decoded = decodeWorkspaceOperationJournalV1(next);
        if (!decoded) {
            throw new Error("Invalid workspace recovery journal transition");
        }
        if (nextIndex === currentIndex) {
            if (!encodeDurableJson(current).equals(encodeDurableJson(decoded))) {
                throw new Error("Idempotent phase transition cannot mutate the journal");
            }
            return current;
        }
        await this.writePhase(decoded);
        return decoded;
    }

    async updatePathProgress(
        operationId: string,
        path: string,
        createdParentDirectories: readonly string[]
    ): Promise<WorkspaceOperationJournalV1> {
        return this.withWorkspaceLock(() =>
            this.updatePathProgressUnlocked(operationId, path, createdParentDirectories)
        );
    }

    async updatePathProgressUnlocked(
        operationId: string,
        path: string,
        createdParentDirectories: readonly string[]
    ): Promise<WorkspaceOperationJournalV1> {
        const current = await this.read(operationId);
        if (current.phase === "prepared" || current.phase === "completed") {
            throw new Error("Workspace path progress is invalid in this recovery phase");
        }
        const index = current.paths.findIndex((item) => item.path === path);
        if (index < 0) {
            throw new Error("Workspace path progress does not belong to the operation");
        }
        const paths = current.paths.map((item, itemIndex) =>
            itemIndex === index
                ? { ...item, createdParentDirectories: [...new Set(createdParentDirectories)].sort(comparePathBytes) }
                : item
        );
        const next = { ...current, paths };
        const decoded = decodeWorkspaceOperationJournalV1(next);
        if (!decoded) {
            throw new Error("Invalid workspace path progress");
        }
        await this.writePhase(decoded);
        return decoded;
    }

    async read(operationId: string): Promise<WorkspaceOperationJournalV1> {
        validateToken(operationId);
        const directory = await this.readAnchoredRoot("journal");
        const entry = directory?.entries.find((item) => item.name === `${operationId}.json`);
        if (!entry) {
            throw new Error(`Workspace recovery journal not found: ${operationId}`);
        }
        const decoded = decodeJournalBytes(entry.bytes);
        if (!decoded || decoded.operationId !== operationId) {
            throw new Error(`Workspace recovery journal is corrupt: ${operationId}`);
        }
        this.assertIdentity(decoded);
        return decoded;
    }

    async readIfPresent(operationId: string): Promise<WorkspaceOperationJournalV1 | undefined> {
        try {
            return await this.read(operationId);
        } catch (error) {
            if (error instanceof Error && error.message.includes("not found")) {
                return undefined;
            }
            throw error;
        }
    }

    async scan(): Promise<ScannedWorkspaceOperationJournal[]> {
        return this.withWorkspaceLock(() => this.scanUnlocked());
    }

    async scanCandidates(): Promise<ScannedWorkspaceOperationJournal[]> {
        return this.scanUnlocked(false);
    }

    async scanUnlocked(reconcileAtomicTemps = true): Promise<ScannedWorkspaceOperationJournal[]> {
        let directory = await this.readAnchoredRoot("journal");
        if (!directory) {
            return [];
        }
        if (reconcileAtomicTemps) {
            await this.reconcileAtomicTemps(directory.identity, directory.entries);
            directory = await this.readAnchoredRoot("journal");
            if (!directory) {
                throw new Error("Workspace recovery journal directory disappeared while scanning");
            }
        }
        this.corruptSources.clear();
        const results: ScannedWorkspaceOperationJournal[] = [];
        for (const entry of directory.entries) {
            const name = entry.name;
            if (!reconcileAtomicTemps && /^\.[0-9a-f]{32}\.tmp$/.test(name)) {
                continue;
            }
            if (/^\.[0-9a-f]{32}\.tmp$/.test(name)) {
                const quarantineToken = recoveryJournalOperationTokenForFilename(name);
                this.corruptSources.set(quarantineToken, name);
                results.push({
                    operationId: quarantineToken,
                    corrupt: true,
                    message: "Invalid atomic workspace recovery journal temp",
                });
                continue;
            }
            const operationId = name.endsWith(".json") ? name.slice(0, -5) : name;
            if (!name.endsWith(".json") || !TokenPattern.test(operationId)) {
                const quarantineToken = recoveryJournalOperationTokenForFilename(name);
                this.corruptSources.set(quarantineToken, name);
                results.push({
                    operationId: quarantineToken,
                    corrupt: true,
                    message: "Invalid workspace recovery journal filename",
                });
                continue;
            }
            try {
                const record = decodeJournalBytes(entry.bytes);
                if (!record || record.operationId !== operationId) {
                    throw new Error("Invalid workspace recovery journal");
                }
                results.push({ operationId, corrupt: false, record });
            } catch (error) {
                this.corruptSources.set(operationId, name);
                results.push({
                    operationId,
                    corrupt: true,
                    message: error instanceof Error ? error.message : "Invalid workspace recovery journal",
                });
            }
        }
        return results;
    }

    async reconcileAtomicTemps(
        rootIdentity: AnchoredJournalDirectoryIdentity,
        entries: readonly AnchoredJournalEntry[]
    ): Promise<void> {
        const temporaryEntries = entries.filter((entry) => /^\.[0-9a-f]{32}\.tmp$/.test(entry.name));
        if (temporaryEntries.length === 0) {
            return;
        }
        const publishedNames = new Set(entries.map((entry) => entry.name));
        for (const entry of temporaryEntries.sort((left, right) => left.name.localeCompare(right.name))) {
            const record = decodeJournalBytes(entry.bytes);
            if (!record) {
                continue;
            }
            this.assertIdentity(record);
            const destinationName = `${record.operationId}.json`;
            if (publishedNames.has(destinationName)) {
                await removeAnchoredJournalEntry({
                    root: this.root,
                    rootIdentity,
                    source: entry,
                });
                continue;
            }
            await renameAnchoredJournalEntry({
                root: this.root,
                rootIdentity,
                source: entry,
                destinationName,
            });
            publishedNames.add(destinationName);
        }
    }

    async reconcileOwnership(): Promise<void> {
        await this.withWorkspaceLock(() => this.reconcileOwnershipUnlocked());
    }

    async reconcileOwnershipUnlocked(): Promise<void> {
        if (!this.store.scanOperationOwners) {
            return;
        }
        const journals = await this.scanUnlocked();
        const owners = await this.store.scanOperationOwners();
        const journalsById = new Map(journals.map((item) => [item.operationId, item]));
        const ownersById = new Map(owners.map((owner) => [owner.operationId, owner]));
        for (const item of journals) {
            if (item.corrupt || !item.record) {
                continue;
            }
            const expected = ownerFromJournal(item.record);
            const owner = ownersById.get(item.operationId);
            if (!owner) {
                await this.store.anchorOperation(expected);
                continue;
            }
            if (!encodeDurableJson(owner).equals(encodeDurableJson(expected))) {
                throw new Error(`Workspace operation owner conflicts with recovery journal: ${item.operationId}`);
            }
        }
        for (const owner of owners) {
            if (journalsById.has(owner.operationId)) {
                continue;
            }
            await this.store.deleteCrestRef(`refs/crest/ops/${owner.operationId}`);
            if (this.store.deleteOperationOwnerRecord) {
                await this.store.deleteOperationOwnerRecord(owner.operationId);
            } else {
                await removeDurableFile(
                    join(this.store.storeRoot, "journal", "operations", `${owner.operationId}.json`)
                );
            }
        }
    }

    async completeCleanup(operationId: string): Promise<void> {
        await this.withWorkspaceLock(() => this.completeCleanupUnlocked(operationId));
    }

    async completeCleanupUnlocked(operationId: string): Promise<void> {
        validateToken(operationId);
        await this.testHooks?.onDurableBoundary?.("before-journal-remove");
        await this.removeJournalEntryIfPresent(`${operationId}.json`);
        await this.testHooks?.onDurableBoundary?.("after-journal-remove");
        await this.store.deleteCrestRef(`refs/crest/ops/${operationId}`);
        await this.testHooks?.onDurableBoundary?.("after-operation-ref-remove");
        await this.deleteOperationOwnerRecord(operationId);
        await this.testHooks?.onDurableBoundary?.("after-operation-owner-remove");
    }

    async resolveToAudit(
        operationId: string,
        resolution: "abandon-current" | "quarantine-corrupt",
        now = Date.now()
    ): Promise<void> {
        await this.withWorkspaceLock(() => this.resolveToAuditUnlocked(operationId, resolution, now));
    }

    async resolveToAuditUnlocked(
        operationId: string,
        resolution: "abandon-current" | "quarantine-corrupt",
        now: number
    ): Promise<void> {
        validateToken(operationId);
        if (!Number.isSafeInteger(now) || now < 0) {
            throw new Error("Invalid recovery resolution time");
        }
        await makePrivateDirectory(this.resolvedRoot);
        const sourceDirectory = await this.readAnchoredRoot("journal");
        const sourceName =
            resolution === "quarantine-corrupt"
                ? (this.corruptSources.get(operationId) ?? `${operationId}.json`)
                : `${operationId}.json`;
        const source = sourceDirectory?.entries.find((entry) => entry.name === sourceName);
        if (!sourceDirectory || !source) {
            throw new Error(`Workspace recovery journal not found: ${operationId}`);
        }
        let auditBytes: Buffer;
        if (resolution === "quarantine-corrupt") {
            auditBytes = source.bytes;
        } else {
            const record = decodeJournalBytes(source.bytes);
            if (!record || record.operationId !== operationId) {
                throw new Error(`Workspace recovery journal is corrupt: ${operationId}`);
            }
            this.assertIdentity(record);
            auditBytes = encodeDurableJson({
                ...record,
                operationId,
                resolution,
                resolvedAt: new Date(now).toISOString(),
                retainUntil: new Date(now + 30 * 24 * 60 * 60 * 1_000).toISOString(),
            });
        }
        const destinationName = `${operationId}-${now}-${resolution}.json`;
        const resolvedDirectory = await this.readAnchoredRoot("resolved");
        if (!resolvedDirectory) {
            throw new Error("Workspace recovery resolved audit directory disappeared");
        }
        const existing = resolvedDirectory.entries.find((entry) => entry.name === destinationName);
        if (existing) {
            if (!existing.bytes.equals(auditBytes)) {
                throw new Error("Workspace recovery resolved audit destination conflicts");
            }
        } else {
            await writeAnchoredJournalEntry({
                root: this.resolvedRoot,
                rootIdentity: resolvedDirectory.identity,
                destinationName,
                bytes: auditBytes,
            });
        }
        await removeAnchoredJournalEntry({
            root: this.root,
            rootIdentity: sourceDirectory.identity,
            source,
        });
        this.corruptSources.delete(operationId);
        await this.store.deleteCrestRef(`refs/crest/ops/${operationId}`);
        await this.deleteOperationOwnerRecord(operationId);
    }

    async pruneResolvedAudit(now = Date.now()): Promise<void> {
        if (!Number.isSafeInteger(now) || now < 0) {
            throw new Error("Invalid recovery audit prune time");
        }
        const directory = await this.readAnchoredRoot("resolved");
        if (!directory) {
            return;
        }
        for (const entry of directory.entries) {
            const { name } = entry;
            const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})-(\d+)-(abandon-current|quarantine-corrupt)\.json$/.exec(
                name
            );
            if (!match) {
                throw new Error("Invalid resolved recovery audit filename");
            }
            const resolvedAt = Number(match[2]);
            if (!Number.isSafeInteger(resolvedAt) || resolvedAt + 30 * 24 * 60 * 60 * 1_000 > now) {
                continue;
            }
            await removeAnchoredJournalEntry({
                root: this.resolvedRoot,
                rootIdentity: directory.identity,
                source: entry,
            });
        }
    }

    path(operationId: string): string {
        validateToken(operationId);
        return join(this.root, `${operationId}.json`);
    }

    async writePhase(record: WorkspaceOperationJournalV1): Promise<void> {
        await this.testHooks?.onDurableBoundary?.(`before-${record.phase}`);
        await makePrivateDirectory(this.root);
        const directory = await this.readAnchoredRoot("journal");
        if (!directory) {
            throw new Error("Workspace recovery journal directory disappeared before write");
        }
        const destinationName = `${record.operationId}.json`;
        await writeAnchoredJournalEntry({
            root: this.root,
            rootIdentity: directory.identity,
            destinationName,
            bytes: encodeDurableJson(record),
            expectedDestination: directory.entries.find((entry) => entry.name === destinationName),
        });
        await this.testHooks?.onDurableBoundary?.(`after-${record.phase}`);
    }

    async withWorkspaceLock<T>(operation: () => Promise<T>): Promise<T> {
        if (this.store.withWorkspaceLock) {
            return this.store.withWorkspaceLock(operation);
        }
        return operation();
    }

    async deleteOperationOwnerRecord(operationId: string): Promise<void> {
        if (this.store.deleteOperationOwnerRecord) {
            await this.store.deleteOperationOwnerRecord(operationId);
            return;
        }
        await removeDurableFile(join(this.store.storeRoot, "journal", "operations", `${operationId}.json`));
    }

    async readAnchoredRoot(
        kind: "journal" | "resolved"
    ): Promise<{ identity: AnchoredJournalDirectoryIdentity; entries: AnchoredJournalEntry[] } | undefined> {
        const root = kind === "journal" ? this.root : this.resolvedRoot;
        const directory = await readAnchoredJournalDirectory({
            root,
            maximumEntries: MaximumJournalEntries,
            maximumEntryBytes: MaximumJournalBytes,
            maximumTotalBytes: MaximumJournalDirectoryBytes,
        });
        const expected = kind === "journal" ? this.journalRootIdentity : this.resolvedRootIdentity;
        if (!directory) {
            if (expected) {
                throw new Error("Workspace recovery journal directory disappeared");
            }
            return undefined;
        }
        if (expected && !sameAnchoredIdentity(expected, directory.identity)) {
            throw new Error("Workspace recovery journal directory identity changed");
        }
        if (kind === "journal") {
            this.journalRootIdentity ??= directory.identity;
        } else {
            this.resolvedRootIdentity ??= directory.identity;
        }
        return directory;
    }

    async removeJournalEntryIfPresent(name: string): Promise<void> {
        const directory = await this.readAnchoredRoot("journal");
        const source = directory?.entries.find((entry) => entry.name === name);
        if (!directory || !source) {
            return;
        }
        await removeAnchoredJournalEntry({
            root: this.root,
            rootIdentity: directory.identity,
            source,
        });
    }

    assertIdentity(record: WorkspaceOperationJournalV1): void {
        if (
            record.workspaceIdentity !== this.store.identity.workspaceIdentity ||
            record.workspaceIncarnation !== this.store.identity.workspaceIncarnation
        ) {
            throw new Error("Workspace recovery journal belongs to another workspace incarnation");
        }
    }
}

function ownerFromJournal(record: WorkspaceOperationJournalV1): WorkspaceOperationOwnerV1 {
    return {
        operationId: record.operationId,
        sessionId: record.sessionId,
        workspaceIdentity: record.workspaceIdentity,
        workspaceIncarnation: record.workspaceIncarnation,
        snapshot: record.safetySnapshot,
    };
}

export function recoveryJournalOperationTokenForFilename(name: string): string {
    const operationId = name.endsWith(".json") ? name.slice(0, -5) : name;
    if (name.endsWith(".json") && TokenPattern.test(operationId)) {
        return operationId;
    }
    return `corrupt-${createHash("sha1").update(name).digest("hex")}`;
}

export function decodeWorkspaceOperationJournalV1(value: unknown): WorkspaceOperationJournalV1 | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const required = [
        "schemaVersion",
        "phase",
        "workspaceIdentity",
        "workspaceIncarnation",
        "sessionId",
        "sessionPath",
        "operationId",
        "target",
        "commitParentId",
        "applyMode",
        "expectedSemanticLeafId",
        "safetySnapshot",
        "confirmedConflictFingerprints",
        "paths",
        "workspaceStateEntryId",
    ];
    if (!hasExactKeys(value, required, ["resultSnapshot"])) {
        return undefined;
    }
    if (
        value.schemaVersion !== 1 ||
        !PhaseOrder.includes(value.phase as WorkspaceOperationPhase) ||
        !isIdentity(value.workspaceIdentity) ||
        !isIdentity(value.workspaceIncarnation) ||
        !isSafeString(value.sessionId) ||
        !isAbsoluteSafePath(value.sessionPath) ||
        !TokenPattern.test(String(value.operationId ?? "")) ||
        (value.applyMode !== "normal" && value.applyMode !== "force-drift") ||
        (value.expectedSemanticLeafId != null && !isSafeString(value.expectedSemanticLeafId)) ||
        (value.commitParentId != null && !isSafeString(value.commitParentId)) ||
        !isSafeString(value.workspaceStateEntryId) ||
        !Array.isArray(value.confirmedConflictFingerprints) ||
        !Array.isArray(value.paths) ||
        value.paths.length > MaximumJournalPaths
    ) {
        return undefined;
    }
    const target = decodeRestoreTargetV1(value.target);
    if (!target) {
        return undefined;
    }
    if (value.applyMode === "force-drift" && target.kind !== "rewind" && target.kind !== "turn-undo") {
        return undefined;
    }
    const safetySnapshot = decodeWorkspaceSnapshotRefV1(value.safetySnapshot);
    const resultSnapshot =
        value.resultSnapshot == null ? undefined : decodeWorkspaceSnapshotRefV1(value.resultSnapshot);
    if (
        !safetySnapshot ||
        !snapshotMatchesIdentity(safetySnapshot, value.workspaceIdentity, value.workspaceIncarnation) ||
        (value.resultSnapshot != null &&
            (!resultSnapshot ||
                !snapshotMatchesIdentity(resultSnapshot, value.workspaceIdentity, value.workspaceIncarnation))) ||
        ((value.phase === "files_verified" || value.phase === "committing_session" || value.phase === "completed") &&
            !resultSnapshot) ||
        ((value.phase === "prepared" || value.phase === "applying_files") && resultSnapshot != null)
    ) {
        return undefined;
    }
    const conflicts: Array<{ path: string; fingerprint: string }> = [];
    const conflictPaths = new Set<string>();
    for (const item of value.confirmedConflictFingerprints) {
        if (
            !isRecord(item) ||
            !hasExactKeys(item, ["path", "fingerprint"]) ||
            !isCanonicalRelativePath(item.path) ||
            !FingerprintPattern.test(String(item.fingerprint ?? "")) ||
            conflictPaths.has(item.path)
        ) {
            return undefined;
        }
        conflictPaths.add(item.path);
        conflicts.push({ path: item.path, fingerprint: item.fingerprint as string });
    }
    if (value.applyMode === "normal" && conflicts.length > 0) {
        return undefined;
    }
    const paths: WorkspaceOperationPathV1[] = [];
    const seenPaths = new Set<string>();
    for (const item of value.paths) {
        const decoded = decodeOperationPath(item);
        if (!decoded || seenPaths.has(decoded.path)) {
            return undefined;
        }
        seenPaths.add(decoded.path);
        paths.push(decoded);
    }
    if (
        conflicts.some((item) => !seenPaths.has(item.path)) ||
        !isSorted(conflicts.map((item) => item.path)) ||
        !isSorted(paths.map((item) => item.path))
    ) {
        return undefined;
    }
    return {
        schemaVersion: 1,
        phase: value.phase as WorkspaceOperationPhase,
        workspaceIdentity: value.workspaceIdentity as string,
        workspaceIncarnation: value.workspaceIncarnation as string,
        sessionId: value.sessionId as string,
        sessionPath: value.sessionPath as string,
        operationId: value.operationId as string,
        target,
        commitParentId: value.commitParentId as string | null,
        applyMode: value.applyMode,
        expectedSemanticLeafId: value.expectedSemanticLeafId as string | null,
        safetySnapshot,
        confirmedConflictFingerprints: conflicts,
        paths,
        workspaceStateEntryId: value.workspaceStateEntryId as string,
        ...(resultSnapshot == null ? {} : { resultSnapshot }),
    };
}

function decodeRestoreTargetV1(value: unknown): RestoreTargetV1 | undefined {
    if (!isRecord(value)) return undefined;
    if (value.kind === "rewind" && hasExactKeys(value, ["kind", "targetTurnId"]) && isSafeString(value.targetTurnId)) {
        return { kind: "rewind", targetTurnId: value.targetTurnId };
    }
    if (value.kind === "redo" && hasExactKeys(value, ["kind"])) {
        return { kind: "redo" };
    }
    if (
        value.kind === "turn-undo" &&
        hasExactKeys(value, ["kind", "sourceTurnId"]) &&
        isSafeString(value.sourceTurnId)
    ) {
        return { kind: "turn-undo", sourceTurnId: value.sourceTurnId };
    }
    if (
        value.kind === "turn-redo" &&
        hasExactKeys(value, ["kind", "sourceTurnId", "undoOperationId"]) &&
        isSafeString(value.sourceTurnId) &&
        isSafeString(value.undoOperationId)
    ) {
        return {
            kind: "turn-redo",
            sourceTurnId: value.sourceTurnId,
            undoOperationId: value.undoOperationId,
        };
    }
    return undefined;
}

function decodeOperationPath(value: unknown): WorkspaceOperationPathV1 | undefined {
    if (
        !isRecord(value) ||
        !hasExactKeys(value, [
            "path",
            "target",
            "preState",
            "expectedCurrent",
            "confirmedLiveFingerprint",
            "createdParentDirectories",
        ]) ||
        !isCanonicalRelativePath(value.path) ||
        !FingerprintPattern.test(String(value.confirmedLiveFingerprint ?? "")) ||
        !Array.isArray(value.createdParentDirectories)
    ) {
        return undefined;
    }
    const target = decodeCapturedState(value.target);
    const preState = decodeCapturedState(value.preState);
    const expectedCurrent = decodeCapturedState(value.expectedCurrent);
    if (
        !target ||
        !preState ||
        !expectedCurrent ||
        target.state === "excluded" ||
        preState.state === "excluded" ||
        expectedCurrent.state === "excluded" ||
        encodeDurableJson(target).equals(encodeDurableJson(preState))
    ) {
        return undefined;
    }
    const createdParentDirectories: string[] = [];
    for (const path of value.createdParentDirectories) {
        if (
            !isCanonicalRelativePath(path) ||
            createdParentDirectories.includes(path) ||
            !isAncestorPath(path, value.path)
        ) {
            return undefined;
        }
        createdParentDirectories.push(path);
    }
    if (!isSorted(createdParentDirectories)) {
        return undefined;
    }
    return {
        path: value.path as string,
        target,
        preState,
        expectedCurrent,
        confirmedLiveFingerprint: value.confirmedLiveFingerprint as string,
        createdParentDirectories,
    };
}

function decodeCapturedState(value: unknown): CapturedPathStateV1 | undefined {
    if (!isRecord(value) || typeof value.state !== "string") {
        return undefined;
    }
    if (value.state === "absent") {
        return hasExactKeys(value, ["state"]) ? { state: "absent" } : undefined;
    }
    if (value.state === "file") {
        if (
            !hasExactKeys(value, ["state", "oid", "executable"]) ||
            !isOid(value.oid) ||
            typeof value.executable !== "boolean"
        ) {
            return undefined;
        }
        return { state: "file", oid: value.oid, executable: value.executable };
    }
    if (value.state === "symlink") {
        return hasExactKeys(value, ["state", "oid"]) && isOid(value.oid)
            ? { state: "symlink", oid: value.oid }
            : undefined;
    }
    if (value.state === "excluded") {
        return hasExactKeys(value, ["state", "reason"]) && CoverageReasons.has(String(value.reason))
            ? { state: "excluded", reason: value.reason as WorkspaceCoverageReason }
            : undefined;
    }
    return undefined;
}

function decodeJournalBytes(bytes: Buffer): WorkspaceOperationJournalV1 | undefined {
    let value: unknown;
    try {
        value = JSON.parse(bytes.toString("utf8"));
    } catch {
        return undefined;
    }
    const decoded = decodeWorkspaceOperationJournalV1(value);
    if (!decoded || !bytes.equals(encodeDurableJson(decoded))) {
        return undefined;
    }
    return decoded;
}

async function makePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const state = await lstat(path, { bigint: true });
    if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077n) !== 0n) {
        throw new Error("Workspace recovery journal directory is unsafe");
    }
}

function isAncestorPath(parent: string, path: unknown): boolean {
    return typeof path === "string" && path.startsWith(`${parent}/`);
}

function snapshotMatchesIdentity(snapshot: WorkspaceSnapshotRefV1, identity: unknown, incarnation: unknown): boolean {
    return snapshot.workspaceIdentity === identity && snapshot.workspaceIncarnation === incarnation;
}

function isCanonicalRelativePath(path: unknown): path is string {
    return (
        typeof path === "string" &&
        path.length > 0 &&
        path.length <= 4_096 &&
        !path.includes("\0") &&
        !path.includes("\\") &&
        !path.startsWith("/") &&
        !/^[A-Za-z]:/.test(path) &&
        path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    );
}

function isAbsoluteSafePath(path: unknown): path is string {
    return typeof path === "string" && isAbsolute(path) && path.length <= 16_384 && !path.includes("\0");
}

function isSafeString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !value.includes("\0");
}

function isIdentity(value: unknown): value is string {
    return typeof value === "string" && IdentityPattern.test(value);
}

function isOid(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function validateToken(value: string): void {
    if (!TokenPattern.test(value)) {
        throw new Error("Invalid workspace recovery operation id");
    }
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
    const allowed = new Set([...required, ...optional]);
    return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function isSorted(paths: readonly string[]): boolean {
    return paths.every((path, index) => index === 0 || comparePathBytes(paths[index - 1]!, path) < 0);
}

function comparePathBytes(left: string, right: string): number {
    return Buffer.from(left).compare(Buffer.from(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

function sameAnchoredIdentity(
    left: AnchoredJournalDirectoryIdentity,
    right: AnchoredJournalDirectoryIdentity
): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}
