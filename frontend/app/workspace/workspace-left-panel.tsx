// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentRuntimeClient } from "@/app/agent/agent-runtime-client";
import { AgentSessionsPanel } from "@/app/agent/agent-sessions-panel";
import { FileExplorer } from "@/app/fileexplorer/file-explorer";
import type { FileExplorerWorkspaceActions } from "@/app/fileexplorer/file-explorer-workspace-actions";
import type { ReactNode } from "react";
import type { WorkspaceAgentModel } from "./workspace-agent-model";
import type { LeftPanelMode, WorkspaceLayoutModel } from "./workspace-layout-model";
import type { WorkspaceModel } from "./workspace-model";

export interface WorkspaceLeftPanelProps {
    mode: LeftPanelMode;
    terminalList?: ReactNode;
    agentRuntimeClient?: AgentRuntimeClient;
    agentModel?: WorkspaceAgentModel;
    workspaceModel?: WorkspaceModel;
    layoutModel: WorkspaceLayoutModel;
    fileExplorerWorkspaceActions?: FileExplorerWorkspaceActions;
}

const UnavailableFileExplorerWorkspaceActions: FileExplorerWorkspaceActions = {
    openFile: () => Promise.reject(new Error("File Explorer Workspace actions are unavailable")),
    renamePath: () => Promise.resolve(false),
    deletePath: () => Promise.resolve(false),
    createTerminal: () => Promise.reject(new Error("File Explorer Workspace actions are unavailable")),
};

export function WorkspaceLeftPanel({
    mode,
    terminalList,
    agentRuntimeClient,
    agentModel,
    workspaceModel,
    layoutModel,
    fileExplorerWorkspaceActions,
}: WorkspaceLeftPanelProps) {
    if (mode === "files") {
        return <FileExplorer workspaceActions={fileExplorerWorkspaceActions ?? UnavailableFileExplorerWorkspaceActions} />;
    }
    if (mode === "sessions") {
        if (!agentRuntimeClient || !agentModel || !workspaceModel) {
            return null;
        }
        return (
            <AgentSessionsPanel
                runtimeClient={agentRuntimeClient}
                agentModel={agentModel}
                workspaceModel={workspaceModel}
                layoutModel={layoutModel}
            />
        );
    }
    if (mode === "terminals") {
        return terminalList ?? null;
    }
    return null;
}
