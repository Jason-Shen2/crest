// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { forwardRef, useImperativeHandle, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TraceLayoutDesktop } from "./trace-layout-desktop";
import { TracePanelNavigationLayoutDesktop } from "./trace-panel-navigation-layout-desktop";

type PanelHandle = {
    collapse: ReturnType<typeof vi.fn>;
    expand: ReturnType<typeof vi.fn>;
};

type PanelProps = {
    children?: ReactNode;
    "aria-label"?: string;
    role?: string;
    defaultSize?: number;
    minSize?: number;
    collapsedSize?: number;
    onCollapse?: () => void;
    onExpand?: () => void;
};

type PanelGroupProps = {
    children?: ReactNode;
    direction: "horizontal" | "vertical";
    onLayout?: (layout: number[]) => void;
    "data-testid"?: string;
};

const PanelHarness = vi.hoisted(() => ({
    groupLayouts: {} as Record<string, ((layout: number[]) => void) | undefined>,
    handles: {} as Record<string, PanelHandle>,
    panelProps: {} as Record<string, PanelProps>,
}));

class TestResizeObserver {
    static instances: TestResizeObserver[] = [];
    callback: ResizeObserverCallback;
    observed = new Set<Element>();

    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        TestResizeObserver.instances.push(this);
    }

    observe(target: Element) {
        this.observed.add(target);
    }

    unobserve(target: Element) {
        this.observed.delete(target);
    }

    disconnect() {
        this.observed.clear();
    }

    static notify(target: Element, width: number) {
        for (const observer of TestResizeObserver.instances) {
            if (!observer.observed.has(target)) {
                continue;
            }
            observer.callback(
                [
                    {
                        target,
                        contentRect: { width },
                    } as ResizeObserverEntry,
                ],
                observer as unknown as ResizeObserver
            );
        }
    }
}

vi.mock("react-resizable-panels", () => ({
    PanelGroup: ({ children, direction, onLayout, "data-testid": testId }: PanelGroupProps) => {
        PanelHarness.groupLayouts[direction] = onLayout;
        return (
            <div data-testid={testId ?? `panel-group-${direction}`} data-direction={direction}>
                {children}
            </div>
        );
    },
    Panel: forwardRef<PanelHandle, PanelProps>(
        (
            { children, "aria-label": ariaLabel, role, defaultSize, minSize, collapsedSize, onCollapse, onExpand },
            ref
        ) => {
            const key = ariaLabel ?? `panel-${defaultSize}`;
            PanelHarness.panelProps[key] = { role, defaultSize, minSize, collapsedSize };
            const handle: PanelHandle = {
                collapse: vi.fn(() => onCollapse?.()),
                expand: vi.fn(() => onExpand?.()),
            };
            PanelHarness.handles[key] = handle;
            useImperativeHandle(ref, () => handle, [handle]);
            return (
                <div role={role} aria-label={ariaLabel} data-testid={key} data-default-size={defaultSize}>
                    {children}
                </div>
            );
        }
    ),
    PanelResizeHandle: ({ "aria-label": ariaLabel }: { "aria-label"?: string }) => (
        <div aria-label={ariaLabel} role="separator" />
    ),
}));

vi.mock("./trace-navigation-header", () => ({
    TraceNavigationHeader: () => <div>navigation header</div>,
}));

beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

afterEach(() => {
    cleanup();
    PanelHarness.groupLayouts = {};
    PanelHarness.handles = {};
    PanelHarness.panelProps = {};
    TestResizeObserver.instances = [];
    vi.unstubAllGlobals();
});

function LayoutHarness({
    navigationContent = <div>navigation content</div>,
    detailContent = <div>detail content</div>,
}: {
    navigationContent?: ReactNode;
    detailContent?: ReactNode;
}) {
    return (
        <TraceLayoutDesktop>
            <TraceLayoutDesktop.NavigationPanel>
                <TracePanelNavigationLayoutDesktop secondaryContent={<div>graph content</div>}>
                    {navigationContent}
                </TracePanelNavigationLayoutDesktop>
            </TraceLayoutDesktop.NavigationPanel>
            <TraceLayoutDesktop.ResizeHandle />
            <TraceLayoutDesktop.DetailPanel>{detailContent}</TraceLayoutDesktop.DetailPanel>
        </TraceLayoutDesktop>
    );
}

function StatefulNavigation() {
    const [count, setCount] = useState(0);
    return (
        <button type="button" onClick={() => setCount((value) => value + 1)}>
            Navigation count {count}
        </button>
    );
}

function StatefulDetail() {
    const [count, setCount] = useState(0);
    return (
        <button type="button" onClick={() => setCount((value) => value + 1)}>
            Detail count {count}
        </button>
    );
}

