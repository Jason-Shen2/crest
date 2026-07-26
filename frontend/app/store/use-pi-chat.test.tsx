// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
//
// Tests for usePiChat's reducers and subscription lifecycle.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type {
    RenderedExtensionEntryNode,
    WidgetNode,
} from "../../../emain/agent/extensions/pi-gui/crest/widget-tree";

import {
    adoptInitialSessionMetadata,
    getOptimisticAbortStatus,
    type PiAgentMessage,
    type PiExtUiState,
    makeEmptyPiExtUiState,
    reducePiChatEvent,
    reducePiExtUiEvent,
    reducePiTurnsEvent,
    resolveAbortSessionPath,
    shouldReducePiExtUiSubscriptionEvent,
    usePiChat,
} from "./use-pi-chat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("reducePiChatEvent", () => {
    it("appends a user message_start", () => {
        const user: PiAgentMessage = { role: "user", content: [{ type: "text", text: "hi" }] };
        const out = reducePiChatEvent([], { type: "message_start", message: user });
        expect(out).toEqual([user]);
    });

    it("replaces the tail on message_update (streaming message state)", () => {
        const user: PiAgentMessage = { role: "user", content: [{ type: "text", text: "hi" }] };
        const partial: PiAgentMessage = {
            role: "assistant",
            content: [{ type: "text", text: "th" }],
        };
        const fuller: PiAgentMessage = {
            role: "assistant",
            content: [{ type: "text", text: "there" }],
        };
        const after1 = reducePiChatEvent([user], { type: "message_start", message: partial });
        const after2 = reducePiChatEvent(after1, { type: "message_update", message: fuller });
        expect(after2[after2.length - 1]).toEqual(fuller);
        expect(after2[0]).toEqual(user);
        expect(after2).toHaveLength(2);
    });

    it("message_end replaces the tail with the final message", () => {
        const partial: PiAgentMessage = {
            role: "assistant",
            content: [{ type: "text", text: "p" }],
        };
        const final: PiAgentMessage = {
            role: "assistant",
            content: [{ type: "text", text: "full" }],
            stopReason: "stop",
        };
        const after1 = reducePiChatEvent([], { type: "message_start", message: partial });
        const after2 = reducePiChatEvent(after1, { type: "message_end", message: final });
        expect(after2).toEqual([final]);
    });

    it("agent_end does NOT replace the transcript (its messages are turn-scoped)", () => {
        // agent_end.messages carries only the latest turn's messages, not the
        // whole conversation. The message_start/_end stream already appended
        // this turn's messages, so the reducer leaves state untouched.
        const accumulated: PiAgentMessage[] = [
            { role: "user", content: [{ type: "text", text: "q1" }] },
            { role: "assistant", content: [{ type: "text", text: "a1" }] },
            { role: "user", content: [{ type: "text", text: "q2" }] },
            { role: "assistant", content: [{ type: "text", text: "a2" }] },
        ];
        const runScoped: PiAgentMessage[] = [
            { role: "user", content: [{ type: "text", text: "q2" }] },
            { role: "assistant", content: [{ type: "text", text: "a2" }] },
        ];
        const out = reducePiChatEvent(accumulated, { type: "agent_end", messages: runScoped });
        expect(out).toBe(accumulated);
    });

    it("queue_update leaves the message array untouched (queue is separate state)", () => {
        const existing: PiAgentMessage[] = [{ role: "user", content: [{ type: "text", text: "q" }] }];
        const out = reducePiChatEvent(existing, {
            type: "queue_update",
            steer: [],
            followUp: [{ role: "user", content: [{ type: "text", text: "queued" }] }],
        });
        expect(out).toBe(existing);
    });

    it("session_state seeds the mirror with main's authoritative transcript", () => {
        // Sent once on (re)subscribe. A renderer that missed the first
        // turn's events (subscribed late) must back-fill from this. Replaces
        // local state wholesale.
        const authoritative: PiAgentMessage[] = [
            { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1000 },
            { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" },
        ];
        const out = reducePiChatEvent([], { type: "session_state", messages: authoritative });
        expect(out).toEqual(authoritative);
    });

    it("handles message_start on empty state without crashing", () => {
        const msg: PiAgentMessage = { role: "user", content: [] };
        expect(reducePiChatEvent([], { type: "message_start", message: msg })).toEqual([msg]);
    });

    it("handles message_update on empty state by seeding the message", () => {
        const msg: PiAgentMessage = { role: "assistant", content: [{ type: "text", text: "x" }] };
        expect(reducePiChatEvent([], { type: "message_update", message: msg })).toEqual([msg]);
    });

    it("returns the same reference for events with missing required payload", () => {
        const start: PiAgentMessage[] = [{ role: "user", content: [] }];
        expect(reducePiChatEvent(start, { type: "message_update" })).toBe(start);
        expect(reducePiChatEvent(start, { type: "agent_end" })).toBe(start);
    });

    it("returns the same reference for unknown event types", () => {
        const start: PiAgentMessage[] = [{ role: "user", content: [] }];
        expect(reducePiChatEvent(start, { type: "tool_execution_start" })).toBe(start);
        expect(reducePiChatEvent(start, { type: "something_we_dont_handle" })).toBe(start);
    });

    it("ignores legacy snapshot events", () => {
        const start: PiAgentMessage[] = [{ role: "user", content: [{ type: "text", text: "current" }] }];
        const legacy: PiAgentMessage[] = [{ role: "user", content: [{ type: "text", text: "legacy" }] }];

        expect(reducePiChatEvent(start, { type: "snapshot", messages: legacy })).toBe(start);
    });
});

