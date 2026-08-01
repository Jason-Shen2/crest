// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SessionTreeEntry } from "@crest/agent/harness/types";

import { removeCreatedWorkspaceDirectories } from "./created-directory-cleanup";
import { encodeDurableJson } from "./durability";
import {
    applyCapturedPath,
    reconcileInterruptedCapturedPathArtifacts,
    type WorkspacePathApplyProgress,
} from "./filesystem-apply";
import { inspectLivePath, type LiveCapturedPathState } from "./live-path-state";
import {
    WorkspaceRecoveryJournal,
    type ScannedWorkspaceOperationJournal,
    type WorkspaceOperationJournalV1,
    type WorkspaceOperationPathV1,
} from "./recovery-journal";
import { decodeWorkspaceStateEntry } from "./session-state";
import type { CapturedPathStateV1, WorkspaceSnapshotRefV1 } from "./types";
import { verifyCanonicalWorkspaceIdentity, type CanonicalWorkspaceIdentity } from "./workspace-identity";
import { workspaceStateFromJournal } from "./workspace-restore-executor";

export interface WorkspaceRecoveryView {
    operationId: string;
    phase?: WorkspaceOperationJournalV1["phase"];
    corrupt: boolean;
    message: string;
    paths: Array<{ path: string; classification?: "pre" | "target" | "unknown" }>;
    allowedActions: Array<"retry" | "abandon-current" | "quarantine-corrupt">;
}

export interface WorkspaceRecoveryCoordinator {
    scanKnownJournals(): Promise<void>;
    ensureRecovered(workspace: CanonicalWorkspaceIdentity): Promise<void>;
    getRecoveryState(workspace: CanonicalWorkspaceIdentity): Promise<WorkspaceRecoveryView | undefined>;
    retry(operationId: string, assertCurrent?: WorkspaceRecoveryMutationGuard): Promise<void>;
    abandonKeepingCurrent(
        operationId: string,
        binding?: WorkspaceRecoveryOwnerBinding,
        assertCurrent?: WorkspaceRecoveryMutationGuard
    ): Promise<void>;
    quarantineCorrupt(operationId: string, assertCurrent?: WorkspaceRecoveryMutationGuard): Promise<void>;
    assertWorkspaceWritable(workspace: CanonicalWorkspaceIdentity): Promise<void>;
}

export type WorkspaceRecoveryMutationGuard = () => Promise<void>;

export interface WorkspaceRecoveryOwnerBinding {
    sessionId: string;
    locateBoundOwner(): Promise<WorkspaceRecoverySession | undefined>;
}

interface WorkspaceRecoveryMutationScope {
    failure?: unknown;
    assertCurrent(): Promise<void>;
}

export interface WorkspaceRecoverySession {
    getLeafId(): Promise<string | null>;
    getEntry(id: string): Promise<SessionTreeEntry | undefined>;
}

export interface WorkspaceRecoveryStore {
    storeRoot: string;
    identity: CanonicalWorkspaceIdentity;
    readBlob(oid: string): Promise<Buffer>;
    verify(snapshot: WorkspaceSnapshotRefV1): Promise<void>;
    withWorkspaceLock?<T>(operation: () => Promise<T>): Promise<T>;
}

export interface WorkspaceRecoveryOptions {
    workspace: CanonicalWorkspaceIdentity;
    store: WorkspaceRecoveryStore;
    journal: WorkspaceRecoveryJournal;
    locateSession(sessionId: string): Promise<WorkspaceRecoverySession | undefined>;
    inspectPath?: (path: string) => Promise<CapturedPathStateV1 | "unknown">;
    applyPath?: (input: {
        operationId: string;
        path: string;
        expectedCurrent: CapturedPathStateV1;
        target: CapturedPathStateV1;
        progress: WorkspacePathApplyProgress;
    }) => Promise<void>;
    publishState?: (sessionId: string) => Promise<void>;
    repairSessionRefs?: (sessionId: string) => Promise<void>;
    verifyWorkspace?: (workspace: CanonicalWorkspaceIdentity) => Promise<void>;
    withSessionLease?: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
    assertCurrent?: () => Promise<void>;
}

