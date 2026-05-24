// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// _test-openrouter.ts — one-off smoke against an OpenRouter free model.
// Runs the integrated agent stack end-to-end (sessions + harness +
// pi-ai openai-completions provider) against the real OpenRouter API.
//
// Usage:
//   OPENROUTER_API_KEY=sk-or-v1-... \
//     npx tsx emain/agent/_test-openrouter.ts ["prompt text"]
//
// Defaults to a known free model + a short prompt that should
// reliably echo "OK". Delete this file once task #14 (E2E regression)
// has a real test harness.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Api, Model } from "../ai";
import { AgentHarness } from "./harness/agent-harness";
import { JsonlSessionRepo } from "./harness/session/jsonl-repo";
import { NodeExecutionEnv } from "./node";
import { buildSystemPrompt } from "./build-system-prompt";
import { getDefaultTools } from "./tools";

// Free-tier OpenRouter model. Rate-limited but no cost.
// Override via: OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct:free
const DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

function buildOpenRouterModel(modelId: string): Model<Api> {
    // pi-ai's openai-completions provider handles OpenRouter natively
    // (OpenRouter exposes an OpenAI-compatible endpoint). We construct
    // the Model shape manually rather than going through getModel()
    // because the model registry is built from LiteLLM data which
    // doesn't enumerate OpenRouter's free tier specifically.
    return {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: "openrouter",
        // The openai SDK appends /chat/completions itself — only the
        // base path goes here. (crest's catalog has the same field
        // overspecified; that's a separate bug for the wiring path.)
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
    };
}

async function main(): Promise<void> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        throw new Error(
            "OPENROUTER_API_KEY not set. Run with:\n" +
                "  OPENROUTER_API_KEY=sk-or-v1-... npx tsx emain/agent/_test-openrouter.ts",
        );
    }
    const modelId = process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
    const prompt = process.argv[2] ?? "Reply with the single word OK.";
    console.log(`[test] model=${modelId}`);
    console.log(`[test] prompt=${JSON.stringify(prompt)}`);

    // Sandboxed sessions dir so the test doesn't touch real config.
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crest-or-test-"));
    const fsEnv = new NodeExecutionEnv({ cwd: process.cwd() });
    const repo = new JsonlSessionRepo({ fs: fsEnv, sessionsRoot: tmpRoot });
    const { metadata, ...rest } = await (async () => {
        const session = await repo.create({ cwd: process.cwd() });
        return { metadata: await session.getMetadata(), session };
    })();
    const session = rest.session;
    console.log(`[test] sessions root: ${tmpRoot}`);
    console.log(`[test] session id: ${metadata.id}`);

    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const model = buildOpenRouterModel(modelId);
    const harness = new AgentHarness({
        env,
        session,
        model,
        thinkingLevel: "off",
        tools: getDefaultTools(),
        systemPrompt: () =>
            buildSystemPrompt({ cwd: process.cwd(), recentCmds: ["git status"] }),
        // Pi-ai providers read api keys from env or this hook. We pass
        // explicitly so the OpenRouter key doesn't have to be in any
        // standard env var name the provider auto-resolves.
        getApiKeyAndHeaders: async () => ({ apiKey }),
    });

    const eventCounts: Record<string, number> = {};
    let stoppedReason: string | undefined;
    let errorMessage: string | undefined;
    harness.subscribe((event) => {
        eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
        if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
        ) {
            const delta = (event.assistantMessageEvent as { delta?: string }).delta ?? "";
            process.stdout.write(delta);
        }
        if (event.type === "message_end") {
            const m = event.message;
            if (m.role === "assistant") {
                stoppedReason = (m as { stopReason?: string }).stopReason;
                errorMessage = (m as { errorMessage?: string }).errorMessage;
            }
        }
    });

    const result = await harness.prompt(prompt);
    process.stdout.write("\n\n[test] event tally:\n");
    for (const [type, count] of Object.entries(eventCounts).sort()) {
        process.stdout.write(`  ${type}: ${count}\n`);
    }
    console.log(`[test] final stopReason: ${stoppedReason ?? "(none)"}`);
    if (errorMessage) console.log(`[test] error: ${errorMessage}`);

    const lines = (await fs.readFile(metadata.path, "utf8")).trim().split("\n");
    console.log(`[test] session jsonl line count: ${lines.length}`);
    console.log(`[test] full prompt result usage: ${JSON.stringify(result.usage ?? {})}`);
    console.log(`[test] OK`);
}

void main().catch((err) => {
    console.error("[test] FAILED:", err);
    process.exit(1);
});
