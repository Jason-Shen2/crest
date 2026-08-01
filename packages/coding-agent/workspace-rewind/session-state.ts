// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { filterCommittedTransactionEntries } from "@crest/agent/harness/session/entry-transaction";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { isContextCustomEntry } from "../context/journal";
import type { AgentCheckpointQuotaView, AgentRedoView, AgentRewindSessionStateView } from "./api-types";
import type {
    FoldedWorkspaceSessionState,
    WorkspaceCheckpointV1,
    WorkspaceSnapshotRefV1,
    WorkspaceStateV1,
} from "./types";
import { WorkspaceControlCustomTypes } from "./types";
import { decodeWorkspaceCheckpointV1, decodeWorkspaceStateV1 } from "./validation";

const WorkspaceControlTypeValues = new Set<string>(Object.values(WorkspaceControlCustomTypes));
export type WorkspaceTurnMutationStateV1 = Extract<WorkspaceStateV1, { kind: "turn-undo" } | { kind: "turn-redo" }>;
export type WorkspaceTurnMutationAuthority = { action: "undo" } | { action: "redo"; undoOperationId: string };

export function advanceTurnMutationAuthority(
    current: WorkspaceTurnMutationAuthority,
    state: WorkspaceTurnMutationStateV1
): WorkspaceTurnMutationAuthority {
    if (state.kind === "turn-undo" && current.action === "undo") {
        return { action: "redo", undoOperationId: state.operationId };
    }
    if (state.kind === "turn-redo" && current.action === "redo" && current.undoOperationId === state.undoOperationId) {
        return { action: "undo" };
    }
    return current;
}

function rawLeafId(entries: SessionTreeEntry[]): string | null {
    let leafId: string | null = null;
    for (const entry of entries) {
        leafId = entry.type === "leaf" ? entry.targetId : entry.id;
    }
    return leafId;
}

interface ValidatedActiveBranch {
    valid: boolean;
    entries: SessionTreeEntry[];
}

function activeBranch(entries: SessionTreeEntry[], leafId: string | null): ValidatedActiveBranch {
    if (leafId == null) {
        return { valid: true, entries: [] };
    }
    const byId = new Map<string, SessionTreeEntry>();
    for (const entry of entries) {
        if (byId.has(entry.id)) {
            return { valid: false, entries: [] };
        }
        byId.set(entry.id, entry);
    }
    const branch: SessionTreeEntry[] = [];
    const visited = new Set<string>();
    let cursorId: string | null = leafId;
    while (cursorId != null) {
        if (visited.has(cursorId)) {
            return { valid: false, entries: [] };
        }
        const cursor = byId.get(cursorId);
        if (!cursor) {
            return { valid: false, entries: [] };
        }
        branch.push(cursor);
        visited.add(cursorId);
        cursorId = cursor.parentId;
    }
    return { valid: true, entries: branch.reverse() };
}

function displayLeafId(branch: SessionTreeEntry[]): string | null {
    for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index]!;
        if (
            entry.type !== "leaf" &&
            entry.type !== "label" &&
            !isContextCustomEntry(entry) &&
            !isWorkspaceControlEntry(entry)
        ) {
            return entry.id;
        }
    }
    return null;
}

function isUserTurn(entry: SessionTreeEntry): boolean {
    return entry.type === "message" && entry.message.role === "user";
}

function committedTransactionStartsByUserId(branch: SessionTreeEntry[]): Map<string, number> {
    const startsByUserId = new Map<string, number>();
    const transactions = filterCommittedTransactionEntries(branch).committedTransactions;
    for (const transaction of transactions.values()) {
        const firstEntry = transaction.physicalEntries[0];
        const firstIndex = firstEntry == null ? -1 : branch.indexOf(firstEntry);
        const userIndex = branch.findIndex((entry) => entry.id === transaction.userEntryId);
        if (firstIndex >= 0 && userIndex > firstIndex) {
            startsByUserId.set(transaction.userEntryId, firstIndex);
        }
    }
    return startsByUserId;
}

function checkpointGapReason(checkpoint: WorkspaceCheckpointV1): string {
    return checkpoint.status === "unavailable"
        ? `workspace checkpoint unavailable: ${checkpoint.reasonCode}`
        : "workspace checkpoint unavailable";
}

export function isWorkspaceControlEntry(entry: SessionTreeEntry): boolean {
    return entry.type === "custom" && WorkspaceControlTypeValues.has(entry.customType);
}

export function decodeWorkspaceCheckpointEntry(entry: SessionTreeEntry): WorkspaceCheckpointV1 | undefined {
    if (entry.type !== "custom" || entry.customType !== WorkspaceControlCustomTypes.checkpoint) {
        return undefined;
    }
    return decodeWorkspaceCheckpointV1(entry.data);
}

