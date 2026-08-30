// @vitest-environment jsdom

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import {
    AssistantRuntimeProvider,
    useExternalStoreRuntime,
    type ExternalStoreAdapter,
    type QuoteInfo,
    type ThreadMessageLike,
} from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FC, PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TurnChangesContext, type TurnChangesContextValue } from "@/app/agent/rewind/turn-changes-context";
import { Thread, __testing as registryThreadTesting, type ThreadProps } from "./registry-thread";

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: vi.fn(),
    });
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

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
            { type: "reasoning", text: "Inspect the UI state before answering." },
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

const RuntimeProvider: FC<
    PropsWithChildren<{
        messages?: ThreadMessageLike[];
        composerQuote?: QuoteInfo;
        isRunning?: boolean;
        isLoading?: boolean;
    }>
> = ({ children, composerQuote, messages: runtimeMessages = messages, isRunning, isLoading = false }) => {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
        messages: runtimeMessages,
        isRunning,
        isLoading,
        convertMessage: (message) => message,
        onNew: async () => {},
    } satisfies ExternalStoreAdapter<ThreadMessageLike>);
    runtime.thread.composer.setQuote(composerQuote);

    return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
};

function renderThread(props?: ThreadProps, runtimeMessages?: ThreadMessageLike[]): string {
    return renderToStaticMarkup(
        <RuntimeProvider messages={runtimeMessages}>
            <Thread {...props} />
        </RuntimeProvider>
    );
}

function renderThreadWithComposerQuote(props?: ThreadProps): string {
    return renderToStaticMarkup(
        <RuntimeProvider
            composerQuote={{
                text: "The runtime system follows a layered architecture",
                messageId: "assistant-quote-source",
            }}
        >
            <Thread {...props} />
        </RuntimeProvider>
    );
}

function renderEmptyThread(props?: ThreadProps): string {
    return renderToStaticMarkup(
        <RuntimeProvider messages={[]}>
            <Thread {...props} />
        </RuntimeProvider>
    );
}

function renderLoadingThread(props?: ThreadProps): string {
    return renderToStaticMarkup(
        <RuntimeProvider messages={[]} isLoading>
            <Thread {...props} />
        </RuntimeProvider>
    );
}