describe("TracePanel desktop solver state", () => {
    it("converts pixel constraints to solver percentages from the container width", () => {
        render(<LayoutHarness />);
        const container = screen.getByTestId("trace-layout-panels");

        act(() => TestResizeObserver.notify(container, 1_000));
        expect(PanelHarness.panelProps["Trace navigation panel"]).toMatchObject({
            minSize: 26,
            collapsedSize: 4,
        });
        expect(PanelHarness.panelProps["Trace detail panel"]).toMatchObject({
            minSize: 36,
            collapsedSize: 4,
        });

        act(() => TestResizeObserver.notify(container, 621));
        expect(PanelHarness.panelProps["Trace navigation panel"].minSize).toBeCloseTo((260 / 621) * 100);
        expect(PanelHarness.panelProps["Trace detail panel"].minSize).toBeCloseTo((360 / 621) * 100);
        expect(PanelHarness.panelProps["Trace navigation panel"].collapsedSize).toBeCloseTo((40 / 621) * 100);
        expect(PanelHarness.panelProps["Trace detail panel"].collapsedSize).toBeCloseTo((40 / 621) * 100);
    });

    it("exposes navigation and detail panels as named regions", () => {
        render(<LayoutHarness />);

        expect(screen.getByRole("region", { name: "Trace navigation panel" })).not.toBeNull();
        expect(screen.getByRole("region", { name: "Trace detail panel" })).not.toBeNull();
    });

    it("preserves graph collapse and resize state across navigation collapse", () => {
        render(<LayoutHarness navigationContent={<StatefulNavigation />} />);
        act(() => PanelHarness.groupLayouts.vertical?.([70, 30]));
        fireEvent.click(screen.getByRole("button", { name: "Collapse graph" }));
        fireEvent.click(screen.getByRole("button", { name: "Navigation count 0" }));
        const statefulChild = screen.getByRole("button", { name: "Navigation count 1" });

        fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));

        expect(document.body.contains(statefulChild)).toBe(true);
        expect(statefulChild.closest("[data-testid='trace-navigation-content']")?.className).toContain("hidden");

        fireEvent.click(screen.getByRole("button", { name: "Expand navigation" }));
        expect(screen.getByRole("button", { name: "Navigation count 1" })).toBe(statefulChild);
        expect(screen.getByRole("button", { name: "Expand graph" })).not.toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Expand graph" }));
        expect(screen.getByTestId("panel-70").getAttribute("data-default-size")).toBe("70");
        expect(screen.getByTestId("panel-30").getAttribute("data-default-size")).toBe("30");
    });

    it("keeps detail children mounted and preserves their state while collapsed", () => {
        render(<LayoutHarness detailContent={<StatefulDetail />} />);
        fireEvent.click(screen.getByRole("button", { name: "Detail count 0" }));
        const statefulChild = screen.getByRole("button", { name: "Detail count 1" });

        fireEvent.click(screen.getByRole("button", { name: "Collapse detail" }));

        expect(document.body.contains(statefulChild)).toBe(true);
        expect(statefulChild.closest("[data-testid='trace-detail-content']")?.className).toContain("hidden");

        fireEvent.click(screen.getByRole("button", { name: "Expand detail" }));
        expect(screen.getByRole("button", { name: "Detail count 1" })).toBe(statefulChild);
    });

    it("restores the last open graph resize ratio after collapse", () => {
        render(<LayoutHarness />);
        expect(PanelHarness.groupLayouts.vertical).toBeTypeOf("function");

        act(() => PanelHarness.groupLayouts.vertical?.([70, 30]));
        fireEvent.click(screen.getByRole("button", { name: "Collapse graph" }));
        fireEvent.click(screen.getByRole("button", { name: "Expand graph" }));

        expect(screen.getByTestId("panel-70").getAttribute("data-default-size")).toBe("70");
        expect(screen.getByTestId("panel-30").getAttribute("data-default-size")).toBe("30");
    });

    it("drives navigation and detail collapse through solver handles", () => {
        render(<LayoutHarness />);
        const navigationHandle = PanelHarness.handles["Trace navigation panel"];

        fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));
        expect(navigationHandle.collapse).toHaveBeenCalledTimes(1);
        const collapsedNavigationHandle = PanelHarness.handles["Trace navigation panel"];
        fireEvent.click(screen.getByRole("button", { name: "Expand navigation" }));
        expect(collapsedNavigationHandle.expand).toHaveBeenCalledTimes(1);

        const detailHandle = PanelHarness.handles["Trace detail panel"];
        fireEvent.click(screen.getByRole("button", { name: "Collapse detail" }));
        expect(detailHandle.collapse).toHaveBeenCalledTimes(1);
        const collapsedDetailHandle = PanelHarness.handles["Trace detail panel"];
        fireEvent.click(screen.getByRole("button", { name: "Expand detail" }));
        expect(collapsedDetailHandle.expand).toHaveBeenCalledTimes(1);
    });
});