describe("reducePiExtUiEvent", () => {
    it("replaces extension UI and clears the active request from session_state", () => {
        const oldWidget: WidgetNode = {
            kind: "text",
            id: "old-widget",
            text: "old widget",
            paddingx: 0,
            paddingy: 0,
        };
        const oldHeader: WidgetNode = { ...oldWidget, id: "old-header", text: "old header" };
        const oldFooter: WidgetNode = { ...oldWidget, id: "old-footer", text: "old footer" };
        const oldEntry: RenderedExtensionEntryNode = {
            id: "old-entry",
            customtype: "checkpoint",
            source: "message",
            widget: oldWidget,
        };
        const previous: PiExtUiState = {
            statuses: { stale: "old" },
            widgets: { stale: ["old"] },
            widgetnodes: { stale: oldWidget },
            renderedEntries: [oldEntry],
            header: oldHeader,
            footer: oldFooter,
            request: { requestId: "old-request", kind: "confirm", title: "Old" },
        };
        const newWidget: WidgetNode = { ...oldWidget, id: "new-widget", text: "new widget" };
        const newHeader: WidgetNode = { ...oldWidget, id: "new-header", text: "new header" };
        const newEntry: RenderedExtensionEntryNode = {
            id: "new-entry",
            customtype: "result",
            source: "entry",
            widget: newWidget,
        };

        const next = reducePiExtUiEvent(previous, {
            type: "session_state",
            extensionUi: {
                statuses: { fresh: "new" },
                widgets: {},
                widgetnodes: { fresh: newWidget },
                header: newHeader,
            },
            renderedEntries: [newEntry],
        });

        expect(next).toEqual({
            statuses: { fresh: "new" },
            widgets: {},
            widgetnodes: { fresh: newWidget },
            renderedEntries: [newEntry],
            header: newHeader,
            footer: undefined,
            request: null,
        });
    });

    it("removes all prior extension UI when session_state replays empty state", () => {
        const widget: WidgetNode = {
            kind: "text",
            id: "stale-widget",
            text: "stale",
            paddingx: 0,
            paddingy: 0,
        };
        const previous: PiExtUiState = {
            statuses: { stale: "old" },
            widgets: { stale: ["old"] },
            widgetnodes: { stale: widget },
            renderedEntries: [{ id: "stale-entry", customtype: "checkpoint", source: "entry", widget }],
            header: widget,
            footer: widget,
            request: { requestId: "old-request", kind: "input", title: "Old" },
        };

        const next = reducePiExtUiEvent(previous, {
            type: "session_state",
            extensionUi: {},
        });

        expect(next).toEqual(makeEmptyPiExtUiState());
    });

    it("applies extension UI deltas to the replayed baseline without reviving stale keys", () => {
        const staleWidget = {
            kind: "text" as const,
            id: "stale-widget",
            text: "stale",
            paddingx: 0,
            paddingy: 0,
        };
        const freshWidget = { ...staleWidget, id: "fresh-widget", text: "fresh" };
        const previous: PiExtUiState = {
            statuses: { stale: "old" },
            widgets: { stale: ["old"] },
            widgetnodes: { stale: staleWidget },
            renderedEntries: [],
            request: null,
        };
        const replayed = reducePiExtUiEvent(previous, {
            type: "session_state",
            extensionUi: {
                statuses: { fresh: "new" },
                widgetnodes: { fresh: freshWidget },
            },
        });
        const withStatusDelta = reducePiExtUiEvent(replayed, {
            type: "ext_ui_status",
            key: "latest",
            text: "running",
        });
        const withWidgetDelta = reducePiExtUiEvent(withStatusDelta, {
            type: "ext_ui_widget",
            key: "log",
            lines: ["line 1"],
        });

        expect(withWidgetDelta).toEqual({
            statuses: { fresh: "new", latest: "running" },
            widgets: { log: ["line 1"] },
            widgetnodes: { fresh: freshWidget },
            renderedEntries: [],
            header: undefined,
            footer: undefined,
            request: null,
        });
    });

    it("normalizes malformed session_state fields without throwing", () => {
        const widget: WidgetNode = {
            kind: "text",
            id: "valid-widget",
            text: "valid",
            paddingx: 0,
            paddingy: 0,
        };
        const entry: RenderedExtensionEntryNode = {
            id: "valid-entry",
            customtype: "checkpoint",
            source: "entry",
            widget,
        };

        const next = reducePiExtUiEvent(makeEmptyPiExtUiState(), {
            type: "session_state",
            extensionUi: {
                statuses: { valid: "ready", number: 42 },
                widgets: { valid: ["line"], mixed: ["line", 42], scalar: 42 },
                widgetnodes: { valid: widget, missingId: { kind: "text" }, nil: null },
                header: "not-a-widget",
                footer: widget,
            },
            renderedEntries: [entry, null, { id: "bad", customtype: 42, source: "entry", widget }],
        });

        expect(next).toEqual({
            statuses: { valid: "ready" },
            widgets: { valid: ["line"] },
            widgetnodes: { valid: widget },
            renderedEntries: [entry],
            header: undefined,
            footer: widget,
            request: null,
        });
    });

    it("deep-copies replayed extension UI and rendered entries", () => {
        const child: WidgetNode = {
            kind: "text",
            id: "child",
            text: "original",
            paddingx: 0,
            paddingy: 0,
        };
        const container: WidgetNode = {
            kind: "container",
            id: "container",
            paddingx: 0,
            paddingy: 0,
            children: [child],
        };
        const lines = ["original"];
        const entry: RenderedExtensionEntryNode = {
            id: "entry",
            customtype: "checkpoint",
            source: "entry",
            widget: container,
        };
        const event = {
            type: "session_state",
            extensionUi: {
                widgets: { log: lines },
                widgetnodes: { panel: container },
                header: container,
            },
            renderedEntries: [entry],
        };

        const next = reducePiExtUiEvent(makeEmptyPiExtUiState(), event);
        lines[0] = "mutated";
        child.text = "mutated";
        entry.id = "mutated";

        expect(next.widgets.log).toEqual(["original"]);
        expect(next.widgetnodes.panel).toMatchObject({
            children: [expect.objectContaining({ text: "original" })],
        });
        expect(next.header).toMatchObject({
            children: [expect.objectContaining({ text: "original" })],
        });
        expect(next.renderedEntries[0]).toMatchObject({
            id: "entry",
            widget: { children: [expect.objectContaining({ text: "original" })] },
        });
    });

    it("stores custom widget requests from extension UI events", () => {
        const out = reducePiExtUiEvent(makeEmptyPiExtUiState(), {
            type: "ext_ui_request",
            requestId: "r1",
            request: {
                kind: "custom",
                widget: {
                    kind: "text",
                    id: "w1",
                    text: "native gui",
                    paddingx: 0,
                    paddingy: 0,
                },
                options: { anchor: "center" },
            },
        });

        expect(out.request).toEqual({
            requestId: "r1",
            kind: "custom",
            widget: {
                kind: "text",
                id: "w1",
                text: "native gui",
                paddingx: 0,
                paddingy: 0,
            },
            options: { anchor: "center" },
        });
    });

    it("updates the active custom widget request from extension UI update events", () => {
        const initial = reducePiExtUiEvent(makeEmptyPiExtUiState(), {
            type: "ext_ui_request",
            requestId: "r1",
            request: {
                kind: "custom",
                widget: {
                    kind: "terminal",
                    id: "terminal-1",
                    lines: ["count:0"],
                },
            },
        });

        const out = reducePiExtUiEvent(initial, {
            type: "ext_ui_request_update",
            requestId: "r1",
            widget: {
                kind: "terminal",
                id: "terminal-1",
                lines: ["count:1"],
            },
        });

        expect(out.request).toEqual({
            requestId: "r1",
            kind: "custom",
            widget: {
                kind: "terminal",
                id: "terminal-1",
                lines: ["count:1"],
            },
        });
    });

    it("stores semantic widget, header, and footer events", () => {
        const textWidget = {
            kind: "text" as const,
            id: "w1",
            text: "semantic widget",
            paddingx: 0,
            paddingy: 0,
        };
        const headerWidget = { ...textWidget, id: "h1", text: "header gui" };
        const footerWidget = { ...textWidget, id: "f1", text: "footer gui" };

        const withWidget = reducePiExtUiEvent(makeEmptyPiExtUiState(), {
            type: "ext_ui_widget",
            key: "summary",
            widget: textWidget,
        });
        const withHeader = reducePiExtUiEvent(withWidget, { type: "ext_ui_header", widget: headerWidget });
        const withFooter = reducePiExtUiEvent(withHeader, { type: "ext_ui_footer", widget: footerWidget });

        expect(withFooter.widgetnodes.summary).toEqual(textWidget);
        expect(withFooter.header).toEqual(headerWidget);
        expect(withFooter.footer).toEqual(footerWidget);
    });

    it("mirrors rendered extension entries from session_state", () => {
        const widget = {
            kind: "text" as const,
            id: "entry-widget",
            text: "rendered entry",
            paddingx: 0,
            paddingy: 0,
        };

        const out = reducePiExtUiEvent(makeEmptyPiExtUiState(), {
            type: "session_state",
            renderedEntries: [{ id: "entry-1", customtype: "checkpoint", source: "entry", widget }],
        });

        expect(out.renderedEntries).toEqual([{ id: "entry-1", customtype: "checkpoint", source: "entry", widget }]);
    });
});

