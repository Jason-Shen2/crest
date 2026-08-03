// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentRewindFileRowView } from "./api-types";
import { projectWorkspacePathDiff, WorkspaceDiffPreviewBudget } from "./diff-preview";
import type { WorkspaceStateV1 } from "./types";

type WorkspaceRewindMarker = Extract<WorkspaceStateV1, { kind: "rewind" }>;

export async function projectRedoFileRows(
    marker: WorkspaceRewindMarker,
    readBlob: (oid: string) => Promise<Buffer>
): Promise<AgentRewindFileRowView[] | undefined> {
    const current = new Map(marker.currentStates.map((item) => [item.path, item.state]));
    const budget = new WorkspaceDiffPreviewBudget();
    const rows: AgentRewindFileRowView[] = [];
    for (const redo of marker.rewind.redoStates) {
        const before = current.get(redo.path);
        if (!before) return undefined;
        rows.push(
            await projectWorkspacePathDiff({
                path: redo.path,
                before,
                after: redo.state,
                readBlob,
                budget,
            })
        );
    }
    return rows;
}
