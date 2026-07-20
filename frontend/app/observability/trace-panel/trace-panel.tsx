// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse web/src/components/trace/Trace.tsx.

import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { TraceDataProvider, TraceSelectionProvider, useTraceSelection } from "./trace-context";
import { TraceDetailPanel } from "./trace-detail-panel";
import { TraceGraph } from "./trace-graph";
import { TraceNavigationHeader } from "./trace-navigation-header";
import { TraceSearchList } from "./trace-search-list";
import { TraceTimeline } from "./trace-timeline";
import { TraceTree } from "./trace-tree";

function TraceNavigation() {
    const { navigationMode, searchQuery } = useTraceSelection();
    if (searchQuery.trim().length > 0) {
        return <TraceSearchList />;
    }
    return navigationMode === "timeline" ? <TraceTimeline /> : <TraceTree />;
}

function GraphPanelBar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            aria-expanded={!collapsed}
            className="flex h-7 w-full shrink-0 cursor-pointer items-center justify-between border-t border-border px-2 text-xs font-medium text-muted-foreground hover:bg-fg-overlay-1/50 hover:text-foreground"
            onClick={onToggle}
        >
            Graph
            {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
    );
}

function TracePanelContent() {
    const [graphCollapsed, setGraphCollapsed] = useState(false);
    return (
        <PanelGroup direction="horizontal" className="min-h-0 flex-1">
            <Panel defaultSize={56} minSize={35}>
                <div className="flex h-full min-h-0 flex-col border-r border-border">
                    <TraceNavigationHeader />
                    {graphCollapsed ? (
                        <>
                            <div className="min-h-0 flex-1">
                                <TraceNavigation />
                            </div>
                            <GraphPanelBar collapsed onToggle={() => setGraphCollapsed(false)} />
                        </>
                    ) : (
                        <PanelGroup direction="vertical" className="min-h-0 flex-1">
                            <Panel defaultSize={62} minSize={30}>
                                <TraceNavigation />
                            </Panel>
                            <PanelResizeHandle className="h-px bg-border hover:bg-accent/60" />
                            <Panel defaultSize={38} minSize={20} maxSize={70}>
                                <div className="flex h-full min-h-0 flex-col">
                                    <GraphPanelBar collapsed={false} onToggle={() => setGraphCollapsed(true)} />
                                    <div className="min-h-0 flex-1">
                                        <TraceGraph />
                                    </div>
                                </div>
                            </Panel>
                        </PanelGroup>
                    )}
                </div>
            </Panel>
            <PanelResizeHandle className="w-px bg-border hover:bg-accent/60" />
            <Panel defaultSize={44} minSize={30}>
                <div className="h-full overflow-auto bg-panel">
                    <TraceDetailPanel />
                </div>
            </Panel>
        </PanelGroup>
    );
}

export function TracePanel({ detail }: { detail: TraceDetail }) {
    return (
        <TraceDataProvider detail={detail}>
            <TraceSelectionProvider traceId={detail.trace.id}>
                <TracePanelContent />
            </TraceSelectionProvider>
        </TraceDataProvider>
    );
}
