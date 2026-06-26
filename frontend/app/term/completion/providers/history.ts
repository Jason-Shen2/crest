// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CompletionContext, ParsedToken, Suggestion } from "../types";

export function historyProvider(ctx: CompletionContext, _token: ParsedToken): Suggestion[] {
    const prefix = ctx.buffer.slice(0, ctx.cursor);
    if (prefix.trim().length === 0) return [];
    const seen = new Set<string>();
    const out: Suggestion[] = [];
    for (let i = ctx.history.length - 1; i >= 0; i--) {
        const cmd = ctx.history[i];
        if (cmd === prefix) continue;
        if (!cmd.startsWith(prefix)) continue;
        if (seen.has(cmd)) continue;
        seen.add(cmd);
        out.push({
            display: cmd,
            replacement: cmd,
            type: "history",
            priority: 100 - out.length,
            icon: "clock-rotate-left",
        });
    }
    return out;
}