interface ClassifiedOperation {
    record: WorkspaceOperationJournalV1;
    session: WorkspaceRecoverySession;
    leafId: string | null;
    exactOperationLeaf: boolean;
    paths: Array<{
        journalPath: WorkspaceOperationPathV1;
        classification: "pre" | "target" | "unknown";
    }>;
}

export class WorkspaceFrozenError extends Error {
    readonly operationId: string;

    constructor(operationId: string, message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "WorkspaceFrozenError";
        this.operationId = operationId;
    }
}

export class WorkspaceRecovery implements WorkspaceRecoveryCoordinator {
    readonly workspace: CanonicalWorkspaceIdentity;
    readonly store: WorkspaceRecoveryStore;
    readonly journal: WorkspaceRecoveryJournal;
    readonly locateSession: WorkspaceRecoveryOptions["locateSession"];
    readonly inspectPath: NonNullable<WorkspaceRecoveryOptions["inspectPath"]>;
    readonly applyPath: NonNullable<WorkspaceRecoveryOptions["applyPath"]>;
    readonly publishState: NonNullable<WorkspaceRecoveryOptions["publishState"]>;
    readonly repairSessionRefs: NonNullable<WorkspaceRecoveryOptions["repairSessionRefs"]>;
    readonly verifyWorkspace: NonNullable<WorkspaceRecoveryOptions["verifyWorkspace"]>;
    readonly withSessionLease: NonNullable<WorkspaceRecoveryOptions["withSessionLease"]>;
    readonly assertCurrent: NonNullable<WorkspaceRecoveryOptions["assertCurrent"]>;
    readonly reconcileFilesystemArtifacts: boolean;
    frozen?: WorkspaceRecoveryView;
    operationTails = new Map<string, Promise<void>>();

    constructor(options: WorkspaceRecoveryOptions) {
        this.workspace = options.workspace;
        this.store = options.store;
        this.journal = options.journal;
        this.locateSession = options.locateSession;
        this.reconcileFilesystemArtifacts = options.inspectPath == null;
        this.inspectPath =
            options.inspectPath ??
            (async (path) => capturedFromLive(await inspectLivePath(this.workspace.canonicalRoot, path)));
        this.publishState = options.publishState ?? (async () => {});
        this.repairSessionRefs = options.repairSessionRefs ?? (async () => {});
        this.verifyWorkspace = options.verifyWorkspace ?? verifyCanonicalWorkspaceIdentity;
        this.withSessionLease = options.withSessionLease ?? (async (_sessionId, operation) => operation());
        this.assertCurrent = options.assertCurrent ?? (async () => {});
        this.applyPath =
            options.applyPath ??
            (async ({ operationId, path, expectedCurrent, target, progress }) => {
                await applyCapturedPath({
                    root: this.workspace.canonicalRoot,
                    path,
                    expectedCurrent,
                    target,
                    readBlob: (oid) => this.store.readBlob(oid),
                    progress: { ...progress, operationId },
                });
            });
    }

    async scanKnownJournals(): Promise<void> {
        await this.recoverAll();
    }

    async ensureRecovered(workspace: CanonicalWorkspaceIdentity): Promise<void> {
        this.assertRequestedWorkspace(workspace);
        await this.recoverAll();
    }

    async getRecoveryState(workspace: CanonicalWorkspaceIdentity): Promise<WorkspaceRecoveryView | undefined> {
        this.assertRequestedWorkspace(workspace);
        if (this.frozen) {
            return cloneView(this.frozen);
        }
        const scanned = await this.journal.scan();
        if (scanned.length === 0) {
            return undefined;
        }
        return this.viewForScanned(scanned[0]!);
    }

    retry(operationId: string, assertCurrent?: WorkspaceRecoveryMutationGuard): Promise<void> {
        return this.serialize(operationId, async () => {
            await this.recoverAllWithScope(this.makeMutationScope(assertCurrent));
        });
    }

