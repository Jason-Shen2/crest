// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import type { PropsWithChildren, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

function mockAssistantUi(messages: Array<{ role: "user" | "assistant" | "system" }>, isEmpty: boolean) {
    vi.doMock("@assistant-ui/react", () => ({
        ThreadPrimitive: {
            Root: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>,
            Viewport: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>,
            Empty: ({ children }: PropsWithChildren) => (isEmpty ? <>{children}</> : null),
            Messages: ({ children }: { children: (value: { message: { role: string } }) => ReactNode }) => (
                <>{messages.map((message, index) => <span key={index}>{children({ message })}</span>)}</>
            ),
        },
        MessagePrimitive: {
            Root: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>,
            Parts: () => null,
        },
        makeAssistantToolUI: (config: unknown) => config,
        useAuiState: () => false,
    }));
    vi.doMock("@assistant-ui/react-markdown", () => ({
        MarkdownTextPrimitive: () => <div />,
    }));
}

afterEach(() => {
    vi.doUnmock("@assistant-ui/react");
    vi.doUnmock("@assistant-ui/react-markdown");
    vi.resetModules();
});

describe("CrestThread", () => {
    it("renders the empty state when there are no messages", async () => {
        mockAssistantUi([], true);
        const { CrestThread } = await import("./crest-thread");
        const html = renderToStaticMarkup(<CrestThread />);

        expect(html).toContain("Start a conversation with Crest");
    });

    it("selects user and assistant message layouts through the ThreadPrimitive.Messages children API", async () => {
        mockAssistantUi([{ role: "user" }, { role: "assistant" }], false);
        const { CrestThread } = await import("./crest-thread");
        const html = renderToStaticMarkup(<CrestThread />);

        expect(html).toContain('data-testid="crest-user-message"');
        expect(html).toContain('data-testid="crest-assistant-message"');
    });
});
