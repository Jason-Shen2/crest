// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// harness-factory.ts — assembles an AgentHarnessHost for one agent
// session. AgentHarnessHost is a minimal adapter (intentionally not a
// "runtime wrapper") that exposes the env mutation seam pi otherwise
// leaves implicit. See docs/agent-runtime-architecture.md §5.4 / §7.4.
//
// All non-env behavior — subscribe, prompt, abort, message storage,
// model swap, queue management — is direct AgentHarness usage. The
// IPC layer (task #9) holds a Map<sessionPath, AgentHarnessHost> and uses
// it directly without wrapping further.

import type { Api, Model } from "@crest/ai";
import { AgentHarness } from "./harness/agent-harness";
import type {
    Session,
    SessionContext,
    SessionTreeEntry,
    Skill,
    ToolCallEvent,
    ToolCallResult,
} from "./harness/types";
import { NodeExecutionEnv } from "./node";
import type { ToolCallHook } from "./permissions";
import type { ProjectContextFile } from "./resource-loader";
import type { AgentTool, ThinkingLevel } from "./types";
import { buildSystemPrompt, type SystemPromptInputs } from "./build-system-prompt";

export type AgentAuthResolver = (
    model: Model<Api>
) => Promise<{ apiKey: string; headers?: Record<string, string> } | undefined>;

export interface BuildAgentHarnessHostOptions {
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
    /**
     * Project context files (AGENTS.md / CLAUDE.md) loaded via
     * loadProjectContextFiles, injected into the system prompt's
     * <project_context> block. Optional — omit when none apply.
     */
    contextFiles?: ProjectContextFile[];
    /**
     * Skills available to the model, injected into the system prompt
     * when the read tool is active. Optional.
     */
    skills?: Skill[];
    /**
     * Optional tool_call gate (typically from buildPermissionsHook).
     * AgentHarness invokes this before executing every tool call.
     * Returning undefined allows; {block: true, reason} denies and
     * surfaces `reason` as the tool result text (visible inline in
     * the agent block). See emain/agent/permissions.ts and
     * docs/agent-runtime-architecture.md §7.9.
     */
    toolCallHook?: ToolCallHook;
    /**
     * Resolves the API key (+ optional headers) for the model's
     * provider. pi-ai calls this per request; without it, pi-ai falls
     * back to provider env vars (e.g. OPENROUTER_API_KEY), which crest
     * doesn't set — keys live in the safeStorage secret store. The IPC
     * layer resolves the key (literal token or secretstore lookup) and
     * passes it here.
     */
    getApiKeyAndHeaders?: AgentAuthResolver;
    transformSessionContext?: (input: {
        entries: SessionTreeEntry[];
        context: SessionContext;
    }) => Promise<SessionContext>;
}

export interface AgentHarnessHost {
    /** The underlying pi AgentHarness. Use directly for subscribe/prompt/abort. */
    readonly harness: AgentHarness;
    readonly session: Session;
    appendCustomEntry(customType: string, data?: unknown): Promise<void>;
    promptWithCustomEntry(customType: string, data: unknown, text: string): Promise<unknown>;
    setAuthResolver(resolver?: AgentAuthResolver): void;
    setToolCallHook(hook?: ToolCallHook): void;
    resolveAuth(model: Model<Api>): Promise<{ apiKey: string; headers?: Record<string, string> } | undefined>;
    runToolCallHook(event: ToolCallEvent): Promise<ToolCallResult | undefined>;
    getCwd(): string;
    /**
     * Refresh pane state. Mutates the harness's env.cwd (so tool
     * execution targets the latest dir) and the system-prompt input
     * closure (so the next turn's prompt reflects the new cwd / git /
     * recent commands). Cheap — just two assignments. Call before
     * each send if any pane state changed.
     */
    update(inputs: SystemPromptInputs): void;
}

export function buildAgentHarnessHost(opts: BuildAgentHarnessHostOptions): AgentHarnessHost {
    let inputs: SystemPromptInputs = opts.promptInputs;
    let authResolver = opts.getApiKeyAndHeaders;
    let toolCallHook = opts.toolCallHook;
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
        // The harness invokes this once per LLM call (not once per harness
        // construction), passing the turn's activeTools — so the Available
        // tools list and tool-specific guidelines reflect exactly which
        // tools are enabled this turn. Mirrors pi's _rebuildSystemPrompt
        // (coding-agent/src/core/agent-session.ts).
        systemPrompt: ({ activeTools }) => {
            const toolSnippets: Record<string, string> = {};
            const promptGuidelines: string[] = [];
            for (const tool of activeTools) {
                if (tool.promptSnippet) toolSnippets[tool.name] = tool.promptSnippet;
                if (tool.promptGuidelines) promptGuidelines.push(...tool.promptGuidelines);
            }
            return buildSystemPrompt({
                ...inputs,
                selectedTools: activeTools.map((tool) => tool.name),
                toolSnippets,
                promptGuidelines,
                contextFiles: opts.contextFiles,
                skills: opts.skills,
            });
        },
        getApiKeyAndHeaders: async (model) => authResolver?.(model),
        transformSessionContext: opts.transformSessionContext,
    });
    harness.on("tool_call", async (event) => toolCallHook?.(event));
    return {
        harness,
        session: opts.session,
        appendCustomEntry: (customType: string, data?: unknown) => harness.appendCustomEntry(customType, data),
        promptWithCustomEntry: (customType: string, data: unknown, text: string) =>
            harness.promptWithCustomEntry(customType, data, text),
        setAuthResolver(next): void {
            authResolver = next;
        },
        setToolCallHook(next): void {
            toolCallHook = next;
        },
        async resolveAuth(model): Promise<{ apiKey: string; headers?: Record<string, string> } | undefined> {
            return authResolver?.(model);
        },
        async runToolCallHook(event): Promise<ToolCallResult | undefined> {
            return toolCallHook?.(event);
        },
        getCwd(): string {
            return inputs.cwd;
        },
        update(next: SystemPromptInputs): void {
            inputs = next;
            env.cwd = next.cwd;
        },
    };
}
