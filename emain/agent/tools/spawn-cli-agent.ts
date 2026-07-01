// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// spawn-cli-agent.ts — the main-agent-facing delegation tool plus the
// subagent driver. runSubagentToCompletion drives the subagent harness
// to convergence and extracts its natural-language summary. See spec §5
// (decision 5), §7.

import { type Static, Type } from "typebox";
import type { Api, Model } from "../../ai";
import { buildCliSubagentHarness } from "../cli-subagent-factory";
import type { CliSubagentHarness } from "../cli-subagent-factory";
import type { Session } from "../harness/types";
import type { AgentTool } from "../types";
import { startAgentCommandBlock, stopBlock } from "./_pty-rpc";

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

const spawnSchema = Type.Object({
    task: Type.String({
        description: "Natural-language goal, e.g. start the dev server and confirm it listens on 3000.",
    }),
    initial_command: Type.String({ description: "The long-running / interactive command to start." }),
    cwd: Type.String(),
});

export type SpawnCliAgentInput = Static<typeof spawnSchema>;

export interface SpawnCliAgentDetails {
    blockId: string;
}

export interface SpawnCliAgentDeps {
    /** The main agent's own terminal pane block id — used to resolve the tab the new run block is created on. */
    parentBlockId: string;
    model: Model<Api>;
    /** Mint an ephemeral in-memory session for the subagent. */
    createSession: () => Promise<Session>;
    maxTurns?: number;
    getApiKeyAndHeaders?: (
        model: Model<Api>,
    ) => Promise<{ apiKey: string; headers?: Record<string, string> } | undefined>;
}

export function createSpawnCliAgentTool(deps: SpawnCliAgentDeps): AgentTool<typeof spawnSchema, SpawnCliAgentDetails> {
    return {
        name: "spawn_cli_agent",
        label: "spawn cli agent",
        description:
            "Delegate a long-running or interactive shell command to a CLI subagent. Provide a natural-language task and the initial command; the subagent starts it, watches/interacts, and returns a natural-language summary. Use this instead of bash when the command will not exit on its own.",
        promptSnippet: "Delegate long-running / interactive commands to a CLI subagent.",
        parameters: spawnSchema,
        async execute(_toolCallId, params, signal) {
            const blockId = await startAgentCommandBlock(deps.parentBlockId, params.cwd, params.initial_command);
            const session = await deps.createSession();
            const sub = buildCliSubagentHarness({
                session,
                model: deps.model,
                blockId,
                cwd: params.cwd,
                getApiKeyAndHeaders: deps.getApiKeyAndHeaders,
            });
            const onAbort = () => {
                void sub.harness.abort();
                void stopBlock(blockId);
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            try {
                const summary = await runSubagentToCompletion(sub, params.task, {
                    maxTurns: deps.maxTurns ?? 20,
                    signal,
                });
                return { content: [{ type: "text", text: summary }], details: { blockId } };
            } finally {
                signal?.removeEventListener("abort", onAbort);
            }
        },
    };
}
