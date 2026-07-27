// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// cli-subagent-factory.ts — assembles the second AgentHarness that the
// CLI subagent runs in. Ephemeral in-memory session (decision 4), the
// three PTY tools bound to one already-started command, an independent
// system prompt (§8), and its own (smaller) model. Mirrors
// buildAgentHarnessHost but never touches the SQLite session repo. See spec §2, §9.

import type { Api, Model } from "../ai";
import type { AgentPtyCommandPort } from "./agent-pty-host";
import { AgentHarness } from "./harness/agent-harness";
import type { Session } from "./harness/types";
import { NodeExecutionEnv } from "./node";
import { createPtyReadTool } from "./tools/pty-read";
import { createPtyTransferTool } from "./tools/pty-transfer";
import { createPtyWriteTool } from "./tools/pty-write";
import type { AgentTool } from "./types";

export const CLI_SUBAGENT_TOOL_NAMES = ["pty_write", "pty_read", "pty_transfer_to_user"] as const;

const CLI_SUBAGENT_SYSTEM_PROMPT = [
    "You are a CLI subagent driving a single long-running or interactive PTY command.",
    "The parent agent has already started the command in a hosted PTY. Do not type or paste the startup command again.",
    "Your goal is the delegated task. When it is done, call pty_transfer_to_user only if you are stuck; otherwise stop and summarize.",
    "Rules:",
    "1. Goal-oriented: finish the task, then stop. Do not explore beyond it.",
    "2. Look before you act: call pty_read to confirm current output/screen before sending input.",
    "3. Quote errors verbatim: include exact error text and file:line in your summary — the main agent relies on it.",
    "4. When stuck (waiting for a password or a human decision), call pty_transfer_to_user instead of guessing.",
    "5. When the task is complete (or the command is confirmed running), stop and return a concise summary — do not keep polling.",
].join("\n");

export interface BuildCliSubagentOptions {
    session: Session;
    model: Model<Api>;
    command: AgentPtyCommandPort;
    cwd: string;
    initialCommand: string;
    getApiKeyAndHeaders?: (
        model: Model<Api>
    ) => Promise<{ apiKey: string; headers?: Record<string, string> } | undefined>;
}

export interface CliSubagentHarness {
    readonly harness: AgentHarness;
    readonly session: Session;
    readonly tools: AgentTool[];
}

export function buildCliSubagentHarness(opts: BuildCliSubagentOptions): CliSubagentHarness {
    const tools: AgentTool[] = [
        createPtyWriteTool(opts.command, { initialCommand: opts.initialCommand, cwd: opts.cwd }),
        createPtyReadTool(opts.command),
        createPtyTransferTool(opts.command),
    ];
    const env = new NodeExecutionEnv({ cwd: opts.cwd });
    const harness = new AgentHarness({
        env,
        session: opts.session,
        model: opts.model,
        thinkingLevel: "off",
        tools,
        systemPrompt: () => CLI_SUBAGENT_SYSTEM_PROMPT,
        getApiKeyAndHeaders: opts.getApiKeyAndHeaders,
    });
    return { harness, session: opts.session, tools };
}
