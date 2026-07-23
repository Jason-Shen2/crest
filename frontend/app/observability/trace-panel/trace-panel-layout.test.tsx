// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TracePanel } from "./trace-panel";

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class ResizeObserver {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function makeDetail(traceId = "trace-layout", includeGeneration = true): TraceDetail {
    return {
        trace: {
            id: traceId,
            name: "Trace",
            timestamp: "2026-07-20T08:00:00.000Z",
            endedAt: "2026-07-20T08:00:04.000Z",
            environment: "test",
            tags: [],
            release: null,
            version: null,
            input: null,
            output: null,
            metadata: {},
            sessionId: "session-layout",
            userId: null,
            status: "success",
        },
        observations: includeGeneration
            ? [
                  {
                      id: `${traceId}-generation`,
                      traceId,
                      type: "GENERATION",
                      name: "generation",
                      startTime: "2026-07-20T08:00:00.000Z",
                      endTime: "2026-07-20T08:00:04.000Z",
                      parentObservationId: null,
                      level: "DEFAULT",
                      statusMessage: null,
                      version: null,
                      model: "test-model",
                      input: null,
                      output: null,
                      metadata: {},
                      latency: 4,
                      timeToFirstToken: null,
                      usageDetails: {},
                      costDetails: {},
                      toolCalls: null,
                      toolCallNames: null,
                  },
              ]
            : [],
        scores: [],
        corrections: [],
    };
}

describe("TracePanel desktop layout", () => {
    it("composes the shared navigation workspace inside the desktop host", () => {
        render(<TracePanel detail={makeDetail()} layout="desktop" />);

        expect(screen.getByTestId("trace-navigation-workspace")).not.toBeNull();
        expect(screen.getByRole("button", { name: "Collapse navigation" })).not.toBeNull();
        expect(screen.getByRole("region", { name: "Trace graph" })).not.toBeNull();
        expect(screen.getByRole("region", { name: "Trace detail" })).not.toBeNull();
    });

    it("collapses and restores the graph panel", () => {
        render(<TracePanel detail={makeDetail()} layout="desktop" />);

        fireEvent.click(screen.getByRole("button", { name: "Collapse graph" }));
        expect(screen.queryByTestId("trace-graph-content")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Expand graph" }));
        expect(screen.getByTestId("trace-graph-content")).not.toBeNull();
    });

    it("keeps both desktop panels addressable in a narrow host", () => {
        render(
            <div style={{ width: 540 }}>
                <TracePanel detail={makeDetail()} layout="desktop" />
            </div>
        );

        expect(screen.getByLabelText("Trace navigation panel")).not.toBeNull();
        expect(screen.getByLabelText("Trace detail panel")).not.toBeNull();
        expect(screen.getByLabelText("Resize navigation and detail panels")).not.toBeNull();
        expect(screen.getByTestId("trace-layout-scroll").className).toContain("overflow-x-auto");
        expect(screen.getByTestId("trace-layout-panels").className).toContain("min-w-[621px]");
    });
});

describe("TracePanel compact layout", () => {
    it("renders only the compact navigation host with the detail drawer initially closed", () => {
        render(<TracePanel detail={makeDetail()} layout="compact" />);

        expect(screen.getByTestId("trace-layout-compact")).not.toBeNull();
        expect(screen.getByTestId("trace-navigation-workspace")).not.toBeNull();
        expect(screen.queryByTestId("trace-layout-scroll")).toBeNull();
        expect(screen.queryByRole("region", { name: "Trace graph" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Collapse navigation" })).toBeNull();
        expect(screen.queryByRole("region", { name: "Trace detail" })).toBeNull();
        expect(screen.queryByRole("region", { name: "Trace detail drawer" })).toBeNull();
    });

    it("opens, closes, focuses, and reopens an observation detail drawer", () => {
        render(<TracePanel detail={makeDetail()} layout="compact" />);
        const generation = screen.getByRole("treeitem", { name: /^generation/ });

        fireEvent.click(generation);
        expect(screen.getByRole("region", { name: "Observation detail" })).not.toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Close trace detail" }));
        expect(screen.queryByRole("region", { name: "Trace detail drawer" })).toBeNull();
        expect(generation.getAttribute("aria-selected")).toBe("true");
        expect(document.activeElement).toBe(generation);

        fireEvent.click(generation);
        expect(screen.getByRole("region", { name: "Observation detail" })).not.toBeNull();
    });

    it("opens trace detail after explicitly selecting the trace root", () => {
        render(<TracePanel detail={makeDetail()} layout="compact" />);

        fireEvent.click(screen.getByRole("treeitem", { name: /^Trace/ }));

        expect(screen.getByRole("region", { name: "Trace detail" })).not.toBeNull();
    });

    it("closes the drawer when switching traces", () => {
        const { rerender } = render(<TracePanel detail={makeDetail("trace-a")} layout="compact" />);
        fireEvent.click(screen.getByRole("treeitem", { name: /^generation/ }));
        expect(screen.getByRole("region", { name: "Trace detail drawer" })).not.toBeNull();

        rerender(<TracePanel detail={makeDetail("trace-b")} layout="compact" />);

        expect(screen.queryByRole("region", { name: "Trace detail drawer" })).toBeNull();
    });

    it("restores per-trace selection without reopening the drawer", () => {
        const { rerender } = render(<TracePanel detail={makeDetail("trace-a")} layout="compact" />);
        fireEvent.click(screen.getByRole("treeitem", { name: /^generation/ }));

        rerender(<TracePanel detail={makeDetail("trace-b")} layout="compact" />);
        rerender(<TracePanel detail={makeDetail("trace-a")} layout="compact" />);

        expect(screen.getByRole("treeitem", { name: /^generation/ }).getAttribute("aria-selected")).toBe("true");
        expect(screen.queryByRole("region", { name: "Trace detail drawer" })).toBeNull();
    });

    it("keeps an open drawer and falls back to trace detail when the selected observation disappears", () => {
        const { rerender } = render(<TracePanel detail={makeDetail()} layout="compact" />);
        fireEvent.click(screen.getByRole("treeitem", { name: /^generation/ }));

        rerender(<TracePanel detail={makeDetail("trace-layout", false)} layout="compact" />);

        expect(screen.getByRole("region", { name: "Trace detail drawer" })).not.toBeNull();
        expect(screen.getByRole("region", { name: "Trace detail" })).not.toBeNull();
    });

    it("preserves selection across layouts while keeping compact detail closed on return", () => {
        const detail = makeDetail();
        const { rerender } = render(<TracePanel detail={detail} layout="compact" />);
        fireEvent.click(screen.getByRole("treeitem", { name: /^generation/ }));

        rerender(<TracePanel detail={detail} layout="desktop" />);
        expect(screen.getByRole("region", { name: "Observation detail" })).not.toBeNull();

        rerender(<TracePanel detail={detail} layout="compact" />);
        expect(screen.queryByRole("region", { name: "Trace detail drawer" })).toBeNull();
        expect(screen.getByRole("treeitem", { name: /^generation/ }).getAttribute("aria-selected")).toBe("true");
    });
});