    abandonKeepingCurrent(
        operationId: string,
        binding?: WorkspaceRecoveryOwnerBinding,
        assertCurrent?: WorkspaceRecoveryMutationGuard
    ): Promise<void> {
        return this.serialize(operationId, async () => {
            const scope = this.makeMutationScope(assertCurrent);
            if (binding) {
                await this.withSessionLease(binding.sessionId, () =>
                    this.withWorkspaceLock(async () => {
                        const current = await this.findScanned(operationId);
                        if (current.corrupt || !current.record) {
                            throw new Error("Workspace recovery journal changed before abandon");
                        }
                        if (current.record.sessionId !== binding.sessionId) {
                            throw new Error("Workspace recovery journal changed owning session before abandon");
                        }
                        const session = await binding.locateBoundOwner();
                        await this.abandonAuthoritativeCurrent(operationId, current.record, scope, { session });
                    }, scope)
                );
                return;
            }
            const scanned = await this.findScanned(operationId);
            if (scanned.corrupt || !scanned.record) {
                throw new Error("Corrupt workspace recovery journals cannot be abandoned as decoded operations");
            }
            await this.withSessionLease(scanned.record.sessionId, () =>
                this.withWorkspaceLock(async () => {
                    const current = await this.findScanned(operationId);
                    if (current.corrupt || !current.record) {
                        throw new Error("Workspace recovery journal changed before abandon");
                    }
                    if (current.record.sessionId !== scanned.record.sessionId) {
                        throw new Error("Workspace recovery journal changed owning session before abandon");
                    }
                    await this.abandonAuthoritativeCurrent(operationId, current.record, scope);
                }, scope)
            );
        });
    }

    async abandonAuthoritativeCurrent(
        operationId: string,
        record: WorkspaceOperationJournalV1,
        scope: WorkspaceRecoveryMutationScope,
        boundOwner?: { session: WorkspaceRecoverySession | undefined }
    ): Promise<void> {
        const session = boundOwner ? boundOwner.session : await this.locateSession(record.sessionId);
        if (!session) {
            await scope.assertCurrent();
            await this.journal.resolveToAuditUnlocked(operationId, "abandon-current", Date.now());
            this.clearFrozen(operationId);
            return;
        }
        const leafId = await session.getLeafId();
        const operationLeaf = await this.isExactOperationLeaf(session, record, leafId);
        if (leafId !== record.expectedSemanticLeafId && !operationLeaf) {
            throw new Error("Workspace recovery operation cannot be abandoned at an unexpected session leaf");
        }
        await scope.assertCurrent();
        await this.journal.resolveToAuditUnlocked(operationId, "abandon-current", Date.now());
        this.clearFrozen(operationId);
    }

    quarantineCorrupt(operationId: string, assertCurrent?: WorkspaceRecoveryMutationGuard): Promise<void> {
        return this.serialize(operationId, async () => {
            const scope = this.makeMutationScope(assertCurrent);
            const scanned = await this.findScanned(operationId);
            if (!scanned.corrupt) {
                throw new Error("Only a corrupt workspace recovery journal can be quarantined");
            }
            await this.withWorkspaceLock(async () => {
                const current = await this.findScanned(operationId);
                if (!current.corrupt) {
                    throw new Error("Workspace recovery journal changed before quarantine");
                }
                await scope.assertCurrent();
                await this.journal.resolveToAuditUnlocked(operationId, "quarantine-corrupt", Date.now());
                this.clearFrozen(operationId);
            }, scope);
        });
    }

    async assertWorkspaceWritable(workspace: CanonicalWorkspaceIdentity): Promise<void> {
        this.assertRequestedWorkspace(workspace);
        await this.withWorkspaceLock(async () => {
            await this.journal.reconcileOwnership();
            if (this.frozen) {
                throw new WorkspaceFrozenError(this.frozen.operationId, this.frozen.message);
            }
            const scanned = await this.journal.scan();
            if (scanned.length === 0) {
                return;
            }
            const view = await this.viewForScanned(scanned[0]!);
            this.freeze(view);
        });
    }

