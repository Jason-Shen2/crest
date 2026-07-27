// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const openAIMocks = vi.hoisted(() => ({
    create: vi.fn(),
}));

vi.mock("openai", () => ({
    default: vi.fn(() => ({
        responses: {
            create: openAIMocks.create,
        },
    })),
}));

import { streamOpenAIResponses } from "./openai-responses";

describe("OpenAI Responses stream termination", () => {
    it("treats a stream ending without a stop reason as an error", async () => {
        openAIMocks.create.mockReturnValue({
            withResponse: async () => ({
                data: (async function* () {})(),
                response: { status: 200, headers: new Headers() },
            }),
        });

        const stream = streamOpenAIResponses(
            {
                provider: "openai",
                id: "gpt-test",
                name: "GPT Test",
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
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
            { apiKey: "test-key" }
        );

        const result = await stream.result();
        expect(result.stopReason).toBe("error");
        expect(result.errorMessage).toBe("OpenAI Responses stream ended without a stop reason");
    });
});
