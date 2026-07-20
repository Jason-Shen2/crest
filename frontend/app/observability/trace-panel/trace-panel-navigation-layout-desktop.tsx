// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TracePanelNavigationLayoutDesktop.

import { ChevronDown, ChevronLeft, ChevronUp } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { useDesktopTraceLayout } from "./trace-layout-desktop";
import { TraceNavigationHeader } from "./trace-navigation-header";

function GraphPanelBar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
    const label = collapsed ? "Expand graph" : "Collapse graph";

    return (
        <div className="flex h-7 w-full shrink-0 items-center border-t border-border text-xs font-medium text-muted-foreground">
            <button
                type="button"
                aria-label="Graph"
                aria-expanded={!collapsed}
                className="h-full flex-1 cursor-pointer px-2 text-left hover:bg-fg-overlay-1/50 hover:text-foreground"
                onClick={onToggle}
            >
                Graph
            </button>
            <button
                type="button"
                aria-label={label}
                className="flex h-full w-8 cursor-pointer items-center justify-center hover:bg-fg-overlay-1/50 hover:text-foreground"
                onClick={onToggle}
            >
                {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
        </div>
    );
}

export function TracePanelNavigationLayoutDesktop({
    children,
    secondaryContent,
}: {
    children: ReactNode;
    secondaryContent?: ReactNode;
}) {
    const { collapseNavigationPanel } = useDesktopTraceLayout();
    const [graphCollapsed, setGraphCollapsed] = useState(false);
    const graphLayoutRef = useRef<[number, number]>([62, 38]);
    const [navigationSize, graphSize] = graphLayoutRef.current;

    return (
        <div className="flex h-full min-h-0 flex-col border-r border-border">
            <div className="flex shrink-0 items-stretch border-b border-border">
                <div className="min-w-0 flex-1 [&>div]:border-b-0">
                    <TraceNavigationHeader />
                </div>
                <button
                    type="button"
                    aria-label="Collapse navigation"
                    className="flex w-8 shrink-0 cursor-pointer items-center justify-center text-muted-foreground hover:bg-fg-overlay-1/60 hover:text-foreground"
                    onClick={collapseNavigationPanel}
                >
                    <ChevronLeft className="h-3.5 w-3.5" />
                </button>
            </div>
            {secondaryContent == null ? (
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            ) : graphCollapsed ? (
                <>
                    <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
                    <GraphPanelBar collapsed onToggle={() => setGraphCollapsed(false)} />
                </>
            ) : (
                <PanelGroup
                    direction="vertical"
                    className="min-h-0 flex-1 overflow-hidden"
                    onLayout={(layout) => {
                        if (layout.length === 2) {
                            graphLayoutRef.current = [layout[0], layout[1]];
                        }
                    }}
                >
                    <Panel defaultSize={navigationSize} minSize={30}>
                        <div className="h-full overflow-hidden">{children}</div>
                    </Panel>
                    <PanelResizeHandle
                        aria-label="Resize trace navigation and graph"
                        className="relative h-px bg-border after:absolute after:-top-0.5 after:inset-x-0 after:h-1 hover:bg-accent/60"
                    />
                    <Panel defaultSize={graphSize} minSize={20} maxSize={70}>
                        <div className="flex h-full min-h-0 flex-col overflow-hidden">
                            <GraphPanelBar collapsed={false} onToggle={() => setGraphCollapsed(true)} />
                            <div data-testid="trace-graph-content" className="min-h-0 flex-1 overflow-hidden">
                                {secondaryContent}
                            </div>
                        </div>
                    </Panel>
                </PanelGroup>
            )}
        </div>
    );
}
