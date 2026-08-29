// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    filterCommittedTransactionEntries,
    getTransactionForkBoundary,
} from "@crest/agent/harness/session/entry-transaction";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { isDeepStrictEqual } from "node:util";
import {
    classifyLivePath,
    liveMatchesCaptured,
    type LiveCapturedPathState,
    type RewindConflictClass,
} from "./live-path-state";
import { decodeWorkspaceCheckpointEntry, decodeWorkspaceStateEntry, isWorkspaceControlEntry } from "./session-state";
import type {
    CapturedPathStateV1,
    WorkspaceCheckpointV1,
    WorkspaceLinkedOperationV1,
    WorkspacePathChangeV1,
    WorkspaceSnapshotRefV1,
    WorkspaceStateV1,
} from "./types";
import { WorkspaceControlCustomTypes } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import type { WorkspaceMutationLog } from "./workspace-mutation-log";

const RestorePlanMaxInspectedPaths = 4_096;
const RestorePlanFallbackInspectionConcurrency = 8;
type WorkspaceRewindMarkerV1 = Extract<WorkspaceStateV1, { kind: "rewind" }>;

export interface RestorePathPlanV1 {
    path: string;
    operation: "create" | "write" | "delete";
    target: CapturedPathStateV1;
    expectedCurrent: CapturedPathStateV1;
    liveFingerprint: string;
    conflict: RewindConflictClass;
    reason?: string;
}

export type RestoreTargetV1 =
    | { kind: "rewind"; targetTurnId: string }
    | { kind: "redo"; sourceRewindOperationId: string; linkedOperation: WorkspaceLinkedOperationV1 }
    | { kind: "turn-undo"; sourceTurnId: string }
    | {
          kind: "turn-redo";
          sourceTurnId: string;
          undoOperationId: string;
          linkedOperation: WorkspaceLinkedOperationV1;
      };

export interface RestorePlanV1 {
    target: RestoreTargetV1;
    sessionId: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    semanticLeafId: string | null;
    commitParentId: string | null;
    paths: RestorePathPlanV1[];
    coverageWarnings: Array<{ path: string; reason: string }>;
    forceRequired: boolean;
    hardBlocked: boolean;
}

export interface PlanRewindInput {
    sessionId: string;
    workspace: CanonicalWorkspaceIdentity;
    rawEntries: SessionTreeEntry[];
    semanticLeafId: string | null;
    authorityHead?: string;
    targetTurnId: string;
    currentWorkspaceState?: WorkspaceStateV1;
    inspectLivePath: (path: string) => Promise<LiveCapturedPathState>;
    inspectLivePaths?: (paths: readonly string[]) => Promise<ReadonlyMap<string, LiveCapturedPathState>>;
    verifySnapshot: (snapshot: WorkspaceSnapshotRefV1) => Promise<void>;
    mutationLog: RestoreMutationLog;
    diffSnapshots: RestoreSnapshotDiff;
    readCommitSnapshot: RestoreCommitSnapshotReader;
}

export interface PlanRedoInput {
    sessionId: string;
    workspace: CanonicalWorkspaceIdentity;
    rawEntries: SessionTreeEntry[];
    semanticLeafId: string | null;
    authorityHead?: string;
    rewindState: WorkspaceRewindMarkerV1;
    inspectLivePath: (path: string) => Promise<LiveCapturedPathState>;
    inspectLivePaths?: (paths: readonly string[]) => Promise<ReadonlyMap<string, LiveCapturedPathState>>;
    verifySnapshot: (snapshot: WorkspaceSnapshotRefV1) => Promise<void>;
    mutationLog: RestoreMutationLog;
    diffSnapshots: RestoreSnapshotDiff;
    readCommitSnapshot: RestoreCommitSnapshotReader;
}

export type RestoreMutationLog = Pick<WorkspaceMutationLog, "read" | "findForeignOverlap">;
export type RestoreSnapshotDiff = (
    before: WorkspaceSnapshotRefV1,
    after: WorkspaceSnapshotRefV1
) => Promise<WorkspacePathChangeV1[]>;
export type RestoreCommitSnapshotReader = (commit: string) => Promise<WorkspaceSnapshotRefV1>;

interface ActiveBranchResult {
    branch?: SessionTreeEntry[];
    reason?: string;
}

export interface RestorePathTransitionV1 {
    target: CapturedPathStateV1;
    expectedCurrent: CapturedPathStateV1;
    excludedReason?: string;
}

