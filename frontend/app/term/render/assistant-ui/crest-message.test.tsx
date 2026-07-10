// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import type { PropsWithChildren, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageStatus, ToolCallMessagePartProps } from "@assistant-ui/react";

type TestPart = { type: string; [key: string]: unknown };

function mockAssistantUi(parts: TestPart[], messageStatus: MessageStatus = { type: "complete", reason: "stop" }) {
    vi.doMock("@assistant-ui/react", () => ({
        MessagePrimitive: {
            Root: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>,
            Parts: ({ children }: { children: (value: { part: TestPart }) => ReactNode }) => (
                <>{parts.map((part, index) => <span key={index}>{children({ part })}</span>)}</>
            ),
        },
        makeAssistantToolUI: (config: unknown) => config,
        useAuiState: (selector: (state: { message: { status: MessageStatus } }) => unknown) =>
            selector({ message: { status: messageStatus } }),
    }));
    vi.doMock("@assistant-ui/react-markdown", () => ({
        MarkdownTextPrimitive: ({ className }: { className?: string }) => (
            <div className={className} data-markdown-primitive="true">
                <h2>Markdown Title</h2>
                <p>
                    This is <strong>bold</strong> text.
                </p>
            </div>
        ),
    }));
}

function toolProps(overrides: Partial<ToolCallMessagePartProps> = {}): ToolCallMessagePartProps {
    return {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_text_file",
        args: { path: "frontend/app.tsx" },
        argsText: JSON.stringify({ path: "frontend/app.tsx" }),
        status: { type: "complete" },
        addResult: () => {},
        resume: () => {},
        respondToApproval: () => {},
        ...overrides,
    } as ToolCallMessagePartProps;
}

afterEach(() => {
    vi.doUnmock("@assistant-ui/react");
    vi.doUnmock("@assistant-ui/react-markdown");
    vi.resetModules();
});

describe("Crest message rendering", () => {
    it("renders user messages separately from assistant messages", async () => {
        mockAssistantUi([{ type: "text", text: "hello crest" }]);
        const { CrestUserMessage, CrestAssistantMessage } = await import("./crest-message");

        const userHtml = renderToStaticMarkup(<CrestUserMessage />);
        mockAssistantUi([{ type: "text", text: "hello human" }]);
        const assistantHtml = renderToStaticMarkup(<CrestAssistantMessage />);

        expect(userHtml).toContain('data-testid="crest-user-message"');
        expect(userHtml).toContain("hello crest");
        expect(assistantHtml).toContain('data-testid="crest-assistant-message"');
        expect(assistantHtml).toContain("AI");
        expect(assistantHtml).toContain('data-markdown-primitive="true"');
    });

    it("renders assistant text parts with @assistant-ui/react-markdown", async () => {
        mockAssistantUi([{ type: "text", text: "## Markdown Title\n\nThis is **bold** text." }]);
        const { CrestAssistantMessage } = await import("./crest-message");
        const html = renderToStaticMarkup(<CrestAssistantMessage />);

        expect(html).toContain('data-markdown-primitive="true"');
        expect(html).toContain("<h2>Markdown Title</h2>");
        expect(html).toContain("<strong>bold</strong>");
    });

    it("expands running reasoning parts and collapses completed reasoning parts", async () => {
        mockAssistantUi([{ type: "reasoning", text: "still thinking", status: { type: "running" } }], { type: "running" });
        const { CrestAssistantMessage } = await import("./crest-message");
        const runningHtml = renderToStaticMarkup(<CrestAssistantMessage />);

        vi.doUnmock("@assistant-ui/react");
        vi.doUnmock("@assistant-ui/react-markdown");
        vi.resetModules();
        mockAssistantUi([{ type: "reasoning", text: "done thinking", status: { type: "complete" } }]);
        const { CrestAssistantMessage: CompletedAssistantMessage } = await import("./crest-message");
        const completeHtml = renderToStaticMarkup(<CompletedAssistantMessage />);

        expect(runningHtml).toContain('data-testid="crest-reasoning-running" open="">');
        expect(completeHtml).toContain('data-testid="crest-reasoning-complete"');
        expect(completeHtml).not.toContain('data-testid="crest-reasoning-complete" open="">');
    });

    it("uses specialized tool renderers and ToolFallback for unmatched tool calls", async () => {
        mockAssistantUi([]);
        const { getCrestToolRenderer } = await import("./crest-message");
        const ReadRenderer = getCrestToolRenderer("read_text_file");
        const FallbackRenderer = getCrestToolRenderer("unknown_tool");
        const readHtml = renderToStaticMarkup(<ReadRenderer {...toolProps({ toolCallId: "call-read" })} />);
        const fallbackHtml = renderToStaticMarkup(
            <FallbackRenderer {...toolProps({ toolCallId: "call-unknown", toolName: "unknown_tool" })} />
        );

        expect(readHtml).toContain('data-assistant-tool-kind="file-read"');
        expect(fallbackHtml).toContain('data-assistant-tool-fallback="call-unknown"');
    });
});
