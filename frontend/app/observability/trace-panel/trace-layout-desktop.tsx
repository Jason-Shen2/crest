// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceLayoutDesktop.

import { ChevronLeft, ChevronRight } from "lucide-react";
import {
    createContext,
    useContext,
    useLayoutEffect,
    useRef,
    useState,
    type ComponentType,
    type ReactNode,
    type RefObject,
} from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";

import { cn } from "@/util/util";

const NavigationPanelMinWidth = 260;
const DetailPanelMinWidth = 360;
const CollapsedPanelWidth = 40;
const BothPanelsMinWidth = NavigationPanelMinWidth + DetailPanelMinWidth + 1;

function percentOfContainer(pixels: number, containerWidth: number): number {
    return (pixels / containerWidth) * 100;
}

const DetailPanelDefaultSize = percentOfContainer(DetailPanelMinWidth, BothPanelsMinWidth);
const NavigationPanelDefaultSize = 100 - DetailPanelDefaultSize;

type TraceLayoutDesktopContextValue = {
    navigationPanelRef: RefObject<ImperativePanelHandle>;
    detailPanelRef: RefObject<ImperativePanelHandle>;
    isNavigationPanelCollapsed: boolean;
    isDetailPanelCollapsed: boolean;
    navigationPanelMinSize: number;
    detailPanelMinSize: number;
    collapsedPanelSize: number;
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
    const panelContainerRef = useRef<HTMLDivElement>(null);
    const navigationPanelRef = useRef<ImperativePanelHandle>(null);
    const detailPanelRef = useRef<ImperativePanelHandle>(null);
    const [containerWidth, setContainerWidth] = useState(BothPanelsMinWidth);
    const [isNavigationPanelCollapsed, setIsNavigationPanelCollapsed] = useState(false);
    const [isDetailPanelCollapsed, setIsDetailPanelCollapsed] = useState(false);

    useLayoutEffect(() => {
        const container = panelContainerRef.current;
        if (!container) {
            return;
        }
        const updateWidth = (width: number) => {
            if (width > 0) {
                setContainerWidth(width);
            }
        };
        updateWidth(container.offsetWidth);
        if (typeof ResizeObserver === "undefined") {
            return;
        }
        const observer = new ResizeObserver(([entry]) => updateWidth(entry.contentRect.width));
        observer.observe(container);
        return () => observer.disconnect();
    }, []);

    const contextValue: TraceLayoutDesktopContextValue = {
        navigationPanelRef,
        detailPanelRef,
        isNavigationPanelCollapsed,
        isDetailPanelCollapsed,
        navigationPanelMinSize: percentOfContainer(NavigationPanelMinWidth, containerWidth),
        detailPanelMinSize: percentOfContainer(DetailPanelMinWidth, containerWidth),
        collapsedPanelSize: percentOfContainer(CollapsedPanelWidth, containerWidth),
        setIsNavigationPanelCollapsed,
        setIsDetailPanelCollapsed,
        collapseNavigationPanel: () => navigationPanelRef.current?.collapse(),
        expandNavigationPanel: () => navigationPanelRef.current?.expand(),
        collapseDetailPanel: () => detailPanelRef.current?.collapse(),
        expandDetailPanel: () => detailPanelRef.current?.expand(),
    };

    return (
        <TraceLayoutContext.Provider value={contextValue}>
            <div data-testid="trace-layout-scroll" className="relative h-full w-full overflow-x-auto overflow-y-hidden">
                <div ref={panelContainerRef} data-testid="trace-layout-panels" className="h-full min-h-0 min-w-[621px]">
                    <PanelGroup direction="horizontal" className="h-full min-h-0">
                        {children}
                    </PanelGroup>
                </div>
            </div>
        </TraceLayoutContext.Provider>
    );
}

function NavigationPanel({ children }: { children: ReactNode }) {
    const {
        navigationPanelRef,
        isNavigationPanelCollapsed,
        navigationPanelMinSize,
        collapsedPanelSize,
        setIsNavigationPanelCollapsed,
        expandNavigationPanel,
    } = useTraceLayoutContext();

    return (
        <Panel
            ref={navigationPanelRef}
            role="region"
            aria-label="Trace navigation panel"
            defaultSize={NavigationPanelDefaultSize}
            minSize={navigationPanelMinSize}
            collapsible
            collapsedSize={collapsedPanelSize}
            onCollapse={() => setIsNavigationPanelCollapsed(true)}
            onExpand={() => setIsNavigationPanelCollapsed(false)}
        >
            <div
                data-testid="trace-navigation-content"
                className={cn("h-full w-full", isNavigationPanelCollapsed && "hidden")}
            >
                {children}
            </div>
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
            ) : null}
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
    const {
        detailPanelRef,
        isDetailPanelCollapsed,
        detailPanelMinSize,
        collapsedPanelSize,
        setIsDetailPanelCollapsed,
        collapseDetailPanel,
        expandDetailPanel,
    } = useTraceLayoutContext();

    return (
        <Panel
            ref={detailPanelRef}
            role="region"
            aria-label="Trace detail panel"
            defaultSize={DetailPanelDefaultSize}
            minSize={detailPanelMinSize}
            collapsible
            collapsedSize={collapsedPanelSize}
            onCollapse={() => setIsDetailPanelCollapsed(true)}
            onExpand={() => setIsDetailPanelCollapsed(false)}
        >
            <div
                data-testid="trace-detail-content"
                className={cn("relative h-full overflow-auto bg-panel", isDetailPanelCollapsed && "hidden")}
            >
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
            ) : null}
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
