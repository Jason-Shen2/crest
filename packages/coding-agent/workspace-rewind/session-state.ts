// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { filterCommittedTransactionEntries } from "@crest/agent/harness/session/entry-transaction";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { isContextCustomEntry } from "../context/journal";
import type { FoldedWorkspaceSessionState, WorkspaceCheckpointV1, WorkspaceStateV1 } from "./types";
import { WorkspaceControlCustomTypes } from "./types";
import { decodeWorkspaceCheckpointV1, decodeWorkspaceStateV1 } from "./validation";

const WorkspaceControlTypeValues = new Set<string>(Object.values(WorkspaceControlCustomTypes));

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
            semanticLeafId,
            displayLeafId: null,
            eligibleTurnIds: [],
            checkpointGaps: [],
        };
    }
    const branch = active.entries;
    const checkpointsByTurnId = new Map<string, WorkspaceCheckpointV1>();
    const eligibleTurnIds: string[] = [];
    const checkpointGaps: Array<{ turnId: string; reason: string }> = [];
    let activeWorkspaceState: WorkspaceStateV1 | undefined;

    for (const entry of branch) {
        const state = decodeWorkspaceStateEntry(entry);
        if (state?.sessionId === sessionId) {
            activeWorkspaceState = state;
        }
    }

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
            continue;
        }
        checkpointGaps.push({ turnId, reason: checkpointGapReason(checkpoint) });
    }

    return {
        checkpointsByTurnId,
        ...(activeWorkspaceState == null ? {} : { activeWorkspaceState }),
        semanticLeafId,
        displayLeafId: displayLeafId(branch),
        eligibleTurnIds,
        checkpointGaps,
    };
}
