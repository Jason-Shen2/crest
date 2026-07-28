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
    exclusions: Array<{
        path?: string;
        pathBytesBase64?: string;
        reason: WorkspaceCoverageReason;
    }>;
}

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

export interface WorkspaceStateV1 {
    schemaVersion: 1;
    sessionId: string;
    operationId: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    kind: "rewind" | "redo";
    applyMode: "normal" | "force-drift";
    forcedPaths: string[];
    currentSnapshot: WorkspaceSnapshotRefV1;
    currentStates: Array<{ path: string; state: CapturedPathStateV1 }>;
    rewind?: {
        fromLeafId: string | null;
        targetTurnId: string;
        targetBoundaryId: string | null;
        redoSnapshot: WorkspaceSnapshotRefV1;
        redoStates: Array<{ path: string; state: CapturedPathStateV1 }>;
    };
}

export interface FoldedWorkspaceSessionState {
    checkpointsByTurnId: ReadonlyMap<string, WorkspaceCheckpointV1>;
    activeWorkspaceState?: WorkspaceStateV1;
    semanticLeafId: string | null;
    displayLeafId: string | null;
    eligibleTurnIds: string[];
    checkpointGaps: Array<{ turnId: string; reason: string }>;
}
