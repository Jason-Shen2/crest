// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { filterCommittedTransactionEntries } from "@crest/agent/harness/session/entry-transaction";
import type { SessionTreeEntry } from "@crest/agent/harness/types";

import type { LiveCapturedPathState } from "./live-path-state";
import {
    classifyRestoreTransitions,
    type RestorePathTransitionV1,
    type RestorePlanV1,
    type RestoreTargetV1,
} from "./restore-plan";
import {
    advanceTurnMutationAuthority,
    decodeWorkspaceCheckpointEntry,
    decodeWorkspaceStateEntry,
    isWorkspaceControlEntry,
    type WorkspaceTurnMutationAuthority,
} from "./session-state";
import type { WorkspaceCheckpointV1, WorkspaceSnapshotRefV1 } from "./types";
import { WorkspaceControlCustomTypes } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";

interface PlanTurnRestoreBaseInput {
    sessionId: string;
    workspace: CanonicalWorkspaceIdentity;
    rawEntries: SessionTreeEntry[];
    semanticLeafId: string | null;
    sourceTurnId: string;
    inspectLivePath: (path: string) => Promise<LiveCapturedPathState>;
    inspectLivePaths?: (paths: readonly string[]) => Promise<ReadonlyMap<string, LiveCapturedPathState>>;
    verifySnapshot: (snapshot: WorkspaceSnapshotRefV1) => Promise<void>;
}

export type PlanTurnUndoInput = PlanTurnRestoreBaseInput;

export interface PlanTurnRedoInput extends PlanTurnRestoreBaseInput {
    undoOperationId: string;
}

interface ActiveBranchResult {
    branch?: SessionTreeEntry[];
    reason?: string;
}

type AvailableCheckpoint = Extract<WorkspaceCheckpointV1, { status: "available" }>;

function emptyPlan(input: PlanTurnRestoreBaseInput, target: RestoreTargetV1): RestorePlanV1 {
    return {
        target,
        sessionId: input.sessionId,
        workspaceIdentity: input.workspace.workspaceIdentity,
        workspaceIncarnation: input.workspace.workspaceIncarnation,
        semanticLeafId: input.semanticLeafId,
        commitParentId: input.semanticLeafId,
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
        if (entry.type === "leaf") continue;
        if (byId.has(entry.id)) return { reason: "session contains duplicate entry IDs" };
        byId.set(entry.id, entry);
    }
    const reverse: SessionTreeEntry[] = [];
    const visited = new Set<string>();
    let cursor: string | null = semanticLeafId;
    while (cursor != null) {
        if (visited.has(cursor)) return { reason: "session branch contains a cycle" };
        const entry = byId.get(cursor);
        if (!entry) return { reason: "session branch contains a missing parent" };
        reverse.push(entry);
        visited.add(cursor);
        cursor = entry.parentId;
    }
    return { branch: reverse.reverse() };
}

function canonicalPath(path: string): boolean {
    if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
        return false;
    }
    return path.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function userEntry(entry: SessionTreeEntry): boolean {
    return entry.type === "message" && entry.message.role === "user";
}

function committedTransactionStartsByUserId(branch: SessionTreeEntry[]): ReadonlyMap<string, number> {
    const entryIndexes = new Map(branch.map((entry, index) => [entry.id, index]));
    const starts = new Map<string, number>();
    for (const transaction of filterCommittedTransactionEntries(branch).committedTransactions.values()) {
        const first = transaction.physicalEntries[0];
        const firstIndex = first == null ? undefined : entryIndexes.get(first.id);
        if (firstIndex != null) starts.set(transaction.userEntryId, firstIndex);
    }
    return starts;
}

