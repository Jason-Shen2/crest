// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// permissions.ts — per-pane tool gating via pi's AgentHarness
// "tool_call" event hook. Replaces the deleted Go pkg/agent/permissions/
// posture-and-rules engine with a small allowlist + bench-mode bypass.
// See docs/agent-runtime-architecture.md §7.9 for the decision to drop
// posture (1500 LOC Go) in favor of this 50-line shape.
//
// Note: AgentHarness exposes its tool gate via the typed `.on("tool_call", ...)`
// handler (not pi Agent's bare `beforeToolCall` constructor option). The
// callback gets ToolCallEvent and returns ToolCallResult — slimmer shape
// than pi Agent's BeforeToolCallContext, which is what we need anyway.
//
// v1 semantics:
//   - allowAll: true       → every tool call passes (default; the
//                            renderer UX for selective approval is not
//                            wired yet, so the agent stays functional)
//   - allowedTools: [...]  → only listed names pass; others get a
//                            block:true response with a readable reason
//                            that surfaces as the tool result content
//                            (and thus appears inline in the agent block)
//
// Future work (not v1):
//   - Interactive "approve this tool call?" UI — return a Promise that
//     resolves on user click. Requires task #12's IPC channel for
//     prompt → renderer-click → response round-trip.
//   - Per-tool-args matching (e.g. allow `bash` for `git status` but
//     not `rm -rf`) — the dropped posture/rules engine did this; add
//     per-pattern matching in this file when actually needed, without
//     resurrecting the full posture machinery.

import type { ToolCallEvent, ToolCallResult } from "@crest/agent/harness/types";

export interface PermissionsConfig {
    /**
     * Tool names pre-approved for this pane. Ignored when allowAll is true.
     * Names match the `name` field of AgentTool definitions registered
     * with the harness.
     */
    allowedTools?: string[];
    /**
     * When true, every tool call passes (no allowlist check). Set by
     * the bench harness via CREST_AGENT_BENCH=1 so eval runs aren't
     * gated by per-tool approvals. Defaults to true in v1 because no
     * approval UI exists yet — agent functionality must not regress.
     */
    allowAll?: boolean;
}

export type ToolCallHook = (
    event: ToolCallEvent,
) => Promise<ToolCallResult | undefined>;

/**
 * Construct a tool_call handler compatible with AgentHarness's
 * .on("tool_call", ...) registration. Returns undefined to allow
 * the call, or {block: true, reason} to deny.
 */
export function buildPermissionsHook(config: PermissionsConfig = {}): ToolCallHook {
    const allowAll = config.allowAll ?? true;
    const allowSet = new Set(config.allowedTools ?? []);
    return async (event) => {
        if (allowAll) return undefined;
        if (allowSet.has(event.toolName)) return undefined;
        return {
            block: true,
            reason: `Tool "${event.toolName}" is not allowed for this session.`,
        };
    };
}

/**
 * Read CREST_AGENT_BENCH from the environment. Set by the eval harness
 * (and tests) to disable allowlist enforcement.
 */
export function isBenchMode(): boolean {
    return process.env.CREST_AGENT_BENCH === "1";
}