export async function validateCheckpointMutationAuthority(
    plan: RestorePlanV1,
    checkpoint: Extract<WorkspaceCheckpointV1, { status: "available" }>,
    mutationLog: RestoreMutationLog,
    diffSnapshots: RestoreSnapshotDiff
): Promise<boolean> {
    if (checkpoint.before.id === checkpoint.after.id) {
        if (checkpoint.changes.length === 0) return true;
        hardBlock(plan, "workspace checkpoint claims changes without an agent-turn mutation", checkpoint.turnId);
        return false;
    }
    try {
        const mutation = await mutationLog.read(checkpoint.after.id);
        if (
            mutation.metadata.kind !== "agent-turn" ||
            mutation.metadata.sessionid !== checkpoint.originSessionId ||
            mutation.metadata.turnid !== checkpoint.turnId ||
            mutation.parent !== checkpoint.before.id
        ) {
            hardBlock(plan, "workspace checkpoint mutation authority is invalid", checkpoint.turnId);
            return false;
        }
    } catch (error) {
        hardBlock(plan, `workspace checkpoint mutation is unavailable: ${(error as Error).message}`, checkpoint.turnId);
        return false;
    }
    try {
        const exactChanges = await diffSnapshots(checkpoint.before, checkpoint.after);
        if (!isDeepStrictEqual(checkpoint.changes, exactChanges)) {
            hardBlock(plan, "workspace checkpoint changes do not match its exact snapshot diff", checkpoint.turnId);
            return false;
        }
    } catch (error) {
        hardBlock(plan, `workspace checkpoint diff is unavailable: ${(error as Error).message}`, checkpoint.turnId);
        return false;
    }
    return true;
}

export async function validateResultMutationAuthority(
    plan: RestorePlanV1,
    state: WorkspaceStateV1,
    mutationLog: RestoreMutationLog,
    diffSnapshots: RestoreSnapshotDiff,
    readCommitSnapshot: RestoreCommitSnapshotReader
): Promise<WorkspacePathChangeV1[] | undefined> {
    const linkedOperation = state.kind === "redo" || state.kind === "turn-redo" ? state.linkedOperation : undefined;
    const expectedTurnId =
        state.kind === "rewind"
            ? state.rewind.targetTurnId
            : state.kind === "turn-undo" || state.kind === "turn-redo"
              ? state.sourceTurnId
              : undefined;
    const expectedSourceOperationId =
        state.kind === "redo"
            ? state.sourceRewindOperationId
            : state.kind === "turn-redo"
              ? state.undoOperationId
              : undefined;
    try {
        const refs = [
            state.sourceSnapshot,
            state.currentSnapshot,
            ...(linkedOperation ? [linkedOperation.sourceSnapshot, linkedOperation.currentSnapshot] : []),
        ];
        const associated = await Promise.all(refs.map((snapshot) => readCommitSnapshot(snapshot.id)));
        if (
            associated.some((snapshot, index) => !isDeepStrictEqual(snapshot, refs[index])) ||
            refs.some(
                (snapshot) =>
                    snapshot.workspaceIdentity !== state.workspaceIdentity ||
                    snapshot.workspaceIncarnation !== state.workspaceIncarnation
            )
        ) {
            hardBlock(plan, "workspace result snapshot association is invalid");
            return undefined;
        }
        const result = await mutationLog.read(state.currentSnapshot.id);
        if (
            result.parent !== state.sourceSnapshot.id ||
            result.tree !== state.currentSnapshot.tree ||
            result.metadata.kind !== state.kind ||
            result.metadata.sessionid !== state.sessionId ||
            result.metadata.operationid !== state.operationId ||
            result.metadata.turnid !== expectedTurnId ||
            result.metadata.sourceoperationid !== expectedSourceOperationId ||
            result.metadata.linkedresultcommitid !== linkedOperation?.currentSnapshot.id
        ) {
            hardBlock(plan, "workspace result mutation authority is invalid");
            return undefined;
        }
        if (linkedOperation) {
            if (linkedOperation.operationId !== expectedSourceOperationId) {
                hardBlock(plan, "workspace result source operation link is invalid");
                return undefined;
            }
            const source = await mutationLog.read(linkedOperation.currentSnapshot.id);
            const expectedSourceKind = state.kind === "redo" ? "rewind" : "turn-undo";
            if (
                source.parent !== linkedOperation.sourceSnapshot.id ||
                source.tree !== linkedOperation.currentSnapshot.tree ||
                source.metadata.kind !== expectedSourceKind ||
                source.metadata.sessionid !== state.sessionId ||
                source.metadata.operationid !== expectedSourceOperationId ||
                (state.kind === "turn-redo" && source.metadata.turnid !== state.sourceTurnId)
            ) {
                hardBlock(plan, "workspace result source mutation authority is invalid");
                return undefined;
            }
        }
    } catch (error) {
        hardBlock(plan, `workspace result mutation is unavailable: ${(error as Error).message}`);
        return undefined;
    }
    try {
        return await diffSnapshots(state.sourceSnapshot, state.currentSnapshot);
    } catch (error) {
        hardBlock(plan, `workspace result diff is unavailable: ${(error as Error).message}`);
        return undefined;
    }
}

