// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const googleMocks = vi.hoisted(() => ({
    generateContentStream: vi.fn(),
}));

vi.mock("@google/genai", () => ({
    GoogleGenAI: vi.fn(() => ({
        models: {
            generateContentStream: googleMocks.generateContentStream,
        },
    })),
}));

import { streamGoogle } from "./google";

describe("Google transport options", () => {
    beforeEach(() => {
        googleMocks.generateContentStream.mockReset();
    });

    it("reattaches AbortSignal only after the payload hook and propagates cancellation", async () => {
        const controller = new AbortController();
        let abortObserved = false;
        let hookPayload: unknown;
        let preparedPayload: unknown;

        googleMocks.generateContentStream.mockImplementation(
            (params: { config?: { abortSignal?: AbortSignal } }) =>
                new Promise((_, reject) => {
                    params.config?.abortSignal?.addEventListener(
                        "abort",
                        () => {
                            abortObserved = true;
                            reject(new Error("transport aborted"));
                        },
                        { once: true }
                    );
                })
        );

        const stream = streamGoogle(
            {
                provider: "google",
                id: "gemini",
                name: "Gemini",
                api: "google-generative-ai",
                baseUrl: "https://generativelanguage.googleapis.com",
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
            {
                signal: controller.signal,
                onPayload: async (payload) => {
                    hookPayload = payload;
                    preparedPayload = JSON.parse(JSON.stringify(payload));
                    return preparedPayload;
                },
            }
        );

        await vi.waitFor(() => expect(googleMocks.generateContentStream).toHaveBeenCalledOnce());

        expect((hookPayload as { config?: Record<string, unknown> }).config).not.toHaveProperty("abortSignal");
        expect((preparedPayload as { config?: Record<string, unknown> }).config).not.toHaveProperty("abortSignal");

        const sentPayload = googleMocks.generateContentStream.mock.calls[0][0] as {
            config?: Record<string, unknown>;
        };
        expect(sentPayload.config?.abortSignal).toBe(controller.signal);
        const { abortSignal: _transportSignal, ...sentConfig } = sentPayload.config ?? {};
        expect({ ...sentPayload, config: sentConfig }).toEqual(preparedPayload);

        controller.abort();
        expect((await stream.result()).stopReason).toBe("aborted");
        expect(abortObserved).toBe(true);
    });

    it("treats a stream ending without a finish reason as an error", async () => {
        googleMocks.generateContentStream.mockResolvedValue(
            (async function* () {
                yield {
                    candidates: [
                        {
                            content: {
                                parts: [{ text: "partial" }],
                            },
                        },
                    ],
                };
            })()
        );

        const stream = streamGoogle(
            {
                provider: "google",
                id: "gemini",
                name: "Gemini",
                api: "google-generative-ai",
                baseUrl: "https://generativelanguage.googleapis.com",
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
        expect(result.errorMessage).toBe("Google stream ended without a finish reason");
    });
});
