// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// run-regression.ts — repeatable E2E regression for the integrated agent
// runtime. Runs a fixed scenario matrix (see scenarios.ts) against every
// provider in the matrix (see providers.ts) that has an API key set in
// the environment. Replaces the one-off _test-openrouter.ts.
//
// Usage:
//   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... \
//     GEMINI_API_KEY=... OPENROUTER_API_KEY=... \
//     npx tsx packages/coding-agent/eval/run-regression.ts
//
//   # restrict to specific providers:
//   ONLY=openrouter,anthropic npx tsx packages/coding-agent/eval/run-regression.ts
//
//   # restrict to specific scenarios:
//   SCENARIOS=text-only,list-dir npx tsx packages/coding-agent/eval/run-regression.ts
//
// Providers with no key are skipped (not failed). Exit code is non-zero if
// any executed scenario failed, so CI can gate on it once keys are wired
// into secrets.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AgentHarness } from "@crest/agent/harness/agent-harness";
import { JsonlSessionRepo } from "@crest/agent/harness/session/jsonl-repo";
import { NodeExecutionEnv } from "@crest/agent/node";
import { buildSystemPrompt } from "../build-system-prompt";
import { getDefaultTools } from "../tools";
import type { AgentEvent } from "@crest/agent/types";
import { apiKeyFor, PROVIDERS, resolveModelId, type ProviderConfig } from "./providers";
import { SCENARIOS, type RunCapture, type Scenario } from "./scenarios";

const PER_SCENARIO_TIMEOUT_MS = 90_000;

interface ScenarioResult {
    provider: string;
    model: string;
    scenario: string;
    ok: boolean;
    failures: string[];
    durationMs: number;
    toolCalls: string[];
    skipped?: boolean;
    error?: string;
}