export function enforceRestoreTransitionLimit(
    plan: RestorePlanV1,
    transitions: ReadonlyMap<string, RestorePathTransitionV1>
): boolean {
    if (transitions.size <= RestorePlanMaxInspectedPaths) return true;
    hardBlock(plan, `restore path inspection limit exceeded: ${RestorePlanMaxInspectedPaths}`);
    return false;
}

export async function findCrestHistoryBlockers(
    plan: RestorePlanV1,
    input: {
        mutationLog: RestoreMutationLog;
        afterCommit: string;
        authorityHead?: string;
        paths: readonly string[];
        includedCommits: ReadonlySet<string>;
        ownerSessionId: string;
        blockExternal?: boolean;
    }
): Promise<ReadonlyMap<string, string> | undefined> {
    if (input.paths.length === 0) return new Map();
    try {
        const overlaps = await input.mutationLog.findForeignOverlap({
            afterCommit: input.afterCommit,
            ...(input.authorityHead == null ? {} : { head: input.authorityHead }),
            paths: input.paths,
            includedCommits: input.includedCommits,
            ownerSessionId: input.ownerSessionId,
        });
        const blockers = new Map<string, string>();
        for (const overlap of overlaps) {
            if (overlap.sessionId == null && !input.blockExternal) continue;
            blockers.set(
                overlap.path,
                overlap.sessionId == null
                    ? "a later external write changed this path"
                    : "a later Crest operation changed this path"
            );
        }
        return blockers;
    } catch (error) {
        hardBlock(plan, `workspace mutation history is unavailable: ${(error as Error).message}`);
        return undefined;
    }
}

async function validateAuthorityCommitOrder(
    plan: RestorePlanV1,
    commits: readonly string[],
    mutationLog: RestoreMutationLog
): Promise<boolean> {
    if (new Set(commits).size !== commits.length) {
        hardBlock(plan, "workspace mutation authority contains duplicate result commits");
        return false;
    }
    if (commits.length < 2) return true;
    const indexes = new Map(commits.map((commit, index) => [commit, index]));
    let expectedIndex = commits.length - 1;
    let cursor = commits[expectedIndex]!;
    const visited = new Set<string>();
    try {
        while (expectedIndex > 0) {
            if (visited.has(cursor)) throw new Error("workspace mutation history contains a cycle");
            visited.add(cursor);
            const mutation = await mutationLog.read(cursor);
            if (!mutation.parent) throw new Error("workspace mutation authority is not contiguous");
            cursor = mutation.parent;
            const authorityIndex = indexes.get(cursor);
            if (authorityIndex == null) continue;
            if (authorityIndex !== expectedIndex - 1) {
                throw new Error("workspace mutation authority order differs from the active Session branch");
            }
            expectedIndex = authorityIndex;
        }
        return true;
    } catch (error) {
        hardBlock(plan, `workspace mutation authority continuity is invalid: ${(error as Error).message}`);
        return false;
    }
}

function emptyPlan(
    input: {
        sessionId: string;
        workspace: CanonicalWorkspaceIdentity;
        semanticLeafId: string | null;
    },
    target: RestoreTargetV1,
    commitParentId: string | null
): RestorePlanV1 {
    return {
        target,
        sessionId: input.sessionId,
        workspaceIdentity: input.workspace.workspaceIdentity,
        workspaceIncarnation: input.workspace.workspaceIncarnation,
        semanticLeafId: input.semanticLeafId,
        commitParentId,
        paths: [],
        coverageWarnings: [],
        forceRequired: false,
        hardBlocked: false,
    };
}

function hardBlock(plan: RestorePlanV1, reason: string, path = ""): RestorePlanV1 {
    plan.hardBlocked = true;
    plan.coverageWarnings.push({ path, reason });
    return plan;
}

function rawLeafId(entries: SessionTreeEntry[]): string | null {
    let leafId: string | null = null;
    for (const entry of entries) {
        leafId = entry.type === "leaf" ? entry.targetId : entry.id;
    }
    return leafId;
}

