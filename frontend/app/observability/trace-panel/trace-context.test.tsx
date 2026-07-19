// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TraceDataProvider, TraceSelectionProvider, useTraceData, useTraceSelection } from "./trace-context";

afterEach(cleanup);

function makeObservation(id: string, overrides: Partial<Observation> = {}): Observation {
    return {
        id,
        traceId: "trace-1",
        type: "GENERATION",
        name: "assistant response",
        startTime: "2026-07-20T08:00:01.000Z",
        endTime: "2026-07-20T08:00:02.000Z",
        parentObservationId: null,
        level: "DEFAULT",
        statusMessage: null,
        version: null,
        model: "test-model",
        input: null,
        output: null,
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

function makeDetail(observationIds: string[]): TraceDetail {
    return {
        trace: {
            id: "trace-1",
            name: "Trace",
            timestamp: "2026-07-20T08:00:00.000Z",
            environment: "test",
            tags: [],
            release: null,
            version: null,
            input: null,
            output: null,
            metadata: {},
            sessionId: "session-1",
            userId: null,
            status: "success",
            endedAt: "2026-07-20T08:00:04.000Z",
        },
        observations: observationIds.map((id) => makeObservation(id)),
        scores: [],
        corrections: [],
    };
}

function makeDetailWithInvalidObservationTime(): TraceDetail {
    return {
        ...makeDetail([]),
        observations: [
            makeObservation("generation-invalid", {
                startTime: "not-a-date",
                endTime: "also-not-a-date",
            }),
        ],
    };
}

function ContextProbe({ detail }: { detail: TraceDetail }) {
    return (
        <TraceDataProvider detail={detail}>
            <TraceSelectionProvider traceId={detail.trace.id}>
                <Probe />
            </TraceSelectionProvider>
        </TraceDataProvider>
    );
}

function Probe() {
    const { selectedNodeId, setSelectedNodeId } = useTraceSelection();
    const { traceStartTime, traceDuration } = useTraceData();
    return (
        <>
            <button type="button" onClick={() => setSelectedNodeId("generation-1")}>
                select generation-1
            </button>
            <span data-testid="selection">{selectedNodeId ?? "trace"}</span>
            <span data-testid="trace-start">{traceStartTime.toISOString()}</span>
            <span data-testid="trace-duration">{traceDuration}</span>
        </>
    );
}

describe("trace context", () => {
    it("uses null for trace selection and clears a removed observation", () => {
        const { rerender } = render(<ContextProbe detail={makeDetail(["generation-1"])} />);
        fireEvent.click(screen.getByRole("button", { name: "select generation-1" }));
        expect(screen.getByTestId("selection").textContent).toBe("generation-1");

        rerender(<ContextProbe detail={makeDetail([])} />);
        expect(screen.getByTestId("selection").textContent).toBe("trace");
    });

    it("ignores invalid dates when computing the trace time range", () => {
        render(<ContextProbe detail={makeDetailWithInvalidObservationTime()} />);
        expect(screen.getByTestId("trace-start").textContent).toBe("2026-07-20T08:00:00.000Z");
        expect(screen.getByTestId("trace-duration").textContent).toBe("4");
    });
});
