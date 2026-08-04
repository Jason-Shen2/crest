// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureWorkspaceOptions } from "./snapshot-store";
import type { WorkspacePathChangeV1, WorkspaceSnapshotCoverage, WorkspaceSnapshotRefV1 } from "./types";

export interface WorkspaceCheckpointSnapshotSource {
    capture(options: CaptureWorkspaceOptions): Promise<{
        ref: WorkspaceSnapshotRefV1;
        coverage: WorkspaceSnapshotCoverage;
    }>;
    diff(before: WorkspaceSnapshotRefV1, after: WorkspaceSnapshotRefV1): Promise<WorkspacePathChangeV1[]>;
}