function activeBranch(entries: SessionTreeEntry[], semanticLeafId: string | null): ActiveBranchResult {
    if (rawLeafId(entries) !== semanticLeafId) {
        return { reason: "semantic leaf changed" };
    }
    if (semanticLeafId == null) {
        return { branch: [] };
    }
    const byId = new Map<string, SessionTreeEntry>();
    for (const entry of entries) {
        if (entry.type === "leaf") {
            continue;
        }
        if (byId.has(entry.id)) {
            return { reason: "session contains duplicate entry IDs" };
        }
        byId.set(entry.id, entry);
    }
    const reverse: SessionTreeEntry[] = [];
    const visited = new Set<string>();
    let cursor: string | null = semanticLeafId;
    while (cursor != null) {
        if (visited.has(cursor)) {
            return { reason: "session branch contains a cycle" };
        }
        const entry = byId.get(cursor);
        if (!entry) {
            return { reason: "session branch contains a missing parent" };
        }
        visited.add(cursor);
        reverse.push(entry);
        cursor = entry.parentId;
    }
    return { branch: reverse.reverse() };
}

function isUser(entry: SessionTreeEntry): boolean {
    return entry.type === "message" && entry.message.role === "user";
}

function canonicalPath(path: string): boolean {
    if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
        return false;
    }
    return path.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function capturedEqual(left: CapturedPathStateV1, right: CapturedPathStateV1): boolean {
    if (left.state !== right.state) {
        return false;
    }
    if (left.state === "file" && right.state === "file") {
        return left.oid === right.oid && left.executable === right.executable;
    }
    if (left.state === "symlink" && right.state === "symlink") {
        return left.oid === right.oid;
    }
    if (left.state === "excluded" && right.state === "excluded") {
        return left.reason === right.reason;
    }
    return true;
}

function operationFor(target: CapturedPathStateV1, expected: CapturedPathStateV1): RestorePathPlanV1["operation"] {
    if (target.state === "absent") {
        return "delete";
    }
    return expected.state === "absent" ? "create" : "write";
}

async function snapshotsAreReadable(
    snapshots: WorkspaceSnapshotRefV1[],
    workspace: CanonicalWorkspaceIdentity,
    verify: (snapshot: WorkspaceSnapshotRefV1) => Promise<void>
): Promise<string | undefined> {
    for (const snapshot of snapshots) {
        if (
            snapshot.workspaceIdentity !== workspace.workspaceIdentity ||
            snapshot.workspaceIncarnation !== workspace.workspaceIncarnation
        ) {
            return "snapshot workspace identity or incarnation does not match";
        }
        try {
            await verify(snapshot);
        } catch (error) {
            return `snapshot is unavailable: ${(error as Error).message}`;
        }
    }
    return undefined;
}

function terminalCheckpointForTurn(
    branch: SessionTreeEntry[],
    userIndex: number,
    nextUserIndex: number | undefined,
    transactionStartsByUserId: ReadonlyMap<string, number>
): { checkpoint?: WorkspaceCheckpointV1; checkpointEntryId?: string; reason?: string } {
    let end = nextUserIndex ?? branch.length;
    if (nextUserIndex != null) {
        const nextUser = branch[nextUserIndex]!;
        const transactionStart = transactionStartsByUserId.get(nextUser.id);
        if (transactionStart != null && transactionStart > userIndex) {
            end = transactionStart;
        }
    }
    const turnEntries = branch.slice(userIndex + 1, end);
    const checkpointEntries = turnEntries.filter(
        (entry) => entry.type === "custom" && entry.customType === WorkspaceControlCustomTypes.checkpoint
    );
    if (checkpointEntries.length === 0) {
        return { reason: "workspace checkpoint is missing" };
    }
    if (checkpointEntries.length !== 1) {
        return { reason: "workspace checkpoint is not unique" };
    }
    const checkpointEntry = checkpointEntries[0]!;
    const checkpoint = decodeWorkspaceCheckpointEntry(checkpointEntry);
    if (!checkpoint || checkpoint.turnId !== branch[userIndex]!.id) {
        return { reason: "workspace checkpoint is invalid" };
    }
    const checkpointIndex = turnEntries.indexOf(checkpointEntry);
    if (turnEntries.slice(checkpointIndex + 1).some((entry) => !isWorkspaceControlEntry(entry))) {
        return { reason: "workspace checkpoint is not terminal" };
    }
    if (checkpoint.status === "unavailable") {
        return { reason: `workspace checkpoint is unavailable: ${checkpoint.reasonCode}` };
    }
    return { checkpoint, checkpointEntryId: checkpointEntry.id };
}

