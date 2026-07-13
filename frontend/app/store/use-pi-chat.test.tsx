// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for usePiChat's pure reducer. The hook itself needs React
// rendering (renderHook from @testing-library/react), which is not
// installed in crest yet — when it is, add the hook-lifecycle tests
// from the wiring task (see the doc comment at the top of
// use-pi-chat.ts). The reducer is the load-bearing logic; getting it
// right covers most of the "did I write the hook correctly" question.

import { describe, expect, it } from "vitest";

import {
    adoptInitialSessionMetadata,
    getOptimisticAbortStatus,
    type PiAgentMessage,
    reducePiChatEvent,
    reducePiTurnsEvent,
    resolveAbortSessionPath,
} from "./use-pi-chat";

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
