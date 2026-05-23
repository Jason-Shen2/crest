// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// _spike.ts — end-to-end sanity check for the integrated agent stack.
//
// Constructs an Agent with whichever provider has an env-var key
// available, runs one prompt, and prints the streamed event types.
// Confirms:
//   - emain/agent and emain/ai compile and load at runtime
//   - register-builtins wired the providers we care about
//   - a real upstream call streams events back through Agent.subscribe()
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... npx tsx emain/agent/_spike.ts
//   OPENAI_API_KEY=sk-... npx tsx emain/agent/_spike.ts "Hello"
//   GEMINI_API_KEY=... npx tsx emain/agent/_spike.ts
//
// Delete this file once the runtime path is wired through Electron main.

import { Agent } from "./index";
import { getModel } from "../ai";

interface ProviderChoice {
    provider: "anthropic" | "openai" | "google";
    model: string;
    envKey: string;
}

const CANDIDATES: ProviderChoice[] = [
    { provider: "anthropic", model: "claude-haiku-4-5", envKey: "ANTHROPIC_API_KEY" },
    { provider: "openai", model: "gpt-5-mini", envKey: "OPENAI_API_KEY" },
    { provider: "google", model: "gemini-2.5-flash-lite", envKey: "GEMINI_API_KEY" },
];

function pickProvider(): ProviderChoice {
    for (const c of CANDIDATES) {
        if (process.env[c.envKey]) return c;
    }
    throw new Error(
        `No provider key found in env. Set one of: ${CANDIDATES.map((c) => c.envKey).join(", ")}`,
    );
}

async function main(): Promise<void> {
    const prompt = process.argv[2] ?? "Reply with the single word OK.";
    const pick = pickProvider();
    console.log(`[spike] provider=${pick.provider} model=${pick.model}`);

    // getModel is typed with literal generics; the loose `pick.provider`
    // string can't satisfy them. Cast — runtime accepts any registered id.
    const model = (getModel as unknown as (p: string, m: string) => unknown)(
        pick.provider,
        pick.model,
    );
    if (!model) throw new Error(`getModel returned no entry for ${pick.provider}/${pick.model}`);

    const agent = new Agent({
        initialState: {
            systemPrompt: "You answer in five words or fewer.",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            model: model as any,
        },
    });

    const eventCounts: Record<string, number> = {};
    let finalMessageCount = 0;
    agent.subscribe((event) => {
        eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            process.stdout.write(event.assistantMessageEvent.delta);
        }
        if (event.type === "agent_end") {
            finalMessageCount = event.messages.length;
        }
    });

    await agent.prompt(prompt);
    process.stdout.write("\n\n[spike] event tally:\n");
    for (const [type, count] of Object.entries(eventCounts).sort()) {
        process.stdout.write(`  ${type}: ${count}\n`);
    }
    console.log(`[spike] final message count: ${finalMessageCount}`);
    console.log(`[spike] OK`);
}

void main().catch((err) => {
    console.error("[spike] FAILED:", err);
    process.exit(1);
});
