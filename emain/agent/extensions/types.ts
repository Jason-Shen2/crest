// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// extensions/types.ts — headless subset of pi's extension types
// (packages/coding-agent/src/core/extensions/types.ts, earendil-works/pi,
// MIT). Ported for crest's "拷 loader 核心 + 重接线" headless port.
//
// pi's types.ts is ~1500 lines, most of it pi-tui render types (custom
// components, widgets, message/entry renderers) plus pi AgentSession /
// ModelRegistry / SessionManager wiring. crest stripped the TUI layer and
// runs the agent inside AgentHarness, so this file keeps only the shapes a
// headless extension needs: the factory contract, the ExtensionAPI surface,
// the Extension record the loader fills, the minimal ExtensionContext handed
// to handlers, and the ExtensionRuntime seam the loader/bind layer wires to
// AgentHarness. UI-only capabilities (ctx.ui.*, shortcuts, custom renderers)
// are accepted-but-inert so existing extension source still loads.

import type { AgentMessage, AgentTool } from "../types";

/** A tool an extension registers. Same shape crest's harness consumes. */
export type ToolDefinition = AgentTool;

export const ExtensionCompatibilityStatuses = [
    "native-gui",
    "terminal-surface",
    "accepted-inert",
    "unsupported",
    "not-applicable",
] as const;

export type ExtensionCompatibilityStatus = (typeof ExtensionCompatibilityStatuses)[number];

export interface ExtensionCompatibilityItem {
    id: string;
    label: string;
    status: ExtensionCompatibilityStatus;
    notes: string;
}

export const ExtensionBehaviorRequirementStatuses = ["covered", "partial", "planned", "not-applicable"] as const;

export type ExtensionBehaviorRequirementStatus = (typeof ExtensionBehaviorRequirementStatuses)[number];

export interface ExtensionBehaviorRequirement {
    id: string;
    label: string;
    requirement: string;
    status: ExtensionBehaviorRequirementStatus;
    evidence: string[];
}

export const ExtensionComponentCertificationStatuses = ["planned", "passing", "unsupported"] as const;

export type ExtensionComponentCertificationStatus = (typeof ExtensionComponentCertificationStatuses)[number];

export interface ExtensionComponentCompatibilityItem extends ExtensionCompatibilityItem {
    behaviorRequirements: ExtensionBehaviorRequirement[];
    behavior?: string[];
    plannedBehavior?: string[];
    certification?: ExtensionComponentCertificationStatus;
}

export const ExtensionScopes = ["global", "workspace", "session", "headless"] as const;

export type ExtensionScope = (typeof ExtensionScopes)[number];

export const ExtensionRuntimeStatuses = ["discovered", "loaded", "active", "failed", "disabled", "disposed"] as const;

export type ExtensionRuntimeStatus = (typeof ExtensionRuntimeStatuses)[number];

export interface ExtensionGraphError {
    phase: "load" | "activate" | "hook" | "command" | "ui" | "dispose" | "reload";
    message: string;
    timestamp: number;
    stack?: string;
}

export interface ExtensionGraphNode {
    id: string;
    name: string;
    version: string;
    path: string;
    scope: ExtensionScope;
    status: ExtensionRuntimeStatus;
    commands: string[];
    tools: string[];
    hooks: string[];
    flags: string[];
    errors: ExtensionGraphError[];
}

export interface ExtensionGraph {
    generation: number;
    nodes: ExtensionGraphNode[];
}

/**
 * Provenance for a registered resource. pi's createSyntheticSourceInfo
 * returns a much richer object (used by the TUI to render "from
 * <extension>" badges); headless crest only needs enough to attribute
 * diagnostics, so this is trimmed to the fields the loader sets.
 */
export interface SourceInfo {
    source: string;
    path?: string;
    baseDir?: string;
}

/** Handler signature for pi lifecycle/hook events. */
export type HandlerFn = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

/** A command registered via pi.registerCommand(). */
export interface RegisteredCommand {
    name: string;
    sourceInfo: SourceInfo;
    description?: string;
    argumentHint?: string;
    aliases?: string[];
    handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
}

/** A flag registered via pi.registerFlag(). Stored; inert in headless. */
export interface RegisteredFlag {
    name: string;
    extensionPath: string;
    description?: string;
    type: "boolean" | "string";
    default?: boolean | string;
}

