// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export const WorkspaceControlCustomTypes = {
    checkpoint: "workspace_checkpoint",
    state: "workspace_state",
} as const;

export type WorkspaceCoverageReason =
    | "ignored"
    | "nested-repository"
    | "oversized-untracked"
    | "non-utf8-path"
    | "hard-linked"
    | "special-entry"
    | "capture-budget";

export type CapturedPathStateV1 =
    | { state: "absent" }
    | { state: "file"; oid: string; executable: boolean }
    | { state: "symlink"; oid: string }
    | { state: "excluded"; reason: WorkspaceCoverageReason };

export interface WorkspaceSnapshotRefV1 {
    id: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    tree: string;
    scopeManifest: string;
}

export interface WorkspacePathChangeV1 {
    path: string;
    before: CapturedPathStateV1;
    after: CapturedPathStateV1;
}

export interface WorkspaceSnapshotCoverage {
    complete: boolean;
    eligibleEntryCount: number;
    newlyHashedBytes: number;
    exclusions: WorkspaceSnapshotCoverageExclusion[];
}

export type WorkspaceSnapshotCoverageExclusion =
    | {
          path: string;
          pathBytesBase64?: never;
          scope?: never;
          reason: WorkspaceCoverageReason;
      }
    | {
          path?: never;
          pathBytesBase64: string;
          scope?: never;
          reason: WorkspaceCoverageReason;
      }
    | {
          path?: never;
          pathBytesBase64?: never;
          scope: "workspace-root";
          reason: "capture-budget";
      };

export type WorkspaceCheckpointFailureCode =
    | "disabled"
    | "git_unavailable"
    | "capture_timeout"
    | "capture_budget"
    | "unstable_file"
    | "enospc"
    | "quota_exceeded"
    | "hosted_pty_running"
    | "process_crash_before_finalization"
    | "corrupt_snapshot";

export type WorkspaceCheckpointV1 =
    | {
          schemaVersion: 1;
          status: "available";
          originSessionId: string;
          turnId: string;
          workspaceIdentity: string;
          workspaceIncarnation: string;
          before: WorkspaceSnapshotRefV1;
          after: WorkspaceSnapshotRefV1;
          changes: WorkspacePathChangeV1[];
          coverage: WorkspaceSnapshotCoverage;
      }
    | {
          schemaVersion: 1;
          status: "unavailable";
          originSessionId: string;
          turnId: string;
          workspaceIdentity: string;
          workspaceIncarnation?: string;
          reasonCode: WorkspaceCheckpointFailureCode;
          message: string;
          coverage?: WorkspaceSnapshotCoverage;
      };

export interface WorkspaceRewindStateV1 {
    fromLeafId: string | null;
    targetTurnId: string;
    targetBoundaryId: string | null;
    redoStates: Array<{ path: string; state: CapturedPathStateV1 }>;
}

export interface WorkspaceLinkedOperationV1 {
    operationId: string;
    sourceSnapshot: WorkspaceSnapshotRefV1;
    currentSnapshot: WorkspaceSnapshotRefV1;
}

export interface WorkspaceStateBaseV1 {
    schemaVersion: 1;
    sessionId: string;
    operationId: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    applyMode: "normal" | "force-drift";
    forcedPaths: string[];
    sourceSnapshot: WorkspaceSnapshotRefV1;
    currentSnapshot: WorkspaceSnapshotRefV1;
    currentStates: Array<{ path: string; state: CapturedPathStateV1 }>;
}

export type WorkspaceStateV1 = WorkspaceStateBaseV1 &
    (
        | {
              kind: "rewind";
              rewind: WorkspaceRewindStateV1;
              linkedOperation?: never;
              sourceTurnId?: never;
              undoOperationId?: never;
          }
        | {
              kind: "redo";
              rewind?: never;
              sourceTurnId?: never;
              undoOperationId?: never;
              sourceRewindOperationId: string;
              linkedOperation: WorkspaceLinkedOperationV1;
          }
        | {
              kind: "turn-undo";
              rewind?: never;
              linkedOperation?: never;
              sourceTurnId: string;
              undoOperationId?: never;
          }
        | {
              kind: "turn-redo";
              rewind?: never;
              sourceTurnId: string;
              undoOperationId: string;
              linkedOperation: WorkspaceLinkedOperationV1;
          }
    );

export interface FoldedWorkspaceSessionState {
    checkpointsByTurnId: ReadonlyMap<string, WorkspaceCheckpointV1>;
    activeWorkspaceState?: WorkspaceStateV1;
    conversationRedoState?: Extract<WorkspaceStateV1, { kind: "rewind" }>;
    turnMutationsByTurnId: ReadonlyMap<string, { action: "undo" } | { action: "redo"; undoOperationId: string }>;
    semanticLeafId: string | null;
    displayLeafId: string | null;
    eligibleTurnIds: string[];
    checkpointGaps: Array<{ turnId: string; reason: string }>;
}