function committedTransactionStartsByUserId(branch: SessionTreeEntry[]): Map<string, number> {
    const entryIndexes = new Map(branch.map((entry, index) => [entry.id, index]));
    const startsByUserId = new Map<string, number>();
    const transactions = filterCommittedTransactionEntries(branch).committedTransactions;
    for (const transaction of transactions.values()) {
        const firstEntry = transaction.physicalEntries[0];
        const firstIndex = firstEntry == null ? undefined : entryIndexes.get(firstEntry.id);
        if (firstIndex != null) {
            startsByUserId.set(transaction.userEntryId, firstIndex);
        }
    }
    return startsByUserId;
}

function committedEntrySet(branch: SessionTreeEntry[]): ReadonlySet<SessionTreeEntry> {
    return new Set(filterCommittedTransactionEntries(branch).entries);
}

function currentLeafWorkspaceMarker(branch: SessionTreeEntry[], sessionId: string): WorkspaceStateV1 | undefined {
    const leaf = branch.at(-1);
    if (leaf == null || !committedEntrySet(branch).has(leaf)) return undefined;
    const state = leaf == null ? undefined : decodeWorkspaceStateEntry(leaf);
    return state?.sessionId === sessionId ? state : undefined;
}

function activeWorkspaceStates(
    branch: SessionTreeEntry[],
    sessionId: string,
    visibleEntries: ReadonlySet<SessionTreeEntry>
): Array<{ entryId: string; branchIndex: number; state: WorkspaceStateV1 }> {
    return branch.flatMap((entry, branchIndex) => {
        if (!visibleEntries.has(entry)) return [];
        const state = decodeWorkspaceStateEntry(entry);
        return state?.sessionId === sessionId ? [{ entryId: entry.id, branchIndex, state }] : [];
    });
}

export async function classifyRestoreTransitions(
    plan: RestorePlanV1,
    transitions: ReadonlyMap<string, RestorePathTransitionV1>,
    inspect: (path: string) => Promise<LiveCapturedPathState>,
    inspectBatch: ((paths: readonly string[]) => Promise<ReadonlyMap<string, LiveCapturedPathState>>) | undefined,
    redo: boolean,
    historyBlockers: ReadonlyMap<string, string> = new Map()
): Promise<RestorePlanV1> {
    const effective: Array<{ path: string; transition: RestorePathTransitionV1 }> = [];
    for (const path of [...transitions.keys()].sort()) {
        const transition = transitions.get(path)!;
        if (transition.excludedReason) {
            plan.coverageWarnings.push({ path, reason: transition.excludedReason });
            continue;
        }
        if (!canonicalPath(path)) {
            hardBlock(plan, "path is not a canonical workspace-relative path", path);
            continue;
        }
        if (capturedEqual(transition.target, transition.expectedCurrent)) {
            continue;
        }
        effective.push({ path, transition });
    }
    if (effective.length > RestorePlanMaxInspectedPaths) {
        return hardBlock(plan, `restore path inspection limit exceeded: ${RestorePlanMaxInspectedPaths}`);
    }
    const liveStates = inspectBatch
        ? await inspectBatchSafely(
              effective.map((item) => item.path),
              inspectBatch
          )
        : await inspectWithBoundedFallback(
              effective.map((item) => item.path),
              inspect
          );
    for (const { path, transition } of effective) {
        const live = liveStates.get(path) ?? inspectionFailure("path inspection returned no state");
        const classification = classifyLivePath({
            live,
            expected: transition.expectedCurrent,
            target: transition.target,
        });
        const historyBlocker = historyBlockers.get(path);
        if (liveMatchesCaptured(live, transition.target) && !historyBlocker) {
            continue;
        }
        const conflict =
            historyBlocker || (redo && classification.conflict === "forceable-drift")
                ? "hard-blocker"
                : classification.conflict;
        const reason =
            historyBlocker ??
            (redo && classification.conflict === "forceable-drift"
                ? "redo is blocked because the workspace changed after rewind"
                : classification.reason);
        plan.paths.push({
            path,
            operation: operationFor(transition.target, transition.expectedCurrent),
            target: transition.target,
            expectedCurrent: transition.expectedCurrent,
            liveFingerprint: classification.liveFingerprint,
            conflict,
            ...(reason == null ? {} : { reason }),
        });
        plan.forceRequired ||= conflict === "forceable-drift";
        plan.hardBlocked ||= conflict === "hard-blocker";
    }
    return plan;
}

function inspectionFailure(reason: string): LiveCapturedPathState {
    return {
        state: "blocked",
        reason,
        fingerprint: "inspection-failed",
    };
}

