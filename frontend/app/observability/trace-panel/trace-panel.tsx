// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse web/src/components/trace/Trace.tsx.

import { TraceDataProvider, TraceSelectionProvider, useTraceSelection } from "./trace-context";
import { TraceGraph } from "./trace-graph";
import { TraceLayoutDesktop } from "./trace-layout-desktop";
import { TracePanelDetail } from "./trace-panel-detail";
import { TracePanelNavigationLayoutDesktop } from "./trace-panel-navigation-layout-desktop";
import { TraceSearchList } from "./trace-search-list";
import { TraceTimeline } from "./trace-timeline";
import { TraceTree } from "./trace-tree";

export type TracePanelProps = {
    detail: TraceDetail;
    layout: "desktop";
};

function TraceNavigation() {
    const { navigationMode, searchQuery } = useTraceSelection();
    if (searchQuery.trim().length > 0) {
        return <TraceSearchList />;
    }
    return navigationMode === "timeline" ? <TraceTimeline /> : <TraceTree />;
}

function TracePanelContent({ layout }: Pick<TracePanelProps, "layout">) {
    switch (layout) {
        case "desktop":
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
}

export function TracePanel({ detail, layout }: TracePanelProps) {
    return (
        <TraceDataProvider detail={detail}>
            <TraceSelectionProvider traceId={detail.trace.id}>
                <TracePanelContent layout={layout} />
            </TraceSelectionProvider>
        </TraceDataProvider>
    );
}
