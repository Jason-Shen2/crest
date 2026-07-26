// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { GoogleGenAI } from "@google/genai";
import { describe, expect, it } from "vitest";

import { toAnthropicCountParams } from "./anthropic";
import { buildGooglePayload, toGoogleCountParams } from "./google";
import { toOpenAIResponsesCountParams } from "./openai-responses";

describe("authoritative provider count schemas", () => {
    it("whitelists only Anthropic MessageCountTokensParams fields", () => {
        const params = toAnthropicCountParams({
            model: "claude",
            messages: [{ role: "user", content: "hello" }],
            system: "system",
            tools: [{ name: "tool" }],
            thinking: { type: "disabled" },
            output_config: { effort: "low" },
            max_tokens: 1024,
            temperature: 0.3,
            metadata: { user_id: "user" },
            stream: true,
        });

        expect(params).toEqual({
            model: "claude",
            messages: [{ role: "user", content: "hello" }],
            system: "system",
            tools: [{ name: "tool" }],
            thinking: { type: "disabled" },
            output_config: { effort: "low" },
        });
    });

    it("whitelists only OpenAI InputTokenCountParams fields and rejects unknown hook fields", () => {
        const params = toOpenAIResponsesCountParams({
            model: "gpt",
            input: [{ role: "user", content: "hello" }],
            instructions: "system",
            tools: [{ type: "function", name: "tool" }],
            reasoning: { effort: "high" },
            max_output_tokens: 1024,
            temperature: 0.3,
            stream: true,
            store: false,
        });
        expect(params).toEqual({
            model: "gpt",
            input: [{ role: "user", content: "hello" }],
            instructions: "system",
            tools: [{ type: "function", name: "tool" }],
            reasoning: { effort: "high" },
        });
        expect(() => toOpenAIResponsesCountParams({ model: "gpt", input: [], hook_token_field: "x" })).toThrow(
            /unsupported/
        );
    });

    it("rejects Google Developer API count payloads whose system or tools would be omitted", () => {
        const signal = new AbortController().signal;
        expect(() =>
            toGoogleCountParams(
                {
                    model: "gemini",
                    contents: [{ role: "user", parts: [{ text: "hello" }] }],
                    config: {
                        systemInstruction: "system",
                        tools: [{ functionDeclarations: [{ name: "tool" }] }],
                        maxOutputTokens: 1024,
                        temperature: 0.3,
                        thinkingConfig: { thinkingBudget: 1024 },
                    },
                },
                signal
            )
        ).toThrow(/systemInstruction/);
        expect(() =>
            toGoogleCountParams({
                model: "gemini",
                contents: [{ role: "user", parts: [{ text: "hello" }] }],
                config: { tools: [{ functionDeclarations: [{ name: "tool" }] }] },
            })
        ).toThrow(/tools/);
        expect(
            toGoogleCountParams(
                {
                    model: "gemini",
                    contents: [{ role: "user", parts: [{ text: "hello" }] }],
                    config: { maxOutputTokens: 1024, temperature: 0.3, thinkingConfig: { thinkingBudget: 1024 } },
                },
                signal
            )
        ).toEqual({
            model: "gemini",
            contents: [{ role: "user", parts: [{ text: "hello" }] }],
            config: { abortSignal: signal },
        });
    });

    it("exercises the installed Google SDK conversion that rejects system and tools on Gemini API", async () => {
        const client = new GoogleGenAI({ apiKey: "test" });
        await expect(
            client.models.countTokens({
                model: "gemini",
                contents: [{ role: "user", parts: [{ text: "hello" }] }],
                config: { systemInstruction: "system" },
            })
        ).rejects.toThrow("systemInstruction parameter is not supported in Gemini API");
        await expect(
            client.models.countTokens({
                model: "gemini",
                contents: [{ role: "user", parts: [{ text: "hello" }] }],
                config: { tools: [{ functionDeclarations: [{ name: "tool", parametersJsonSchema: {} }] }] },
            })
        ).rejects.toThrow("tools parameter is not supported in Gemini API");
    });

    it("keeps Google transport AbortSignal outside the canonical provider payload", () => {
        const signal = new AbortController().signal;
        const payload = buildGooglePayload(
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
            { signal }
        ) as { config?: Record<string, unknown> };

        expect(payload.config).not.toHaveProperty("abortSignal");
        expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    });
});