async function inspectBatchSafely(
    paths: string[],
    inspect: (paths: readonly string[]) => Promise<ReadonlyMap<string, LiveCapturedPathState>>
): Promise<ReadonlyMap<string, LiveCapturedPathState>> {
    try {
        return await inspect(paths);
    } catch (error) {
        const failed = inspectionFailure(`path inspection failed: ${(error as Error).message}`);
        return new Map(paths.map((path) => [path, failed]));
    }
}

async function inspectWithBoundedFallback(
    paths: string[],
    inspect: (path: string) => Promise<LiveCapturedPathState>
): Promise<ReadonlyMap<string, LiveCapturedPathState>> {
    const states = new Map<string, LiveCapturedPathState>();
    let cursor = 0;
    const run = async () => {
        while (cursor < paths.length) {
            const path = paths[cursor++]!;
            try {
                states.set(path, await inspect(path));
            } catch (error) {
                states.set(path, inspectionFailure(`path inspection failed: ${(error as Error).message}`));
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(RestorePlanFallbackInspectionConcurrency, paths.length) }, run));
    return states;
}

export async function planRewind(input: PlanRewindInput): Promise<RestorePlanV1> {
    const targetBoundaryId = getTransactionForkBoundary(input.rawEntries, input.targetTurnId, "before");
    const plan = emptyPlan(input, { kind: "rewind", targetTurnId: input.targetTurnId }, targetBoundaryId);
    const active = activeBranch(input.rawEntries, input.semanticLeafId);
    if (!active.branch) {
        return hardBlock(plan, active.reason!);
    }
    const branch = active.branch;
    const targetIndex = branch.findIndex((entry) => entry.id === input.targetTurnId && isUser(entry));
    if (targetIndex < 0) {
        return hardBlock(plan, "target turn is not a durable user entry on the active branch");
    }

    const userIndexes = branch.flatMap((entry, index) => (isUser(entry) && index >= targetIndex ? [index] : []));
    const transactionStartsByUserId = committedTransactionStartsByUserId(branch);
    const checkpoints: WorkspaceCheckpointV1[] = [];
    const checkpointsByEntryId = new Map<string, Extract<WorkspaceCheckpointV1, { status: "available" }>>();
    for (let index = 0; index < userIndexes.length; index++) {
        const result = terminalCheckpointForTurn(
            branch,
            userIndexes[index]!,
            userIndexes[index + 1],
            transactionStartsByUserId
        );
        if (!result.checkpoint) {
            return hardBlock(plan, result.reason!, branch[userIndexes[index]!]!.id);
        }
        const checkpoint = result.checkpoint;
        if (checkpoint.originSessionId !== input.sessionId) {
            return hardBlock(plan, "checkpoint is owned by another session", checkpoint.turnId);
        }
        if (
            checkpoint.workspaceIdentity !== input.workspace.workspaceIdentity ||
            checkpoint.workspaceIncarnation !== input.workspace.workspaceIncarnation
        ) {
            return hardBlock(plan, "checkpoint workspace identity or incarnation does not match", checkpoint.turnId);
        }
        checkpoints.push(checkpoint);
        if (checkpoint.status === "available") {
            checkpointsByEntryId.set(result.checkpointEntryId!, checkpoint);
        }
    }

    const suffix = branch.slice(targetIndex);
    const visibleEntries = committedEntrySet(branch);
    for (const entry of suffix) {
        if (!visibleEntries.has(entry)) {
            continue;
        }
        if (entry.type !== "custom" || entry.customType !== WorkspaceControlCustomTypes.state) {
            continue;
        }
        const state = decodeWorkspaceStateEntry(entry);
        if (!state) {
            return hardBlock(plan, "workspace state inside the target suffix is invalid", entry.id);
        }
        if (state.sessionId !== input.sessionId) {
            return hardBlock(plan, "workspace state inside the target suffix belongs to another session", entry.id);
        }
    }
    const fullBranchWorkspaceStates = activeWorkspaceStates(branch, input.sessionId, visibleEntries);
    const latestWorkspaceState = fullBranchWorkspaceStates.at(-1)?.state;
    if (
        input.currentWorkspaceState &&
        (!latestWorkspaceState || !isDeepStrictEqual(latestWorkspaceState, input.currentWorkspaceState))
    ) {
        return hardBlock(plan, "caller workspace state differs from the authoritative active-branch state");
    }
    const workspaceStates = fullBranchWorkspaceStates.filter((item) => item.branchIndex >= targetIndex);
    for (const item of workspaceStates) {
        if (
            item.state.workspaceIdentity !== input.workspace.workspaceIdentity ||
            item.state.workspaceIncarnation !== input.workspace.workspaceIncarnation
        ) {
            return hardBlock(plan, "workspace state identity or incarnation does not match", item.entryId);
        }
    }

    const snapshots = checkpoints.flatMap((checkpoint) =>
        checkpoint.status === "available" ? [checkpoint.before, checkpoint.after] : []
    );
    for (const item of workspaceStates) {
        snapshots.push(item.state.sourceSnapshot, item.state.currentSnapshot);
        if (item.state.kind === "redo" || item.state.kind === "turn-redo") {
            snapshots.push(item.state.linkedOperation.sourceSnapshot, item.state.linkedOperation.currentSnapshot);
        }
    }
    const snapshotFailure = await snapshotsAreReadable(snapshots, input.workspace, input.verifySnapshot);
    if (snapshotFailure) {
        return hardBlock(plan, snapshotFailure);
    }
    for (const checkpoint of checkpoints) {
        if (
            checkpoint.status === "available" &&
            !(await validateCheckpointMutationAuthority(plan, checkpoint, input.mutationLog, input.diffSnapshots))
        ) {
            return plan;
        }
    }

    const resultChangesByEntryId = new Map<string, WorkspacePathChangeV1[]>();
    const bridgeChangesByEntryId = new Map<string, WorkspacePathChangeV1[]>();
    const activeResultCommits = new Set(fullBranchWorkspaceStates.map((item) => item.state.currentSnapshot.id));
    for (const item of workspaceStates) {
        const exact = await validateResultMutationAuthority(
            plan,
            item.state,
            input.mutationLog,
            input.diffSnapshots,
            input.readCommitSnapshot
        );
        if (!exact) return plan;
        resultChangesByEntryId.set(item.entryId, exact);
        if (
            (item.state.kind === "redo" || item.state.kind === "turn-redo") &&
            !activeResultCommits.has(item.state.linkedOperation.currentSnapshot.id)
        ) {
            try {
                bridgeChangesByEntryId.set(
                    item.entryId,
                    await input.diffSnapshots(
                        item.state.linkedOperation.sourceSnapshot,
                        item.state.linkedOperation.currentSnapshot
                    )
                );
            } catch (error) {
                return hardBlock(plan, `workspace linked result diff is unavailable: ${(error as Error).message}`);
            }
        }
    }

    const workspaceStatesByEntryId = new Map(workspaceStates.map((item) => [item.entryId, item.state]));
    const transitions = new Map<string, RestorePathTransitionV1>();
    for (const entry of suffix) {
        const checkpoint = checkpointsByEntryId.get(entry.id);
        if (checkpoint) {
            for (const change of checkpoint.changes) {
                const existing = transitions.get(change.path);
                if (existing && !capturedEqual(existing.expectedCurrent, change.before)) {
                    return hardBlock(plan, "workspace history is not continuous for this path", change.path);
                }
                const excluded =
                    change.before.state === "excluded" || change.after.state === "excluded"
                        ? `path was excluded from snapshot coverage: ${
                              change.before.state === "excluded"
                                  ? change.before.reason
                                  : change.after.state === "excluded"
                                    ? change.after.reason
                                    : ""
                          }`
                        : existing?.excludedReason;
                transitions.set(change.path, {
                    target: existing?.target ?? change.before,
                    expectedCurrent: change.after,
                    ...(excluded == null ? {} : { excludedReason: excluded }),
                });
            }
        }
        const workspaceState = workspaceStatesByEntryId.get(entry.id);
        const resultChangeSets = [bridgeChangesByEntryId.get(entry.id), resultChangesByEntryId.get(entry.id)];
        if (workspaceState) {
            for (const resultChanges of resultChangeSets) {
                if (!resultChanges) continue;
                for (const change of resultChanges) {
                    const existing = transitions.get(change.path);
                    if (existing && !capturedEqual(existing.expectedCurrent, change.before)) {
                        return hardBlock(plan, "workspace history is not continuous for this path", change.path);
                    }
                    const excluded =
                        change.before.state === "excluded" || change.after.state === "excluded"
                            ? "path was excluded from snapshot coverage"
                            : existing?.excludedReason;
                    transitions.set(change.path, {
                        target: existing?.target ?? change.before,
                        expectedCurrent: change.after,
                        ...(excluded == null ? {} : { excludedReason: excluded }),
                    });
                }
            }
        }
    }
    if (!enforceRestoreTransitionLimit(plan, transitions)) return plan;
    const authorityCommits: string[] = [];
    for (const entry of suffix) {
        const checkpoint = checkpointsByEntryId.get(entry.id);
        if (checkpoint && checkpoint.before.id !== checkpoint.after.id) authorityCommits.push(checkpoint.after.id);
        const state = workspaceStatesByEntryId.get(entry.id);
        const bridge = bridgeChangesByEntryId.get(entry.id);
        if (state && bridge && state.linkedOperation) authorityCommits.push(state.linkedOperation.currentSnapshot.id);
        if (state && state.sourceSnapshot.id !== state.currentSnapshot.id)
            authorityCommits.push(state.currentSnapshot.id);
    }
    if (!(await validateAuthorityCommitOrder(plan, authorityCommits, input.mutationLog))) return plan;
    const historyBoundary = authorityCommits[0];
    const includedCommits = new Set(authorityCommits.slice(1));
    if (!historyBoundary) {
        return classifyRestoreTransitions(plan, transitions, input.inspectLivePath, input.inspectLivePaths, false);
    }
    const historyBlockers = await findCrestHistoryBlockers(plan, {
        mutationLog: input.mutationLog,
        afterCommit: historyBoundary,
        ...(input.authorityHead == null ? {} : { authorityHead: input.authorityHead }),
        paths: [...transitions.keys()].sort(),
        includedCommits,
        ownerSessionId: input.sessionId,
    });
    if (!historyBlockers) return plan;
    return classifyRestoreTransitions(
        plan,
        transitions,
        input.inspectLivePath,
        input.inspectLivePaths,
        false,
        historyBlockers
    );
}

