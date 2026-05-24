// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AI configuration types — selection (per-pane), user config (~/.config),
// resolved config (the wire shape sent to the agent backend).
//
// Design: see docs/ai-config-architecture.md.  These types are
// frontend-authored; the Go side has a mirror struct in
// pkg/aiusechat/aiconfig.go (AIConfigRequest) that ingests the resolved
// shape.  Field names match across the boundary so JSON round-trips
// without translation.

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

export interface AIUserConfig {
    providers: { [key: string]: ProviderCredentials };
    default: AISelectionConfigPersisted;
    profiles?: { [key: string]: AISelectionConfigPersisted };
    custom_models?: UserCustomModel[];
    custom_endpoints?: { [key: string]: UserCustomEndpoint };
    pinned?: PinnedModel[];
}

// `UserConfig` is a local alias so resolver / picker code can stay
// vocabulary-neutral.  Same shape, narrower-feel name.
export type UserConfig = AIUserConfig;

// =========================================================================
// Resolved config — output of the resolver, input to the backend
// =========================================================================
//
// What gets sent on the wire to /api/post-agent-message in the
// `aiconfig` field.  Mirrors pkg/aiusechat/aiconfig.go AIConfigRequest
// 1:1 — field names must stay in sync.

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
    // Exactly one of tokensecretname / token will be set.  Backend
    // resolves tokensecretname via secretstore.GetSecret; token is
    // passed through literally (used for testing or unauthed local
    // endpoints).
    tokensecretname?: string;
    token?: string;
}

// AIConfigRequest is what the agent HTTP request body carries.  Same
// shape as ResolvedAIConfig — separate name purely for callsite
// clarity (we say "the request carries an AIConfigRequest, the
// resolver produces a ResolvedAIConfig" even though they're identical).
export type AIConfigRequest = ResolvedAIConfig;

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
