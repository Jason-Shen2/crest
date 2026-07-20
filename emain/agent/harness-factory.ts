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

import type { Api, Model } from "../ai";
import {
	bindExtensionRuntime,
	createExtensionContext,
	mergeBaseAndExtensionTools,
	wireExtensionHooks,
} from "./extensions";
import type {
	Extension,
	ExtensionContext,
	ExtensionContextHost,
	ExtensionModelInfo,
	ExtensionRuntime,
	ExtensionUiBridge,
} from "./extensions";
import type { ExtensionLifecycleHost } from "./extensions/lifecycle";
import { AgentHarness } from "./harness/agent-harness";
import type { PromptTemplate, Session, Skill, ToolCallEvent, ToolCallResult } from "./harness/types";
import { NodeExecutionEnv } from "./node";
import type { ToolCallHook } from "./permissions";
import type { ProjectContextFile } from "./resource-loader";
import type { AgentTool, ThinkingLevel } from "./types";
import { buildSystemPrompt, type SystemPromptInputs } from "./build-system-prompt";

export type AgentAuthResolver = (
    model: Model<Api>
) => Promise<{ apiKey: string; headers?: Record<string, string> } | undefined>;

export interface BuildAgentHarnessHostOptions {
    /** Session this host is bound to. Mint via createPaneSession() first. */
    session: Session;
    /** Resolved model from the frontend ai-resolver, threaded through IPC. */
    model: Model<Api>;
    /** Reasoning effort, when the model supports it. */
    thinkingLevel?: ThinkingLevel;
    /** Initial execution context — cwd / git / recent cmds. Mutable via update(). */
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
    /** Prompt templates available for explicit invocation via the harness. */
    promptTemplates?: PromptTemplate[];
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
    /**
     * Loaded headless extensions (from loadAgentExtensions). Their tools are
     * merged into the harness tool set and their hook handlers are wired onto
     * the harness after construction. The shared runtime is bound to the live
     * harness so extension action methods (appendEntry / setActiveTools) work.
     * Omit when no extensions apply.
     */
    extensions?: Extension[];
    /** Shared runtime returned alongside `extensions` by loadAgentExtensions. */
    extensionRuntime?: ExtensionRuntime;
    /**
     * Late-bound UI bridge for ctx.ui. When present, extension ctx.ui calls
     * (notify / setStatus / setWidget / confirm / select / input) route to the
     * renderer instead of the headless no-op. The IPC layer creates the bridge,
     * passes it here, and attaches the AgentSessionRuntime as its host once the
     * owner is constructed. Omit for a fully headless harness.
     */
    extensionUiBridge?: ExtensionUiBridge;
    /** Stable owner/session id used to attribute lifecycle disposers. */
    extensionLifecycleOwnerId?: string;
    /** Lifecycle owner that disposes extension hook subscriptions for this harness. */
    extensionLifecycleHost?: ExtensionLifecycleHost;
}

