// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolFallback, getToolFallbackInitialExpanded, renderToolFallbackPreview } from "./tool-fallback";

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

function findElementByType(element: unknown, type: string): any {
    if (!element || typeof element !== "object") return undefined;
    const node = element as { type?: unknown; props?: { children?: unknown } };
    if (node.type === type) return node;
    const children = node.props?.children;
    if (Array.isArray(children)) {
        for (const child of children) {
            const found = findElementByType(child, type);
            if (found) return found;
        }
        return undefined;
    }
    return findElementByType(children, type);
}

function hasDataAttribute(element: unknown, name: string, value: string): boolean {
    if (!element || typeof element !== "object") return false;
    const node = element as { props?: Record<string, unknown> };
    if (node.props?.[name] === value) return true;
    const children = node.props?.children;
    if (Array.isArray(children)) return children.some((child) => hasDataAttribute(child, name, value));
    return hasDataAttribute(children, name, value);
}

afterEach(() => {
    vi.doUnmock("react");
});

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

    it("renders status.error when an incomplete error has no result", () => {
        const html = renderToStaticMarkup(
            <ToolFallback
                {...toolProps({
                    status: { type: "incomplete", reason: "error", error: "tool crashed before returning a result" },
                })}
            />
        );

        expect(html).toContain('data-assistant-tool-status="error"');
        expect(html).toContain('data-assistant-tool-detail-section="result"');
        expect(html).toContain("tool crashed before returning a result");
    });

    it("toggles collapsed and expanded detail when the header button is clicked", async () => {
        vi.resetModules();
        let stateInitialized = false;
        let expandedState = false;
        vi.doMock("react", async () => {
            const actual = await vi.importActual<typeof import("react")>("react");
            return {
                ...actual,
                memo: <T,>(component: T) => component,
                useEffect: () => {},
                useMemo: (factory: () => unknown) => factory(),
                useState: (initial: boolean | (() => boolean)) => {
                    if (!stateInitialized) {
                        expandedState = typeof initial === "function" ? initial() : initial;
                        stateInitialized = true;
                    }
                    return [
                        expandedState,
                        (next: boolean | ((value: boolean) => boolean)) => {
                            expandedState = typeof next === "function" ? next(expandedState) : next;
                        },
                    ];
                },
            };
        });
        const { ToolFallback: InteractiveToolFallback } = await import("./tool-fallback");
        const props = toolProps({ status: { type: "complete" }, result: "finished" });

        const collapsed = InteractiveToolFallback(props);
        const collapseButton = findElementByType(collapsed, "button");
        expect(collapseButton.props["aria-expanded"]).toBe(false);
        expect(hasDataAttribute(collapsed, "data-assistant-tool-detail", "call-1")).toBe(false);

        collapseButton.props.onClick();
        const expanded = InteractiveToolFallback(props);
        const expandButton = findElementByType(expanded, "button");
        expect(expandButton.props["aria-expanded"]).toBe(true);
        expect(hasDataAttribute(expanded, "data-assistant-tool-detail", "call-1")).toBe(true);

        expandButton.props.onClick();
        const collapsedAgain = InteractiveToolFallback(props);
        const collapsedAgainButton = findElementByType(collapsedAgain, "button");
        expect(collapsedAgainButton.props["aria-expanded"]).toBe(false);
        expect(hasDataAttribute(collapsedAgain, "data-assistant-tool-detail", "call-1")).toBe(false);
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
