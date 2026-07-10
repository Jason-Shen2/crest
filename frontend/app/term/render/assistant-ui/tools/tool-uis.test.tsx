// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { afterEach, describe, expect, it, vi } from "vitest";

function toolProps(overrides: Partial<ToolCallMessagePartProps> = {}): ToolCallMessagePartProps {
    return {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_text_file",
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

describe("assistant-ui specialized tool UIs", () => {
    it("covers planned read, write, shell, and web tool names", async () => {
        const { AssistantToolUIs, assistantToolRenderersByName, getAssistantToolRenderer } = await import("./index");

        expect(getAssistantToolRenderer("read_text_file")).toBe(assistantToolRenderersByName.read_text_file);
        expect(getAssistantToolRenderer("functions.read_text_file")).toBe(assistantToolRenderersByName["functions.read_text_file"]);
        expect(getAssistantToolRenderer("edit_text_file")).toBe(assistantToolRenderersByName.edit_text_file);
        expect(getAssistantToolRenderer("functions.apply_patch")).toBe(assistantToolRenderersByName["functions.apply_patch"]);
        expect(getAssistantToolRenderer("bash")).toBe(assistantToolRenderersByName.bash);
        expect(getAssistantToolRenderer("functions.exec_command")).toBe(assistantToolRenderersByName["functions.exec_command"]);
        expect(getAssistantToolRenderer("web_fetch")).toBe(assistantToolRenderersByName.web_fetch);
        expect(getAssistantToolRenderer("functions.web_fetch")).toBe(assistantToolRenderersByName["functions.web_fetch"]);
        expect(getAssistantToolRenderer("unknown_tool")).toBeUndefined();
        expect(AssistantToolUIs.length).toBe(Object.keys(assistantToolRenderersByName).length);
    });

    it("renders file read running, complete, and error states", async () => {
        const { getAssistantToolRenderer } = await import("./index");
        const ReadRenderer = getAssistantToolRenderer("read_text_file")!;
        const running = renderToStaticMarkup(<ReadRenderer {...toolProps({ status: { type: "running" } })} />);
        const complete = renderToStaticMarkup(
            <ReadRenderer {...toolProps({ status: { type: "complete" }, result: { content: [{ type: "text", text: "hello" }] } })} />
        );
        const error = renderToStaticMarkup(
            <ReadRenderer
                {...toolProps({
                    status: { type: "incomplete", reason: "error", error: "read failed" },
                    isError: true,
                    result: "read failed",
                })}
            />
        );

        expect(running).toContain('data-assistant-tool-kind="file-read"');
        expect(running).toContain('data-assistant-tool-status="running"');
        expect(running).toContain('aria-expanded="true"');
        expect(complete).toContain('data-assistant-tool-status="complete"');
        expect(complete).toContain('aria-expanded="false"');
        expect(error).toContain('data-assistant-tool-status="error"');
        expect(error).toContain("read failed");
    });

    it("renders write, shell, and web summaries from current ToolCallMessagePartProps args", async () => {
        const { getAssistantToolRenderer } = await import("./index");
        const WriteRenderer = getAssistantToolRenderer("edit_text_file")!;
        const ShellRenderer = getAssistantToolRenderer("functions.exec_command")!;
        const WebRenderer = getAssistantToolRenderer("web_fetch")!;

        const writeHtml = renderToStaticMarkup(
            <WriteRenderer {...toolProps({ toolName: "edit_text_file", args: { file_path: "src/app.ts", oldText: "a", newText: "b" } })} />
        );
        const shellHtml = renderToStaticMarkup(
            <ShellRenderer {...toolProps({ toolName: "functions.exec_command", args: { cmd: "npm test -- --run tool-uis.test.tsx" } })} />
        );
        const webHtml = renderToStaticMarkup(
            <WebRenderer {...toolProps({ toolName: "web_fetch", args: { url: "https://example.com/docs" } })} />
        );

        expect(writeHtml).toContain('data-assistant-tool-kind="file-write"');
        expect(writeHtml).toContain("src/app.ts");
        expect(shellHtml).toContain('data-assistant-tool-kind="shell"');
        expect(shellHtml).toContain("npm test -- --run tool-uis.test.tsx");
        expect(webHtml).toContain('data-assistant-tool-kind="web"');
        expect(webHtml).toContain("https://example.com/docs");
    });

    it("toggles completed specialized tools from collapsed to expanded detail", async () => {
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
        const { ToolDisclosureContent } = await import("./tool-ui-shared");
        const props = {
            toolCallId: "call-1",
            kind: "web" as const,
            status: "complete" as const,
            title: "Fetch web",
            summary: "https://example.com",
            renderDetails: () => <div data-assistant-tool-detail-section="result">result</div>,
        };

        const collapsed = ToolDisclosureContent(props);
        const collapseButton = findElementByType(collapsed, "button");
        expect(collapseButton.props["aria-expanded"]).toBe(false);
        expect(hasDataAttribute(collapsed, "data-assistant-tool-detail", "call-1")).toBe(false);

        collapseButton.props.onClick();
        const expanded = ToolDisclosureContent(props);
        const expandButton = findElementByType(expanded, "button");
        expect(expandButton.props["aria-expanded"]).toBe(true);
        expect(hasDataAttribute(expanded, "data-assistant-tool-detail", "call-1")).toBe(true);
    });

    it("truncates long text previews", async () => {
        const { renderToolTextPreview } = await import("./tool-ui-shared");
        const preview = renderToolTextPreview("x".repeat(10_000));

        expect(preview.length).toBeLessThan(7_000);
        expect(preview).toContain("[truncated]");
    });

    it("does not stringify huge complete results while collapsed", async () => {
        const { getAssistantToolRenderer } = await import("./index");
        const { getToolInitialExpanded } = await import("./tool-ui-shared");
        const result = {
            toJSON() {
                throw new Error("collapsed result should not be stringified");
            },
        };
        const Renderer = getAssistantToolRenderer("functions.exec_command")!;

        expect(getToolInitialExpanded({ status: { type: "complete" }, isError: false })).toBe(false);
        expect(() =>
            renderToStaticMarkup(<Renderer {...toolProps({ toolName: "functions.exec_command", status: { type: "complete" }, result })} />)
        ).not.toThrow();
    });
});