export async function planRedo(input: PlanRedoInput): Promise<RestorePlanV1> {
    const plan = emptyPlan(
        input,
        {
            kind: "redo",
            sourceRewindOperationId: input.rewindState.operationId,
            linkedOperation: {
                operationId: input.rewindState.operationId,
                sourceSnapshot: input.rewindState.sourceSnapshot,
                currentSnapshot: input.rewindState.currentSnapshot,
            },
        },
        input.rewindState.rewind.fromLeafId
    );
    const active = activeBranch(input.rawEntries, input.semanticLeafId);
    if (!active.branch) {
        return hardBlock(plan, active.reason!);
    }
    const marker = currentLeafWorkspaceMarker(active.branch, input.sessionId);
    if (!marker || marker.kind !== "rewind" || !isDeepStrictEqual(marker, input.rewindState)) {
        return hardBlock(plan, "redo requires the current raw leaf to be this session's rewind marker");
    }
    if (
        input.rewindState.workspaceIdentity !== input.workspace.workspaceIdentity ||
        input.rewindState.workspaceIncarnation !== input.workspace.workspaceIncarnation
    ) {
        return hardBlock(plan, "redo workspace identity or incarnation does not match");
    }
    const snapshotFailure = await snapshotsAreReadable(
        [input.rewindState.sourceSnapshot, input.rewindState.currentSnapshot],
        input.workspace,
        input.verifySnapshot
    );
    if (snapshotFailure) {
        return hardBlock(plan, snapshotFailure);
    }

    const exactChanges = await validateResultMutationAuthority(
        plan,
        input.rewindState,
        input.mutationLog,
        input.diffSnapshots,
        input.readCommitSnapshot
    );
    if (!exactChanges) return plan;
    const transitions = new Map<string, RestorePathTransitionV1>();
    for (const change of exactChanges) {
        if (!canonicalPath(change.path) || transitions.has(change.path)) {
            return hardBlock(plan, "workspace result diff contains an invalid path", change.path);
        }
        transitions.set(change.path, {
            target: change.before,
            expectedCurrent: change.after,
            ...(change.before.state === "excluded" || change.after.state === "excluded"
                ? { excludedReason: "path was excluded from snapshot coverage" }
                : {}),
        });
    }
    if (!enforceRestoreTransitionLimit(plan, transitions)) return plan;
    const historyBlockers = await findCrestHistoryBlockers(plan, {
        mutationLog: input.mutationLog,
        afterCommit: input.rewindState.currentSnapshot.id,
        ...(input.authorityHead == null ? {} : { authorityHead: input.authorityHead }),
        paths: [...transitions.keys()].sort(),
        includedCommits: new Set(),
        ownerSessionId: input.sessionId,
        blockExternal: true,
    });
    if (!historyBlockers) return plan;
    return classifyRestoreTransitions(
        plan,
        transitions,
        input.inspectLivePath,
        input.inspectLivePaths,
        true,
        historyBlockers
    );
}