describe("usePiChat session replay", () => {
    it("returns the widget event handled promise from the agent API", async () => {
        const respondWidgetEvent = vi.fn(async () => ({ handled: true, published: false }));
        const subscribe = vi.fn(() => () => {});
        (window as unknown as { api: unknown }).api = {
            agent: {
                subscribe,
                respondWidgetEvent,
            },
        };
        let latest: ReturnType<typeof usePiChat>;
        const container = document.createElement("div");
        const root = createRoot(container);

        function TestComponent() {
            latest = usePiChat({
                initialSession: { path: "/tmp/session.jsonl" } as AgentSessionMeta,
                paneContext: { cwd: "/tmp" },
                modelSelection: { provider: "test", model: "test" },
            });
            return null;
        }

        try {
            await act(async () => {
                root.render(<TestComponent />);
                await Promise.resolve();
            });
            const event: AgentWidgetEvent = {
                nodeid: "input",
                type: "change",
                eventid: "event-1",
                payload: { value: "next", selectionstart: 4, selectionend: 4 },
            };

            await expect(latest.respondWidgetEvent(event)).resolves.toEqual({
                handled: true,
                published: false,
            });
            expect(respondWidgetEvent).toHaveBeenCalledWith("/tmp/session.jsonl", event);
        } finally {
            await act(async () => root.unmount());
            delete (window as unknown as { api?: unknown }).api;
        }
    });

    it("uses subscribe as the only replay channel so a late pull cannot roll state back", async () => {
        const getSessionState = vi.fn(() => new Promise<never>(() => {}));
        let subscriptionCallback: (event: unknown) => void = () => {};
        const subscribe = vi.fn((_path: string, callback: (event: unknown) => void) => {
            subscriptionCallback = callback;
            return () => {};
        });
        (window as unknown as { api: unknown }).api = {
            agent: {
                getSessionState,
                subscribe,
            },
        };
        let latest: ReturnType<typeof usePiChat>;
        const container = document.createElement("div");
        const root = createRoot(container);

        function TestComponent() {
            latest = usePiChat({
                initialSession: { path: "/tmp/session.jsonl" } as AgentSessionMeta,
                paneContext: { cwd: "/tmp" },
                modelSelection: { provider: "test", model: "test" },
            });
            return null;
        }

        try {
            await act(async () => {
                root.render(<TestComponent />);
                await Promise.resolve();
            });

            expect(subscribe).toHaveBeenCalledOnce();
            expect(getSessionState).not.toHaveBeenCalled();

            act(() => {
                subscriptionCallback({
                    type: "session_state",
                    extensionUi: { statuses: { build: "fresh" } },
                    renderedEntries: [],
                    messages: [],
                    turns: [],
                    status: "idle",
                    steer: [],
                    followUp: [],
                });
            });

            expect(latest.extUi.statuses).toEqual({ build: "fresh" });
        } finally {
            await act(async () => root.unmount());
            delete (window as unknown as { api?: unknown }).api;
        }
    });
});

