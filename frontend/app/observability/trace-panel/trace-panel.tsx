// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse web/src/components/trace/Trace.tsx.

import { useEffect, useState } from "react";

import { TraceDataProvider, TraceSelectionProvider, useTraceSelection } from "./trace-context";
import { TraceGraph } from "./trace-graph";
import { TraceLayoutCompact } from "./trace-layout-compact";
import { TraceLayoutDesktop } from "./trace-layout-desktop";
import { TracePanelDetail } from "./trace-panel-detail";
import { TracePanelNavigationLayoutDesktop } from "./trace-panel-navigation-layout-desktop";
import { TracePanelNavigationWorkspace } from "./trace-panel-navigation-workspace";
import { TraceSearchList } from "./trace-search-list";
import { TraceTimeline } from "./trace-timeline";
import { TraceTree } from "./trace-tree";

export type TracePanelLayout = "compact" | "desktop";

export type TracePanelProps = {
    detail: TraceDetail;
    layout: TracePanelLayout;
};

function TraceNavigation() {
    const { navigationMode, searchQuery } = useTraceSelection();
    if (searchQuery.trim().length > 0) {
        return <TraceSearchList />;
    }
    return navigationMode === "timeline" ? <TraceTimeline /> : <TraceTree />;
}

function TracePanelDesktopContent() {
    return (
        <TraceLayoutDesktop>
            <TraceLayoutDesktop.NavigationPanel>
                <TracePanelNavigationLayoutDesktop secondaryContent={<TraceGraph />}>
                    <TraceNavigation />
                </TracePanelNavigationLayoutDesktop>
            </TraceLayoutDesktop.NavigationPanel>
            <TraceLayoutDesktop.ResizeHandle />
            <TraceLayoutDesktop.DetailPanel>
                <TracePanelDetail />
            </TraceLayoutDesktop.DetailPanel>
        </TraceLayoutDesktop>
    );
}

function TracePanelCompactContent({ detailOpen, onCloseDetail }: { detailOpen: boolean; onCloseDetail: () => void }) {
    return (
        <TraceLayoutCompact
            navigation={
                <TracePanelNavigationWorkspace>
                    <TraceNavigation />
                </TracePanelNavigationWorkspace>
            }
            detail={<TracePanelDetail />}
            detailOpen={detailOpen}
            onCloseDetail={onCloseDetail}
        />
    );
}

export function TracePanel({ detail, layout }: TracePanelProps) {
    const [detailOpen, setDetailOpen] = useState(false);

    useEffect(() => {
        setDetailOpen(false);
    }, [detail.trace.id, layout]);

    return (
        <TraceDataProvider detail={detail}>
            <TraceSelectionProvider
                traceId={detail.trace.id}
                onSelectionIntent={layout === "compact" ? () => setDetailOpen(true) : undefined}
            >
                {layout === "compact" ? (
                    <TracePanelCompactContent detailOpen={detailOpen} onCloseDetail={() => setDetailOpen(false)} />
                ) : (
                    <TracePanelDesktopContent />
                )}
            </TraceSelectionProvider>
        </TraceDataProvider>
    );
}
