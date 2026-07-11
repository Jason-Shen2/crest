// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    AssistantRuntimeProvider,
    useExternalStoreRuntime,
    type ExternalStoreAdapter,
    type ThreadMessageLike,
} from "@assistant-ui/react";
import type { FC, PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Thread } from "./registry-thread";

const messages: ThreadMessageLike[] = [
    {
        role: "user",
        content: [
            { type: "text", text: "show this picture" },
            { type: "image", image: "https://example.com/user.png", filename: "user-upload.png" },
        ],
    },
    {
        role: "assistant",
        content: [
            { type: "text", text: "## Markdown Title\n\nThis is **bold** text." },
            { type: "image", image: "https://example.com/assistant.png" },
            {
                type: "tool-call",
                toolCallId: "call-read",
                toolName: "read_text_file",
                args: { path: "frontend/app.tsx" },
                argsText: JSON.stringify({ path: "frontend/app.tsx" }),
            },
        ],
        status: { type: "complete", reason: "stop" },
    },
];

const RuntimeProvider: FC<PropsWithChildren> = ({ children }) => {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
        messages,
        convertMessage: (message) => message,
        onNew: async () => {},
    } satisfies ExternalStoreAdapter<ThreadMessageLike>);

    return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
};

function renderThread(): string {
    return renderToStaticMarkup(
        <RuntimeProvider>
            <Thread />
        </RuntimeProvider>
    );
}

describe("Thread assistant-ui integration", () => {
    it("renders real Thread/Parts/Markdown/tool UI and image alt text without mocking assistant-ui packages", () => {
        const html = renderThread();

        expect(html).toContain("aui-root aui-thread-root");
        expect(html).toContain('data-testid="crest-thread"');
        expect(html).toContain('class="aui-md"');
        expect(html).toContain(">Markdown Title</h2>");
        expect(html).toContain("aui-md-strong");
        expect(html).toContain(">bold</strong>");
        expect(html).toContain("data-slot=\"tool-group-root\"");
        expect(html).toContain("alt=\"user-upload.png\"");
        expect(html).toContain("alt=\"Assistant image attachment\"");
        expect(html).toContain("aui-composer-root");
        expect(html).toContain('data-slot="aui_composer-shell"');
    });
});