    async recoverAll(): Promise<void> {
        await this.recoverAllWithScope(this.makeMutationScope());
    }

    async recoverAllWithScope(scope: WorkspaceRecoveryMutationScope): Promise<void> {
        let scanned = await this.journal.scanCandidates();
        if (scanned.length === 0) {
            scanned = await this.withWorkspaceLock(async () => {
                await this.journal.reconcileOwnership();
                return this.journal.scan();
            }, scope);
        }
        if (scanned.length === 0) {
            this.frozen = undefined;
            return;
        }
        scanned.sort((left, right) => {
            const sessionOrder = (left.record?.sessionId ?? "\uffff").localeCompare(
                right.record?.sessionId ?? "\uffff"
            );
            return sessionOrder || left.operationId.localeCompare(right.operationId);
        });
        try {
            await this.verifyWorkspace(this.workspace);
        } catch (error) {
            const first = scanned[0]!;
            const view = await this.viewForScanned(first);
            this.freeze({ ...view, message: "Workspace incarnation changed before recovery" }, error);
        }
        for (const item of scanned) {
            let candidate = item;
            if (candidate.corrupt || !candidate.record) {
                const current = await this.withWorkspaceLock(
                    async () => (await this.journal.scan()).find((entry) => entry.operationId === item.operationId),
                    scope
                );
                if (!current) {
                    continue;
                }
                if (current.corrupt || !current.record) {
                    this.freeze(await this.viewForScanned(current));
                }
                candidate = current;
            }
            try {
                await this.withSessionLease(candidate.record!.sessionId, () =>
                    this.withWorkspaceLock(async () => {
                        await this.journal.reconcileOwnership();
                        const current = (await this.journal.scan()).find(
                            (entry) => entry.operationId === candidate.operationId
                        );
                        if (!current) {
                            return;
                        }
                        if (current.corrupt || !current.record) {
                            this.freeze(await this.viewForScanned(current));
                        }
                        if (current.record.sessionId !== candidate.record!.sessionId) {
                            this.freeze(await this.viewForScanned(current));
                        }
                        await scope.assertCurrent();
                        await this.verifyWorkspace(this.workspace);
                        await scope.assertCurrent();
                        await this.recoverRecord(current.record);
                    }, scope)
                );
            } catch (error) {
                if (error === scope.failure) {
                    throw error;
                }
                if (error instanceof WorkspaceFrozenError) {
                    throw error;
                }
                const view = await this.viewForRecord(candidate.record!, error);
                this.freeze(view, error);
            }
        }
        this.frozen = undefined;
    }

    async recoverRecord(record: WorkspaceOperationJournalV1): Promise<void> {
        if (
            record.workspaceIdentity !== this.workspace.workspaceIdentity ||
            record.workspaceIncarnation !== this.workspace.workspaceIncarnation
        ) {
            this.freeze({
                operationId: record.operationId,
                phase: record.phase,
                corrupt: false,
                message: "Workspace recovery journal belongs to another workspace incarnation",
                paths: record.paths.map((path) => ({ path: path.path })),
                allowedActions: ["retry"],
            });
        }
        await this.store.verify(record.safetySnapshot);
        if (record.resultSnapshot) {
            await this.store.verify(record.resultSnapshot);
        }
        const classified = await this.classify(record, true);
        if (classified.paths.some((path) => path.classification === "unknown")) {
            this.freeze(viewFromClassified(classified, "Workspace recovery found an unknown live path state"));
        }
        if (record.phase === "prepared") {
            if (classified.paths.some((path) => path.classification !== "pre")) {
                this.freeze(viewFromClassified(classified, "Prepared operation no longer matches its pre-state"));
            }
            await this.journal.completeCleanup(record.operationId);
            return;
        }
        if (record.phase === "applying_files" || record.phase === "files_verified") {
            await this.rollback(classified);
            return;
        }
        const exactOperationLeaf = classified.exactOperationLeaf;
        if (record.phase === "committing_session") {
            if (exactOperationLeaf) {
                await this.finishCommitted(classified);
                return;
            }
            if (classified.leafId === record.expectedSemanticLeafId) {
                await this.rollback(classified);
                return;
            }
            this.freeze(viewFromClassified(classified, "Session leaf changed during workspace recovery"));
        }
        if (!exactOperationLeaf) {
            this.freeze(viewFromClassified(classified, "Completed operation is not the exact session leaf"));
        }
        await this.finishCommitted(classified);
    }

