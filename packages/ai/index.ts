// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Public surface of crest's integrated AI client (started from pi-ai
// v0.75.5, now owned in-tree). Image generation, Bedrock, Vertex,
// Azure, Codex, Mistral, Cloudflare, Faux are stripped — re-add by
// copying back from upstream and re-exporting here.

export type { Static, TSchema } from "typebox";
export { Type } from "typebox";

export * from "./api-registry";
export * from "./env-api-keys";
export * from "./models";
export type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./providers/anthropic";
export type { GoogleOptions } from "./providers/google";
export type { GoogleThinkingLevel } from "./providers/google-shared";
export type { OpenAICompletionsOptions } from "./providers/openai-completions";
export type { OpenAIResponsesOptions } from "./providers/openai-responses";
export * from "./providers/register-builtins";
export * from "./session-resources";
export * from "./stream";
export * from "./types";
export * from "./utils/diagnostics";
export * from "./utils/event-stream";
export * from "./utils/json-parse";
export type {
    OAuthAuthInfo,
    OAuthCredentials,
    OAuthDeviceCodeInfo,
    OAuthLoginCallbacks,
    OAuthPrompt,
    OAuthProvider,
    OAuthProviderId,
    OAuthProviderInfo,
    OAuthProviderInterface,
    OAuthSelectOption,
    OAuthSelectPrompt,
} from "./utils/oauth/types";
export * from "./utils/overflow";
export * from "./utils/typebox-helpers";
export * from "./utils/validation";
