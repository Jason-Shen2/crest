// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// spawn-cli-agent.ts — the main-agent-facing delegation tool plus the
// subagent driver. runSubagentToCompletion drives the subagent harness
// to convergence and extracts its natural-language summary. See spec §5
// (decision 5), §7.

import type { CliSubagentHarness } from "../cli-subagent-factory";

function extractText(message: unknown): string {
    const content = (message as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
    return content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n")
        .trim();
}

export async function runSubagentToCompletion(
    sub: CliSubagentHarness,
    task: string,
    opts: { maxTurns: number; signal?: AbortSignal },
): Promise<string> {
    if (opts.signal?.aborted) {
        await sub.harness.abort();
        throw new Error("aborted");
    }
    const onAbort = () => {
        void sub.harness.abort();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        const finalMessage = await sub.harness.prompt(task);
        const summary = extractText(finalMessage);
        return summary || "(subagent produced no summary)";
    } finally {
        opts.signal?.removeEventListener("abort", onAbort);
    }
}
