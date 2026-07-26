// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Built-in API provider registration. Trimmed to the four providers
// crest actively uses (openai-responses, openai-completions,
// anthropic-messages, google-generative-ai). The OpenRouter live list
// routes through openai-completions with a custom baseURL, so no
// dedicated OpenRouter provider entry is required.
//
// Dropped from upstream pi-ai (delete the file under providers/ when
// adding back): amazon-bedrock, azure-openai-responses, cloudflare,
// faux, google-vertex, mistral, openai-codex-responses, images.
// Re-introduce one of these by:
//   1. Copying the provider file back from pi v0.75.5 packages/ai/src/providers/.
//   2. Adding a streamX / streamSimpleX import + registerApiProvider call below.
//   3. Updating crest's catalog + secret store if the provider needs auth.

import { clearApiProviders, registerApiProvider } from "../api-registry";
import type {
    Api,
    AssistantMessage,
    AssistantMessageEvent,
    Context,
    Model,
    SimpleStreamOptions,
    StreamFunction,
    StreamOptions,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { AnthropicOptions } from "./anthropic";
import type { GoogleOptions } from "./google";
import type { OpenAICompletionsOptions } from "./openai-completions";
import type { OpenAIResponsesOptions } from "./openai-responses";

interface LazyProviderModule<
    TApi extends Api,
    TOptions extends StreamOptions,
    TSimpleOptions extends SimpleStreamOptions,
> {
    stream: (model: Model<TApi>, context: Context, options?: TOptions) => AsyncIterable<AssistantMessageEvent>;
    streamSimple: (
        model: Model<TApi>,
        context: Context,
        options?: TSimpleOptions,
    ) => AsyncIterable<AssistantMessageEvent>;
}

interface AnthropicProviderModule {
    streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions>;
    streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions>;
}

interface GoogleProviderModule {
    streamGoogle: StreamFunction<"google-generative-ai", GoogleOptions>;
    streamSimpleGoogle: StreamFunction<"google-generative-ai", SimpleStreamOptions>;
}

interface OpenAICompletionsProviderModule {
    streamOpenAICompletions: StreamFunction<"openai-completions", OpenAICompletionsOptions>;
    streamSimpleOpenAICompletions: StreamFunction<"openai-completions", SimpleStreamOptions>;
}

interface OpenAIResponsesProviderModule {
    streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions>;
    streamSimpleOpenAIResponses: StreamFunction<"openai-responses", SimpleStreamOptions>;
}

let anthropicProviderModulePromise:
    | Promise<LazyProviderModule<"anthropic-messages", AnthropicOptions, SimpleStreamOptions>>
    | undefined;
let googleProviderModulePromise:
    | Promise<LazyProviderModule<"google-generative-ai", GoogleOptions, SimpleStreamOptions>>
    | undefined;
let openAICompletionsProviderModulePromise:
    | Promise<LazyProviderModule<"openai-completions", OpenAICompletionsOptions, SimpleStreamOptions>>
    | undefined;
let openAIResponsesProviderModulePromise:
    | Promise<LazyProviderModule<"openai-responses", OpenAIResponsesOptions, SimpleStreamOptions>>
    | undefined;

function forwardStream(target: AssistantMessageEventStream, source: AsyncIterable<AssistantMessageEvent>): void {
    (async () => {
        for await (const event of source) {
            target.push(event);
        }
        target.end();
    })();
}

function createLazyLoadErrorMessage<TApi extends Api>(model: Model<TApi>, error: unknown): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
    };
}

function createLazyStream<TApi extends Api, TOptions extends StreamOptions, TSimpleOptions extends SimpleStreamOptions>(
    loadModule: () => Promise<LazyProviderModule<TApi, TOptions, TSimpleOptions>>,
): StreamFunction<TApi, TOptions> {
    return (model, context, options) => {
        const outer = new AssistantMessageEventStream();

        loadModule()
            .then((module) => {
                const inner = module.stream(model, context, options);
                forwardStream(outer, inner);
            })
            .catch((error) => {
                const message = createLazyLoadErrorMessage(model, error);
                outer.push({ type: "error", reason: "error", error: message });
                outer.end(message);
            });

        return outer;
    };
}