export function decodeWorkspaceStateEntry(entry: SessionTreeEntry): WorkspaceStateV1 | undefined {
    if (entry.type !== "custom" || entry.customType !== WorkspaceControlCustomTypes.state) {
        return undefined;
    }
    return decodeWorkspaceStateV1(entry.data);
}

export function foldWorkspaceSessionState(entries: SessionTreeEntry[], sessionId: string): FoldedWorkspaceSessionState {
    const semanticLeafId = rawLeafId(entries);
    const active = activeBranch(entries, semanticLeafId);
    if (!active.valid) {
        return {
            checkpointsByTurnId: new Map(),
            turnMutationsByTurnId: new Map(),
            semanticLeafId,
            displayLeafId: null,
            eligibleTurnIds: [],
            checkpointGaps: [],
        };
    }
    const branch = active.entries;
    const committedEntries = filterCommittedTransactionEntries(branch).entries;
    const committedEntrySet = new Set(committedEntries);
    const checkpointsByTurnId = new Map<string, WorkspaceCheckpointV1>();
    const eligibleTurnIds: string[] = [];
    const checkpointGaps: Array<{ turnId: string; reason: string }> = [];
    let activeWorkspaceState: WorkspaceStateV1 | undefined;
    const turnMutationStates: Array<{ branchIndex: number; state: WorkspaceTurnMutationStateV1 }> = [];

    for (let branchIndex = 0; branchIndex < branch.length; branchIndex++) {
        const entry = branch[branchIndex]!;
        if (!committedEntrySet.has(entry)) {
            continue;
        }
        const state = decodeWorkspaceStateEntry(entry);
        if (state?.sessionId !== sessionId) {
            continue;
        }
        activeWorkspaceState = state;
        if (state.kind === "turn-undo" || state.kind === "turn-redo") {
            turnMutationStates.push({ branchIndex, state });
        }
    }
    const rawLeaf = branch.at(-1);
    const rawLeafState =
        rawLeaf != null && committedEntrySet.has(rawLeaf) ? decodeWorkspaceStateEntry(rawLeaf) : undefined;
    const conversationRedoState =
        rawLeafState?.sessionId === sessionId && rawLeafState.kind === "rewind" ? rawLeafState : undefined;

    const mutationSourcesByTurnId = new Map<
        string,
        { checkpoint: Extract<WorkspaceCheckpointV1, { status: "available" }>; branchIndex: number }
    >();
    const userIndexes = branch.flatMap((entry, index) => (isUserTurn(entry) ? [index] : []));
    const transactionStartsByUserId = committedTransactionStartsByUserId(branch);
    for (let turnIndex = 0; turnIndex < userIndexes.length; turnIndex++) {
        const start = userIndexes[turnIndex]!;
        const nextUserIndex = userIndexes[turnIndex + 1];
        const nextUserId = nextUserIndex == null ? undefined : branch[nextUserIndex]!.id;
        const end = nextUserId == null ? branch.length : (transactionStartsByUserId.get(nextUserId) ?? nextUserIndex!);
        const turnId = branch[start]!.id;
        const turnEntries = branch.slice(start + 1, end);
        const checkpointEntries = turnEntries.filter(
            (entry) => entry.type === "custom" && entry.customType === WorkspaceControlCustomTypes.checkpoint
        );
        if (checkpointEntries.length !== 1) {
            checkpointGaps.push({
                turnId,
                reason:
                    checkpointEntries.length === 0
                        ? "workspace checkpoint is missing"
                        : "workspace checkpoint is not unique",
            });
            continue;
        }
        const checkpointEntry = checkpointEntries[0]!;
        const checkpoint = decodeWorkspaceCheckpointEntry(checkpointEntry);
        if (!checkpoint) {
            checkpointGaps.push({ turnId, reason: "workspace checkpoint is invalid" });
            continue;
        }
        if (checkpoint.turnId !== turnId) {
            checkpointGaps.push({ turnId, reason: "workspace checkpoint turnId does not match the active turn" });
            continue;
        }
        if (checkpoint.originSessionId !== sessionId) {
            checkpointGaps.push({ turnId, reason: "workspace checkpoint originSessionId does not match the session" });
            continue;
        }
        const checkpointIndex = turnEntries.indexOf(checkpointEntry);
        const hasNonterminalEntry = turnEntries
            .slice(checkpointIndex + 1)
            .some((entry) => !isWorkspaceControlEntry(entry));
        if (hasNonterminalEntry) {
            checkpointGaps.push({ turnId, reason: "workspace checkpoint is not terminal" });
            continue;
        }
        checkpointsByTurnId.set(turnId, checkpoint);
        if (checkpoint.status === "available") {
            eligibleTurnIds.push(turnId);
            mutationSourcesByTurnId.set(turnId, {
                checkpoint,
                branchIndex: start + 1 + checkpointIndex,
            });
            continue;
        }
        checkpointGaps.push({ turnId, reason: checkpointGapReason(checkpoint) });
    }

    const turnMutationsByTurnId = new Map<string, WorkspaceTurnMutationAuthority>();
    for (const turnId of eligibleTurnIds) {
        turnMutationsByTurnId.set(turnId, { action: "undo" });
    }
    for (const { branchIndex, state } of turnMutationStates) {
        const source = mutationSourcesByTurnId.get(state.sourceTurnId);
        if (
            !source ||
            branchIndex <= source.branchIndex ||
            state.workspaceIdentity !== source.checkpoint.workspaceIdentity ||
            state.workspaceIncarnation !== source.checkpoint.workspaceIncarnation
        ) {
            continue;
        }
        const current = turnMutationsByTurnId.get(state.sourceTurnId);
        if (!current) {
            continue;
        }
        turnMutationsByTurnId.set(state.sourceTurnId, advanceTurnMutationAuthority(current, state));
    }

    return {
        checkpointsByTurnId,
        ...(activeWorkspaceState == null ? {} : { activeWorkspaceState }),
        ...(conversationRedoState == null ? {} : { conversationRedoState }),
        turnMutationsByTurnId,
        semanticLeafId,
        displayLeafId: displayLeafId(branch),
        eligibleTurnIds,
        checkpointGaps,
    };
}