describe("Thread assistant-ui integration", () => {
    it("renders checkpoint-backed turn changes after a completed assistant message and routes immutable file intent", async () => {
        const openReview = vi.fn();
        const openMutation = vi.fn();
        const onOpenTurnDiff = vi.fn();
        const turnChanges: TurnChangesContextValue = {
            cards: new Map([
                [
                    "turn-card",
                    {
                        summary: {
                            turnId: "turn-card",
                            semanticLeafId: "leaf-1",
                            fileCount: 1,
                            additions: 4,
                            deletions: 2,
                            files: [
                                {
                                    path: "frontend/app/card.tsx",
                                    operation: "write",
                                    additions: 4,
                                    deletions: 2,
                                },
                            ],
                        },
                        action: "undo",
                        disabled: false,
                    },
                ],
            ]),
            openReview,
            openMutation,
        };

        render(
            <RuntimeProvider
                messages={[
                    {
                        role: "assistant",
                        content: [{ type: "text", text: "Done." }],
                        status: { type: "complete", reason: "stop" },
                        metadata: { custom: { turnId: "turn-card" } },
                    } as ThreadMessageLike,
                ]}
            >
                <TurnChangesContext.Provider value={turnChanges}>
                    <Thread onOpenTurnDiff={onOpenTurnDiff} />
                </TurnChangesContext.Provider>
            </RuntimeProvider>
        );

        expect(screen.getByText("已编辑 1 个文件")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: /card\.tsx/ }));
        fireEvent.click(screen.getByRole("button", { name: "审核" }));
        fireEvent.click(screen.getByRole("button", { name: /撤销/ }));
        expect(onOpenTurnDiff).toHaveBeenCalledWith("turn-card", "frontend/app/card.tsx");
        expect(openReview).toHaveBeenCalledWith("turn-card");
        expect(openMutation).toHaveBeenCalledWith("turn-card");
    });

    it("renders a loading state instead of the welcome view while history hydrates", () => {
        const html = renderLoadingThread();

        expect(html).toContain('data-slot="aui_thread-loading"');
        expect(html).toContain("Loading conversation…");
        expect(html).not.toContain("How can I help you today?");
    });

    it("discovers /session and /info while keeping /resume hidden", () => {
        const byId = new Map(registryThreadTesting.SlashCommands.map((command) => [command.id, command]));

        expect(byId.get("session")).toMatchObject({
            label: "/session",
            icon: "History",
            description: expect.stringMatching(/manage|resume|reference/i),
        });
        expect(byId.get("info")).toMatchObject({
            label: "/info",
            icon: "Info",
            description: expect.stringMatching(/current.*session.*information/i),
        });
        expect(byId.get("rewind")).toEqual({
            id: "rewind",
            label: "/rewind",
            icon: "RotateCcw",
            description: "Revert conversation and workspace to an earlier turn",
        });
        expect(byId.get("redo")).toEqual({
            id: "redo",
            label: "/redo",
            icon: "RotateCw",
            description: "Restore the most recently reverted conversation and files",
        });
        expect(registryThreadTesting.SlashIconMap.RotateCcw).toBeTypeOf("object");
        expect(registryThreadTesting.SlashIconMap.RotateCw).toBeTypeOf("object");
        expect(byId.has("resume")).toBe(false);
    });

    it("writes persisted turn ids onto user messages", () => {
        const html = renderThread(undefined, [
            {
                role: "user",
                content: [{ type: "text", text: "rewind target" }],
                metadata: { custom: { turnId: "turn-[special]-1" } },
            } as ThreadMessageLike,
        ]);

        expect(html).toContain('data-agent-turn-id="turn-[special]-1"');
        expect(html).toContain('tabindex="-1"');
    });

    it("shows a keyboard-accessible Revert action only for an eligible persisted user turn", async () => {
        const onRevertTurn = vi.fn();
        render(
            <RuntimeProvider
                messages={[
                    {
                        role: "user",
                        content: [{ type: "text", text: "eligible rewind target" }],
                        metadata: { custom: { turnId: "turn-eligible" } },
                    } as ThreadMessageLike,
                    {
                        role: "user",
                        content: [{ type: "text", text: "not eligible" }],
                        metadata: { custom: { turnId: "turn-unavailable" } },
                    } as ThreadMessageLike,
                    {
                        role: "user",
                        content: [{ type: "text", text: "missing metadata" }],
                    } as ThreadMessageLike,
                ]}
            >
                <Thread rewindableTurnIds={new Set(["turn-eligible"])} onRevertTurn={onRevertTurn} />
            </RuntimeProvider>
        );

        const revert = screen.getByRole("button", { name: "Revert" });
        expect(revert.getAttribute("aria-label")).toBe("Revert");
        fireEvent.focus(revert);
        expect((await screen.findByRole("tooltip")).textContent).toBe("Revert");
        fireEvent.click(revert);
        expect(onRevertTurn).toHaveBeenCalledOnce();
        expect(onRevertTurn).toHaveBeenCalledWith("turn-eligible");
    });

    it("hides Revert while rewind work is busy", () => {
        const html = renderThread(
            {
                rewindableTurnIds: new Set(["turn-eligible"]),
                rewindBusy: true,
                onRevertTurn: vi.fn(),
            },
            [
                {
                    role: "user",
                    content: [{ type: "text", text: "eligible rewind target" }],
                    metadata: { custom: { turnId: "turn-eligible" } },
                } as ThreadMessageLike,
            ]
        );

        expect(html).not.toContain(">Revert<");
        expect(html).not.toContain('aria-label="Revert"');
    });

    it("hides Revert while the thread is running", () => {
        const { container } = render(
            <RuntimeProvider
                isRunning
                messages={[
                    {
                        role: "user",
                        content: [{ type: "text", text: "eligible rewind target" }],
                        metadata: { custom: { turnId: "turn-eligible" } },
                    } as ThreadMessageLike,
                ]}
            >
                <Thread rewindableTurnIds={new Set(["turn-eligible"])} onRevertTurn={vi.fn()} />
            </RuntimeProvider>
        );

        expect(container.querySelector('[aria-label="Revert"]')).toBeNull();
    });

    it("keeps the latest eligible action bar visible and older eligible actions hover-revealed", () => {
        const { container } = render(
            <RuntimeProvider
                messages={[
                    {
                        role: "user",
                        content: [{ type: "text", text: "older eligible" }],
                        metadata: { custom: { turnId: "turn-old" } },
                    } as ThreadMessageLike,
                    {
                        role: "user",
                        content: [{ type: "text", text: "latest eligible" }],
                        metadata: { custom: { turnId: "turn-latest" } },
                    } as ThreadMessageLike,
                ]}
            >
                <Thread rewindableTurnIds={new Set(["turn-old", "turn-latest"])} onRevertTurn={vi.fn()} />
            </RuntimeProvider>
        );

        const rows = container.querySelectorAll<HTMLElement>('[data-testid="crest-user-message"]');
        const oldBar = rows[0]?.querySelector<HTMLElement>(".aui-user-action-bar-root");
        const latestBar = rows[1]?.querySelector<HTMLElement>(".aui-user-action-bar-root");
        expect(oldBar?.className).toContain("group-hover/user-message:opacity-100");
        expect(latestBar?.className).toContain("opacity-100");
        expect(latestBar?.className).not.toContain("pointer-events-none");
    });

    it("reveals and focuses a matching user turn only inside the requested Thread root", async () => {
        const scrollIntoView = vi.fn();
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });
        const duplicatedTurn: ThreadMessageLike[] = [
            {
                role: "user",
                content: [{ type: "text", text: "same id in two surfaces" }],
                metadata: { custom: { turnId: "turn-[special]-1" } },
            } as ThreadMessageLike,
        ];
        const { container, rerender } = render(
            <div>
                <RuntimeProvider messages={duplicatedTurn}>
                    <Thread />
                </RuntimeProvider>
                <RuntimeProvider messages={duplicatedTurn}>
                    <Thread />
                </RuntimeProvider>
            </div>
        );

        rerender(
            <div>
                <RuntimeProvider messages={duplicatedTurn}>
                    <Thread />
                </RuntimeProvider>
                <RuntimeProvider messages={duplicatedTurn}>
                    <Thread revealTurnRequest={{ turnId: "turn-[special]-1", requestId: 1 }} />
                </RuntimeProvider>
            </div>
        );

        const targets = container.querySelectorAll<HTMLElement>('[data-agent-turn-id="turn-[special]-1"]');
        await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
        expect(document.activeElement).toBe(targets[1]);
        expect(document.activeElement).not.toBe(targets[0]);
    });

    it("retries the same reveal request when its target mounts after the request", async () => {
        const scrollIntoView = vi.fn();
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });
        const request = { turnId: "late-turn", requestId: 9 };
        const { container, rerender } = render(
            <RuntimeProvider messages={[]}>
                <Thread revealTurnRequest={request} />
            </RuntimeProvider>
        );

        rerender(
            <RuntimeProvider
                messages={[
                    {
                        role: "user",
                        content: [{ type: "text", text: "mounted later" }],
                        metadata: { custom: { turnId: "late-turn" } },
                    } as ThreadMessageLike,
                ]}
            >
                <Thread revealTurnRequest={request} />
            </RuntimeProvider>
        );

        const target = await waitFor(() => {
            const element = container.querySelector<HTMLElement>('[data-agent-turn-id="late-turn"]');
            expect(element).not.toBeNull();
            expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
            return element!;
        });
        expect(document.activeElement).toBe(target);
    });

    it("acknowledges a reveal only after the target is mounted, scrolled, and focused", async () => {
        const onRevealTurnComplete = vi.fn();
        const request = { turnId: "late-ack-turn", requestId: 10 };
        const { container, rerender } = render(
            <RuntimeProvider messages={[]}>
                <Thread {...({ revealTurnRequest: request, onRevealTurnComplete } as ThreadProps)} />
            </RuntimeProvider>
        );

        expect(onRevealTurnComplete).not.toHaveBeenCalled();

        rerender(
            <RuntimeProvider
                messages={[
                    {
                        role: "user",
                        content: [{ type: "text", text: "mounted for acknowledgement" }],
                        metadata: { custom: { turnId: "late-ack-turn" } },
                    } as ThreadMessageLike,
                ]}
            >
                <Thread {...({ revealTurnRequest: request, onRevealTurnComplete } as ThreadProps)} />
            </RuntimeProvider>
        );

        const target = await waitFor(() => {
            const element = container.querySelector<HTMLElement>('[data-agent-turn-id="late-ack-turn"]');
            expect(document.activeElement).toBe(element);
            return element!;
        });
        expect(target).not.toBeNull();
        expect(onRevealTurnComplete).toHaveBeenCalledOnce();
        expect(onRevealTurnComplete).toHaveBeenCalledWith(request);
    });

    it("actively remounts a requested turn that is present in runtime state but windowed out", async () => {
        const scrollIntoView = vi.fn();
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });
        const runtimeMessages = [
            {
                id: "windowed-user-message",
                role: "user",
                content: [{ type: "text", text: "windowed target" }],
                metadata: { custom: { turnId: "windowed-turn" } },
            } as ThreadMessageLike,
        ];
        const { container, rerender } = render(
            <RuntimeProvider messages={runtimeMessages}>
                <Thread />
            </RuntimeProvider>
        );
        const windowedTarget = container.querySelector<HTMLElement>('[data-agent-turn-id="windowed-turn"]')!;
        windowedTarget.hidden = true;

        rerender(
            <RuntimeProvider messages={runtimeMessages}>
                <Thread revealTurnRequest={{ turnId: "windowed-turn", requestId: 11 }} />
            </RuntimeProvider>
        );

        const target = await waitFor(() => {
            const element = container.querySelector<HTMLElement>('[data-agent-turn-id="windowed-turn"]');
            expect(element).not.toBeNull();
            expect(element).not.toBe(windowedTarget);
            expect(element?.hidden).toBe(false);
            expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
            return element!;
        });
        expect(document.activeElement).toBe(target);
    });

    it("completes a pending reveal when same-count metadata hydrates the turn id", async () => {
        const scrollIntoView = vi.fn();
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });
        const request = { turnId: "hydrated-turn", requestId: 12 };
        const { container, rerender } = render(
            <RuntimeProvider
                messages={[
                    {
                        id: "hydrating-user-message",
                        role: "user",
                        content: [{ type: "text", text: "metadata arrives later" }],
                        metadata: { custom: {} },
                    } as ThreadMessageLike,
                ]}
            >
                <Thread revealTurnRequest={request} />
            </RuntimeProvider>
        );

        rerender(
            <RuntimeProvider
                messages={[
                    {
                        id: "hydrating-user-message",
                        role: "user",
                        content: [{ type: "text", text: "metadata arrives later" }],
                        metadata: { custom: { turnId: "hydrated-turn" } },
                    } as ThreadMessageLike,
                ]}
            >
                <Thread revealTurnRequest={request} />
            </RuntimeProvider>
        );

        const target = await waitFor(() => {
            const element = container.querySelector<HTMLElement>('[data-agent-turn-id="hydrated-turn"]');
            expect(element).not.toBeNull();
            expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
            return element!;
        });
        expect(document.activeElement).toBe(target);
    });

    it("renders a persisted context projection before assistant content and omits it when absent", () => {
        const report = {
            schemaVersion: 1,
            transactionId: "transaction-1",
            targetTurnId: "turn-1",
            createdAt: "2026-07-23T00:00:00.000Z",
            contextWindow: 1000,
            effectiveOutputReserve: 100,
            inputLimit: 900,
            baseInputTokens: 100,
            finalInputTokens: 110,
            referenceTokens: 10,
            countAccuracy: "exact",
            overlaySha256: "projection-sha",
            items: [],
        } satisfies AgentContextProjectionReportView;
        const html = renderThread(undefined, [
            {
                role: "assistant",
                content: [{ type: "text", text: "Projected answer" }],
                status: { type: "complete", reason: "stop" },
                metadata: { custom: { contextProjection: report } },
            } as ThreadMessageLike,
        ]);

        expect(html).toContain("Show context projection details");
        expect(html).toContain("projection-sha");
        expect(html.indexOf("Show context projection details")).toBeLessThan(html.indexOf("Projected answer"));
        expect(renderThread(undefined, [messages[1]])).not.toContain("Show context projection details");
    });

    it("renders real Thread/Parts/Markdown/tool UI and image alt text without mocking assistant-ui packages", () => {
        const html = renderThread();

        expect(html).toContain("aui-root aui-thread-root");
        expect(html).toContain('data-testid="crest-thread"');
        expect(html).toContain("aui-md");
        expect(html).toContain(">Markdown Title</h2>");
        expect(html).toContain("aui-md-strong");
        expect(html).toContain(">bold</strong>");
        expect(html).toContain('data-slot="reasoning-root"');
        expect(html).toMatch(/data-slot="reasoning-root"[^>]*data-variant="ghost"/);
        expect(html).toContain('data-slot="tool-group-root"');
        expect(html).toContain('alt="user-upload.png"');
        expect(html).toContain('alt="Assistant image attachment"');
        expect(html).toContain("aui-composer-root");
        expect(html).toContain('data-slot="aui_composer-shell"');
    });

    it("renders an active quote preview inside the composer", () => {
        const html = renderThreadWithComposerQuote();

        expect(html).toContain("aui-composer-quote");
        expect(html).toContain("The runtime system follows a layered architecture");
        expect(html.indexOf("aui-composer-quote")).toBeLessThan(html.indexOf("aui-composer-input"));
        expect(html).toContain('aria-label="Dismiss quote"');
    });

    it("renders quote metadata above user message text", () => {
        const html = renderThread(undefined, [
            {
                role: "user",
                content: [{ type: "text", text: "Can you explain how the layers connect?" }],
                metadata: {
                    custom: {
                        quote: {
                            text: "The runtime system follows a layered architecture",
                            messageId: "assistant-quote-source",
                        },
                    },
                },
            } as ThreadMessageLike,
        ]);

        expect(html).toContain("aui-user-quote-block");
        expect(html).toContain("The runtime system follows a layered architecture");
        expect(html.indexOf("aui-user-quote-block")).toBeLessThan(
            html.indexOf("Can you explain how the layers connect?")
        );
    });

    it("renders assistant code fences through Streamdown", () => {
        const html = renderThread(undefined, [
            {
                role: "assistant",
                content: [{ type: "text", text: "```typescript\nconst answer: number = 42\n```" }],
                status: { type: "complete", reason: "stop" },
            },
        ]);

        expect(html).toContain("aui-md");
        expect(html).toContain("typescript");
        expect(html).toContain("const answer");
    });

    it("renders assistant diff fences with the local DiffViewer", () => {
        const html = renderThread(undefined, [
            {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: [
                            "最终 diff:",
                            "",
                            "```diff",
                            "--- a/frontend/app.tsx",
                            "+++ b/frontend/app.tsx",
                            "@@ -1,2 +1,2 @@",
                            "-old line",
                            "+new line",
                            "```",
                        ].join("\n"),
                    },
                ],
                status: { type: "complete", reason: "stop" },
            },
        ]);

        expect(html).toContain('data-slot="diff-viewer"');
        expect(html).toContain('data-slot="file-card-header"');
        expect(html).toContain('data-slot="file-card-collapse-icon"');
        expect(html).toContain("<diffs-container");
        expect(html).toContain("frontend/app.tsx");
    });

    it("renders a completed edit tool result as a diff file card", () => {
        const patch = [
            "diff --git a/src/app.ts b/src/app.ts",
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "@@ -1 +1 @@",
            "-old",
            "+new",
        ].join("\n");
        const html = renderThread(undefined, [
            {
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        toolCallId: "call-edit",
                        toolName: "edit",
                        args: { path: "src/app.ts", edits: [] },
                        argsText: JSON.stringify({ path: "src/app.ts", edits: [] }),
                        result: {
                            content: [{ type: "text", text: "ok" }],
                            details: {
                                patch,
                                changeOperation: { path: "src/app.ts" },
                            },
                        },
                        isError: false,
                    },
                ],
                status: { type: "complete", reason: "stop" },
            } as ThreadMessageLike,
        ]);

        expect(html).toContain('data-slot="diff-viewer"');
        expect(html).toContain("src/app.ts");
        expect(html).not.toContain("Used tool: <b>edit</b>");
    });

    it("renders a completed write tool result as a full-file card", () => {
        const html = renderThread(undefined, [
            {
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        toolCallId: "call-write",
                        toolName: "write",
                        args: { path: "src/new.ts", content: "export const value = 1;\n" },
                        argsText: JSON.stringify({ path: "src/new.ts", content: "export const value = 1;\n" }),
                        result: {
                            content: [{ type: "text", text: "ok" }],
                            details: {},
                        },
                        isError: false,
                    },
                ],
                status: { type: "complete", reason: "stop" },
            } as ThreadMessageLike,
        ]);

        expect(html).toContain('data-slot="write-file-card"');
        expect(html).toContain("src/new.ts");
        expect(html).toContain("export const value = 1");
    });

    it("coalesces adjacent read calls into one semantic Read activity", () => {
        const html = renderThread({ workspaceDir: "/repo", onOpenFile: () => {} }, [
            {
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        toolCallId: "read-1",
                        toolName: "read",
                        args: { path: "src/app.ts" },
                        argsText: "{}",
                    },
                    {
                        type: "tool-call",
                        toolCallId: "read-2",
                        toolName: "read",
                        args: { path: "src/util.ts" },
                        argsText: "{}",
                    },
                ],
                status: { type: "complete", reason: "stop" },
            } as ThreadMessageLike,
        ]);

        expect(html.match(/data-slot="tool-activity-read"/g) ?? []).toHaveLength(1);
        expect(html).toContain("app.ts and util.ts");
        expect(html).not.toContain("Used tool: <b>read</b>");
    });

    it("coalesces adjacent find and grep calls but text splits Search groups", () => {
        const html = renderThread(undefined, [
            {
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        toolCallId: "find-1",
                        toolName: "find",
                        args: { pattern: "*.md" },
                        argsText: "{}",
                    },
                    {
                        type: "tool-call",
                        toolCallId: "grep-1",
                        toolName: "grep",
                        args: { pattern: "TODO", glob: "*.ts" },
                        argsText: "{}",
                    },
                    { type: "text", text: "Checking another area." },
                    {
                        type: "tool-call",
                        toolCallId: "find-2",
                        toolName: "find",
                        args: { pattern: "*.json" },
                        argsText: "{}",
                    },
                ],
                status: { type: "complete", reason: "stop" },
            } as ThreadMessageLike,
        ]);

        expect(html.match(/data-slot="tool-activity-search"/g) ?? []).toHaveLength(2);
        expect(html).toContain("*.md");
        expect(html).toContain("TODO");
        expect(html).toContain("*.json");
    });

    it("leaves malformed semantic calls on the existing generic grouping path", () => {
        const group = (registryThreadTesting as any).groupCrestAssistantPart({
            type: "tool-call",
            toolCallId: "bad",
            toolName: "read",
            args: {},
            status: { type: "complete" },
        });

        expect(group).not.toContain("group-read-activity");
    });

    it("renders beforeComposer content directly above the composer", () => {
        const html = renderThread({ beforeComposer: <div data-testid="before-composer">Panel</div> });

        expect(html).toContain('data-testid="before-composer"');
        expect(html.indexOf('data-testid="before-composer"')).toBeLessThan(html.indexOf("aui-composer-root"));
        expect(html).toContain("aui-composer-before-panel-stack");
        expect(html).toContain("gap-2");
        expect(html).not.toContain("aui-composer-before-panel-overlay");
    });

    it("keeps beforeComposer in normal flow in the welcome empty state", () => {
        const html = renderEmptyThread({ beforeComposer: <div data-testid="before-composer">Panel</div> });

        expect(html).toContain('data-testid="before-composer"');
        expect(html.indexOf('data-testid="before-composer"')).toBeLessThan(html.indexOf("aui-composer-root"));
        expect(html).toContain("aui-composer-before-panel-stack");
        expect(html).not.toContain("aui-composer-before-panel-overlay");
    });

    it("hides scroll to bottom while a command attached panel is open", () => {
        const html = renderThread({
            beforeComposer: <div data-testid="before-composer">Panel</div>,
            hideScrollToBottom: true,
        } as ThreadProps & { hideScrollToBottom: boolean });

        expect(html).toContain('data-testid="before-composer"');
        expect(html).not.toContain("aui-thread-scroll-to-bottom");
    });

    it("renders local context usage ring in the composer action row", () => {
        const html = renderThread({
            modelLabel: "MiniMax-M3",
            contextDisplayValue: {
                effectiveInputTokens: 72000,
                inputCapacity: 128000,
                accuracy: "estimated",
                lifecycle: "ready",
            },
        } as ThreadProps);

        expect(html).toContain("aui-context-display-ring");
        expect(html).toContain("56%");
        expect(html).toContain("MiniMax-M3");
        expect(html).toContain("aui-composer-left-actions");
        expect(html).toContain("aui-composer-right-actions");
        expect(html).toMatch(/aui-composer-right-actions[^"]*"[^>]*>[\s\S]*MiniMax-M3[\s\S]*aui-context-display-ring/);
    });

    it("keeps slash command popover compact and glassy", () => {
        expect(registryThreadTesting.SlashCommandPopoverClassName).toContain("w-full");
        expect(registryThreadTesting.SlashCommandPopoverClassName).not.toContain("w-[min");
        expect(registryThreadTesting.SlashCommandPopoverClassName).toContain("bg-[rgba(34,34,36,0.62)]");
        expect(registryThreadTesting.SlashCommandPopoverClassName).toContain("backdrop-blur-2xl");
        expect(registryThreadTesting.SlashCommandPopoverClassName).not.toContain("linear-gradient");
        expect(registryThreadTesting.SlashCommandPopoverClassName).not.toContain("0.9");
        expect(registryThreadTesting.SlashCommandPopoverClassName).toContain("shadow-[0_10px_32px_-24px");
        expect(registryThreadTesting.SlashCommandPopoverClassName).toContain("overflow-hidden");
        expect(registryThreadTesting.SlashCommandPopoverClassName).not.toContain("overflow-y-auto");
        expect(registryThreadTesting.SlashCommandScrollAreaClassName).toContain("overflow-y-auto");
        expect(registryThreadTesting.SlashCommandScrollAreaClassName).toContain("[scrollbar-width:none]");
        expect(registryThreadTesting.SlashCommandScrollAreaClassName).toContain("data-[scrolling=true]");
        expect(registryThreadTesting.SlashCommandItemClassName).toContain("gap-2.5");
        expect(registryThreadTesting.SlashCommandItemClassName).toContain("py-2");
        expect(registryThreadTesting.SlashCommandItemClassName).toContain("text-sm");
        expect(registryThreadTesting.SlashCommandIconClassName).toContain("size-7");
        expect(registryThreadTesting.SlashCommandItemClassName).not.toContain("duration-100");
        expect(registryThreadTesting.SlashCommandIconClassName).not.toContain("transition-colors");
    });

    it("keeps the selection quote toolbar as a subtle icon-only glass chip", () => {
        expect(registryThreadTesting.SelectionToolbarRootClassName).toContain("rounded-[0.95rem]");
        expect(registryThreadTesting.SelectionToolbarRootClassName).toContain("bg-[rgba(24,24,26,0.46)]");
        expect(registryThreadTesting.SelectionToolbarRootClassName).toContain("backdrop-blur-xl");
        expect(registryThreadTesting.SelectionToolbarRootClassName).not.toContain("bg-popover");
        expect(registryThreadTesting.SelectionToolbarRootClassName).not.toContain("shadow-lg");

        expect(registryThreadTesting.SelectionToolbarQuoteClassName).toContain("size-7");
        expect(registryThreadTesting.SelectionToolbarQuoteClassName).toContain("cursor-pointer");
        expect(registryThreadTesting.SelectionToolbarQuoteClassName).toContain("active:scale-95");
        expect(registryThreadTesting.SelectionToolbarQuoteClassName).not.toContain("px-2.5");
        expect(registryThreadTesting.SelectionToolbarQuoteIconClassName).toContain("size-3.5");
    });

    it("keeps slash command keyboard scrolling stable at list edges", () => {
        const { getSlashCommandScrollTop } = registryThreadTesting;

        expect(
            getSlashCommandScrollTop({
                currentScrollTop: 0,
                maxScrollTop: 100,
                itemTop: 0,
                itemBottom: 32,
                viewportTop: 0,
                viewportBottom: 128,
                margin: 8,
            })
        ).toBeNull();
        expect(
            getSlashCommandScrollTop({
                currentScrollTop: 100,
                maxScrollTop: 100,
                itemTop: 196,
                itemBottom: 228,
                viewportTop: 100,
                viewportBottom: 228,
                margin: 8,
            })
        ).toBeNull();
        expect(
            getSlashCommandScrollTop({
                currentScrollTop: 0,
                maxScrollTop: 100,
                itemTop: 118,
                itemBottom: 150,
                viewportTop: 0,
                viewportBottom: 128,
                margin: 8,
            })
        ).toBe(30);
    });

    it("keeps assistant more menu styled as a compact menu item", () => {
        expect(registryThreadTesting.AssistantActionBarMoreContentClassName).toContain("min-w-[11rem]");
        expect(registryThreadTesting.AssistantActionBarMoreContentClassName).toContain("rounded-xl");
        expect(registryThreadTesting.AssistantActionBarMoreItemClassName).toContain("h-8");
        expect(registryThreadTesting.AssistantActionBarMoreItemClassName).toContain("border-0");
        expect(registryThreadTesting.AssistantActionBarMoreItemClassName).toContain("bg-transparent");
        expect(registryThreadTesting.AssistantActionBarMoreItemClassName).toContain("hover:bg-fg-overlay-1");
        expect(registryThreadTesting.AssistantActionBarMoreItemClassName).not.toContain("rounded-lg px-2.5 py-1.5");
        expect(registryThreadTesting.AssistantActionBarMoreIconClassName).toContain("size-3.5");
    });

    it("does not render reload when the external-store runtime cannot reload messages", () => {
        const html = renderThread();

        expect(html).not.toContain(">Refresh</span>");
    });

    it("does not render edit when the external-store runtime cannot edit messages", () => {
        const html = renderThread();

        expect(html).not.toContain(">Edit</span>");
    });

    it("keeps composer drag-and-drop recoverable after drop or window leave", () => {
        const { ComposerDropzoneShellClassName, getNextComposerDragDepth } = registryThreadTesting;

        expect(ComposerDropzoneShellClassName).toContain("data-[dragging=true]:border-dashed");
        expect(ComposerDropzoneShellClassName).toContain("data-[dragging=true]:bg-[color-mix");
        expect(getNextComposerDragDepth(0, "enter")).toBe(1);
        expect(getNextComposerDragDepth(1, "enter")).toBe(2);
        expect(getNextComposerDragDepth(2, "leave")).toBe(1);
        expect(getNextComposerDragDepth(1, "leave")).toBe(0);
        expect(getNextComposerDragDepth(4, "drop")).toBe(0);
        expect(getNextComposerDragDepth(4, "reset")).toBe(0);
    });
});
