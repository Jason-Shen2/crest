// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AI configuration types — selection (per-pane), user config
// (~/.config/crest/ai.json), and the resolver's output.
//
// Design: see docs/ai-config-architecture.md.  These are the canonical
// TS definitions; ai.json read/write happens in electron-main
// (emain/aiconfig/user-config.ts) over the same JSON shape, and the
// agent send path carries only {provider, model, reasoning} via IPC.

import type { ApiType, Capability, ModelEntry, ReasoningLevel } from "./ai-catalog";

// =========================================================================
// Selection — what the user currently has picked in one pane
// =========================================================================
//
// Stored at block.meta["agent:selection"] on the outer block.  Inline
// triple (not a profile reference) so it's self-describing and
// survives profile deletes.  See docs/ai-config-architecture.md §5.

export interface AgentSelection {
    provider: string;
    model: string;
    // Only honored when the resolved model has the "reasoning"
    // capability.  Silently dropped by the resolver otherwise.
    reasoning?: ReasoningLevel;
}

// =========================================================================
// User config — ~/.config/crest/ai.json
// =========================================================================
//
// One file replaces both legacy `ai:*` global settings and `waveai@*`
// mode dict.  See docs/ai-config-architecture.md §4.
//
// Defined here as the canonical TS shape.  Read/written via the
// electron-main IPC handlers in emain/aiconfig-ipc.ts — the renderer
// uses getApi().ai.getUserConfig() / writeUserConfig().

export interface ProviderCredentials {
    tokensecretname?: string;
    token?: string;
}

export interface PinnedModel {
    provider: string;
    model: string;
}

export interface UserCustomModel {
    provider: string;
    id: string;
    displayname: string;
    description?: string;
    capabilities: string[];
    contextwindow: number;
    reasoninglevels?: string[];
    apitypeoverride?: string;
}

export interface UserCustomEndpointModel {
    id: string;
    displayName: string;
    description?: string;
    capabilities: string[];
    contextWindow: number;
    reasoningLevels?: string[];
}

export interface UserCustomEndpoint {
    displayname: string;
    endpoint: string;
    apitype: string;
    tokensecretname: string;
    icon?: string;
    models: UserCustomEndpointModel[];
}

export interface AISelectionConfigPersisted {
    provider: string;
    model: string;
    reasoning?: string;
}

export interface AIContextReferencesConfig {
    enabled?: boolean;
    max_tokens?: number;
}

export interface AIUserConfig {
    providers: { [key: string]: ProviderCredentials };
    default: AISelectionConfigPersisted;
    profiles?: { [key: string]: AISelectionConfigPersisted };
    custom_models?: UserCustomModel[];
    custom_endpoints?: { [key: string]: UserCustomEndpoint };
    pinned?: PinnedModel[];
    context_references?: AIContextReferencesConfig;
}

// `UserConfig` is a local alias so resolver / picker code can stay
// vocabulary-neutral.  Same shape, narrower-feel name.
export type UserConfig = AIUserConfig;

// =========================================================================
// Resolved config — output of the resolver
// =========================================================================
//
// Historically this was the wire shape POSTed to the Go agent backend.
// With the pi-native runtime (agent loop in electron-main), the agent
// send path carries only {provider, model, reasoning} over IPC and
// pi-ai resolves the endpoint/credentials from its own registry. The
// resolver now serves two live purposes: (1) validation — does the
// current selection resolve to a real model with credentials? the
// error half drives the picker's empty/error state — and (2) the
// derived endpoint/apitype fields the picker reads for display.

export interface ResolvedAIConfig {
    provider: string;
    model: string;
    endpoint: string;
    apitype: ApiType;
    capabilities: Capability[];
    contextwindow: number;
    // Only present when the resolved model supports reasoning AND the
    // selection requested a level.
    reasoning?: ReasoningLevel;
    // Exactly one of tokensecretname / token will be set.  The agent
    // runtime resolves tokensecretname via emain/aiconfig/secrets.ts;
    // token is a literal pass-through (testing / unauthed local
    // endpoints).
    tokensecretname?: string;
    token?: string;
}

// =========================================================================
// Resolver errors
// =========================================================================
//
// resolveAIConfig returns a discriminated union so callers can branch
// on `ok` without try/catch.  Error codes are stable strings the UI
// can switch on to render a helpful empty state.

export type ResolveResult =
    | { ok: true; config: ResolvedAIConfig }
    | { ok: false; error: ResolveError };

export interface ResolveError {
    code:
        | "unknown_provider"
        | "unknown_model"
        | "no_credentials"
        | "no_default"
        | "no_config";
    message: string;
    // When the error is fixable by editing ai.json, this points the UI
    // at the failing piece.
    hint?: {
        provider?: string;
        model?: string;
    };
}
