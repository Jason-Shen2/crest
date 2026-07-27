// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { streamAnthropic } from "./anthropic";

describe("Anthropic stream termination", () => {
    it("treats message_stop without a stop reason as an error", async () => {
        const events = [
            {
                type: "message_start",
                message: {
                    id: "msg_test",
                    type: "message",
                    role: "assistant",
                    content: [],
                    model: "claude-test",
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 1, output_tokens: 0 },
                },
            },
            { type: "message_stop" },
        ];
        const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
        const client = {
            messages: {
                create: () => ({
                    asResponse: async () =>
                        new Response(body, {
                            status: 200,
                            headers: { "content-type": "text/event-stream" },
                        }),
                }),
            },
        } as unknown as Anthropic;

        const stream = streamAnthropic(
            {
                provider: "anthropic",
                id: "claude-test",
                name: "Claude Test",
                api: "anthropic-messages",
                baseUrl: "https://api.anthropic.com",
                reasoning: false,
                contextWindow: 100_000,
                maxTokens: 4_000,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
            {
                systemPrompt: "",
                messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
                tools: [],
            },
            { client }
        );

        const result = await stream.result();
        expect(result.stopReason).toBe("error");
        expect(result.errorMessage).toBe("Anthropic stream ended without a stop reason");
    });
});