/** A shortcut registered via pi.registerShortcut(). Stored; inert in headless. */
export interface RegisteredShortcut {
    shortcut: string;
    extensionPath: string;
    description?: string;
    handler: (ctx: ExtensionContext) => void | Promise<void>;
}

/** Provider registered via pi.registerProvider(). Captured for crest model wiring. */
export interface RegisteredProvider {
    name: string;
    extensionPath: string;
    config: unknown;
}

/** Renderer registered via pi.registerMessageRenderer/EntryRenderer. Inert in headless. */
export type MessageRenderer<T = unknown> = (data: T) => unknown;
export type EntryRenderer<T = unknown> = (data: T) => unknown;

/**
 * The mutable record the loader builds for one extension. Registration
 * methods on ExtensionAPI write here; the bind layer reads handlers/tools/
 * commands back out to wire them into AgentHarness.
 */
export interface Extension {
    path: string;
    resolvedPath: string;
    sourceInfo: SourceInfo;
    handlers: Map<string, HandlerFn[]>;
    tools: Map<string, { definition: ToolDefinition; sourceInfo: SourceInfo }>;
    commands: Map<string, RegisteredCommand>;
    flags: Map<string, RegisteredFlag>;
    shortcuts: Map<string, RegisteredShortcut>;
    messageRenderers: Map<string, MessageRenderer>;
    entryRenderers: Map<string, EntryRenderer>;
}

/** Result of one `exec` invocation. */
export interface ExecResult {
    stdout: string;
    stderr: string;
    code: number | null;
}

export interface ExecOptions {
    cwd?: string;
    env?: Record<string, string>;
    input?: string;
    timeoutMs?: number;
}

/**
 * Minimal context handed to event handlers and commands. pi's
 * ExtensionContext exposes the full session/model/UI surface; headless
 * crest provides cwd plus a no-op `ui` (auto-accepting confirms) so
 * extensions written for the TUI still run without a terminal.
 */
