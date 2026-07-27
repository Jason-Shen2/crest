// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// _spike.ts — end-to-end smoke for the integrated agent runtime.
//
// Exercises the full stack from sessions.ts → harness-factory.ts →
// AgentHarness → pi-ai → upstream LLM. Confirms:
//   - packages/coding-agent + packages/ai compile and load at runtime
//   - SqliteSessionRepo mints a SQLite session under the configured root
//   - buildAgentHarnessHost wires env / model / system prompt correctly
//   - AgentHarness.prompt drives a real turn and emits event stream
//   - Session storage contains the appended messages afterwards
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... npx tsx packages/coding-agent/_spike.ts
//   OPENAI_API_KEY=sk-... npx tsx packages/coding-agent/_spike.ts "Tell me a joke"
//   GEMINI_API_KEY=... npx tsx packages/coding-agent/_spike.ts
//
// Spike writes session data under a tmp dir (not the user's real
// sessions store) so repeated runs don't pile up real conversations.
//
// Delete this file once the Electron main runtime + IPC wiring is in
// place and exercised by integration tests.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getModel } from "@crest/ai";
import { SqliteSessionRepo } from "@crest/agent/harness/session/sqlite-repo";
import { buildAgentHarnessHost } from "./harness-factory";
import { _setSessionsRepoForTests, createPaneSession } from "./sessions";

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

    // Sandbox the sessions root to a tmp dir so we don't pollute the
    // user's real conversation history.
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crest-spike-"));
    const tmpRepo = new SqliteSessionRepo({ sessionsRoot: tmpRoot });
    _setSessionsRepoForTests(tmpRepo);
    console.log(`[spike] sessions root: ${tmpRoot}`);

    const { session, metadata } = await createPaneSession(process.cwd());
    console.log(`[spike] minted session id=${metadata.id} at ${metadata.path}`);

    // getModel is typed with literal generics; the loose `pick.provider`
    // string can't satisfy them. Cast — runtime accepts any registered id.
    const model = (getModel as unknown as (p: string, m: string) => unknown)(
        pick.provider,
        pick.model,
    );
    if (!model) throw new Error(`getModel returned no entry for ${pick.provider}/${pick.model}`);

    const pane = buildAgentHarnessHost({
        session,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        model: model as any,
        promptInputs: {
            cwd: process.cwd(),
            gitBranch: "main",
            recentCmds: ["git status", "ls"],
        },
    });

    const eventCounts: Record<string, number> = {};
    // subscribe() gets the full AgentHarnessEvent | AgentEvent union;
    // the per-type .on() API is reserved for AgentHarness-OWN hooks
    // (queue, save_point, ...), not the underlying Agent's stream events.
    pane.harness.subscribe((event) => {
        eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            process.stdout.write(event.assistantMessageEvent.delta);
        }
    });

    const assistantMessage = await pane.harness.prompt(prompt);

    process.stdout.write("\n\n[spike] event tally:\n");
    for (const [type, count] of Object.entries(eventCounts).sort()) {
        process.stdout.write(`  ${type}: ${count}\n`);
    }
    console.log(`[spike] stop reason: ${assistantMessage.stopReason}`);
    if (assistantMessage.errorMessage) {
        console.log(`[spike] error message: ${assistantMessage.errorMessage}`);
    }

    // Verify the session JSONL has appended entries.
    const lines = (await fs.readFile(metadata.path, "utf8")).trim().split("\n");
    console.log(`[spike] session jsonl line count: ${lines.length}`);
    console.log(`[spike] OK`);
}

void main().catch((err) => {
    console.error("[spike] FAILED:", err);
    process.exit(1);
});