describe("shouldReducePiExtUiSubscriptionEvent", () => {
    it("includes live custom widget update events from the subscription stream", () => {
        expect(shouldReducePiExtUiSubscriptionEvent("ext_ui_request_update")).toBe(true);
    });

    it("excludes notify because notifications are routed as toasts", () => {
        expect(shouldReducePiExtUiSubscriptionEvent("ext_ui_notify")).toBe(false);
    });
});

describe("reducePiTurnsEvent", () => {
    it("keeps the same turn reference for events without main-owned turns", () => {
        const turns = [
            {
                turnId: "turn-owned",
                userMessage: { role: "user", content: [] } as PiAgentMessage,
                responseMessages: [],
                status: "streaming" as const,
            },
        ];

        expect(reducePiTurnsEvent(turns, { type: "message_start", message: turns[0].userMessage })).toBe(turns);
    });

    it("mirrors main-owned turns from session_state", () => {
        const userMessage = { role: "user", content: [{ type: "text", text: "q" }] } as PiAgentMessage;
        const assistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "a" }],
            stopReason: "stop",
        } as PiAgentMessage;

        const turns = [
            {
                turnId: "entry-xyz",
                userMessage,
                responseMessages: [assistantMessage],
                status: "done" as const,
            },
        ];

        const out = reducePiTurnsEvent([], {
            type: "session_state",
            turns: [
                {
                    turnId: "entry-xyz",
                    userMessage,
                    responseMessages: [assistantMessage],
                    status: "done",
                },
            ],
        });

        expect(out).toEqual(turns);
    });

    it("ignores legacy snapshot turn payloads", () => {
        const turns = [
            {
                turnId: "current",
                userMessage: { role: "user", content: [] } as PiAgentMessage,
                responseMessages: [],
                status: "streaming" as const,
            },
        ];

        expect(reducePiTurnsEvent(turns, { type: "snapshot", turns: [] })).toBe(turns);
    });
});

