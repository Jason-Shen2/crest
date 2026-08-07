// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { PendingWorkspaceRestoreV2 } from "./pending-restore-store";
import type { WorkspaceSnapshotStore } from "./snapshot-store";
import type { CapturedPathStateV1, WorkspaceSnapshotRefV1, WorkspaceStateBaseV1, WorkspaceStateV1 } from "./types";

export type RestorableCapturedPathState = Exclude<CapturedPathStateV1, { state: "excluded" }>;

export interface DerivedWorkspaceRestoreState {
    sourceSnapshot: WorkspaceSnapshotRefV1;
    plannedSnapshot: WorkspaceSnapshotRefV1;
    sourceStates: Array<{ path: string; state: RestorableCapturedPathState }>;
    plannedStates: Array<{ path: string; state: RestorableCapturedPathState }>;
    markerState: WorkspaceStateV1;
}

export async function deriveWorkspaceRestoreState(
    store: Pick<WorkspaceSnapshotStore, "readCommitSnapshot" | "readPathState">,
    pending: PendingWorkspaceRestoreV2
): Promise<DerivedWorkspaceRestoreState> {
    const [sourceSnapshot, plannedSnapshot] = await Promise.all([
        store.readCommitSnapshot(pending.sourceCommit),
        store.readCommitSnapshot(pending.plannedCommit),
    ]);
    const sourceStates: DerivedWorkspaceRestoreState["sourceStates"] = [];
    const plannedStates: DerivedWorkspaceRestoreState["plannedStates"] = [];
    for (const path of pending.affectedPaths) {
        const [source, planned] = await Promise.all([
            store.readPathState(sourceSnapshot, path),
            store.readPathState(plannedSnapshot, path),
        ]);
        if (source.state === "excluded" || planned.state === "excluded") {
            throw new Error(`Restore result commit excludes an affected path: ${path}`);
        }
        sourceStates.push({ path, state: source });
        plannedStates.push({ path, state: planned });
    }
    const base = {
        schemaVersion: 1,
        sessionId: pending.sessionId,
        operationId: pending.operationId,
        workspaceIdentity: pending.workspaceIdentity,
        workspaceIncarnation: pending.workspaceIncarnation,
        applyMode: pending.applyMode,
        forcedPaths: [...pending.forcedPaths],
        currentSnapshot: plannedSnapshot,
        currentStates: plannedStates.map((item) => ({ path: item.path, state: item.state })),
    } satisfies WorkspaceStateBaseV1;
    let markerState: WorkspaceStateV1;
    if (pending.target.kind === "rewind") {
        markerState = {
            ...base,
            kind: "rewind",
            rewind: {
                fromLeafId: pending.expectedSemanticLeafId,
                targetTurnId: pending.target.targetTurnId,
                targetBoundaryId: pending.commitParentId,
                redoSnapshot: sourceSnapshot,
                redoStates: sourceStates.map((item) => ({ path: item.path, state: item.state })),
            },
        };
    } else if (pending.target.kind === "redo") {
        markerState = { ...base, kind: "redo" };
    } else if (pending.target.kind === "turn-undo") {
        markerState = { ...base, kind: "turn-undo", sourceTurnId: pending.target.sourceTurnId };
    } else {
        markerState = {
            ...base,
            kind: "turn-redo",
            sourceTurnId: pending.target.sourceTurnId,
            undoOperationId: pending.target.undoOperationId,
        };
    }
    return { sourceSnapshot, plannedSnapshot, sourceStates, plannedStates, markerState };
}