export interface AgentHarnessHost {
    /** The underlying pi AgentHarness. Use directly for subscribe/prompt/abort. */
    readonly harness: AgentHarness;
    readonly session: Session;
    /**
     * Loaded extensions bound to this harness. Command dispatch (see
     * AgentSessionRuntime.runExtensionCommand) looks up a registered command here
     * and invokes its handler with `ctx`. Empty when no extensions loaded.
     */
    readonly extensions: Extension[];
    /**
     * The live ExtensionContext handed to extension command handlers. Reads the
     * current env.cwd and routes ctx.ui through the runtime's attached UI host.
     */
    readonly ctx: ExtensionContext;
    /**
     * The shared extension runtime bound to this harness. Holds live flag
     * values (runtime.flagValues), which the IPC layer reads/writes for the
     * flag surface (agent:list-flags / agent:set-flag). Undefined when no
     * extensions loaded.
     */
    readonly extensionRuntime?: ExtensionRuntime;
    readonly extensionLifecycleOwnerId?: string;
    readonly extensionLifecycleHost?: ExtensionLifecycleHost;
    appendCustomEntry(customType: string, data?: unknown): Promise<void>;
    promptWithCustomEntry(customType: string, data: unknown, text: string): Promise<unknown>;
    setAuthResolver(resolver?: AgentAuthResolver): void;
    setToolCallHook(hook?: ToolCallHook): void;
    resolveAuth(model: Model<Api>): Promise<{ apiKey: string; headers?: Record<string, string> } | undefined>;
    runToolCallHook(event: ToolCallEvent): Promise<ToolCallResult | undefined>;
    getCwd(): string;
    /**
     * Refresh execution state. Mutates the harness's env.cwd (so tool
     * execution targets the latest dir) and the system-prompt input
     * closure (so the next turn's prompt reflects the new cwd / git /
     * recent commands). Cheap — just two assignments. Call before
     * each send if any workspace context changed.
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
    const baseTools = opts.tools ?? [];
    const extensions = opts.extensions ?? [];
    // Extension tools are merged into the harness tool set at construction so
    // they're active from the first turn. Base tools win on name clash.
    const mergedTools = mergeBaseAndExtensionTools(baseTools, extensions);
    const harness = new AgentHarness({
        env,
        session: opts.session,
        model: opts.model,
        thinkingLevel: opts.thinkingLevel ?? "off",
        tools: mergedTools,
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
        resources: {
            skills: opts.skills,
            promptTemplates: opts.promptTemplates,
        },
        getApiKeyAndHeaders: async (model) => authResolver?.(model),
    });
    harness.on("tool_call", async (event) => toolCallHook?.(event));
    // Always create the ctx so it can be surfaced on AgentHarnessHost for command
    // dispatch, even when no hook handlers exist. It reads env.cwd live and
    // routes ctx.ui through the attached UI bridge. The host delegates the
    // read + safe-action surface (isIdle/signal/model/systemPrompt/usage/
    // entries/leaf/abort/compact) to the live harness.
    const host: ExtensionContextHost = {
        isIdle: () => harness.isIdle(),
        getSignal: () => harness.getCurrentSignal(),
        getModel: (): ExtensionModelInfo => {
            const model = harness.getModel();
            return { provider: model.provider, id: model.id, contextWindow: model.contextWindow };
        },
        getSystemPrompt: () => harness.buildSystemPrompt(),
        getContextUsage: () => harness.getContextUsage(),
        getSessionEntries: () => harness.getSession().getEntries(),
        getLeafId: () => harness.getSession().getLeafId(),
        abort: () => {
            void harness.abort().catch((error) => {
                console.warn("[extension] ctx.abort() failed:", error);
            });
        },
        compact: (customInstructions?: string) => {
            void harness.compact(customInstructions).catch((error) => {
                console.warn("[extension] ctx.compact() failed:", error);
            });
        },
    };
    const ctx = createExtensionContext(() => env.cwd, opts.extensionUiBridge, host);
    if (extensions.length > 0) {
        // Bind the shared runtime's action methods to this live harness, then
        // wire each extension's hook handlers. The lifecycle host owns the
        // returned cleanup when the session runtime provides one.
        if (opts.extensionRuntime) {
            bindExtensionRuntime(opts.extensionRuntime, harness, baseTools, extensions);
        }
        const cleanupExtensionHooks = wireExtensionHooks(harness, extensions, ctx);
        if (opts.extensionLifecycleHost && opts.extensionLifecycleOwnerId) {
            opts.extensionLifecycleHost.registerDispose(opts.extensionLifecycleOwnerId, cleanupExtensionHooks);
        }
    }
    return {
        harness,
        session: opts.session,
        extensions,
        ctx,
        extensionRuntime: opts.extensionRuntime,
        extensionLifecycleOwnerId: opts.extensionLifecycleOwnerId,
        extensionLifecycleHost: opts.extensionLifecycleHost,
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
