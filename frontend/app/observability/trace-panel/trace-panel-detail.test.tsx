// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { serializeDetailValue } from "./detail-value";
import { IOPreview } from "./io-preview";
import { ObservationDetailView } from "./observation-detail-view";
import { TraceDataProvider, TraceSelectionProvider, useTraceSelection } from "./trace-context";
import { TraceDetailView } from "./trace-detail-view";
import { TracePanelDetail } from "./trace-panel-detail";

const CopyScopeKey = "observation-current";

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
    return {
        id: "generation-1",
        traceId: "trace-1",
        type: "GENERATION",
        name: "assistant_response",
        startTime: "2026-07-20T08:00:01.000Z",
        endTime: "2026-07-20T08:00:03.500Z",
        parentObservationId: null,
        level: "DEFAULT",
        statusMessage: null,
        version: null,
        model: "claude-sonnet-4",
        input: null,
        output: { answer: "done" },
        metadata: {},
        latency: 2.5,
        timeToFirstToken: 0.4,
        usageDetails: { input: 20, output: 8, totalTokens: 28 },
        costDetails: { total: 0.0125 },
        toolCalls: null,
        toolCallNames: null,
        ...overrides,
    };
}

function makeDetail(): TraceDetail {
    return {
        trace: {
            id: "trace-1",
            name: "agent_run",
            timestamp: "2026-07-20T08:00:00.000Z",
            environment: "test",
            tags: [],
            release: null,
            version: null,
            input: { prompt: "hello" },
            output: { answer: "done" },
            metadata: { runtime: "pi" },
            sessionId: "session-1",
            userId: null,
            status: "success",
            endedAt: "2026-07-20T08:00:04.000Z",
        },
        observations: [makeObservation()],
        scores: [
            {
                id: "score-1",
                traceId: "trace-1",
                observationId: null,
                name: "quality",
                source: "EVAL",
                dataType: "NUMERIC",
                value: 1,
                comment: null,
            },
        ],
        corrections: [],
    };
}

function SelectionSync({ selectedNodeId }: { selectedNodeId: string | null }) {
    const { selectNode } = useTraceSelection();

    useEffect(() => {
        selectNode(selectedNodeId);
    }, [selectedNodeId, selectNode]);

    return null;
}

function DetailHarness({ selectedNodeId }: { selectedNodeId: string | null }) {
    const detail = makeDetail();
    return (
        <TraceDataProvider detail={detail}>
            <TraceSelectionProvider traceId={detail.trace.id}>
                <SelectionSync selectedNodeId={selectedNodeId} />
                <TracePanelDetail />
            </TraceSelectionProvider>
        </TraceDataProvider>
    );
}

