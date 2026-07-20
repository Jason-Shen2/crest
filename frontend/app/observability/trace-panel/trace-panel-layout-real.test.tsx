// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TraceLayoutDesktop, useDesktopTraceLayout } from "./trace-layout-desktop";

vi.mock("react-resizable-panels", async () => {
    // Vitest resolves the package's effect-free node build even in jsdom; exercise its real browser build here.
    return import("../../../../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.js");
});

const CanvasMinWidth = 621;
const OriginalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const OriginalGetBoundingClientRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");

let hostWidth = 540;

function canvasWidth(element: Element): number {
    const canvas = element.matches("[data-testid='trace-layout-panels']")
        ? element
        : element.closest("[data-testid='trace-layout-panels']");
    if (!canvas) {
        return hostWidth;
    }
    return canvas.className.includes("min-w-[621px]") ? Math.max(hostWidth, CanvasMinWidth) : hostWidth;
}

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

    static notifyAll() {
        for (const observer of TestResizeObserver.instances) {
            for (const target of observer.observed) {
                const rect = target.getBoundingClientRect();
                observer.callback(
                    [{ target, contentRect: rect } as ResizeObserverEntry],
                    observer as unknown as ResizeObserver
                );
            }
        }
    }
}

function NavigationContent() {
    const { collapseNavigationPanel } = useDesktopTraceLayout();
    return (
        <button type="button" onClick={collapseNavigationPanel}>
            Collapse navigation
        </button>
    );
}

function RealLayoutHarness() {
    return (
        <div style={{ width: hostWidth }}>
            <TraceLayoutDesktop>
                <TraceLayoutDesktop.NavigationPanel>
                    <NavigationContent />
                </TraceLayoutDesktop.NavigationPanel>
                <TraceLayoutDesktop.ResizeHandle />
                <TraceLayoutDesktop.DetailPanel>
                    <div>detail content</div>
                </TraceLayoutDesktop.DetailPanel>
            </TraceLayoutDesktop>
        </div>
    );
}

beforeAll(() => {
    Object.defineProperties(HTMLElement.prototype, {
        offsetWidth: {
            configurable: true,
            get() {
                return canvasWidth(this);
            },
        },
        getBoundingClientRect: {
            configurable: true,
            value() {
                const width = canvasWidth(this);
                return {
                    x: 0,
                    y: 0,
                    top: 0,
                    right: width,
                    bottom: 600,
                    left: 0,
                    width,
                    height: 600,
                    toJSON: () => undefined,
                };
            },
        },
    });
});

beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

afterEach(() => {
    cleanup();
    TestResizeObserver.instances = [];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

afterAll(() => {
    if (OriginalOffsetWidth) {
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", OriginalOffsetWidth);
    } else {
        delete HTMLElement.prototype.offsetWidth;
    }
    if (OriginalGetBoundingClientRect) {
        Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", OriginalGetBoundingClientRect);
    } else {
        delete HTMLElement.prototype.getBoundingClientRect;
    }
});

describe.each([320, 540])("TracePanel real narrow layout at %ipx", (width) => {
    it("keeps the 621px canvas through collapse, observer notification, and expand", async () => {
        hostWidth = width;
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        render(<RealLayoutHarness />);
        const canvas = screen.getByTestId("trace-layout-panels");

        fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));
        await waitFor(() => expect(screen.getByRole("button", { name: "Expand navigation" })).not.toBeNull());

        act(() => TestResizeObserver.notifyAll());
        fireEvent.click(screen.getByRole("button", { name: "Expand navigation" }));

        await waitFor(() => expect(screen.getByRole("button", { name: "Collapse navigation" })).not.toBeNull());
        expect(canvas.className).toContain("min-w-[621px]");
        expect(canvas.getBoundingClientRect().width).toBe(CanvasMinWidth);
        expect(screen.getByText("detail content")).not.toBeNull();
        expect(consoleWarn).not.toHaveBeenCalled();
    });
});
