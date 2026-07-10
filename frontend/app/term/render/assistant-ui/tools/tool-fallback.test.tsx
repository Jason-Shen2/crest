// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";

import {
    ToolFallback,
    getToolFallbackInitialExpanded,
    renderToolFallbackPreview,
} from "./tool-fallback";

function toolProps(overrides: Partial<ToolCallMessagePartProps> = {}): ToolCallMessagePartProps {
    return {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_file",
        args: { path: "frontend/app.tsx" },
        argsText: JSON.stringify({ path: "frontend/app.tsx" }),
        status: { type: "running" },
        addResult: () => {},
        resume: () => {},
        respondToApproval: () => {},
        ...overrides,
    } as ToolCallMessagePartProps;
}

describe("ToolFallback", () => {
    it("defaults running tools expanded", () => {
        const html = renderToStaticMarkup(<ToolFallback {...toolProps({ status: { type: "running" } })} />);

        expect(html).toContain('data-assistant-tool-fallback="call-1"');
        expect(html).toContain('data-assistant-tool-status="running"');
        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain('data-assistant-tool-detail="call-1"');
    });

    it("defaults completed tools collapsed", () => {
        const html = renderToStaticMarkup(
            <ToolFallback {...toolProps({ status: { type: "complete" }, result: { ok: true } })} />
        );

        expect(html).toContain('data-assistant-tool-status="complete"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain('data-assistant-tool-detail="call-1"');
    });

    it("marks error tool calls with red styling and expands them", () => {
        const html = renderToStaticMarkup(
            <ToolFallback
                {...toolProps({
                    status: { type: "incomplete", reason: "error", error: "boom" },
                    isError: true,
                    result: "boom",
                })}
            />
        );

        expect(html).toContain('data-assistant-tool-status="error"');
        expect(html).toContain("border-rose-500");
        expect(html).toContain("text-rose-300");
        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain("boom");
    });

    it("truncates long result previews", () => {
        const preview = renderToolFallbackPreview("x".repeat(10_000));

        expect(preview.length).toBeLessThan(7_000);
        expect(preview).toContain("[truncated]");
    });

    it("does not stringify result values while collapsed", () => {
        const result = {
            toJSON() {
                throw new Error("collapsed result should not be stringified");
            },
        };

        expect(getToolFallbackInitialExpanded({ status: { type: "complete" }, isError: false })).toBe(false);
        expect(() =>
            renderToStaticMarkup(<ToolFallback {...toolProps({ status: { type: "complete" }, result })} />)
        ).not.toThrow();
    });
});