export interface AgentRewindSessionStateProbe {
    enabled: boolean;
    busy: boolean;
    frozen: boolean;
    verifySnapshot(snapshot: WorkspaceSnapshotRefV1): Promise<void>;
    getQuota(): Promise<AgentCheckpointQuotaView>;
}

const DisabledQuota: AgentCheckpointQuotaView = {
    status: "ok",
    usedBytes: 0,
    softQuotaBytes: 0,
    cleanupAvailable: false,
};

function userPrompt(entries: SessionTreeEntry[], turnId: string): string {
    const entry = entries.find((candidate) => candidate.id === turnId);
    if (entry?.type !== "message") return "";
    const content = (entry.message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (part): part is { type: "text"; text: string } =>
                part != null &&
                typeof part === "object" &&
                "type" in part &&
                part.type === "text" &&
                "text" in part &&
                typeof part.text === "string"
        )
        .map((part) => part.text)
        .join("");
}

/**
 * Builds the renderer state from the raw persisted branch and verifies every
 * advertised snapshot against the store. SQLite metadata alone is never
 * treated as proof that snapshot objects are still available.
 */
export async function buildAgentRewindSessionStateView(
    entries: SessionTreeEntry[],
    sessionId: string,
    probe: AgentRewindSessionStateProbe
): Promise<AgentRewindSessionStateView> {
    const folded = foldWorkspaceSessionState(entries, sessionId);
    if (!probe.enabled) {
        return {
            enabled: false,
            semanticLeafId: folded.semanticLeafId,
            displayLeafId: folded.displayLeafId,
            eligibleTurnIds: [],
            turnChanges: [],
            busy: probe.busy,
            frozen: probe.frozen,
            quota: DisabledQuota,
        };
    }

    const eligibleTurnIds: string[] = [];
    for (const turnId of folded.eligibleTurnIds) {
        const checkpoint = folded.checkpointsByTurnId.get(turnId);
        if (checkpoint?.status !== "available") continue;
        try {
            await probe.verifySnapshot(checkpoint.before);
            await probe.verifySnapshot(checkpoint.after);
            eligibleTurnIds.push(turnId);
        } catch {
            // A corrupt/missing descriptor is a checkpoint gap, not an
            // invitation for the renderer to attempt a destructive action.
        }
    }

    const readableTurnIds = new Set(eligibleTurnIds);
    const turnChanges: AgentRewindSessionStateView["turnChanges"] = [];
    for (const [turnId, mutation] of folded.turnMutationsByTurnId) {
        const checkpoint = folded.checkpointsByTurnId.get(turnId);
        if (checkpoint?.status !== "available" || checkpoint.changes.length === 0 || !readableTurnIds.has(turnId)) {
            continue;
        }
        turnChanges.push({
            turnId,
            action: mutation.action,
            ...(mutation.action === "redo" ? { undoOperationId: mutation.undoOperationId } : {}),
        });
    }

    let redo: AgentRedoView | undefined;
    const state = folded.conversationRedoState;
    if (state) {
        try {
            await probe.verifySnapshot(state.currentSnapshot);
            await probe.verifySnapshot(state.rewind.redoSnapshot);
            redo = {
                operationId: state.operationId,
                targetPrompt: userPrompt(entries, state.rewind.targetTurnId),
                messageCount: 0,
                fileCount: state.rewind.redoStates.length,
                files: [],
            };
        } catch {
            redo = undefined;
        }
    }

    return {
        enabled: true,
        semanticLeafId: folded.semanticLeafId,
        displayLeafId: folded.displayLeafId,
        eligibleTurnIds,
        turnChanges,
        busy: probe.busy,
        frozen: probe.frozen,
        quota: await probe.getQuota(),
        ...(redo == null ? {} : { redo }),
    };
}