    async classify(record: WorkspaceOperationJournalV1, reconcileArtifacts = false): Promise<ClassifiedOperation> {
        const session = await this.requireSession(record.sessionId);
        const leafId = await session.getLeafId();
        const exactOperationLeaf = await this.isExactOperationLeaf(session, record, leafId);
        const canRollback =
            record.phase === "applying_files" ||
            record.phase === "files_verified" ||
            (record.phase === "committing_session" && leafId === record.expectedSemanticLeafId);
        const paths: ClassifiedOperation["paths"] = [];
        for (const journalPath of record.paths) {
            const desired = journalPath.preState;
            const alternate = journalPath.target;
            if (desired.state === "excluded" || alternate.state === "excluded") {
                throw new Error("Excluded workspace path cannot participate in recovery");
            }
            let live = await this.inspectPath(journalPath.path);
            if (
                canRollback &&
                reconcileArtifacts &&
                this.reconcileFilesystemArtifacts &&
                live !== "unknown" &&
                live.state !== "excluded"
            ) {
                await reconcileInterruptedCapturedPathArtifacts({
                    root: this.workspace.canonicalRoot,
                    path: journalPath.path,
                    live,
                    desired,
                    alternate,
                    operationId: record.operationId,
                    onPathRecovered: async () => {
                        await this.journal.updatePathProgress(record.operationId, journalPath.path, [
                            ...journalPath.createdParentDirectories,
                        ]);
                    },
                });
                live = await this.inspectPath(journalPath.path);
            }
            const classification = classifyWorkspaceRecoveryPath(live, desired, alternate);
            paths.push({
                journalPath,
                classification,
            });
        }
        return { record, session, leafId, exactOperationLeaf, paths };
    }

    async rollback(classified: ClassifiedOperation): Promise<void> {
        if (classified.paths.some((path) => path.classification === "unknown")) {
            this.freeze(viewFromClassified(classified, "Workspace rollback cannot overwrite an unknown live state"));
        }
        for (const path of [...classified.paths].reverse()) {
            if (path.classification !== "target") {
                continue;
            }
            const createdParentDirectories = new Set(path.journalPath.createdParentDirectories);
            const progress: WorkspacePathApplyProgress = {
                operationId: classified.record.operationId,
                createdParentDirectories,
                onParentDirectoryCreated: async () => {
                    await this.journal.updatePathProgress(classified.record.operationId, path.journalPath.path, [
                        ...createdParentDirectories,
                    ]);
                },
                onPathReplaced: async () => {
                    await this.journal.updatePathProgress(classified.record.operationId, path.journalPath.path, [
                        ...createdParentDirectories,
                    ]);
                },
            };
            await this.applyPath({
                operationId: classified.record.operationId,
                path: path.journalPath.path,
                expectedCurrent: path.journalPath.target,
                target: path.journalPath.preState,
                progress,
            });
        }
        for (const path of classified.record.paths) {
            await this.verifyExpected(path.path, path.preState);
        }
        await removeCreatedWorkspaceDirectories(
            this.workspace.canonicalRoot,
            classified.record.paths.flatMap((path) => path.createdParentDirectories)
        );
        await this.journal.completeCleanup(classified.record.operationId);
    }

