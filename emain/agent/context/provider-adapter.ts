// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Api, Context, Message, Model } from "@crest/ai";
import { getEnvApiKey } from "@crest/ai/env-api-keys";
import {
    buildAnthropicPayload,
    countAnthropicPayload,
    getAnthropicReasoningOptions,
} from "@crest/ai/providers/anthropic";
import { buildGooglePayload, countGooglePayload, getGoogleReasoningOptions } from "@crest/ai/providers/google";
import {
    buildOpenAIResponsesPayload,
    countOpenAIResponsesPayload,
    getOpenAIResponsesReasoningOptions,
} from "@crest/ai/providers/openai-responses";
import type { AgentHarnessStreamOptions } from "../harness/types";
import type { AgentTool, ThinkingLevel } from "../types";
import type { ContextProviderRequest, ContextTokenCounter } from "./projector";

export interface ContextProviderAdapter {
    preparePayload(input: {
        model: Model<Api>;
        request: ContextProviderRequest;
        maxOutputTokens: number;
        requestOptions?: AgentHarnessStreamOptions;
    }): Promise<unknown>;
    tokenCounter: ContextTokenCounter;
}

const MiniMaxProviders = new Set(["minimax", "minimax-cn"]);

function supportsAnthropicTokenCounting(model: Model<Api>): boolean {
    if (model.api !== "anthropic-messages") return false;
    if (model.provider === "anthropic") return true;
    return MiniMaxProviders.has(model.provider) && model.id === "MiniMax-M3";
}

function providerContext(request: ContextProviderRequest): Context {
    return {
        systemPrompt: request.systemPrompt,
        messages: request.history as Message[],
        tools: request.tools as AgentTool[],
    };
}

function overlayContext(overlay: string): Context {
    return {
        systemPrompt: overlay,
        messages: [{ role: "user", content: [{ type: "text", text: "" }], timestamp: 0 }],
        tools: [],
    };
}

export function createContextProviderAdapter(
    model: Model<Api>,
    apiKey: string | undefined,
    thinkingLevel: ThinkingLevel | "off" = "off"
): ContextProviderAdapter | undefined {
    const resolvedApiKey = apiKey ?? getEnvApiKey(model.provider);
    if (supportsAnthropicTokenCounting(model) && resolvedApiKey) {
        return {
            preparePayload: async ({ request, maxOutputTokens, requestOptions }) =>
                buildAnthropicPayload(model as Model<"anthropic-messages">, providerContext(request), resolvedApiKey, {
                    ...requestOptions,
                    ...getAnthropicReasoningOptions(
                        model as Model<"anthropic-messages">,
                        thinkingLevel === "off" ? undefined : thinkingLevel,
                        maxOutputTokens
                    ),
                }),
            tokenCounter: {
                countFinalRequest: async ({ payload, signal }) => ({
                    inputTokens: await countAnthropicPayload(
                        model as Model<"anthropic-messages">,
                        payload,
                        resolvedApiKey,
                        signal
                    ),
                    accuracy: "exact",
                }),
                countContextOverlay: async ({ overlay, signal }) => ({
                    inputTokens: await countAnthropicPayload(
                        model as Model<"anthropic-messages">,
                        buildAnthropicPayload(
                            model as Model<"anthropic-messages">,
                            overlayContext(overlay),
                            resolvedApiKey,
                            {
                                ...getAnthropicReasoningOptions(
                                    model as Model<"anthropic-messages">,
                                    thinkingLevel === "off" ? undefined : thinkingLevel,
                                    1
                                ),
                            }
                        ),
                        resolvedApiKey,
                        signal
                    ),
                    accuracy: "conservative_upper_bound",
                }),
            },
        };
    }
    if (model.api === "openai-responses" && model.provider === "openai" && resolvedApiKey) {
        return {
            preparePayload: async ({ request, maxOutputTokens, requestOptions }) =>
                buildOpenAIResponsesPayload(model as Model<"openai-responses">, providerContext(request), {
                    ...requestOptions,
                    maxTokens: maxOutputTokens,
                    ...getOpenAIResponsesReasoningOptions(
                        model as Model<"openai-responses">,
                        thinkingLevel === "off" ? undefined : thinkingLevel
                    ),
                }),
            tokenCounter: {
                countFinalRequest: async ({ payload, signal }) => ({
                    inputTokens: await countOpenAIResponsesPayload(
                        model as Model<"openai-responses">,
                        payload,
                        resolvedApiKey,
                        signal
                    ),
                    accuracy: "exact",
                }),
                countContextOverlay: async ({ overlay, signal }) => ({
                    inputTokens: await countOpenAIResponsesPayload(
                        model as Model<"openai-responses">,
                        buildOpenAIResponsesPayload(model as Model<"openai-responses">, overlayContext(overlay), {
                            maxTokens: 1,
                            ...getOpenAIResponsesReasoningOptions(
                                model as Model<"openai-responses">,
                                thinkingLevel === "off" ? undefined : thinkingLevel
                            ),
                        }),
                        resolvedApiKey,
                        signal
                    ),
                    accuracy: "conservative_upper_bound",
                }),
            },
        };
    }
    if (model.api === "google-generative-ai" && model.provider === "google" && resolvedApiKey) {
        return {
            preparePayload: async ({ request, maxOutputTokens, requestOptions }) =>
                buildGooglePayload(model as Model<"google-generative-ai">, providerContext(request), {
                    ...requestOptions,
                    maxTokens: maxOutputTokens,
                    ...getGoogleReasoningOptions(
                        model as Model<"google-generative-ai">,
                        thinkingLevel === "off" ? undefined : thinkingLevel
                    ),
                }),
            tokenCounter: {
                countFinalRequest: async ({ payload, signal }) => ({
                    inputTokens: await countGooglePayload(
                        model as Model<"google-generative-ai">,
                        payload,
                        resolvedApiKey,
                        signal
                    ),
                    accuracy: "exact",
                }),
                countContextOverlay: async ({ overlay, signal }) => ({
                    inputTokens: await countGooglePayload(
                        model as Model<"google-generative-ai">,
                        buildGooglePayload(model as Model<"google-generative-ai">, overlayContext(overlay), {
                            maxTokens: 1,
                            ...getGoogleReasoningOptions(
                                model as Model<"google-generative-ai">,
                                thinkingLevel === "off" ? undefined : thinkingLevel
                            ),
                        }),
                        resolvedApiKey,
                        signal
                    ),
                    accuracy: "conservative_upper_bound",
                }),
            },
        };
    }
    return undefined;
}