describe("IOPreview", () => {
    it("does not render a section for a null value", () => {
        render(<IOPreview label="Output" value={null} copyScopeKey={CopyScopeKey} />);

        expect(screen.queryByRole("region", { name: "Output" })).toBeNull();
    });

    it.each([
        ["zero", 0, "0"],
        ["false", false, "false"],
        ["empty string", "", ""],
    ])("renders %s as a present value", (_, value, expected) => {
        render(<IOPreview label="Output" value={value} copyScopeKey={CopyScopeKey} />);

        const section = screen.getByRole("region", { name: "Output" });
        expect(within(section).getByTestId("detail-value-preview").textContent).toBe(expected);
    });

    it("runs complete serialization only when Copy is requested", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const stringify = vi.spyOn(JSON, "stringify");
        const value = { output: "complete value" };

        render(<IOPreview label="Output" value={value} copyScopeKey={CopyScopeKey} />);
        expect(stringify).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));

        expect(stringify).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledWith(serializeDetailValue(value));
        expect(await screen.findByText("Copied")).not.toBeNull();
    });

    it("bounds the preview but copies the complete value", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const value = { output: "x".repeat(20_000) };
        render(<IOPreview label="Output" value={value} copyScopeKey={CopyScopeKey} />);

        const section = screen.getByRole("region", { name: "Output" });
        expect(within(section).getByTestId("detail-value-preview").textContent?.length).toBeLessThanOrEqual(10_001);
        expect(within(section).getByText("Preview truncated")).not.toBeNull();

        fireEvent.click(within(section).getByRole("button", { name: "Copy Output" }));
        expect(writeText).toHaveBeenCalledWith(serializeDetailValue(value));
        expect(await within(section).findByText("Copied")).not.toBeNull();
    });

    it("reports clipboard failure", async () => {
        vi.stubGlobal("navigator", {
            clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
        });
        render(<IOPreview label="Output" value={{ ok: true }} copyScopeKey={CopyScopeKey} />);

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));

        expect(await screen.findByText("Copy failed")).not.toBeNull();
    });

    it("reports an unavailable clipboard API as a failure", async () => {
        vi.stubGlobal("navigator", {});
        render(<IOPreview label="Output" value={{ ok: true }} copyScopeKey={CopyScopeKey} />);

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));

        expect(await screen.findByText("Copy failed")).not.toBeNull();
    });

    it("ignores an old copy success after the value changes", async () => {
        const oldCopy = deferred<void>();
        const writeText = vi.fn().mockReturnValueOnce(oldCopy.promise).mockResolvedValueOnce(undefined);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const view = render(<IOPreview label="Output" value={{ version: "old" }} copyScopeKey="observation-old" />);

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));
        view.rerender(<IOPreview label="Output" value={{ version: "new" }} copyScopeKey="observation-new" />);
        await act(() => oldCopy.resolve());

        expect(screen.queryByText("Copied")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));
        expect(await screen.findByText("Copied")).not.toBeNull();
    });

    it("ignores an old copy success after switching to an equivalent value", async () => {
        const oldCopy = deferred<void>();
        const writeText = vi.fn().mockReturnValueOnce(oldCopy.promise);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const view = render(<IOPreview label="Output" value={{ result: "same" }} copyScopeKey="observation-old" />);

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));
        view.rerender(<IOPreview label="Output" value={{ result: "same" }} copyScopeKey="observation-new" />);
        await act(() => oldCopy.resolve());

        expect(screen.queryByText("Copied")).toBeNull();
    });

    it("ignores an old copy success after the selection changes with the same string value", async () => {
        const oldCopy = deferred<void>();
        const writeText = vi.fn().mockReturnValueOnce(oldCopy.promise);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const view = render(<IOPreview label="Output" value="same" copyScopeKey="observation-old" />);

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));
        view.rerender(<IOPreview label="Output" value="same" copyScopeKey="observation-new" />);
        await act(() => oldCopy.resolve());

        expect(screen.queryByText("Copied")).toBeNull();
    });

    it("ignores an old copy failure after the selection changes with the same string value", async () => {
        const oldCopy = deferred<void>();
        const writeText = vi.fn().mockReturnValueOnce(oldCopy.promise);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const view = render(<IOPreview label="Output" value="same" copyScopeKey="observation-old" />);

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));
        view.rerender(<IOPreview label="Output" value="same" copyScopeKey="observation-new" />);
        await act(() => oldCopy.reject(new Error("denied")));

        expect(screen.queryByText("Copy failed")).toBeNull();
    });

    it("ignores an old copy failure after the value changes", async () => {
        const oldCopy = deferred<void>();
        const writeText = vi.fn().mockReturnValueOnce(oldCopy.promise).mockResolvedValueOnce(undefined);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const view = render(<IOPreview label="Output" value={{ version: "old" }} copyScopeKey="observation-old" />);

        fireEvent.click(screen.getByRole("button", { name: "Copy Output" }));
        view.rerender(<IOPreview label="Output" value={{ version: "new" }} copyScopeKey="observation-new" />);
        await act(() => oldCopy.reject(new Error("denied")));

        expect(screen.queryByText("Copy failed")).toBeNull();
    });

    it("does not expose media or comments controls", () => {
        render(<IOPreview label="Output" value={{ ok: true }} copyScopeKey={CopyScopeKey} />);

        expect(screen.queryByText(/media/i)).toBeNull();
        expect(screen.queryByText(/comment/i)).toBeNull();
    });
});

