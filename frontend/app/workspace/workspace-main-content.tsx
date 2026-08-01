// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentRuntimeClient } from "@/app/agent/agent-runtime-client";
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AgentTurnDiffTopTab } from "./agent-turn-diff-top-tab";
import { FileTopTab } from "./file-top-tab";
import { GitDiffTopTab } from "./git-diff-top-tab";
import type { WorkspacePreviewRepository } from "./preview-repository";
import { PreviewTopTab } from "./preview-top-tab";
import { TopTabContentDeck } from "./top-tab-content-deck";
import type { WorkspaceTopTabController } from "./top-tab-controller";
import type { TopTabSurfaceFactories } from "./top-tab-runtime-host";
import type { TopTabRuntime } from "./top-tab-runtime-registry";
import { WorkspaceTopTabRuntimeRegistry } from "./top-tab-runtime-registry";
import { WorkspaceAgentContentSlot } from "./workspace-agent-content-slot";
import type { WorkspaceAgentModel } from "./workspace-agent-model";
import type { ActiveContent, TopTab } from "./workspace-content-state";
import type { WorkspaceEditorRegistry, WorkspaceFileRuntime } from "./workspace-editor-registry";

export interface WorkspaceMainContentProps {
    workspaceId: string;
    generation: number;
    activeContent: ActiveContent;
    topTabs: TopTab[];
    terminalSurfaceStatus?: TerminalSurfaceStatus;
    agentModel?: WorkspaceAgentModel;
    agentClient?: AgentRuntimeClient;
    agentExecutionContext?: AgentExecutionContext;
    onCloseTopTab: (topTabId: string) => Promise<boolean>;
    onCloseTerminal: (terminalTabId: string) => void;
    topTabRuntimeFactory?: (tab: TopTab) => TopTabRuntime;
    topTabSurfaceFactories?: TopTabSurfaceFactories;
    editorRegistry?: WorkspaceEditorRegistry;
    runtimeRegistry?: WorkspaceTopTabRuntimeRegistry;
    previewRepository?: WorkspacePreviewRepository;
    topTabController?: WorkspaceTopTabController;
}

const DefaultTopTabSurfaceFactories: TopTabSurfaceFactories = {
    renderFile: (_tab, runtime) => <FileTopTab runtime={runtime as WorkspaceFileRuntime} />,
    renderPreview: (tab) => tab.title,
    renderGitDiff: (tab) => <GitDiffTopTab tab={tab} />,
};

function makeColdRuntime(tab: TopTab): TopTabRuntime {
    const snapshot = { dirty: false, title: tab.title, status: "cold" as const };
    return {
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
        dispose: () => {},
    };
}

