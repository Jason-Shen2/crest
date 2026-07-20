// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeGraphLayout } from "./elk-layout";
import { TracePanel } from "./trace-panel";

vi.mock("./elk-layout", () => ({
    computeGraphLayout: vi.fn().mockResolvedValue({
        nodes: [],
        edges: [],
        width: 0,
        height: 0,
    }),
}));

const computeGraphLayoutMock = vi.mocked(computeGraphLayout);

function makeObservation(overrides: Partial<Observation> = {}): Observation {
    return {
        id: "generation-1",
        traceId: "trace-layout",
        type: "GENERATION",
        name: "generation",
        startTime: "2026-07-20T08:00:00.000Z",
        endTime: null,
        parentObservationId: null,
        level: "DEFAULT",
        statusMessage: null,
        version: null,
        model: "test-model",
        input: null,
        output: "first token",
        metadata: {},
        latency: null,
        timeToFirstToken: null,
        usageDetails: {},
        costDetails: {},
        toolCalls: null,
        toolCallNames: null,
        ...overrides,
    };
}

function makeDetail(observations: Observation[] = [makeObservation()]): TraceDetail {
    return {
        trace: {
            id: "trace-layout",
            name: "layout_run",
            timestamp: "2026-07-20T08:00:00.000Z",
            endedAt: null,
            environment: "test",
            tags: [],
            release: null,
            version: null,
            input: null,
            output: null,
            metadata: {},
            sessionId: "session-layout",
            userId: null,
            status: "running",
        },
        observations,
        scores: [],
        corrections: [],
    };
}

function withChild(detail: TraceDetail): TraceDetail {
    return {
        ...detail,
        observations: [
            ...detail.observations,
            makeObservation({
                id: "tool-1",
                type: "TOOL",
                name: "read",
                startTime: "2026-07-20T08:00:01.000Z",
                parentObservationId: "generation-1",
            }),
        ],
    };
}

beforeEach(() => {
    computeGraphLayoutMock.mockClear();
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

describe("Trace graph layout lifecycle", () => {
    it("reuses layout for streaming fields and recomputes for topology changes", async () => {
        const detail = makeDetail();
        const { rerender } = render(<TracePanel detail={detail} />);
        await waitFor(() => expect(computeGraphLayoutMock).toHaveBeenCalledTimes(1));

        rerender(
            <TracePanel
                detail={{
                    ...detail,
                    observations: [
                        makeObservation({
                            output: "first token second token",
                            usageDetails: { input: 12, output: 2, totalTokens: 14 },
                        }),
                    ],
                }}
            />
        );
        await Promise.resolve();
        expect(computeGraphLayoutMock).toHaveBeenCalledTimes(1);

        rerender(<TracePanel detail={withChild(detail)} />);
        await waitFor(() => expect(computeGraphLayoutMock).toHaveBeenCalledTimes(2));
    });

    it("does not run layout while the graph is collapsed", async () => {
        const detail = makeDetail();
        const { rerender } = render(<TracePanel detail={detail} />);
        await waitFor(() => expect(computeGraphLayoutMock).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole("button", { name: "Collapse graph" }));
        rerender(<TracePanel detail={withChild(detail)} />);
        await Promise.resolve();
        expect(computeGraphLayoutMock).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("button", { name: "Expand graph" }));
        await waitFor(() => expect(computeGraphLayoutMock).toHaveBeenCalledTimes(2));
    });
});