describe("TracePanelDetail", () => {
    it("shows trace detail when selection is null or stale", () => {
        const view = render(<DetailHarness selectedNodeId={null} />);
        expect(screen.getByRole("heading", { name: "agent_run" })).not.toBeNull();

        view.rerender(<DetailHarness selectedNodeId="missing-observation" />);
        expect(screen.getByRole("heading", { name: "agent_run" })).not.toBeNull();
        expect(screen.queryByText("Observation not found")).toBeNull();
    });

    it("shows only observation sections backed by real data", () => {
        render(<DetailHarness selectedNodeId="generation-1" />);

        expect(screen.getByRole("heading", { name: "assistant_response" })).not.toBeNull();
        expect(screen.queryByRole("region", { name: "Input" })).toBeNull();
        expect(screen.getByRole("region", { name: "Output" })).not.toBeNull();
        expect(screen.getByRole("region", { name: "Usage" })).not.toBeNull();
        expect(screen.getByRole("region", { name: "Cost" })).not.toBeNull();
        expect(screen.queryByRole("region", { name: "Metadata" })).toBeNull();
        expect(screen.queryByRole("tab", { name: "Scores" })).toBeNull();
    });

    it("switches observation detail between Preview and JSON", () => {
        render(<DetailHarness selectedNodeId="generation-1" />);

        expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
        fireEvent.click(screen.getByRole("tab", { name: "JSON" }));

        expect(screen.getByText(/"id": "generation-1"/)).not.toBeNull();
        expect(screen.queryByRole("region", { name: "Output" })).toBeNull();
    });

    it("renders only supported trace and observation header metrics", () => {
        const view = render(<DetailHarness selectedNodeId={null} />);
        const traceHeader = screen.getByRole("banner", { name: "Trace header" });
        expect(within(traceHeader).getByText("success")).not.toBeNull();
        expect(within(traceHeader).getByText("4.00s")).not.toBeNull();
        expect(within(traceHeader).getByText("1 observation")).not.toBeNull();
        expect(within(traceHeader).getByText("28 tokens")).not.toBeNull();
        expect(within(traceHeader).getByText("$0.0125")).not.toBeNull();
        expect(within(traceHeader).queryByText(/score/i)).toBeNull();

        view.rerender(<DetailHarness selectedNodeId="generation-1" />);
        const observationHeader = screen.getByRole("banner", { name: "Observation header" });
        expect(within(observationHeader).getByText("GENERATION")).not.toBeNull();
        expect(within(observationHeader).getByText("DEFAULT")).not.toBeNull();
        expect(within(observationHeader).getByText("2.50s")).not.toBeNull();
        expect(within(observationHeader).getByText("TTFT 400ms")).not.toBeNull();
        expect(within(observationHeader).getByText("claude-sonnet-4")).not.toBeNull();
        expect(within(observationHeader).getByText("28 tokens")).not.toBeNull();
        expect(within(observationHeader).getByText("$0.0125")).not.toBeNull();
    });
});

describe("ObservationDetailView error status", () => {
    it("shows a non-empty status message for an ERROR generation", () => {
        render(
            <ObservationDetailView
                trace={makeDetail().trace}
                observation={makeObservation({
                    level: "ERROR",
                    statusMessage: "Generation request failed",
                })}
            />
        );

        const header = screen.getByRole("banner", { name: "Observation header" });
        expect(within(header).getByText("ERROR")).not.toBeNull();
        expect(within(header).getByText("Generation request failed")).not.toBeNull();
    });

    it("shows a non-empty status message for an ERROR tool", () => {
        render(
            <ObservationDetailView
                trace={makeDetail().trace}
                observation={makeObservation({
                    id: "tool-1",
                    type: "TOOL",
                    name: "read_file",
                    level: "ERROR",
                    statusMessage: "File does not exist",
                })}
            />
        );

        const header = screen.getByRole("banner", { name: "Observation header" });
        expect(within(header).getByText("ERROR")).not.toBeNull();
        expect(within(header).getByText("File does not exist")).not.toBeNull();
    });
});