function createLazySimpleStream<
    TApi extends Api,
    TOptions extends StreamOptions,
    TSimpleOptions extends SimpleStreamOptions,
>(loadModule: () => Promise<LazyProviderModule<TApi, TOptions, TSimpleOptions>>): StreamFunction<TApi, TSimpleOptions> {
    return (model, context, options) => {
        const outer = new AssistantMessageEventStream();

        loadModule()
            .then((module) => {
                const inner = module.streamSimple(model, context, options);
                forwardStream(outer, inner);
            })
            .catch((error) => {
                const message = createLazyLoadErrorMessage(model, error);
                outer.push({ type: "error", reason: "error", error: message });
                outer.end(message);
            });

        return outer;
    };
}

function loadAnthropicProviderModule(): Promise<
    LazyProviderModule<"anthropic-messages", AnthropicOptions, SimpleStreamOptions>
> {
    anthropicProviderModulePromise ||= import("./anthropic").then((module) => {
        const provider = module as AnthropicProviderModule;
        return {
            stream: provider.streamAnthropic,
            streamSimple: provider.streamSimpleAnthropic,
        };
    });
    return anthropicProviderModulePromise;
}

function loadGoogleProviderModule(): Promise<
    LazyProviderModule<"google-generative-ai", GoogleOptions, SimpleStreamOptions>
> {
    googleProviderModulePromise ||= import("./google").then((module) => {
        const provider = module as GoogleProviderModule;
        return {
            stream: provider.streamGoogle,
            streamSimple: provider.streamSimpleGoogle,
        };
    });
    return googleProviderModulePromise;
}

function loadOpenAICompletionsProviderModule(): Promise<
    LazyProviderModule<"openai-completions", OpenAICompletionsOptions, SimpleStreamOptions>
> {
    openAICompletionsProviderModulePromise ||= import("./openai-completions").then((module) => {
        const provider = module as OpenAICompletionsProviderModule;
        return {
            stream: provider.streamOpenAICompletions,
            streamSimple: provider.streamSimpleOpenAICompletions,
        };
    });
    return openAICompletionsProviderModulePromise;
}

function loadOpenAIResponsesProviderModule(): Promise<
    LazyProviderModule<"openai-responses", OpenAIResponsesOptions, SimpleStreamOptions>
> {
    openAIResponsesProviderModulePromise ||= import("./openai-responses").then((module) => {
        const provider = module as OpenAIResponsesProviderModule;
        return {
            stream: provider.streamOpenAIResponses,
            streamSimple: provider.streamSimpleOpenAIResponses,
        };
    });
    return openAIResponsesProviderModulePromise;
}

export const streamAnthropic = createLazyStream(loadAnthropicProviderModule);
export const streamSimpleAnthropic = createLazySimpleStream(loadAnthropicProviderModule);
export const streamGoogle = createLazyStream(loadGoogleProviderModule);
export const streamSimpleGoogle = createLazySimpleStream(loadGoogleProviderModule);
export const streamOpenAICompletions = createLazyStream(loadOpenAICompletionsProviderModule);
export const streamSimpleOpenAICompletions = createLazySimpleStream(loadOpenAICompletionsProviderModule);
export const streamOpenAIResponses = createLazyStream(loadOpenAIResponsesProviderModule);
export const streamSimpleOpenAIResponses = createLazySimpleStream(loadOpenAIResponsesProviderModule);

export function registerBuiltInApiProviders(): void {
    registerApiProvider({
        api: "anthropic-messages",
        stream: streamAnthropic,
        streamSimple: streamSimpleAnthropic,
    });

    registerApiProvider({
        api: "openai-completions",
        stream: streamOpenAICompletions,
        streamSimple: streamSimpleOpenAICompletions,
    });

    registerApiProvider({
        api: "openai-responses",
        stream: streamOpenAIResponses,
        streamSimple: streamSimpleOpenAIResponses,
    });

    registerApiProvider({
        api: "google-generative-ai",
        stream: streamGoogle,
        streamSimple: streamSimpleGoogle,
    });
}

export function resetApiProviders(): void {
    clearApiProviders();
    registerBuiltInApiProviders();
}

registerBuiltInApiProviders();