    async finishCommitted(classified: ClassifiedOperation): Promise<void> {
        if (classified.paths.some((path) => path.classification !== "target")) {
            this.freeze(viewFromClassified(classified, "Committed workspace operation does not match target state"));
        }
        for (const path of classified.record.paths) {
            await this.verifyExpected(path.path, path.target);
        }
        let record = classified.record;
        if (record.phase === "committing_session") {
            if (!record.resultSnapshot) {
                this.freeze(viewFromClassified(classified, "Committed operation is missing its result snapshot"));
            }
            record = await this.journal.transition(record.operationId, "completed", {
                resultSnapshot: record.resultSnapshot,
            });
        }
        await this.store.verify(record.resultSnapshot!);
        await this.repairSessionRefs(record.sessionId);
        await this.publishState(record.sessionId);
        await this.journal.completeCleanup(record.operationId);
    }

    async verifyExpected(path: string, expected: CapturedPathStateV1): Promise<void> {
        if (expected.state === "excluded") {
            throw new Error("Excluded workspace path cannot participate in recovery");
        }
        const live = await this.inspectPath(path);
        if (classifyWorkspaceRecoveryPath(live, expected, expected) !== "pre") {
            throw new Error(`Workspace recovery verification failed: ${path}`);
        }
    }

    async isExactOperationLeaf(
        session: WorkspaceRecoverySession,
        record: WorkspaceOperationJournalV1,
        leafId: string | null
    ): Promise<boolean> {
        if (leafId !== record.workspaceStateEntryId) {
            return false;
        }
        if (!record.resultSnapshot) {
            return false;
        }
        const entry = await session.getEntry(record.workspaceStateEntryId);
        const state = entry == null ? undefined : decodeWorkspaceStateEntry(entry);
        return (
            entry?.parentId === record.commitParentId &&
            state != null &&
            sameDurableValue(state, workspaceStateFromJournal(record))
        );
    }

    async requireSession(sessionId: string): Promise<WorkspaceRecoverySession> {
        const session = await this.locateSession(sessionId);
        if (!session) {
            throw new Error(`Workspace recovery session is missing: ${sessionId}`);
        }
        return session;
    }

    async viewForScanned(scanned: ScannedWorkspaceOperationJournal): Promise<WorkspaceRecoveryView> {
        if (scanned.corrupt || !scanned.record) {
            return {
                operationId: scanned.operationId,
                corrupt: true,
                message: scanned.message ?? "Workspace recovery journal is corrupt",
                paths: [],
                allowedActions: ["quarantine-corrupt"],
            };
        }
        return this.viewForRecord(scanned.record);
    }

    async viewForRecord(record: WorkspaceOperationJournalV1, error?: unknown): Promise<WorkspaceRecoveryView> {
        try {
            if (!(await this.locateSession(record.sessionId))) {
                return {
                    operationId: record.operationId,
                    phase: record.phase,
                    corrupt: false,
                    message: `Workspace recovery session is missing: ${record.sessionId}`,
                    paths: record.paths.map((path) => ({ path: path.path })),
                    allowedActions: ["retry", "abandon-current"],
                };
            }
            const classified = await this.classify(record);
            return viewFromClassified(
                classified,
                error instanceof Error ? error.message : "Workspace recovery requires attention"
            );
        } catch (viewError) {
            return {
                operationId: record.operationId,
                phase: record.phase,
                corrupt: false,
                message:
                    error instanceof Error
                        ? error.message
                        : viewError instanceof Error
                          ? viewError.message
                          : "Workspace recovery requires attention",
                paths: record.paths.map((path) => ({ path: path.path })),
                allowedActions: ["retry"],
            };
        }
    }

    async findScanned(operationId: string): Promise<ScannedWorkspaceOperationJournal> {
        const scanned = (await this.journal.scan()).find((item) => item.operationId === operationId);
        if (!scanned) {
            throw new Error(`Workspace recovery operation not found: ${operationId}`);
        }
        return scanned;
    }