describe("Detail JSON view", () => {
    it("bounds trace JSON during render and copies the complete value explicitly", () => {
        const detail = makeDetail();
        detail.trace.metadata = { payload: "x".repeat(20_000) };
        const completeJson = serializeDetailValue(detail.trace);
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const stringify = vi.spyOn(JSON, "stringify");

        render(<TraceDetailView detail={detail} />);
        fireEvent.click(screen.getByRole("tab", { name: "JSON" }));

        expect(stringify).not.toHaveBeenCalledWith(detail.trace, null, 2);
        expect(screen.getByTestId("detail-json-preview").textContent?.length).toBeLessThanOrEqual(10_001);
        expect(within(screen.getByRole("tabpanel")).getByText("Preview truncated")).not.toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
        expect(writeText).toHaveBeenCalledWith(completeJson);
    });

    it("bounds observation JSON during render and copies the complete value explicitly", () => {
        const observation = makeObservation({ metadata: { payload: "x".repeat(20_000) } });
        const completeJson = serializeDetailValue(observation);
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal("navigator", { clipboard: { writeText } });
        const stringify = vi.spyOn(JSON, "stringify");

        render(<ObservationDetailView trace={makeDetail().trace} observation={observation} />);
        fireEvent.click(screen.getByRole("tab", { name: "JSON" }));

        expect(stringify).not.toHaveBeenCalledWith(observation, null, 2);
        expect(screen.getByTestId("detail-json-preview").textContent?.length).toBeLessThanOrEqual(10_001);
        expect(within(screen.getByRole("tabpanel")).getByText("Preview truncated")).not.toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
        expect(writeText).toHaveBeenCalledWith(completeJson);
    });
});

function renderDetailView(kind: "trace" | "observation") {
    return kind === "trace"
        ? render(<TraceDetailView detail={makeDetail()} />)
        : render(<ObservationDetailView trace={makeDetail().trace} observation={makeObservation()} />);
}

describe.each(["trace", "observation"] as const)("%s detail tabs", (kind) => {
    it("connects tabs to labelled tabpanels with roving tab stops", () => {
        renderDetailView(kind);
        const previewTab = screen.getByRole("tab", { name: "Preview" });
        const jsonTab = screen.getByRole("tab", { name: "JSON" });

        expect(previewTab.tabIndex).toBe(0);
        expect(jsonTab.tabIndex).toBe(-1);
        expect(previewTab.id).not.toBe("");
        expect(jsonTab.id).not.toBe("");

        for (const tab of [previewTab, jsonTab]) {
            const panelId = tab.getAttribute("aria-controls");
            expect(panelId).not.toBeNull();
            const panel = document.getElementById(panelId!);
            expect(panel?.getAttribute("role")).toBe("tabpanel");
            expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
        }
    });

    it("automatically activates tabs with ArrowLeft, ArrowRight, Home, and End", () => {
        renderDetailView(kind);
        const previewTab = screen.getByRole("tab", { name: "Preview" });
        const jsonTab = screen.getByRole("tab", { name: "JSON" });

        previewTab.focus();
        fireEvent.keyDown(previewTab, { key: "ArrowRight" });
        expect(document.activeElement).toBe(jsonTab);
        expect(jsonTab.getAttribute("aria-selected")).toBe("true");
        expect(jsonTab.tabIndex).toBe(0);

        fireEvent.keyDown(jsonTab, { key: "ArrowRight" });
        expect(document.activeElement).toBe(previewTab);
        expect(previewTab.getAttribute("aria-selected")).toBe("true");

        fireEvent.keyDown(previewTab, { key: "ArrowLeft" });
        expect(document.activeElement).toBe(jsonTab);
        expect(jsonTab.getAttribute("aria-selected")).toBe("true");

        fireEvent.keyDown(jsonTab, { key: "Home" });
        expect(document.activeElement).toBe(previewTab);
        expect(previewTab.getAttribute("aria-selected")).toBe("true");

        fireEvent.keyDown(previewTab, { key: "End" });
        expect(document.activeElement).toBe(jsonTab);
        expect(jsonTab.getAttribute("aria-selected")).toBe("true");
    });
});