export function WorkspaceMainContent({
    workspaceId,
    generation,
    activeContent,
    topTabs,
    terminalSurfaceStatus,
    agentModel,
    agentClient,
    agentExecutionContext,
    onCloseTopTab,
    onCloseTerminal,
    topTabRuntimeFactory = makeColdRuntime,
    topTabSurfaceFactories = DefaultTopTabSurfaceFactories,
    editorRegistry,
    runtimeRegistry: injectedRuntimeRegistry,
    previewRepository,
    topTabController,
}: WorkspaceMainContentProps) {
    const surfaceRef = useRef<HTMLDivElement>(null);
    const revisionRef = useRef(0);
    const lastBoundsRef = useRef<WorkspaceSurfaceState["bounds"]>({ x: 0, y: 0, width: 0, height: 0 });
    const reportSurfaceRef = useRef<() => void>(() => {});
    const activeTopTabId = activeContent.kind === "top-tab" ? activeContent.topTabId : undefined;
    const [hasActivatedAgent, setHasActivatedAgent] = useState(activeContent.kind === "agent");
    const ownedRuntimeRegistry = useMemo(() => new WorkspaceTopTabRuntimeRegistry(), [workspaceId, generation]);
    const runtimeRegistry = injectedRuntimeRegistry ?? ownedRuntimeRegistry;
    const surfaceFactories = useMemo<TopTabSurfaceFactories>(
        () =>
            previewRepository && topTabController
                ? {
                      ...topTabSurfaceFactories,
                      renderFile: (tab, runtime) => (
                          <FileTopTab
                              runtime={runtime as WorkspaceFileRuntime}
                              onClose={() => void onCloseTopTab(tab.id)}
                              onLocate={() => {
                                  void (async () => {
                                      try {
                                          const path = await getApi().selectFile?.();
                                          if (!path || !editorRegistry) {
                                              return;
                                          }
                                          const fileRuntime = runtime as WorkspaceFileRuntime;
                                          await editorRegistry.migratePath(fileRuntime.path, path, () =>
                                              topTabController.relocateFile(tab.id, path)
                                          );
                                      } catch {
                                          // The registry exposes the actionable error through the existing File error surface.
                                      }
                                  })();
                              }}
                          />
                      ),
                      renderPreview: (tab) => (
                          <PreviewTopTab tab={tab} repository={previewRepository} controller={topTabController} />
                      ),
                      renderAgentTurnDiff: (tab) => <AgentTurnDiffTopTab tab={tab} client={agentClient} />,
                  }
                : {
                      ...topTabSurfaceFactories,
                      renderAgentTurnDiff: (tab) => <AgentTurnDiffTopTab tab={tab} client={agentClient} />,
                  },
        [agentClient, editorRegistry, onCloseTopTab, previewRepository, topTabController, topTabSurfaceFactories]
    );
    const createRuntime = useCallback(
        (tab: TopTab) =>
            tab.kind === "file" && editorRegistry ? editorRegistry.open(tab.id, tab.path) : topTabRuntimeFactory(tab),
        [editorRegistry, topTabRuntimeFactory]
    );
    const openAgentFile = useCallback(
        (path: string) => {
            topTabController?.openFile(path);
        },
        [topTabController]
    );
    const openAgentTurnDiff = useCallback(
        (turnId: string, path: string) => {
            if (!topTabController || !agentModel) return;
            const sessionMetadata = globalStore.get(agentModel.stateAtom).activeSession;
            if (!sessionMetadata) return;
            topTabController.openAgentTurnDiff({ sessionMetadata, turnId, path });
        },
        [agentModel, topTabController]
    );
    const registryDisposal = useRef<{ registry: WorkspaceTopTabRuntimeRegistry; cancelled: boolean } | undefined>(
        undefined
    );

    useEffect(() => {
        const pending = registryDisposal.current;
        if (pending?.registry === runtimeRegistry) {
            pending.cancelled = true;
        }
        return () => {
            const disposal = { registry: runtimeRegistry, cancelled: false };
            registryDisposal.current = disposal;
            queueMicrotask(() => {
                if (!disposal.cancelled) {
                    void runtimeRegistry.disposeSafely();
                }
            });
        };
    }, [runtimeRegistry]);

    useEffect(() => {
        if (activeContent.kind !== "agent") {
            return;
        }
        setHasActivatedAgent(true);
    }, [activeContent.kind]);

    useLayoutEffect(() => {
        const surface = surfaceRef.current;
        if (!surface) {
            return;
        }
        const reportSurface = () => {
            const rect = surface.getBoundingClientRect();
            const bounds = {
                x: Math.max(0, Math.round(rect.x)),
                y: Math.max(0, Math.round(rect.y)),
                width: Math.max(0, Math.round(rect.width)),
                height: Math.max(0, Math.round(rect.height)),
            };
            lastBoundsRef.current = bounds;
            const state: WorkspaceSurfaceState =
                activeContent.kind === "terminal"
                    ? {
                          kind: "terminal",
                          terminalTabId: activeContent.terminalTabId,
                          workspaceId,
                          generation,
                          revision: ++revisionRef.current,
                          bounds,
                      }
                    : {
                          kind: activeContent.kind,
                          workspaceId,
                          generation,
                          revision: ++revisionRef.current,
                          bounds,
                      };
            getApi()?.setWorkspaceSurface?.(state);
        };
        reportSurfaceRef.current = reportSurface;
        reportSurface();
        const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reportSurface);
        resizeObserver?.observe(surface);
        window.addEventListener("resize", reportSurface);
        return () => {
            reportSurfaceRef.current = () => {};
            resizeObserver?.disconnect();
            window.removeEventListener("resize", reportSurface);
        };
    }, [activeContent, workspaceId, generation]);
    useLayoutEffect(
        () => () => {
            getApi()?.setWorkspaceSurface?.({
                kind: "agent",
                workspaceId,
                generation,
                revision: ++revisionRef.current,
                bounds: lastBoundsRef.current,
            });
        },
        [workspaceId, generation]
    );
    const matchingTerminalStatus =
        activeContent.kind === "terminal" &&
        terminalSurfaceStatus != null &&
        terminalSurfaceStatus.state !== "idle" &&
        terminalSurfaceStatus.workspaceid === workspaceId &&
        terminalSurfaceStatus.generation === generation &&
        terminalSurfaceStatus.terminaltabid === activeContent.terminalTabId
            ? terminalSurfaceStatus
            : undefined;
    const terminalError = matchingTerminalStatus?.state === "error" ? matchingTerminalStatus : undefined;

    return (
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="relative min-h-0 flex-1 overflow-hidden" ref={surfaceRef}>
                <WorkspaceAgentContentSlot
                    active={activeContent.kind === "agent"}
                    mounted={hasActivatedAgent}
                    model={agentModel}
                    client={agentClient}
                    executionContext={agentExecutionContext}
                    onOpenFile={topTabController ? openAgentFile : undefined}
                    onOpenTurnDiff={topTabController ? openAgentTurnDiff : undefined}
                />
                {activeContent.kind === "terminal" ? (
                    <section
                        className="pointer-events-none absolute inset-0 h-full w-full"
                        data-testid="terminal-surface"
                        key={activeContent.terminalTabId}
                    >
                        {terminalError ? (
                            <div className="pointer-events-auto flex h-full flex-col items-center justify-center gap-3">
                                <p>{terminalError.message}</p>
                                <div className="flex gap-2">
                                    <button
                                        className="cursor-pointer rounded bg-accent/80 px-3 py-1 text-primary transition-colors hover:bg-accent"
                                        type="button"
                                        onClick={() => reportSurfaceRef.current()}
                                    >
                                        Retry
                                    </button>
                                    <button
                                        className="cursor-pointer rounded px-3 py-1"
                                        type="button"
                                        onClick={() => onCloseTerminal(activeContent.terminalTabId)}
                                    >
                                        Close
                                    </button>
                                </div>
                            </div>
                        ) : matchingTerminalStatus?.state === "loading" ? (
                            <div className="flex h-full items-center justify-center" role="status">
                                Loading terminal…
                            </div>
                        ) : null}
                    </section>
                ) : null}
                <TopTabContentDeck
                    topTabs={topTabs}
                    activeTopTabId={activeTopTabId}
                    registry={runtimeRegistry}
                    createRuntime={createRuntime}
                    factories={surfaceFactories}
                />
            </div>
        </main>
    );
}