    makeMutationScope(requestGuard?: WorkspaceRecoveryMutationGuard): WorkspaceRecoveryMutationScope {
        const scope: WorkspaceRecoveryMutationScope = {
            assertCurrent: async () => {
                try {
                    await this.assertCurrent();
                    await requestGuard?.();
                } catch (error) {
                    scope.failure = error;
                    throw error;
                }
            },
        };
        return scope;
    }

    async withWorkspaceLock<T>(operation: () => Promise<T>, scope?: WorkspaceRecoveryMutationScope): Promise<T> {
        if (this.store.withWorkspaceLock) {
            return this.store.withWorkspaceLock(async () => {
                if (scope) await scope.assertCurrent();
                else await this.assertCurrent();
                return await operation();
            });
        }
        if (scope) await scope.assertCurrent();
        else await this.assertCurrent();
        return operation();
    }

    serialize(operationId: string, operation: () => Promise<void>): Promise<void> {
        const previous = this.operationTails.get(operationId) ?? Promise.resolve();
        const next = previous.then(operation, operation);
        this.operationTails.set(operationId, next);
        return next.finally(() => {
            if (this.operationTails.get(operationId) === next) {
                this.operationTails.delete(operationId);
            }
        });
    }

    freeze(view: WorkspaceRecoveryView, cause?: unknown): never {
        this.frozen = cloneView(view);
        throw new WorkspaceFrozenError(view.operationId, view.message, cause == null ? undefined : { cause });
    }

    clearFrozen(operationId: string): void {
        if (this.frozen?.operationId === operationId) {
            this.frozen = undefined;
        }
    }

    assertRequestedWorkspace(workspace: CanonicalWorkspaceIdentity): void {
        if (
            workspace.workspaceIdentity !== this.workspace.workspaceIdentity ||
            workspace.workspaceIncarnation !== this.workspace.workspaceIncarnation ||
            workspace.canonicalRoot !== this.workspace.canonicalRoot
        ) {
            throw new Error("Workspace recovery coordinator belongs to another workspace incarnation");
        }
    }
}

export function classifyWorkspaceRecoveryPath(
    live: CapturedPathStateV1 | "unknown",
    preState: CapturedPathStateV1,
    target: CapturedPathStateV1
): "pre" | "target" | "unknown" {
    if (
        live === "unknown" ||
        live.state === "excluded" ||
        preState.state === "excluded" ||
        target.state === "excluded"
    ) {
        return "unknown";
    }
    if (sameCapturedState(live, preState)) {
        return "pre";
    }
    if (sameCapturedState(live, target)) {
        return "target";
    }
    return "unknown";
}

function viewFromClassified(classified: ClassifiedOperation, message: string): WorkspaceRecoveryView {
    const canAbandon = classified.leafId === classified.record.expectedSemanticLeafId || classified.exactOperationLeaf;
    return {
        operationId: classified.record.operationId,
        phase: classified.record.phase,
        corrupt: false,
        message,
        paths: classified.paths.map((path) => ({
            path: path.journalPath.path,
            classification: path.classification,
        })),
        allowedActions: canAbandon ? ["retry", "abandon-current"] : ["retry"],
    };
}

function capturedFromLive(live: LiveCapturedPathState): CapturedPathStateV1 | "unknown" {
    if (live.state === "absent") {
        return { state: "absent" };
    }
    if (live.state === "file") {
        return { state: "file", oid: live.oid, executable: live.executable };
    }
    if (live.state === "symlink") {
        return { state: "symlink", oid: live.oid };
    }
    return "unknown";
}

function sameCapturedState(left: CapturedPathStateV1 | "unknown", right: CapturedPathStateV1): boolean {
    if (left === "unknown") {
        return false;
    }
    return JSON.stringify(left) === JSON.stringify(right);
}

function sameDurableValue(left: unknown, right: unknown): boolean {
    return encodeDurableJson(left).equals(encodeDurableJson(right));
}

function cloneView(view: WorkspaceRecoveryView): WorkspaceRecoveryView {
    return {
        ...view,
        paths: view.paths.map((path) => ({ ...path })),
        allowedActions: [...view.allowedActions],
    };
}
