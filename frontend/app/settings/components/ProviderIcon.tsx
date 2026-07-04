// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// ProviderIcon — provider-specific brand glyph. Mirrors terax-ai
// ProviderIcon.tsx — same icon pick per provider, same strokeWidth
// (1.75) so the cards stay visually aligned between crest and the
// reference app.
//
// Notes:
//   - Stroke width 1.75 is what terax uses everywhere in its settings.
//     1.5 (crest default) is too thin at the 14-15px the settings cards
//     use and reads as "outline-y" — easy to mistake for a placeholder.
//   - All icons live in the standard Hugeicons package — no custom SVGs.
//   - `ProviderId` matches the crest CATALOG id (openai / anthropic /
//     google / openrouter + minimax / minimax-cn). ProviderKeyCard keys
//     its PROVIDER_META Record by this set. `ProviderIconId` widens to
//     include non-catalog kinds (`openai-compatible` for user-defined
//     OpenAI-compatible endpoints) — ProviderIcon itself accepts any
//     string and falls back to "code-02" for unknown ids, so custom
//     endpoint ids (UUIDs) also resolve cleanly.

import { Icon } from "@/app/icon/Icon";

export type ProviderId =
    | "openai"
    | "anthropic"
    | "google"
    | "minimax"
    | "minimax-cn"
    | "openrouter";

export type ProviderIconId = ProviderId | "openai-compatible";

const NAME_BY_PROVIDER: Record<string, string> = {
    openai: "chat-gpt",
    anthropic: "claude",
    google: "google-gemini",
    minimax: "stars-01",
    "minimax-cn": "stars-01",
    openrouter: "globe",
    "openai-compatible": "code",
};

const FALLBACK_ICON = "code";

type Props = {
    provider: string;
    size?: number;
    className?: string;
};

export function ProviderIcon({ provider, size = 14, className }: Props) {
    const iconName = NAME_BY_PROVIDER[provider] ?? FALLBACK_ICON;
    return <Icon name={iconName} size={size} className={className} />;
}