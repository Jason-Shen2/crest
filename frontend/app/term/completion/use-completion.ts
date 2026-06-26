// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { suggest } from "./engine";
import type { CompletionContext, Provider, SuggestionResults } from "./types";

export function createRunner(providers: Provider[]) {
    let seq = 0;
    async function run(ctx: CompletionContext): Promise<SuggestionResults | null> {
        const mine = ++seq;
        const res = await suggest(ctx, providers);
        if (mine !== seq) return null;
        return res;
    }
    return { run };
}
