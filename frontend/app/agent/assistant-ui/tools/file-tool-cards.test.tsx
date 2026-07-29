// @vitest-environment jsdom

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const pierreMocks = vi.hoisted(() => ({
    fileDiff: vi.fn((props: { fileDiff: { name: string } }) => (
        <div data-testid="pierre-file-diff" data-name={props.fileDiff.name} />
    )),
    multiFileDiff: vi.fn((_props: Record<string, unknown>) => <div data-testid="pierre-multi-file-diff" />),
}));

vi.mock("@pierre/diffs/react", () => ({
    FileDiff: pierreMocks.fileDiff,
    MultiFileDiff: pierreMocks.multiFileDiff,
}));

import { getCrestToolRenderer } from "../crest-message";
import { EditToolCard, WriteToolCard } from "./file-tool-cards";
import { ToolFallback } from "./tool-fallback";

const Patch = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
].join("\n");

function toolProps(overrides: Partial<ToolCallMessagePartProps> = {}): ToolCallMessagePartProps {
    return {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "edit",
        args: { path: "src/app.ts", edits: [] },
        argsText: JSON.stringify({ path: "src/app.ts", edits: [] }),
        status: { type: "complete" },
        addResult: () => {},
        resume: () => {},
        respondToApproval: () => {},
        ...overrides,
    } as ToolCallMessagePartProps;
}

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("file tool cards", () => {
    it("selects specialized renderers only for edit and write", () => {
        expect(getCrestToolRenderer("edit")).toBe(EditToolCard);
        expect(getCrestToolRenderer("write")).toBe(WriteToolCard);
        expect(getCrestToolRenderer("read")).toBe(ToolFallback);
    });

    it("renders a completed edit result as a diff card", () => {
        render(
            <EditToolCard
                {...toolProps({
                    result: {
                        content: [{ type: "text", text: "ok" }],
                        details: {
                            patch: Patch,
                            changeOperation: { path: "src/app.ts" },
                        },
                    },
                })}
            />
        );

        expect(screen.getByRole("button", { name: /src\/app\.ts/i })).toBeTruthy();
        expect(screen.getByTestId("pierre-file-diff")).toBeTruthy();
    });

    it("renders a completed write as a full-file card", () => {
        const { container } = render(
            <WriteToolCard
                {...toolProps({
                    toolName: "write",
                    args: { path: "src/new.ts", content: "export const value = 1;\n" },
                    argsText: JSON.stringify({ path: "src/new.ts", content: "export const value = 1;\n" }),
                    result: {
                        content: [{ type: "text", text: "ok" }],
                        details: {},
                    },
                })}
            />
        );

        expect(screen.getByRole("button", { name: /src\/new\.ts/i })).toBeTruthy();
        expect(screen.getByText(/export const value = 1/)).toBeTruthy();
        expect(container.querySelector('[data-slot="file-card-stats"]')).toBeNull();
    });

    it("falls back while an edit is still running", () => {
        const { container } = render(<EditToolCard {...toolProps({ status: { type: "running" }, result: undefined })} />);

        expect(container.querySelector('[data-slot="tool-fallback-root"]')).not.toBeNull();
        expect(container.querySelector('[data-slot="diff-viewer"]')).toBeNull();
    });

    it("falls back when an edit patch is malformed", () => {
        const { container } = render(
            <EditToolCard
                {...toolProps({
                    result: {
                        details: {
                            patch: "not a unified patch",
                            changeOperation: { path: "src/app.ts" },
                        },
                    },
                })}
            />
        );

        expect(container.querySelector('[data-slot="tool-fallback-root"]')).not.toBeNull();
        expect(container.querySelector('[data-slot="diff-viewer"]')).toBeNull();
    });
});
