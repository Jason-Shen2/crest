// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { forwardRef, useImperativeHandle, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TraceLayoutDesktop } from "./trace-layout-desktop";
import { TracePanelNavigationLayoutDesktop } from "./trace-panel-navigation-layout-desktop";

type PanelHandle = {
    collapse: ReturnType<typeof vi.fn>;
    expand: ReturnType<typeof vi.fn>;
};

type PanelProps = {
    children?: ReactNode;
    "aria-label"?: string;
    defaultSize?: number;
    onCollapse?: () => void;
    onExpand?: () => void;
};

type PanelGroupProps = {
    children?: ReactNode;
    direction: "horizontal" | "vertical";
    onLayout?: (layout: number[]) => void;
};

const PanelHarness = vi.hoisted(() => ({
    groupLayouts: {} as Record<string, ((layout: number[]) => void) | undefined>,
    handles: {} as Record<string, PanelHandle>,
}));

vi.mock("react-resizable-panels", () => ({
    PanelGroup: ({ children, direction, onLayout }: PanelGroupProps) => {
        PanelHarness.groupLayouts[direction] = onLayout;
        return (
            <div data-testid={`panel-group-${direction}`} data-direction={direction}>
                {children}
            </div>
        );
    },
    Panel: forwardRef<PanelHandle, PanelProps>(
        ({ children, "aria-label": ariaLabel, defaultSize, onCollapse, onExpand }, ref) => {
            const key = ariaLabel ?? `panel-${defaultSize}`;
            const handle: PanelHandle = {
                collapse: vi.fn(() => onCollapse?.()),
                expand: vi.fn(() => onExpand?.()),
            };
            PanelHarness.handles[key] = handle;
            useImperativeHandle(ref, () => handle, [handle]);
            return (
                <div aria-label={ariaLabel} data-testid={key} data-default-size={defaultSize}>
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

afterEach(() => {
    cleanup();
    PanelHarness.groupLayouts = {};
    PanelHarness.handles = {};
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
