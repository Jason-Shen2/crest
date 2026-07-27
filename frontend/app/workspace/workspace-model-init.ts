// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceModelOptions } from "./workspace-model";

export function workspaceModelOptionsFromLoadedWorkspace(
    windowId: string,
    workspace: Workspace,
    surfaceGeneration: number
): WorkspaceModelOptions & { windowId: string } {
    return {
        windowId,
        workspaceId: workspace.oid,
        surfaceGeneration,
        initialContentState: workspace.contentstate,
        initialTerminalTabIds: workspace.terminaltabids,
        initialActiveTerminalTabId: workspace.activeterminaltabid,
        initialNavigationRevision: workspace.navigationrevision,
    };
}
