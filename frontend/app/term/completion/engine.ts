// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { parseToken } from "./parse";
import type { CompletionContext, Provider, Suggestion, SuggestionResults } from "./types";

export async function suggest(ctx: CompletionContext, providers: Provider[]): Promise<SuggestionResults> {
    const token = parseToken(ctx.buffer, ctx.cursor);
    const results = await Promise.all(providers.map((p) => p(ctx, token)));
    const merged: Suggestion[] = [];
    const seen = new Set<string>();
    for (const list of results) {
        for (const s of list) {
            const spanStart = s.spanStart ?? (s.type === "history" ? 0 : token.start);
            const key = `${spanStart}:${s.replacement}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push({ ...s, spanStart });
        }
    }
    merged.sort((a, b) => b.priority - a.priority);
    const hasToken = merged.some((s) => s.spanStart === token.start);
    const start = merged.length === 0 ? token.start : hasToken ? token.start : 0;
    return { replacementSpan: { start, end: ctx.cursor }, suggestions: merged, matchStrategy: "prefix" };
}
