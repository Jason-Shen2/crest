// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    filterCommittedTransactionEntries,
    getTransactionForkBoundary,
} from "@crest/agent/harness/session/entry-transaction";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { isDeepStrictEqual } from "node:util";
import { classifyLivePath, type LiveCapturedPathState, type RewindConflictClass } from "./live-path-state";
import { decodeWorkspaceCheckpointEntry, decodeWorkspaceStateEntry, isWorkspaceControlEntry } from "./session-state";
import type { CapturedPathStateV1, WorkspaceCheckpointV1, WorkspaceSnapshotRefV1, WorkspaceStateV1 } from "./types";
import { WorkspaceControlCustomTypes } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";

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

export interface RestorePlanV1 {
    kind: "rewind" | "redo";
    sessionId: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    semanticLeafId: string | null;
    targetTurnId?: string;
    targetBoundaryId: string | null;
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
    targetTurnId: string;
    currentWorkspaceState?: WorkspaceStateV1;
    inspectLivePath: (path: string) => Promise<LiveCapturedPathState>;
    inspectLivePaths?: (paths: readonly string[]) => Promise<ReadonlyMap<string, LiveCapturedPathState>>;
    verifySnapshot: (snapshot: WorkspaceSnapshotRefV1) => Promise<void>;
}

export interface PlanRedoInput {
    sessionId: string;
    workspace: CanonicalWorkspaceIdentity;
    rawEntries: SessionTreeEntry[];
    semanticLeafId: string | null;
    rewindState: WorkspaceRewindMarkerV1;
    inspectLivePath: (path: string) => Promise<LiveCapturedPathState>;
    inspectLivePaths?: (paths: readonly string[]) => Promise<ReadonlyMap<string, LiveCapturedPathState>>;
    verifySnapshot: (snapshot: WorkspaceSnapshotRefV1) => Promise<void>;
}

interface ActiveBranchResult {
    branch?: SessionTreeEntry[];
    reason?: string;
}

interface PathTransition {
    target: CapturedPathStateV1;
    expectedCurrent: CapturedPathStateV1;
    excludedReason?: string;
}

function emptyPlan(
    input: {
        sessionId: string;
        workspace: CanonicalWorkspaceIdentity;
        semanticLeafId: string | null;
    },
    kind: "rewind" | "redo",
    targetBoundaryId: string | null,
    targetTurnId?: string
): RestorePlanV1 {
    return {
        kind,
        sessionId: input.sessionId,
        workspaceIdentity: input.workspace.workspaceIdentity,
        workspaceIncarnation: input.workspace.workspaceIncarnation,
        semanticLeafId: input.semanticLeafId,
        ...(targetTurnId == null ? {} : { targetTurnId }),
        targetBoundaryId,
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

function currentLeafWorkspaceMarker(branch: SessionTreeEntry[], sessionId: string): WorkspaceStateV1 | undefined {
    const leaf = branch.at(-1);
    const state = leaf == null ? undefined : decodeWorkspaceStateEntry(leaf);
    return state?.sessionId === sessionId ? state : undefined;
}

function activeWorkspaceStates(
    branch: SessionTreeEntry[],
    sessionId: string
): Array<{ entryId: string; branchIndex: number; state: WorkspaceStateV1 }> {
    return branch.flatMap((entry, branchIndex) => {
        const state = decodeWorkspaceStateEntry(entry);
        return state?.sessionId === sessionId ? [{ entryId: entry.id, branchIndex, state }] : [];
    });
}

async function classifyTransitions(
    plan: RestorePlanV1,
    transitions: Map<string, PathTransition>,
    inspect: (path: string) => Promise<LiveCapturedPathState>,
    inspectBatch: ((paths: readonly string[]) => Promise<ReadonlyMap<string, LiveCapturedPathState>>) | undefined,
    redo: boolean
): Promise<RestorePlanV1> {
    const effective: Array<{ path: string; transition: PathTransition }> = [];
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
        const conflict =
            redo && classification.conflict === "forceable-drift" ? "hard-blocker" : classification.conflict;
        const reason =
            redo && classification.conflict === "forceable-drift"
                ? "redo is blocked because the workspace changed after rewind"
                : classification.reason;
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
    const plan = emptyPlan(input, "rewind", targetBoundaryId, input.targetTurnId);
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
    for (const entry of suffix) {
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
    const fullBranchWorkspaceStates = activeWorkspaceStates(branch, input.sessionId);
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
        snapshots.push(item.state.currentSnapshot);
    }
    const snapshotFailure = await snapshotsAreReadable(snapshots, input.workspace, input.verifySnapshot);
    if (snapshotFailure) {
        return hardBlock(plan, snapshotFailure);
    }

    const workspaceStatesByEntryId = new Map(workspaceStates.map((item) => [item.entryId, item.state]));
    const transitions = new Map<string, PathTransition>();
    for (const entry of suffix) {
        const checkpoint = checkpointsByEntryId.get(entry.id);
        if (checkpoint) {
            for (const change of checkpoint.changes) {
                const existing = transitions.get(change.path);
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
        if (workspaceState) {
            const seen = new Set<string>();
            for (const item of workspaceState.currentStates) {
                if (seen.has(item.path)) {
                    return hardBlock(plan, "workspace state contains duplicate paths", item.path);
                }
                seen.add(item.path);
                const transition = transitions.get(item.path);
                if (transition) {
                    transition.expectedCurrent = item.state;
                }
            }
        }
    }
    return classifyTransitions(plan, transitions, input.inspectLivePath, input.inspectLivePaths, false);
}

export async function planRedo(input: PlanRedoInput): Promise<RestorePlanV1> {
    const plan = emptyPlan(input, "redo", input.rewindState.rewind.targetBoundaryId);
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
        [input.rewindState.currentSnapshot, input.rewindState.rewind.redoSnapshot],
        input.workspace,
        input.verifySnapshot
    );
    if (snapshotFailure) {
        return hardBlock(plan, snapshotFailure);
    }

    const current = new Map<string, CapturedPathStateV1>();
    for (const item of input.rewindState.currentStates) {
        if (current.has(item.path)) {
            return hardBlock(plan, "rewind marker contains duplicate current paths", item.path);
        }
        current.set(item.path, item.state);
    }
    const transitions = new Map<string, PathTransition>();
    for (const item of input.rewindState.rewind.redoStates) {
        if (transitions.has(item.path)) {
            return hardBlock(plan, "rewind marker contains duplicate redo paths", item.path);
        }
        const expectedCurrent = current.get(item.path);
        if (!expectedCurrent) {
            return hardBlock(plan, "rewind marker is missing an expected current path state", item.path);
        }
        transitions.set(item.path, {
            target: item.state,
            expectedCurrent,
            ...(item.state.state === "excluded" || expectedCurrent.state === "excluded"
                ? { excludedReason: "path was excluded from snapshot coverage" }
                : {}),
        });
    }
    return classifyTransitions(plan, transitions, input.inspectLivePath, input.inspectLivePaths, true);
}