function terminalCheckpoint(
    branch: SessionTreeEntry[],
    visibleEntries: ReadonlySet<SessionTreeEntry>,
    sourceIndex: number,
    sessionId: string
): { checkpoint?: AvailableCheckpoint; entryIndex?: number; reason?: string } {
    const nextUserIndex = branch.findIndex((entry, index) => index > sourceIndex && userEntry(entry));
    let end = nextUserIndex < 0 ? branch.length : nextUserIndex;
    if (nextUserIndex >= 0) {
        const transactionStart = committedTransactionStartsByUserId(branch).get(branch[nextUserIndex]!.id);
        if (transactionStart != null && transactionStart > sourceIndex) end = transactionStart;
    }
    const checkpointEntries = branch
        .map((entry, index) => ({ entry, index }))
        .slice(sourceIndex + 1, end)
        .filter(
            (item) =>
                visibleEntries.has(item.entry) &&
                item.entry.type === "custom" &&
                item.entry.customType === WorkspaceControlCustomTypes.checkpoint
        );
    if (checkpointEntries.length === 0) return { reason: "workspace checkpoint is missing" };
    if (checkpointEntries.length !== 1) return { reason: "workspace checkpoint is not unique" };
    const selected = checkpointEntries[0]!;
    const checkpoint = decodeWorkspaceCheckpointEntry(selected.entry);
    if (!checkpoint) return { reason: "workspace checkpoint is invalid" };
    if (checkpoint.originSessionId !== sessionId) return { reason: "checkpoint is owned by another session" };
    if (checkpoint.turnId !== branch[sourceIndex]!.id) {
        return { reason: "workspace checkpoint is invalid" };
    }
    if (
        branch
            .slice(selected.index + 1, end)
            .some((entry) => visibleEntries.has(entry) && !isWorkspaceControlEntry(entry))
    ) {
        return { reason: "workspace checkpoint is not terminal" };
    }
    if (checkpoint.status === "unavailable") {
        return { reason: `workspace checkpoint is unavailable: ${checkpoint.reasonCode}` };
    }
    return { checkpoint, entryIndex: selected.index };
}

async function verifyCheckpoint(
    plan: RestorePlanV1,
    checkpoint: AvailableCheckpoint,
    input: PlanTurnRestoreBaseInput
): Promise<boolean> {
    if (
        checkpoint.workspaceIdentity !== input.workspace.workspaceIdentity ||
        checkpoint.workspaceIncarnation !== input.workspace.workspaceIncarnation
    ) {
        hardBlock(plan, "checkpoint workspace identity or incarnation does not match", checkpoint.turnId);
        return false;
    }
    for (const snapshot of [checkpoint.before, checkpoint.after]) {
        if (
            snapshot.workspaceIdentity !== input.workspace.workspaceIdentity ||
            snapshot.workspaceIncarnation !== input.workspace.workspaceIncarnation
        ) {
            hardBlock(plan, "snapshot workspace identity or incarnation does not match");
            return false;
        }
        try {
            await input.verifySnapshot(snapshot);
        } catch (error) {
            hardBlock(plan, `snapshot is unavailable: ${(error as Error).message}`);
            return false;
        }
    }
    return true;
}

function projectCoverage(plan: RestorePlanV1, checkpoint: AvailableCheckpoint): boolean {
    for (const exclusion of checkpoint.coverage.exclusions) {
        if (exclusion.path != null) {
            if (!canonicalPath(exclusion.path)) {
                hardBlock(plan, "path is not a canonical workspace-relative path", exclusion.path);
                return false;
            }
            plan.coverageWarnings.push({ path: exclusion.path, reason: exclusion.reason });
            continue;
        }
        plan.coverageWarnings.push({ path: "", reason: exclusion.reason });
    }
    if (!checkpoint.coverage.complete || checkpoint.coverage.exclusions.length > 0) {
        hardBlock(plan, "workspace checkpoint coverage is incomplete");
        return false;
    }
    return true;
}

function transitionsForCheckpoint(
    plan: RestorePlanV1,
    checkpoint: AvailableCheckpoint,
    direction: "undo" | "redo"
): Map<string, RestorePathTransitionV1> | undefined {
    const transitions = new Map<string, RestorePathTransitionV1>();
    for (const change of checkpoint.changes) {
        if (!canonicalPath(change.path)) {
            hardBlock(plan, "path is not a canonical workspace-relative path", change.path);
            return undefined;
        }
        if (transitions.has(change.path)) {
            hardBlock(plan, "workspace checkpoint contains duplicate paths", change.path);
            return undefined;
        }
        const target = direction === "undo" ? change.before : change.after;
        const expectedCurrent = direction === "undo" ? change.after : change.before;
        if (target.state === "excluded" || expectedCurrent.state === "excluded") {
            hardBlock(plan, "path was excluded from snapshot coverage", change.path);
            return undefined;
        }
        transitions.set(change.path, {
            target,
            expectedCurrent,
        });
    }
    return transitions;
}

