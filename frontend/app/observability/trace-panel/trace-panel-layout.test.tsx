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

function makeDetail(): TraceDetail {
    return {
        trace: {
            id: "trace-layout",
            name: "layout_run",
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
        observations: [
            {
                id: "agent-1",
                traceId: "trace-layout",
                type: "AGENT",
                name: "agent",
                startTime: "2026-07-20T08:00:00.000Z",
                endTime: "2026-07-20T08:00:04.000Z",
                parentObservationId: null,
                level: "DEFAULT",
                statusMessage: null,
                version: null,
                model: null,
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
        ],
        scores: [],
        corrections: [],
    };
}

describe("TracePanel desktop layout", () => {
    it("collapses and restores the graph panel", () => {
        render(<TracePanel detail={makeDetail()} />);

        fireEvent.click(screen.getByRole("button", { name: "Collapse graph" }));
        expect(screen.queryByTestId("trace-graph-content")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Expand graph" }));
        expect(screen.getByTestId("trace-graph-content")).not.toBeNull();
    });

    it("keeps both desktop panels addressable in a narrow host", () => {
        render(
            <div style={{ width: 540 }}>
                <TracePanel detail={makeDetail()} />
            </div>
        );

        expect(screen.getByLabelText("Trace navigation panel")).not.toBeNull();
        expect(screen.getByLabelText("Trace detail panel")).not.toBeNull();
        expect(screen.getByLabelText("Resize navigation and detail panels")).not.toBeNull();
        expect(screen.getByTestId("trace-layout-scroll").className).toContain("overflow-x-auto");
        expect(screen.getByTestId("trace-layout-panels").className).toContain("min-w-[621px]");
    });
});