export interface ExtensionUI {
    notify(message: string, level?: "info" | "warn" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
    setWidget(key: string, value: unknown | undefined): void;
    setFooter(factory: unknown | undefined): void;
    setHeader(factory: unknown | undefined): void;
    confirm(title: string, message?: string): Promise<boolean>;
    select<T = string>(title: string, options: T[]): Promise<T | undefined>;
    input(title: string, initial?: string): Promise<string | undefined>;
    custom<T = unknown>(factory: unknown, options?: unknown): Promise<T | undefined>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
}

/** Current model as visible to extensions. Trimmed from pi's Model<Api>. */
export interface ExtensionModelInfo {
    provider: string;
    id: string;
    contextWindow?: number;
}

/** Context-window usage snapshot. `tokens`/`percent` are null when unknown. */
export interface ContextUsage {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
}

/**
 * Harness-backed capabilities the ExtensionContext delegates to. The bind
 * layer (harness-factory) supplies one wired to the live AgentHarness; when
 * absent (headless pre-bind / no harness) the context degrades gracefully.
 * Mirrors the read + safe-action subset of pi's ExtensionContext.
 */
export interface ExtensionContextHost {
    /** Whether the agent is idle (not streaming/compacting/navigating). */
    isIdle(): boolean;
    /** The current run's abort signal, or undefined when idle. */
    getSignal(): AbortSignal | undefined;
    /** The current model, or undefined when none is set. */
    getModel(): ExtensionModelInfo | undefined;
    /** The current effective system prompt. */
    getSystemPrompt(): Promise<string>;
    /** Current context-window usage for the active model. */
    getContextUsage(): Promise<ContextUsage>;
    /** Read-only access to the session tree. */
    getSessionEntries(): Promise<unknown[]>;
    getLeafId(): Promise<string | null>;
    /** Abort the current agent operation. */
    abort(): void;
    /** Trigger compaction without awaiting completion. */
    compact(customInstructions?: string): void;
}

/**
 * Command-only host extras. pi hands command handlers an
 * ExtensionCommandContext with session-control methods that are only safe in
 * user-initiated commands (opening/forking/switching sessions, sending
 * messages). The bind layer supplies these when a live pane owner exists.
 * The read surface is provided separately by the base ExtensionContext, so
 * this host carries only the command-only actions.
 */
export interface ExtensionCommandHost {
    /** Wait for the agent to finish streaming. */
    waitForIdle(): Promise<void>;
    /** Reload extensions, skills, prompts, themes. */
    reload(): Promise<void>;
    /** Navigate to a different point in the session tree. */
    navigateTree(
        targetId: string,
        options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
    ): Promise<{ cancelled: boolean }>;
    /** Start a new session (renderer-driven reset in crest). */
    newSession(): Promise<{ cancelled: boolean }>;
    /** Fork from a specific entry, creating a new session. */
    fork(entryId: string): Promise<{ cancelled: boolean }>;
    /** Switch to a different session file. */
    switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
    /** Send a message into the current session. */
    sendMessage(text: string, options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void>;
}

export interface ExtensionContext {
    /** Current working directory of the pane's agent session. */
    readonly cwd: string;
    /** True when a UI host (renderer or command owner) is attached. */
    readonly hasUI: boolean;
    /** No-op / auto-accepting UI shim. Check hasUI before relying on prompts. */
    readonly ui: ExtensionUI;
    /** Whether the agent is idle. True (optimistic) when no harness is bound. */
    isIdle(): boolean;
    /** The current run's abort signal, or undefined when idle / unbound. */
    readonly signal: AbortSignal | undefined;
    /** The current model, or undefined. */
    readonly model: ExtensionModelInfo | undefined;
    /** The current effective system prompt (empty string when unbound). */
    getSystemPrompt(): Promise<string>;
    /** Current context-window usage. Zeroed window when unbound. */
    getContextUsage(): Promise<ContextUsage>;
    /** Read-only session tree entries (empty when unbound). */
    getSessionEntries(): Promise<unknown[]>;
    /** Current leaf entry id, or null. */
    getLeafId(): Promise<string | null>;
    /** Abort the current agent operation. No-op when unbound. */
    abort(): void;
    /** Trigger compaction. No-op when unbound. */
    compact(customInstructions?: string): void;
}

/**
 * Extended context for command handlers. Adds session-control methods only
 * safe in user-initiated commands. Mirrors pi's ExtensionCommandContext.
 */
export interface ExtensionCommandContext extends ExtensionContext {
    waitForIdle(): Promise<void>;
    reload(): Promise<void>;
    navigateTree(
        targetId: string,
        options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
    ): Promise<{ cancelled: boolean }>;
    newSession(): Promise<{ cancelled: boolean }>;
    fork(entryId: string): Promise<{ cancelled: boolean }>;
    switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
    sendMessage(text: string, options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void>;
}

/**
 * Action seam the ExtensionAPI delegates to. The loader creates one with
 * throwing stubs (action methods are illegal during factory load); the
 * bind layer replaces them with AgentHarness-backed implementations once
 * the harness exists. Mirrors pi's createExtensionRuntime + bindCore.
 */
export interface ExtensionRuntime {
    appendEntry: (customType: string, data?: unknown) => void;
    getActiveTools: () => string[];
    setActiveTools: (toolNames: string[]) => void;
    getAllTools: () => string[];
    /** Called after registerTool so a bound runtime can refresh harness tools. */
    refreshTools: () => void;
    flagValues: Map<string, boolean | string>;
    providerRegistrations: RegisteredProvider[];
    assertActive: () => void;
    invalidate: (message?: string) => void;
}

/**
 * The `pi` object handed to an extension's factory. Headless subset:
 * registration methods (on/registerTool/registerCommand/registerFlag/
 * registerShortcut/renderers) plus a few action methods that delegate to
 * the runtime. Unsupported pi methods are intentionally omitted.
 */
export interface ExtensionAPI {
    on(event: string, handler: HandlerFn): void;
    registerTool(tool: ToolDefinition): void;
    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
    registerFlag(
        name: string,
        options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
    ): void;
    registerShortcut(
        shortcut: string,
        options: { description?: string; handler: (ctx: ExtensionContext) => void | Promise<void> },
    ): void;
    registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void;
    registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void;
    getFlag(name: string): boolean | string | undefined;
    appendEntry(customType: string, data?: unknown): void;
    exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
    getActiveTools(): string[];
    getAllTools(): string[];
    setActiveTools(toolNames: string[]): void;
    registerProvider(name: string, config: unknown): void;
    unregisterProvider(name: string): void;
}

/** An extension module's default export. */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

/** Aggregate result of a discovery + load pass. */
export interface LoadExtensionsResult {
    extensions: Extension[];
    errors: Array<{ path: string; error: string }>;
    runtime: ExtensionRuntime;
}

// Re-export for handler authors that want the crest message type.
export type { AgentMessage };
