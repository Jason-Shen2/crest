// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { type AssistantMessage, type Model, type UserMessage } from "@crest/ai";
import { AssistantMessageEventStream } from "@crest/ai/utils/event-stream";
import { runAgentLoop } from "./agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "./types";

function fakeModel(): Model<any> {
    return {
        id: "fake-model",
        name: "Fake Model",
        api: "fake-api",
        provider: "fake-provider",
        baseUrl: "http://localhost",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 1000,
    };
}

function user(text: string): UserMessage {
    return {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
    };
}

function assistant(model: Model<any>, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason,
        timestamp: Date.now(),
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    };
}

function streamResult(message: AssistantMessage): AssistantMessageEventStream {
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
        stream.push({ type: "done", reason: message.stopReason, message });
    }
    return stream;
}

function context(): AgentContext {
    return {
        systemPrompt: "test",
        messages: [],
        tools: [],
    };
}

function config(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
    return {
        model: fakeModel(),
        convertToLlm: (messages) => messages,
        ...overrides,
    };
}

async function waitFor(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("condition was not reached");
}

describe("agent loop user-message seam", () => {
    it("awaits each initial and next-turn user message before it enters context", async () => {
        const first = user("queued");
        const second = user("prompt");
        const events: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const streamFn = vi.fn((_model, llmContext) => {
            events.push(
                `provider:${llmContext.messages
                    .filter((message: AgentMessage) => message.role === "user")
                    .map((message: UserMessage) => message.content[0].type === "text" && message.content[0].text)
                    .join(",")}`
            );
            return streamResult(assistant(fakeModel()));
        });
        const run = runAgentLoop(
            [first, second],
            context(),
            config({
                beforeUserMessage: async (message) => {
                    events.push(message === first ? "before:queued" : "before:prompt");
                    if (message === first) await gate;
                },
            }),
            async (event) => {
                if (event.type === "message_end" && event.message.role === "user") {
                    events.push(event.message === first ? "end:queued" : "end:prompt");
                }
            },
            undefined,
            streamFn
        );

        await waitFor(() => events.length > 0);
        expect(events).toEqual(["before:queued"]);
        expect(streamFn).not.toHaveBeenCalled();

        release();
        await run;

        expect(events).toEqual([
            "before:queued",
            "end:queued",
            "before:prompt",
            "end:prompt",
            "provider:queued,prompt",
        ]);
    });

    it("awaits steering and follow-up messages before adding them to context", async () => {
        const initial = user("initial");
        const steering = user("steering");
        const followUp = user("follow-up");
        const before: UserMessage[] = [];
        let steeringDrain = 0;
        let followUpDrain = 0;
        const streamFn = vi
            .fn()
            .mockImplementationOnce(() => streamResult(assistant(fakeModel())))
            .mockImplementationOnce(() => streamResult(assistant(fakeModel())))
            .mockImplementationOnce(() => streamResult(assistant(fakeModel())));

        await runAgentLoop(
            [initial],
            context(),
            config({
                beforeUserMessage: async (message) => {
                    before.push(message);
                },
                getSteeringMessages: async () => (steeringDrain++ === 0 ? [steering] : []),
                getFollowUpMessages: async () => (followUpDrain++ === 0 ? [followUp] : []),
            }),
            async () => {},
            undefined,
            streamFn
        );

        expect(before).toEqual([initial, steering, followUp]);
        expect(streamFn).toHaveBeenCalledTimes(2);
    });
});
