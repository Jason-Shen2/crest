// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceLayoutDesktop.

import { ChevronLeft, ChevronRight } from "lucide-react";
import { createContext, useContext, useState, type ComponentType, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { cn } from "@/util/util";

const NavigationPanelMinWidth = 260;
const DetailPanelMinWidth = 360;
const CollapsedPanelWidth = 40;

type TraceLayoutDesktopContextValue = {
    isNavigationPanelCollapsed: boolean;
    isDetailPanelCollapsed: boolean;
    setIsNavigationPanelCollapsed: (collapsed: boolean) => void;
    setIsDetailPanelCollapsed: (collapsed: boolean) => void;
    collapseNavigationPanel: () => void;
    expandNavigationPanel: () => void;
    collapseDetailPanel: () => void;
    expandDetailPanel: () => void;
};

const TraceLayoutContext = createContext<TraceLayoutDesktopContextValue>(null);

function useTraceLayoutContext(): TraceLayoutDesktopContextValue {
    const context = useContext(TraceLayoutContext);
    if (!context) {
        throw new Error("TraceLayoutDesktop compound components must be used within TraceLayoutDesktop");
    }
    return context;
}

export function useDesktopTraceLayout() {
    return useTraceLayoutContext();
}

function TraceLayoutDesktopRoot({ children }: { children: ReactNode }) {
    const [isNavigationPanelCollapsed, setIsNavigationPanelCollapsed] = useState(false);
    const [isDetailPanelCollapsed, setIsDetailPanelCollapsed] = useState(false);

    const contextValue: TraceLayoutDesktopContextValue = {
        isNavigationPanelCollapsed,
        isDetailPanelCollapsed,
        setIsNavigationPanelCollapsed,
        setIsDetailPanelCollapsed,
        collapseNavigationPanel: () => setIsNavigationPanelCollapsed(true),
        expandNavigationPanel: () => setIsNavigationPanelCollapsed(false),
        collapseDetailPanel: () => setIsDetailPanelCollapsed(true),
        expandDetailPanel: () => setIsDetailPanelCollapsed(false),
    };

    return (
        <TraceLayoutContext.Provider value={contextValue}>
            <div data-testid="trace-layout-scroll" className="relative h-full w-full overflow-x-auto overflow-y-hidden">
                <PanelGroup
                    data-testid="trace-layout-panels"
                    direction="horizontal"
                    className={cn(
                        "h-full min-h-0",
                        !isNavigationPanelCollapsed && !isDetailPanelCollapsed ? "min-w-[621px]" : "min-w-0"
                    )}
                >
                    {children}
                </PanelGroup>
            </div>
        </TraceLayoutContext.Provider>
    );
}

function NavigationPanel({ children }: { children: ReactNode }) {
    const { isNavigationPanelCollapsed, setIsNavigationPanelCollapsed, expandNavigationPanel } =
        useTraceLayoutContext();

    return (
        <Panel
            aria-label="Trace navigation panel"
            defaultSize={56}
            minSize={20}
            collapsible
            collapsedSize={6}
            onCollapse={() => setIsNavigationPanelCollapsed(true)}
            onExpand={() => setIsNavigationPanelCollapsed(false)}
            style={
                isNavigationPanelCollapsed
                    ? { minWidth: CollapsedPanelWidth, maxWidth: CollapsedPanelWidth }
                    : { minWidth: NavigationPanelMinWidth }
            }
        >
            {isNavigationPanelCollapsed ? (
                <div className="flex h-full w-full justify-center border-r border-border py-2">
                    <button
                        type="button"
                        aria-label="Expand navigation"
                        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-fg-overlay-1/60 hover:text-foreground"
                        onClick={expandNavigationPanel}
                    >
                        <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                </div>
            ) : (
                children
            )}
        </Panel>
    );
}

function ResizeHandle() {
    return (
        <PanelResizeHandle
            aria-label="Resize navigation and detail panels"
            className="relative w-px bg-border after:absolute after:inset-y-0 after:-left-0.5 after:w-1 hover:bg-accent/60"
        />
    );
}

function DetailPanel({ children }: { children: ReactNode }) {
    const { isDetailPanelCollapsed, setIsDetailPanelCollapsed, collapseDetailPanel, expandDetailPanel } =
        useTraceLayoutContext();

    return (
        <Panel
            aria-label="Trace detail panel"
            defaultSize={44}
            minSize={20}
            collapsible
            collapsedSize={6}
            onCollapse={() => setIsDetailPanelCollapsed(true)}
            onExpand={() => setIsDetailPanelCollapsed(false)}
            style={
                isDetailPanelCollapsed
                    ? { minWidth: CollapsedPanelWidth, maxWidth: CollapsedPanelWidth }
                    : { minWidth: DetailPanelMinWidth }
            }
        >
            {isDetailPanelCollapsed ? (
                <div className="flex h-full w-full justify-center bg-panel py-2">
                    <button
                        type="button"
                        aria-label="Expand detail"
                        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-fg-overlay-1/60 hover:text-foreground"
                        onClick={expandDetailPanel}
                    >
                        <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                </div>
            ) : (
                <div className="relative h-full overflow-auto bg-panel">
                    <button
                        type="button"
                        aria-label="Collapse detail"
                        className="absolute right-2 top-2 z-10 flex h-7 w-7 cursor-pointer items-center justify-center rounded bg-panel/90 text-muted-foreground shadow-sm hover:bg-fg-overlay-1/60 hover:text-foreground"
                        onClick={collapseDetailPanel}
                    >
                        <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                    {children}
                </div>
            )}
        </Panel>
    );
}

type TraceLayoutDesktopComponent = ComponentType<{ children: ReactNode }> & {
    NavigationPanel: typeof NavigationPanel;
    ResizeHandle: typeof ResizeHandle;
    DetailPanel: typeof DetailPanel;
};

export const TraceLayoutDesktop = Object.assign(TraceLayoutDesktopRoot, {
    NavigationPanel,
    ResizeHandle,
    DetailPanel,
}) as TraceLayoutDesktopComponent;