function sourceMutationAuthority(
    branch: SessionTreeEntry[],
    visibleEntries: ReadonlySet<SessionTreeEntry>,
    checkpointIndex: number,
    input: PlanTurnRedoInput
): WorkspaceTurnMutationAuthority {
    let authority: WorkspaceTurnMutationAuthority = { action: "undo" };
    for (const entry of branch.slice(checkpointIndex + 1)) {
        if (!visibleEntries.has(entry)) continue;
        const state = decodeWorkspaceStateEntry(entry);
        if (
            state?.sessionId === input.sessionId &&
            state.sourceTurnId === input.sourceTurnId &&
            state.workspaceIdentity === input.workspace.workspaceIdentity &&
            state.workspaceIncarnation === input.workspace.workspaceIncarnation &&
            (state.kind === "turn-undo" || state.kind === "turn-redo")
        ) {
            authority = advanceTurnMutationAuthority(authority, state);
        }
    }
    return authority;
}

async function prepare(
    input: PlanTurnRestoreBaseInput,
    target: RestoreTargetV1
): Promise<{
    plan: RestorePlanV1;
    branch?: SessionTreeEntry[];
    visibleEntries?: ReadonlySet<SessionTreeEntry>;
    checkpoint?: AvailableCheckpoint;
    checkpointIndex?: number;
}> {
    const plan = emptyPlan(input, target);
    const active = activeBranch(input.rawEntries, input.semanticLeafId);
    if (!active.branch) return { plan: hardBlock(plan, active.reason!) };
    const sourceIndex = active.branch.findIndex((entry) => entry.id === input.sourceTurnId && userEntry(entry));
    if (sourceIndex < 0) {
        return { plan: hardBlock(plan, "source turn is not a durable user entry on the active branch") };
    }
    const visibleEntries = new Set(filterCommittedTransactionEntries(active.branch).entries);
    if (!visibleEntries.has(active.branch[sourceIndex]!)) {
        return { plan: hardBlock(plan, "source turn is not committed on the active branch") };
    }
    const selected = terminalCheckpoint(active.branch, visibleEntries, sourceIndex, input.sessionId);
    if (!selected.checkpoint) return { plan: hardBlock(plan, selected.reason!, input.sourceTurnId) };
    if (!(await verifyCheckpoint(plan, selected.checkpoint, input))) return { plan };
    if (!projectCoverage(plan, selected.checkpoint)) return { plan };
    return {
        plan,
        branch: active.branch,
        visibleEntries,
        checkpoint: selected.checkpoint,
        checkpointIndex: selected.entryIndex,
    };
}

export async function planTurnUndo(input: PlanTurnUndoInput): Promise<RestorePlanV1> {
    const prepared = await prepare(input, { kind: "turn-undo", sourceTurnId: input.sourceTurnId });
    if (!prepared.checkpoint) return prepared.plan;
    const transitions = transitionsForCheckpoint(prepared.plan, prepared.checkpoint, "undo");
    if (!transitions) return prepared.plan;
    return classifyRestoreTransitions(prepared.plan, transitions, input.inspectLivePath, input.inspectLivePaths, false);
}

export async function planTurnRedo(input: PlanTurnRedoInput): Promise<RestorePlanV1> {
    const prepared = await prepare(input, {
        kind: "turn-redo",
        sourceTurnId: input.sourceTurnId,
        undoOperationId: input.undoOperationId,
    });
    if (!prepared.checkpoint) return prepared.plan;
    const authority = sourceMutationAuthority(
        prepared.branch!,
        prepared.visibleEntries!,
        prepared.checkpointIndex!,
        input
    );
    if (authority.action !== "redo" || authority.undoOperationId !== input.undoOperationId) {
        return hardBlock(
            prepared.plan,
            "Redo requires the source turn's current last marker to point at this undoOperationId"
        );
    }
    const transitions = transitionsForCheckpoint(prepared.plan, prepared.checkpoint, "redo");
    if (!transitions) return prepared.plan;
    return classifyRestoreTransitions(prepared.plan, transitions, input.inspectLivePath, input.inspectLivePaths, true);
}