function csvEnv(name: string): Set<string> | null {
    const raw = process.env[name];
    if (!raw) return null;
    return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

async function runScenario(
    provider: ProviderConfig,
    modelId: string,
    apiKey: string,
    scenario: Scenario,
    cwd: string,
    sessionsRoot: string,
): Promise<ScenarioResult> {
    const start = Date.now();
    const env = new NodeExecutionEnv({ cwd });
    const repoEnv = new NodeExecutionEnv({ cwd });
    const repo = new JsonlSessionRepo({ fs: repoEnv, sessionsRoot });
    const session = await repo.create({ cwd });

    const cap: RunCapture = {
        toolCalls: [],
        toolResults: [],
        finalText: "",
        turnCount: 0,
    };

    const harness = new AgentHarness({
        env,
        session,
        model: provider.buildModel(modelId),
        thinkingLevel: "off",
        tools: getDefaultTools(cwd),
        // Match production wiring (harness-factory.ts): feed the turn's
        // activeTools into the prompt so the Available tools list and
        // tool guidelines are present, exactly as the real agent sees them.
        systemPrompt: ({ activeTools }) => {
            const toolSnippets: Record<string, string> = {};
            const promptGuidelines: string[] = [];
            for (const tool of activeTools) {
                if (tool.promptSnippet) toolSnippets[tool.name] = tool.promptSnippet;
                if (tool.promptGuidelines) promptGuidelines.push(...tool.promptGuidelines);
            }
            return buildSystemPrompt({
                cwd,
                selectedTools: activeTools.map((tool) => tool.name),
                toolSnippets,
                promptGuidelines,
            });
        },
        getApiKeyAndHeaders: async () => ({ apiKey }),
    });

    harness.subscribe((event: AgentEvent) => {
        switch (event.type) {
            case "tool_execution_start":
                cap.toolCalls.push({ name: event.toolName, args: event.args });
                break;
            case "tool_execution_end":
                cap.toolResults.push({ name: event.toolName, isError: event.isError });
                break;
            case "turn_end":
                cap.turnCount += 1;
                break;
            default:
                break;
        }
    });

    const prompt = scenario.prompt.replaceAll("{cwd}", cwd);
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        void harness.abort();
    }, PER_SCENARIO_TIMEOUT_MS);

    try {
        const final = await harness.prompt(prompt);
        clearTimeout(timer);
        cap.stopReason = (final as { stopReason?: string }).stopReason;
        cap.errorMessage = (final as { errorMessage?: string }).errorMessage;
        // Final assistant text = concatenated text content blocks.
        cap.finalText = (final.content ?? [])
            .filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
            .map((c) => c.text)
            .join("");
        if (timedOut) {
            return resultOf(provider, modelId, scenario, start, cap, [
                `scenario timed out after ${PER_SCENARIO_TIMEOUT_MS}ms`,
            ]);
        }
        const failures = scenario.check(cap);
        return resultOf(provider, modelId, scenario, start, cap, failures);
    } catch (err) {
        clearTimeout(timer);
        return {
            provider: provider.id,
            model: modelId,
            scenario: scenario.id,
            ok: false,
            failures: [`threw: ${err instanceof Error ? err.message : String(err)}`],
            durationMs: Date.now() - start,
            toolCalls: cap.toolCalls.map((c) => c.name),
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

function resultOf(
    provider: ProviderConfig,
    modelId: string,
    scenario: Scenario,
    start: number,
    cap: RunCapture,
    failures: string[],
): ScenarioResult {
    return {
        provider: provider.id,
        model: modelId,
        scenario: scenario.id,
        ok: failures.length === 0,
        failures,
        durationMs: Date.now() - start,
        toolCalls: cap.toolCalls.map((c) => c.name),
    };
}

async function main(): Promise<void> {
    const onlyProviders = csvEnv("ONLY");
    const onlyScenarios = csvEnv("SCENARIOS");
    const cwd = process.cwd();
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crest-regression-"));

    const scenarios = SCENARIOS.filter((s) => !onlyScenarios || onlyScenarios.has(s.id));
    const providers = PROVIDERS.filter((p) => !onlyProviders || onlyProviders.has(p.id));

    console.log(`[regression] cwd=${cwd}`);
    console.log(`[regression] sessions=${sessionsRoot}`);
    console.log(`[regression] scenarios: ${scenarios.map((s) => s.id).join(", ")}`);

    const results: ScenarioResult[] = [];
    const skippedProviders: string[] = [];

    for (const provider of providers) {
        const apiKey = apiKeyFor(provider);
        if (!apiKey) {
            skippedProviders.push(provider.id);
            continue;
        }
        const modelId = resolveModelId(provider);
        console.log(`\n[regression] === ${provider.id} (${modelId}) ===`);
        for (const scenario of scenarios) {
            process.stdout.write(`  ${scenario.id} ... `);
            const r = await runScenario(provider, modelId, apiKey, scenario, cwd, sessionsRoot);
            results.push(r);
            if (r.ok) {
                console.log(`PASS (${r.durationMs}ms, tools: ${r.toolCalls.join(",") || "none"})`);
            } else {
                console.log(`FAIL (${r.durationMs}ms)`);
                for (const f of r.failures) console.log(`      - ${f}`);
            }
        }
    }

    console.log("\n[regression] ───────── summary ─────────");
    if (skippedProviders.length) {
        console.log(`[regression] skipped (no API key): ${skippedProviders.join(", ")}`);
    }
    const executed = results.length;
    const passed = results.filter((r) => r.ok).length;
    const failed = executed - passed;
    console.log(`[regression] ${passed}/${executed} scenarios passed across ${providers.length - skippedProviders.length} provider(s)`);

    if (executed === 0) {
        console.log("[regression] nothing ran — set at least one provider API key.");
        process.exit(2);
    }
    if (failed > 0) {
        console.log(`[regression] ${failed} failed`);
        process.exit(1);
    }
    console.log("[regression] all green");
}

void main().catch((err) => {
    console.error("[regression] FATAL:", err);
    process.exit(1);
});
