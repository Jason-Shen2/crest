// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ToolFallback } from "./tool-fallback";

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
    it("renders running tools with official fallback trigger shimmer", () => {
        const html = renderToStaticMarkup(<ToolFallback {...toolProps({ status: { type: "running" } })} />);

        expect(html).toContain('data-slot="tool-fallback-root"');
        expect(html).toContain("aui-tool-fallback-root");
        expect(html).toContain('data-slot="tool-fallback-trigger"');
        expect(html).toContain('data-slot="tool-fallback-trigger-icon"');
        expect(html).toContain('data-slot="tool-fallback-trigger-label"');
        expect(html).toContain('data-slot="tool-fallback-trigger-shimmer"');
        expect(html).toContain('data-slot="tool-fallback-trigger-chevron"');
        expect(html).not.toContain('data-slot="tool-fallback-args"');
    });

    it("defaults completed tools collapsed", () => {
        const html = renderToStaticMarkup(
            <ToolFallback {...toolProps({ status: { type: "complete" }, result: { ok: true } })} />
        );

        expect(html).toContain('data-slot="tool-fallback-root"');
        expect(html).toContain('data-slot="tool-fallback-trigger"');
        expect(html).toContain('data-slot="tool-fallback-content"');
        expect(html).toContain('data-state="closed"');
        expect(html).not.toContain('data-slot="tool-fallback-result"');
    });

    it("keeps incomplete errors collapsed while exposing official trigger state", () => {
        const html = renderToStaticMarkup(
            <ToolFallback
                {...toolProps({
                    status: { type: "incomplete", reason: "error", error: "boom" },
                    isError: true,
                    result: "boom",
                })}
            />
        );

        expect(html).toContain('data-slot="tool-fallback-root"');
        expect(html).toContain('data-slot="tool-fallback-trigger"');
        expect(html).toContain('data-state="closed"');
        expect(html).not.toContain('data-slot="tool-fallback-result"');
        expect(html).not.toContain("boom");
    });

    it("renders requires-action content and status errors with official slots", () => {
        const html = renderToStaticMarkup(
            <ToolFallback
                {...toolProps({
                    status: { type: "requires-action", reason: "interrupt" },
                    interrupt: {
                        type: "human",
                        payload: "tool crashed before returning a result",
                    } as ToolCallMessagePartProps["interrupt"],
                    result: "tool crashed before returning a result",
                })}
            />
        );

        expect(html).toContain('data-slot="tool-fallback-content"');
        expect(html).toContain('data-slot="tool-fallback-args"');
        expect(html).toContain('data-slot="tool-fallback-result"');
        expect(html).toContain('data-slot="tool-fallback-approval"');
        expect(html).toContain("tool crashed before returning a result");
    });

    it("does not stringify result values while collapsed", () => {
        const result = {
            toJSON() {
                throw new Error("collapsed result should not be stringified");
            },
        };

        expect(() =>
            renderToStaticMarkup(<ToolFallback {...toolProps({ status: { type: "complete" }, result })} />)
        ).not.toThrow();
    });
});
