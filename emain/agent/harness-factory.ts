// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// harness-factory.ts — assembles a PaneHarness for one pane's agent
// session. PaneHarness is a minimal adapter (intentionally not a
// "runtime wrapper") that exposes the env mutation seam pi otherwise
// leaves implicit. See docs/agent-runtime-architecture.md §5.4 / §7.4.
//
// All non-env behavior — subscribe, prompt, abort, message storage,
// model swap, queue management — is direct AgentHarness usage. The
// IPC layer (task #9) holds a Map<sessionPath, PaneHarness> and uses
// it directly without wrapping further.

import type { Api, Model } from "../ai";
import { AgentHarness } from "./harness/agent-harness";
import type { Session } from "./harness/types";
import { NodeExecutionEnv } from "./node";
import type { AgentTool, ThinkingLevel } from "./types";
import { buildSystemPrompt, type SystemPromptInputs } from "./build-system-prompt";

export interface BuildPaneHarnessOptions {
    /** Session this pane is bound to. Mint via createPaneSession() first. */
    session: Session;
    /** Resolved model from the frontend ai-resolver, threaded through IPC. */
    model: Model<Api>;
    /** Reasoning effort, when the model supports it. */
    thinkingLevel?: ThinkingLevel;
    /** Initial pane context — cwd / git / recent cmds. Mutable via update(). */
    promptInputs: SystemPromptInputs;
    /** Tool definitions. Empty until task #10 wires the crest tools. */
    tools?: AgentTool[];
}

export interface PaneHarness {
    /** The underlying pi AgentHarness. Use directly for subscribe/prompt/abort. */
    readonly harness: AgentHarness;
    /**
     * Refresh pane state. Mutates the harness's env.cwd (so tool
     * execution targets the latest dir) and the system-prompt input
     * closure (so the next turn's prompt reflects the new cwd / git /
     * recent commands). Cheap — just two assignments. Call before
     * each send if any pane state changed.
     */
    update(inputs: SystemPromptInputs): void;
}

export function buildPaneHarness(opts: BuildPaneHarnessOptions): PaneHarness {
    let inputs: SystemPromptInputs = opts.promptInputs;
    // env.cwd is publicly mutable on NodeExecutionEnv (harness/env/nodejs.ts:218);
    // we keep one env for the harness's lifetime and mutate it in place.
    const env = new NodeExecutionEnv({ cwd: inputs.cwd });
    const harness = new AgentHarness({
        env,
        session: opts.session,
        model: opts.model,
        thinkingLevel: opts.thinkingLevel ?? "off",
        tools: opts.tools ?? [],
        // Function form so each turn re-reads the latest inputs closure.
        // The harness invokes this once per LLM call, not once per harness
        // construction — picker model changes mid-conversation also work
        // because pi's AgentHarness threads this through every turn.
        systemPrompt: () => buildSystemPrompt(inputs),
    });
    return {
        harness,
        update(next: SystemPromptInputs): void {
            inputs = next;
            env.cwd = next.cwd;
        },
    };
}
