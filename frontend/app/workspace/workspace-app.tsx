// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { AgentRuntimeClient } from "@/app/agent/agent-runtime-client";
import { makeFileExplorerWorkspaceActions } from "@/app/fileexplorer/file-explorer-workspace-actions";
import { ModalsRenderer } from "@/app/modals/modalsrenderer";
import { WorkspaceNotificationToastStacker } from "@/app/notifications/notification-toast";
import { ToastModel } from "@/app/notifications/toast-model";
import { MonacoModelRegistry } from "@/app/righteditor/monaco-model-registry";
import { RightEditorProductionRpc } from "@/app/righteditor/right-editor-rpc";
import { StatusBar } from "@/app/statusbar/status-bar";
import { getApi, getOrefMetaKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { registerWorkspaceKeyLifecycle } from "@/app/store/keymodel";
import * as WOS from "@/app/store/wos";
import { TopBar } from "@/app/topbar/topbar";
import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { makeWaveEnvImpl } from "@/app/waveenv/waveenvimpl";
import { Provider, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkspacePreviewRepository } from "./preview-repository";
import { ResizeHandle } from "./resize-handle";
import { makeTerminalNavigationAdapter } from "./terminal-navigation";
import { TerminalTabList } from "./terminal-tab-list";
import {
    makeTopTabCloseCoordinator,
    type PreparedTopTabCloseSession,
    type TopTabCloseCoordinator,
} from "./top-tab-close-coordinator";
import { TopTabCloseDialog, TopTabCloseDialogController } from "./top-tab-close-dialog";
import { makeWorkspaceTopTabController } from "./top-tab-controller";
import { WorkspaceTopTabControllerContext } from "./top-tab-controller-context";
import { WorkspaceTopTabRuntimeRegistry } from "./top-tab-runtime-registry";
import { TopTabStrip } from "./top-tab-strip";
import { buildWorkspaceAgentExecutionContext, useWorkspaceAgentTerminalContext } from "./workspace-agent-context";
import { WorkspaceAgentModel } from "./workspace-agent-model";
import { WorkspaceAgentSync } from "./workspace-agent-sync";
import { WorkspaceCommandRouter } from "./workspace-command-router";
import { WorkspaceEditorRegistry } from "./workspace-editor-registry";
import { WorkspaceLayoutModel } from "./workspace-layout-model";
import { WorkspaceLeftPanel } from "./workspace-left-panel";
import { WorkspaceMainContent } from "./workspace-main-content";
import { WorkspaceModel } from "./workspace-model";
import { subscribeWorkspaceOpenContentEvents } from "./workspace-open-content-events";
import { WorkspaceRightPanelHost } from "./workspace-right-panel-host";
import { WorkspaceTerminalSync } from "./workspace-terminal-sync";

export interface WorkspaceAppInit {
    windowId: string;
    generation: number;
    workspace: Workspace;
}

interface WorkspaceAppProps {
    init: WorkspaceAppInit;
    onFirstRender?: () => void;
}

export async function handleWorkspaceCloseRequest(
    coordinator: Pick<TopTabCloseCoordinator, "prepareWorkspaceClose">,
    respond: (response: WorkspaceCloseResponse) => void,
    request: WorkspaceCloseRequest
): Promise<void> {
    let allow = false;
    try {
        allow = await coordinator.prepareWorkspaceClose();
    } catch {
        allow = false;
    }
    respond({ requestid: request.requestid, allow });
}

function WorkspaceAppInner({
    windowId,
    workspace,
    generation,
    model,
    onFirstRender,
}: {
    windowId: string;
    workspace: Workspace;
    generation: number;
    model: WorkspaceModel;
    onFirstRender?: () => void;
}) {
    const layoutModel = WorkspaceLayoutModel.getInstance();
    const contentState = useAtomValue(model.contentStateAtom);
    const terminalTabIds = useAtomValue(model.terminalTabIdsAtom);
    const activeTerminalTabId = useAtomValue(model.activeTerminalTabIdAtom);
    const terminalSurfaceStatus = useAtomValue(model.terminalSurfaceStatusAtom);
    const [workspaceDirAtom] = useState(() => {
        WOS.primeWaveObject(workspace);
        return getOrefMetaKeyAtom(WOS.makeORef("workspace", workspace.oid), "workspace:dir");
    });
    const workspaceDirMeta = useAtomValue(workspaceDirAtom) as string | undefined;
    const workspaceDir = workspaceDirMeta ?? workspace.meta?.["workspace:dir"] ?? getApi().getHomeDir?.() ?? "~";
    const hydratedLeftPanel = useAtomValue(layoutModel.leftPanelAtom);
    const leftPanel = layoutModel.getLeftPanelStateForWorkspace(workspace.oid, hydratedLeftPanel);
    const [terminalNavigation] = useState(() => makeTerminalNavigationAdapter(model));
    const [editorRegistry] = useState(
        () => new WorkspaceEditorRegistry(workspace.oid, RightEditorProductionRpc, new MonacoModelRegistry())
    );
    const [topTabRuntimeRegistry] = useState(() => new WorkspaceTopTabRuntimeRegistry());
    const [previewRepository] = useState(() => new WorkspacePreviewRepository());
    const [closeDialogController] = useState(() => new TopTabCloseDialogController());
    const closeSessions = useRef(new Map<string, PreparedTopTabCloseSession>());
    const [closeCoordinator] = useState(() =>
        makeTopTabCloseCoordinator({
            model,
            getTopTabs: () => globalStore.get(model.contentStateAtom).topTabs,
            getFileRuntime: (topTabId) => editorRegistry.runtimesById.get(topTabId),
            requestDecision: (request) => closeDialogController.requestDecision(request),
            closeRuntime: (topTabId) => topTabRuntimeRegistry.closeSafely(topTabId),
        })
    );
    const [topTabController] = useState(() => makeWorkspaceTopTabController(model, closeCoordinator));
    const [fileExplorerWorkspaceActions] = useState(() =>
        makeFileExplorerWorkspaceActions({
            controller: topTabController,
            closeCoordinator,
            editorRegistry,
            homeDir: getApi().getHomeDir(),
            model,
            terminalNavigation,
        })
    );
    const registryDisposal = useRef<{
        editorRegistry: WorkspaceEditorRegistry;
        runtimeRegistry: WorkspaceTopTabRuntimeRegistry;
        cancelled: boolean;
    }>(undefined);
    const [topTabControllerReady, setTopTabControllerReady] = useState(false);
    const firstRenderReported = useRef(false);
    const [terminalSync] = useState(() => {
        const workspaceAtom = WOS.getWaveObjectAtom<Workspace>(WOS.makeORef("workspace", workspace.oid), false);
        WOS.primeWaveObject(workspace);
        return new WorkspaceTerminalSync(model, workspaceAtom);
    });
    const [commandRouter] = useState(
        () =>
            new WorkspaceCommandRouter(
                model,
                terminalNavigation,
                terminalNavigation,
                undefined,
                closeCoordinator,
                topTabController,
                layoutModel
            )
    );
    const [agentRuntimeClient] = useState(() => {
        const agentApi = getApi().agent;
        if (!agentApi) return undefined;
        return new AgentRuntimeClient(agentApi, { workspaceId: workspace.oid, generation });
    });
    const terminalAgentContext = useWorkspaceAgentTerminalContext(activeTerminalTabId);
    const agentExecutionContext = useMemo(
        () =>
            buildWorkspaceAgentExecutionContext({
                workspaceId: workspace.oid,
                generation,
                workspaceDir,
                preferredTerminalTabId: activeTerminalTabId,
                connection: terminalAgentContext.connection,
                recentCmds: terminalAgentContext.recentCmds,
            }),
        [activeTerminalTabId, generation, terminalAgentContext, workspace.oid, workspaceDir]
    );
    const [agentModel] = useState(() =>
        WorkspaceAgentModel.getInstance({
            windowId,
            workspaceId: workspace.oid,
            generation,
            initialState: workspace.agentstate,
            initialRevision: workspace.agentrevision,
        })
    );
    const [agentSync] = useState(() => {
        const workspaceAtom = WOS.getWaveObjectAtom<Workspace>(WOS.makeORef("workspace", workspace.oid), false);
        WOS.primeWaveObject(workspace);
        return new WorkspaceAgentSync(agentModel, model, workspaceAtom);
    });

    useEffect(() => {
        layoutModel.hydrateLeftPanelFromWorkspace();
        layoutModel.hydrateRightToolPanelFromWorkspace();
    }, [layoutModel, workspace.oid]);

    useEffect(() => {
        if (!topTabControllerReady || firstRenderReported.current) {
            return;
        }
        firstRenderReported.current = true;
        onFirstRender?.();
    }, [onFirstRender, topTabControllerReady]);

    useEffect(() => getApi().onWorkspaceCommand((command) => commandRouter.dispatch(command)), [commandRouter]);
    useEffect(() => registerWorkspaceKeyLifecycle((command) => commandRouter.dispatch(command)), [commandRouter]);
    useEffect(
        () =>
            getApi().onWorkspaceCloseRequest?.((request) => {
                void (async () => {
                    let allow = false;
                    try {
                        const session = await closeCoordinator.prepareWorkspaceCloseSession();
                        if (session) {
                            closeSessions.current.set(request.requestid, session);
                            allow = true;
                        }
                    } catch {
                        allow = false;
                    }
                    getApi().respondWorkspaceClose?.({ requestid: request.requestid, allow });
                })();
            }) ?? (() => {}),
        [closeCoordinator]
    );
    useEffect(() => {
        const unsubscribe = getApi().onWorkspaceCloseFinalize?.((finalize) => {
            if (!finalize || typeof finalize.requestid !== "string" || typeof finalize.commit !== "boolean") {
                return;
            }
            const session = closeSessions.current.get(finalize.requestid);
            if (!session) {
                return;
            }
            closeSessions.current.delete(finalize.requestid);
            if (finalize.commit) {
                session.commit();
            } else {
                session.rollback();
            }
        });
        return () => {
            unsubscribe?.();
            closeSessions.current.forEach((session) => session.rollback());
            closeSessions.current.clear();
        };
    }, []);
    useEffect(() => getApi().onTerminalSurfaceStatus((status) => model.applyTerminalSurfaceStatus(status)), [model]);
    useEffect(() => {
        terminalSync.start();
        return () => terminalSync.dispose();
    }, [terminalSync]);
    useEffect(() => {
        topTabController.start();
        setTopTabControllerReady(true);
        return () => {
            setTopTabControllerReady(false);
            topTabController.stop();
        };
    }, [topTabController]);
    useEffect(
        () =>
            subscribeWorkspaceOpenContentEvents({
                workspaceId: workspace.oid,
                generation,
                controller: topTabController,
                isCurrent: (workspaceId, expectedGeneration) =>
                    workspaceId === model.workspaceId && expectedGeneration === model.surfaceGeneration,
            }),
        [generation, model, topTabController, workspace.oid]
    );
    useEffect(() => model.registerPreReplacementTeardown(() => editorRegistry.dispose()), [editorRegistry, model]);
    useEffect(
        () => model.registerPreReplacementTeardown(() => topTabRuntimeRegistry.disposeSafely()),
        [model, topTabRuntimeRegistry]
    );
    useEffect(() => {
        const pending = registryDisposal.current;
        if (pending?.editorRegistry === editorRegistry && pending.runtimeRegistry === topTabRuntimeRegistry) {
            pending.cancelled = true;
        }
        return () => {
            const disposal = {
                editorRegistry,
                runtimeRegistry: topTabRuntimeRegistry,
                cancelled: false,
            };
            registryDisposal.current = disposal;
            queueMicrotask(() => {
                if (disposal.cancelled) {
                    return;
                }
                void Promise.all([disposal.runtimeRegistry.disposeSafely(), disposal.editorRegistry.dispose()]);
            });
        };
    }, [editorRegistry, topTabRuntimeRegistry]);
    useEffect(() => {
        agentSync.start();
        return () => void agentSync.dispose();
    }, [agentSync]);

    const leftPanelMaxFn = useCallback(() => layoutModel.getLeftPanelMaxWidth(window.innerWidth), [layoutModel]);
    const onLeftPanelResize = useCallback((width: number) => layoutModel.previewLeftPanelWidth(width), [layoutModel]);
    const onLeftPanelResizeEnd = useCallback((width: number) => layoutModel.setLeftPanelWidth(width), [layoutModel]);
    const onActivateAgent = useCallback(() => {
        model.activateAgent();
        layoutModel.showLeftPanel("sessions");
    }, [layoutModel, model]);

    if (!topTabControllerReady) {
        return <div className="flex h-full w-full flex-col overflow-hidden" data-testid="workspace-renderer-root" />;
    }

    return (
        <WorkspaceTopTabControllerContext.Provider value={topTabController}>
            <div className="flex h-full w-full flex-col overflow-hidden" data-testid="workspace-renderer-root">
                <TopBar
                    workspace={workspace}
                    agentActive={contentState.activeContent.kind === "agent"}
                    onActivateAgent={onActivateAgent}
                    topTabStrip={
                        contentState.topTabs.length > 0 ? (
                            <TopTabStrip
                                tabs={contentState.topTabs}
                                activeTopTabId={
                                    contentState.activeContent.kind === "top-tab"
                                        ? contentState.activeContent.topTabId
                                        : undefined
                                }
                                registry={topTabRuntimeRegistry}
                                onActivate={(topTabId) => topTabController.activate(topTabId)}
                                onClose={(topTabId) => topTabController.close(topTabId)}
                                onReorder={(topTabId, targetIndex) => {
                                    const target = contentState.topTabs[targetIndex];
                                    if (target) {
                                        model.reorderTopTabs(topTabId, target.id);
                                    }
                                }}
                            />
                        ) : undefined
                    }
                />
                <div className="flex min-h-0 flex-1">
                    {leftPanel.visible ? (
                        <>
                            <div className="h-full shrink-0 overflow-hidden" style={{ width: `${leftPanel.width}px` }}>
                                <WorkspaceLeftPanel
                                    mode={leftPanel.mode}
                                    agentRuntimeClient={agentRuntimeClient}
                                    agentModel={agentModel}
                                    workspaceModel={model}
                                    layoutModel={layoutModel}
                                    fileExplorerWorkspaceActions={fileExplorerWorkspaceActions}
                                    terminalList={
                                        <TerminalTabList
                                            terminalTabIds={terminalTabIds}
                                            activeTerminalTabId={activeTerminalTabId}
                                            navigation={terminalNavigation}
                                        />
                                    }
                                />
                            </div>
                            <ResizeHandle
                                width={leftPanel.width}
                                min={layoutModel.getLeftPanelMinWidth()}
                                maxFn={leftPanelMaxFn}
                                onResize={onLeftPanelResize}
                                onResizeEnd={onLeftPanelResizeEnd}
                                side="right"
                            />
                        </>
                    ) : null}
                    <WorkspaceMainContent
                        workspaceId={workspace.oid}
                        generation={generation}
                        activeContent={contentState.activeContent}
                        terminalSurfaceStatus={terminalSurfaceStatus}
                        agentModel={agentModel}
                        agentClient={agentRuntimeClient}
                        agentExecutionContext={agentExecutionContext}
                        topTabs={contentState.topTabs}
                        onCloseTopTab={(topTabId) => topTabController.close(topTabId)}
                        onCloseTerminal={(terminalTabId) => void terminalNavigation.close(terminalTabId)}
                        editorRegistry={editorRegistry}
                        runtimeRegistry={topTabRuntimeRegistry}
                        previewRepository={previewRepository}
                        topTabController={topTabController}
                    />
                    <WorkspaceRightPanelHost agentModel={agentModel} />
                </div>
                <StatusBar />
                <ModalsRenderer />
                <TopTabCloseDialog controller={closeDialogController} />
                <WorkspaceNotificationToastStacker />
            </div>
        </WorkspaceTopTabControllerContext.Provider>
    );
}

export function WorkspaceApp({ init, onFirstRender }: WorkspaceAppProps) {
    const [waveEnv] = useState(makeWaveEnvImpl);
    const [model] = useState(() =>
        WorkspaceModel.getInstance({
            windowId: init.windowId,
            workspaceId: init.workspace.oid,
            initialContentState: init.workspace.contentstate,
            initialTerminalTabIds: init.workspace.terminaltabids,
            initialActiveTerminalTabId: init.workspace.activeterminaltabid,
            initialNavigationRevision: init.workspace.navigationrevision,
            surfaceGeneration: init.generation,
            onCheckpointError: (error) =>
                ToastModel.getInstance().push({
                    id: `workspace-checkpoint:${init.workspace.oid}:${crypto.randomUUID()}`,
                    source: "crest-agent",
                    kind: "failed",
                    title: "Workspace changes could not be saved",
                    body: error instanceof Error ? error.message : "Retrying workspace save failed",
                    ts: Date.now(),
                    read: false,
                }),
        })
    );

    return (
        <Provider store={globalStore}>
            <WaveEnvContext.Provider value={waveEnv}>
                <WorkspaceAppInner
                    workspace={init.workspace}
                    windowId={init.windowId}
                    generation={init.generation}
                    model={model}
                    onFirstRender={onFirstRender}
                />
            </WaveEnvContext.Provider>
        </Provider>
    );
}