describe("resolveAbortSessionPath", () => {
    it("uses the active in-flight session path before React state commits metadata", () => {
        expect(resolveAbortSessionPath(undefined, "/tmp/agent.jsonl")).toBe("/tmp/agent.jsonl");
    });

    it("prefers committed session metadata over the in-flight path", () => {
        expect(
            resolveAbortSessionPath({ path: "/tmp/committed.jsonl" } as AgentSessionMeta, "/tmp/inflight.jsonl")
        ).toBe("/tmp/committed.jsonl");
    });
});

describe("getOptimisticAbortStatus", () => {
    it("unblocks a locally streaming renderer while waiting for the owner abort event", () => {
        expect(getOptimisticAbortStatus("streaming")).toBe("idle");
    });

    it("does not erase existing error state", () => {
        expect(getOptimisticAbortStatus("error")).toBe("error");
    });
});

describe("adoptInitialSessionMetadata", () => {
    it("adopts a session path that arrives after the hook mounted", () => {
        const incoming = { path: "/tmp/session.jsonl", id: "s1", cwd: "/tmp", createdAt: "" } as AgentSessionMeta;

        expect(adoptInitialSessionMetadata(undefined, incoming)).toBe(incoming);
    });

    it("keeps current session when no incoming session exists", () => {
        const current = { path: "/tmp/current.jsonl", id: "s1", cwd: "/tmp", createdAt: "" } as AgentSessionMeta;

        expect(adoptInitialSessionMetadata(current, undefined)).toBe(current);
    });
});
