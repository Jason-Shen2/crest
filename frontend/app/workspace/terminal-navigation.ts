// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { WorkspaceModel } from "./workspace-model";

export interface TerminalNavigationRpc {
    create(data: WorkspaceCreateTerminalData): Promise<WorkspaceCheckpoint>;
    rename(data: WorkspaceRenameTerminalData): Promise<void>;
    close(data: WorkspaceTerminalData): Promise<WorkspaceCheckpoint>;
    reorder(data: WorkspaceReorderTerminalsData): Promise<WorkspaceCheckpoint>;
    reload(): Promise<Workspace>;
}

export interface TerminalNavigationAdapter {
    getTerminalTabIds(): readonly string[];
    activate(terminalTabId: string): boolean;
    select(terminalTabId: string): boolean;
    create(options?: Pick<WorkspaceCreateTerminalData, "name" | "connection" | "cwd">): Promise<void>;
    rename(terminalTabId: string, name: string): Promise<void>;
    close(terminalTabId: string): Promise<void>;
    reorder(terminalTabIds: readonly string[]): Promise<void>;
}

function checkpointFromWorkspace(workspace: Workspace): WorkspaceCheckpoint {
    return {
        workspaceid: workspace.oid,
        navigationrevision: workspace.navigationrevision ?? 0,
        terminaltabids: Array.from(workspace.terminaltabids ?? []),
        contentstate: workspace.contentstate,
        activeterminaltabid: workspace.activeterminaltabid,
    };
}

function defaultRpc(model: WorkspaceModel): TerminalNavigationRpc {
    return {
        create: (data) => RpcApi.WorkspaceCreateTerminalCommand(TabRpcClient, data),
        rename: (data) => RpcApi.WorkspaceRenameTerminalCommand(TabRpcClient, data),
        close: (data) => RpcApi.WorkspaceCloseTerminalCommand(TabRpcClient, data),
        reorder: (data) => RpcApi.WorkspaceReorderTerminalsCommand(TabRpcClient, data),
        reload: () => WOS.reloadWaveObject<Workspace>(WOS.makeORef("workspace", model.workspaceId)),
    };
}

export function makeTerminalNavigationAdapter(
    model: WorkspaceModel,
    rpc: TerminalNavigationRpc = defaultRpc(model)
): TerminalNavigationAdapter {
    const reconcileAfterStale = async (error: unknown): Promise<never> => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("stale workspace checkpoint") || message.includes("expected revision")) {
            model.adoptAuthoritativeCheckpoint(checkpointFromWorkspace(await rpc.reload()));
        }
        throw error;
    };

    const structuralMutation = async (
        mutate: (expectedRevision: number) => Promise<WorkspaceCheckpoint>
    ): Promise<void> => {
        try {
            await model.navigationQueue.runTerminalMutation(mutate);
        } catch (error) {
            await reconcileAfterStale(error);
        }
    };

    return {
        getTerminalTabIds: () => globalStore.get(model.terminalTabIdsAtom),
        activate: (terminalTabId) => model.activateTerminal(terminalTabId),
        select: (terminalTabId) => model.activateTerminal(terminalTabId),
        create: (options = {}) =>
            structuralMutation((expectedrevision) =>
                rpc.create({ workspaceid: model.workspaceId, expectedrevision, ...options })
            ),
        rename: (terminalTabId, name) =>
            rpc.rename({ workspaceid: model.workspaceId, terminaltabid: terminalTabId, name }),
        close: (terminalTabId) =>
            structuralMutation((expectedrevision) =>
                rpc.close({ workspaceid: model.workspaceId, terminaltabid: terminalTabId, expectedrevision })
            ),
        reorder: (terminalTabIds) =>
            structuralMutation((expectedrevision) =>
                rpc.reorder({
                    workspaceid: model.workspaceId,
                    terminaltabids: Array.from(terminalTabIds),
                    expectedrevision,
                })
            ),
    };
}
