// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// agent-session-runtime.ts — the per-session conversation OWNER.
//
// This is pi's `AgentSession` aggregator pattern, applied at the
// AgentHarness layer and adapted for crest's process split. pi's own
// coding-agent wraps the low-level `Agent` (which exposes synchronous
// `state.messages`) in an `AgentSession` that subscribes once, owns the
// authoritative transcript + the steer/followUp queues, and re-emits to
// the UI (packages/coding-agent/src/core/agent-session.ts:157/336/811).
//
// crest consumes the higher-level `AgentHarness` instead — the right
// layer for an embedder, because the harness bundles session persistence
// and queue management and is event-driven (the renderer lives in another
// process and can't read synchronous state across IPC anyway). What was
// missing was the *owner*: harness events were scattered into a loose Map
// (updated only on agent_end) and concurrent sends were handled by
// catching a "busy" error. This class is that single owner:
//
//   - subscribes to the harness ONCE at construction (before any prompt),
//   - maintains the authoritative `messages` from the live event stream
//     (message_start/update/end) and reconciles on agent_end,
//   - mirrors the steer/followUp queues from the harness's own
//     `queue_update` events,
//   - tracks run status (idle/streaming/error),
//   - routes send() to prompt-vs-followUp from its own synchronously
//     tracked run state — NOT by catching AgentHarnessError("busy"),
//   - re-emits the harness event stream to its subscribers (the IPC layer
//     registers one subscriber per renderer) and replays getSessionState() so
//     a late/re-subscribing renderer converges to the owned state.
//
// See docs/agent-rendering-architecture.md.

import type { Api, Model } from "../ai";
import type { SystemPromptInputs } from "./build-system-prompt";
import type { ChangeOutline } from "./change-review/change-outline";
import { filterTreeForDisplay } from "./commands/session-views";
import type { AgentCommandExecutionResult } from "./commands/types";
import { createCommandContext } from "./extensions";
import type { ExtensionCommandHost, ExtensionUiBridge, ExtUiRequest, WidgetEvent } from "./extensions";
import { unregisterExtensionLifecycleHost } from "./extensions/lifecycle";
import type { WidgetNode } from "./extensions/pi-gui/crest/widget-tree";
import type { AgentAuthResolver, AgentHarnessHost } from "./harness-factory";
import type { AgentHarnessEvent, SessionTreeEntry } from "./harness/types";
import type { ToolCallHook } from "./permissions";
import type { AgentMessage, ThinkingLevel } from "./types";

export type AgentSessionRuntimeStatus = "idle" | "streaming" | "error";
export type AgentTurnStatus = "streaming" | "done" | "error";
export type ExtensionUiTerminationReason = "abort" | "reload" | "dispose";

export class ExtensionUiRequestTerminatedError extends Error {
    readonly code = "EXT_UI_REQUEST_TERMINATED";

    constructor(readonly reason: ExtensionUiTerminationReason) {
        super(`extension UI request terminated: ${reason}`);
        this.name = "ExtensionUiRequestTerminatedError";
    }
}

export interface ExtensionUiSnapshot {
    statuses: Record<string, string>;
    widgets: Record<string, string[]>;
    widgetnodes: Record<string, WidgetNode>;
    header?: WidgetNode;
    footer?: WidgetNode;
}

export interface ExtensionReloadState {
    ui: ExtensionUiSnapshot;
    flags: Record<string, boolean | string>;
}

export interface AgentTurn {
    // Identity of the turn = the session entry id of the user message that
    // started it (see applyMessageUpdateToTurn).
    turnId: string;
    userMessage?: AgentMessage;
    responseMessages: AgentMessage[];
    status: AgentTurnStatus;
    errorMessage?: string;
    changeOutline?: ChangeOutline;
}

/**
 * The owned conversation state at a point in time. Replayed to every new
 * subscriber so a renderer that attaches late (or re-attaches) mirrors the
 * authoritative state instead of reconstructing it from a partial stream.
 */
export interface AgentSessionRuntimeState {
    messages: AgentMessage[];
    turns: AgentTurn[];
    steerQueue: AgentMessage[];
    followUpQueue: AgentMessage[];
    status: AgentSessionRuntimeStatus;
    errorMessage?: string;
    extensionUi: ExtensionUiSnapshot;
}

export type AgentExtensionUiEvent =
    | { type: "ext_ui_notify"; message: string; level: "info" | "warn" | "error" }
    | { type: "ext_ui_status"; key: string; text: string | undefined }
    | { type: "ext_ui_widget"; key: string; lines: string[] | undefined }
    | { type: "ext_ui_widget"; key: string; widget: WidgetNode }
    | { type: "ext_ui_header"; widget: WidgetNode | undefined }
    | { type: "ext_ui_footer"; widget: WidgetNode | undefined }
    | { type: "ext_ui_request"; requestId: string; request: ExtUiRequest }
    | { type: "ext_ui_request_update"; requestId: string; widget: WidgetNode }
    | { type: "ext_ui_resolved"; requestId: string };

export type AgentSessionRuntimeEvent = AgentHarnessEvent | AgentExtensionUiEvent;
export type AgentSessionRuntimeListener = (event: AgentSessionRuntimeEvent) => void;
export type AgentTurnFinishedHook = (turn: AgentTurn) => void | Promise<void>;

interface AgentSessionRuntimeStateEvent {
    type: "session_state";
    messages: AgentMessage[];
    turns: AgentTurn[];
    status: AgentSessionRuntimeStatus;
    steer: AgentMessage[];
    followUp: AgentMessage[];
    extensionUi: ExtensionUiSnapshot;
}

export interface AgentSessionRuntimeOptions {
    onTurnFinished?: AgentTurnFinishedHook;
    extensionUiBridge?: ExtensionUiBridge;
    initialExtensionUi?: ExtensionUiSnapshot;
    initialFlagValues?: Record<string, boolean | string>;
}

export interface AgentExecutionConfig {
    promptInputs: SystemPromptInputs;
    model: Model<Api>;
    thinkingLevel: ThinkingLevel;
    authResolver?: AgentAuthResolver;
    toolCallHook?: ToolCallHook;
}

function makeEmptyExtensionUiSnapshot(): ExtensionUiSnapshot {
    return { statuses: {}, widgets: {}, widgetnodes: {} };
}

function cloneWidgetNode(widget: WidgetNode): WidgetNode {
    return structuredClone(widget);
}

function cloneExtensionUiSnapshot(snapshot: ExtensionUiSnapshot): ExtensionUiSnapshot {
    return {
        statuses: { ...snapshot.statuses },
        widgets: Object.fromEntries(Object.entries(snapshot.widgets).map(([key, lines]) => [key, [...lines]])),
        widgetnodes: Object.fromEntries(
            Object.entries(snapshot.widgetnodes).map(([key, widget]) => [key, cloneWidgetNode(widget)])
        ),
        header: snapshot.header == null ? undefined : cloneWidgetNode(snapshot.header),
        footer: snapshot.footer == null ? undefined : cloneWidgetNode(snapshot.footer),
    };
}

function acceptsFlagValue(type: "boolean" | "string", value: boolean | string): boolean {
    return type === "boolean" ? typeof value === "boolean" : typeof value === "string";
}

function isErroredAssistant(message: AgentMessage): boolean {
    return (
        (message as { role?: string }).role === "assistant" &&
        (message as { stopReason?: string }).stopReason === "error"
    );
}

/**
 * Deterministic turn reconstruction from a session branch. The session is the
 * single source of truth: each user message entry starts a turn keyed by its
 * own entry id, and the following non-user messages (until the next user
 * entry) become its responses. This mirrors the live stream, where a turn's
 * identity is the user message's session entry id (see applyMessageUpdateToTurn).
 */
export function buildPersistedTurnsFromSessionEntries(entries: SessionTreeEntry[]): AgentTurn[] {
    const turns: AgentTurn[] = [];
    let current: AgentTurn | undefined;
    for (const entry of entries) {
        if (entry.type !== "message") continue;
        const message = entry.message as AgentMessage;
        const role = (message as { role?: string }).role;
        if (role === "user") {
            current = { turnId: entry.id, userMessage: message, responseMessages: [], status: "done" };
            turns.push(current);
        } else if (current && (role === "assistant" || role === "tool" || role === "toolResult")) {
            current.responseMessages = [...current.responseMessages, message];
            if (isErroredAssistant(message)) {
                current.status = "error";
                current.errorMessage = (message as { errorMessage?: string }).errorMessage ?? "agent error";
            }
        }
    }
    return turns;
}

export class AgentSessionRuntime {
    readonly path: string;
    host: AgentHarnessHost;

    messages: AgentMessage[] = [];
    turns: AgentTurn[] = [];
    steerQueue: AgentMessage[] = [];
    followUpQueue: AgentMessage[] = [];
    status: AgentSessionRuntimeStatus = "idle";
    errorMessage: string | undefined;
    activeTurnId: string | undefined;
    extensionUi: ExtensionUiSnapshot;
    // Resolvers for in-flight send() promises, awaiting the userEntryId that
    // arrives on the user message_end event. FIFO: one resolver per send.
    private pendingEntryIdResolvers: Array<{ resolve: (id: string) => void; reject: (err: unknown) => void }> = [];
    configQueue: Promise<void> = Promise.resolve();

    // In-flight ctx.ui.confirm/select/input requests, keyed by a requestId we
    // mint per request. The renderer answers via respondUi(); abort/dispose
    // reject any still outstanding so an extension never hangs on a prompt.
    private pendingUiRequests = new Map<string, { resolve: (value: unknown) => void; reject: (err: unknown) => void }>();
    private customWidgetRequestIds = new Map<string, string>();
    private nextUiRequestId = 0;

    // Synchronous send-routing gate. Flipped true the instant we call
    // prompt() (which itself flips the harness phase synchronously), so a
    // same-tick burst of sends routes deterministically: the first starts
    // the run, the rest queue via followUp. Cleared when the run settles.
    running = false;

    listeners = new Set<AgentSessionRuntimeListener>();
    unsubscribeHarness: () => void;
    onTurnFinished: AgentTurnFinishedHook | undefined;
    extensionUiBridge: ExtensionUiBridge | undefined;

    constructor(
        path: string,
        host: AgentHarnessHost,
        initialMessages: AgentMessage[] = [],
        initialTurns: AgentTurn[] = [],
        options: AgentSessionRuntimeOptions = {}
    ) {
        this.path = path;
        this.host = host;
        this.onTurnFinished = options.onTurnFinished;
        this.extensionUiBridge = options.extensionUiBridge;
        this.extensionUi = cloneExtensionUiSnapshot(options.initialExtensionUi ?? makeEmptyExtensionUiSnapshot());
        const restoredFlagNames = new Set<string>();
        for (const extension of host.extensions) {
            for (const flag of extension.flags.values()) {
                if (restoredFlagNames.has(flag.name)) continue;
                restoredFlagNames.add(flag.name);
                const value = options.initialFlagValues?.[flag.name];
                if (value != null && acceptsFlagValue(flag.type, value)) {
                    host.extensionRuntime?.flagValues.set(flag.name, value);
                }
            }
        }
        // Seed the transcript from the persisted session so a REOPENED
        // conversation shows its history. A fresh session passes []. New
        // messages then accumulate via the live stream on top of this.
        this.messages = initialMessages;
        this.turns = initialTurns;
        // Attach BEFORE any prompt() runs so we never miss events — this is
        // what closes the "fast turn finished before the renderer
        // subscribed" race; the owner has the history regardless.
        this.unsubscribeHarness = host.harness.subscribe((event) => this.onHarnessEvent(event as AgentHarnessEvent));
    }

    /** Refresh execution context (cwd / git / recent cmds) for the next turn. */
    update(inputs: SystemPromptInputs): void {
        this.host.update(inputs);
    }

    isRunning(): boolean {
        return !this.host.harness.isIdle();
    }

    async syncExecutionConfig(config: AgentExecutionConfig): Promise<void> {
        this.host.update(config.promptInputs);
        this.host.setAuthResolver(config.authResolver);
        this.host.setToolCallHook(config.toolCallHook);
        const currentModel = this.host.harness.getModel();
        const sameModel =
            currentModel.provider === config.model.provider &&
            currentModel.id === config.model.id &&
            currentModel.api === config.model.api &&
            currentModel.baseUrl === config.model.baseUrl;
        if (!sameModel) {
            await this.host.harness.setModel(config.model);
        }
        if (this.host.harness.getThinkingLevel() !== config.thinkingLevel) {
            await this.host.harness.setThinkingLevel(config.thinkingLevel);
        }
    }

    sendWithExecutionConfig(text: string, config: AgentExecutionConfig): Promise<string> {
        const operation = this.configQueue.then(async () => {
            if (this.running) {
                return this.send(text, () => this.syncExecutionConfig(config));
            }
            await this.syncExecutionConfig(config);
            return this.send(text);
        });
        this.configQueue = operation.then(
            () => undefined,
            () => undefined
        );
        return operation;
    }

    private onHarnessEvent(event: AgentHarnessEvent): void {
        // Update owned state FIRST so a subscriber that reads getSessionState()
        // synchronously inside its callback sees the post-event state.
        this.applyToState(event);
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                console.error(`[agent-session] listener error for ${this.path}:`, err);
            }
        }
    }

    private applyToState(event: AgentHarnessEvent): void {
        switch (event.type) {
            case "agent_start":
            case "turn_start":
                this.status = "streaming";
                this.errorMessage = undefined;
                return;
            case "message_start": {
                const message = (event as { message?: AgentMessage }).message;
                if (!message) return;
                this.messages = [...this.messages, message];
                this.applyMessageStartToTurn(message);
                return;
            }
            case "message_update":
            case "message_end": {
                const message = (event as { message?: AgentMessage }).message;
                if (!message) return;
                if (this.messages.length === 0) {
                    this.messages = [message];
                } else {
                    const next = this.messages.slice();
                    next[next.length - 1] = message;
                    this.messages = next;
                }
                if (event.type === "message_end" && isErroredAssistant(message)) {
                    this.status = "error";
                    this.errorMessage = (message as { errorMessage?: string }).errorMessage ?? "agent error";
                }
                this.applyMessageUpdateToTurn(
                    message,
                    event.type === "message_end",
                    (event as { entryId?: string }).entryId
                );
                return;
            }
            case "agent_end": {
                // NOTE: agent_end.messages is RUN-SCOPED — only this
                // prompt()'s new messages (agent-loop.ts builds it as
                // `[...prompts]` + responses), NOT the full conversation. So
                // we must NOT replace `this.messages` with it; doing so wipes
                // every prior run (the "…loading agent run…" bug). The live
                // message_start/message_end stream already accumulated the
                // full transcript on top of the seeded history. agent_end is
                // only a run-lifecycle signal here.
                this.running = false;
                this.finishActiveTurn();
                if (this.status !== "error") this.status = "idle";
                return;
            }
            case "queue_update": {
                this.steerQueue = (event as { steer?: AgentMessage[] }).steer ?? [];
                this.followUpQueue = (event as { followUp?: AgentMessage[] }).followUp ?? [];
                return;
            }
            case "abort": {
                this.running = false;
                this.finishActiveTurn(false);
                if (this.status !== "error") this.status = "idle";
                // Any send() still awaiting its userEntryId will never get one:
                // abort clears the harness followUpQueue (agent-harness.ts:999)
                // so a queued-but-undrained followUp never emits a user
                // message_end. Reject those promises now — otherwise they hang
                // forever AND leave a stale resolver at the FIFO head, which
                // would mis-resolve the NEXT send. See agent-harness abort().
                this.rejectPendingSends(new Error("send aborted before the user message was committed"));
                this.terminatePendingUiRequests("abort");
                return;
            }
            default:
                return;
        }
    }

    getSessionState(): AgentSessionRuntimeState {
        return {
            messages: this.messages,
            turns: this.turns,
            steerQueue: this.steerQueue,
            followUpQueue: this.followUpQueue,
            status: this.status,
            errorMessage: this.errorMessage,
            extensionUi: cloneExtensionUiSnapshot(this.extensionUi),
        };
    }

    getReloadState(): ExtensionReloadState {
        return {
            ui: cloneExtensionUiSnapshot(this.extensionUi),
            flags: Object.fromEntries(this.host.extensionRuntime?.flagValues ?? []),
        };
    }

    subscribe(listener: AgentSessionRuntimeListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Send a user message. Resolves with the userEntryId of THIS send's user
     * message — the run identity, which only becomes known when the user
     * message_end event arrives (carrying the session entry id). Routes
     * prompt-vs-followUp from our own tracked run state — pi decides the same
     * way (it checks streaming state / queue mode before steer/followUp;
     * agent-session.ts:1225/1242), not by catching the harness "busy" error.
     * `running` flips synchronously so a burst of sends in one tick is
     * deterministic; prompt() flips the harness phase synchronously too, so a
     * followUp issued right after never hits the idle guard.
     */
    send(text: string, prepareFollowUp?: () => Promise<void>): Promise<string> {
        const promise = new Promise<string>((resolve, reject) => {
            this.pendingEntryIdResolvers.push({ resolve, reject });
        });
        if (this.running) {
            void this.host.harness
                .followUp(text, undefined, prepareFollowUp)
                .catch((err) => this.onSendError("followUp", err));
            return promise;
        }
        this.running = true;
        void this.startPromptTurn(text);
        return promise;
    }

    abort(): void {
        void this.host.harness.abort().catch((err) => {
            console.error(`[agent-session] abort error for ${this.path}:`, err);
        });
    }

    async listTreeEntries(): Promise<{
        entries: SessionTreeEntry[];
        leafId: string | null;
        labels: Map<string, string | undefined>;
    }> {
        const allEntries = await this.host.session.getEntries();
        const leafId = await this.host.session.getLeafId();
        const { entries, effectiveLeafId } = filterTreeForDisplay(allEntries, leafId);
        const labels = new Map<string, string | undefined>();
        for (const entry of entries) {
            labels.set(entry.id, await this.host.session.getLabel(entry.id));
        }
        return { entries, leafId: effectiveLeafId, labels };
    }

    async navigateTree(targetId: string): Promise<{ editorText?: string }> {
        const result = await this.host.harness.navigateTree(targetId, { summarize: false });
        if (result.cancelled) {
            return {};
        }
        await this.rebuildFromCurrentBranch();
        this.emitSessionState();
        return { editorText: result.editorText };
    }

    async compact(customInstructions?: string): Promise<void> {
        await this.host.harness.compact(customInstructions);
        await this.rebuildFromCurrentBranch();
        this.emitSessionState();
    }

    /**
     * Execute an extension-registered slash command (pi.registerCommand). Looks
     * the command up among this runtime's loaded extensions and invokes its handler
     * with a command context: the runtime's live ctx (correct cwd + attached ctx.ui
     * host) wrapped with the session-control methods pi exposes to command
     * handlers (waitForIdle / navigateTree / compact / sendMessage). Session
     * lifecycle actions that crest drives from the renderer (newSession / fork /
     * switchSession / reload) resolve as cancelled/no-op here — they require an
     * IPC round-trip the in-process owner can't perform. Returns a success/noop
     * result the renderer echoes into the command-result UI.
     */
    async runExtensionCommand(name: string, argsText: string): Promise<AgentCommandExecutionResult> {
        for (const extension of this.host.extensions) {
            const command = extension.commands.get(name);
            if (!command) continue;
            const ctx = createCommandContext(this.host.ctx, this.buildCommandHost());
            await command.handler(argsText, ctx);
            return { status: "success", message: `Ran extension command /${name}` };
        }
        return { status: "noop", message: `Extension command /${name} is not available.` };
    }

    /**
     * Activate an extension-registered keyboard shortcut (pi.registerShortcut).
     * Looks the shortcut up among this runtime's loaded extensions and invokes its
     * handler with the runtime's live ctx. Returns success/noop the renderer can
     * surface. Shortcut handlers receive the base ExtensionContext (not the
     * command context) — pi hands shortcuts the same read/UI surface.
     */
    async runShortcut(shortcut: string): Promise<AgentCommandExecutionResult> {
        for (const extension of this.host.extensions) {
            const registered = extension.shortcuts.get(shortcut);
            if (!registered) continue;
            await registered.handler(this.host.ctx);
            return { status: "success", message: `Ran extension shortcut ${shortcut}` };
        }
        return { status: "noop", message: `Extension shortcut ${shortcut} is not available.` };
    }

    /** Read a live flag value from this session's bound extension runtime. */
    getFlagValue(name: string): boolean | string | undefined {
        return this.host.extensionRuntime?.flagValues.get(name);
    }

    /** Write a live flag value into this session's bound extension runtime. */
    setFlagValue(name: string, value: boolean | string): void {
        this.host.extensionRuntime?.flagValues.set(name, value);
    }

    /**
     * The command-only session-control seam handed to extension command
     * handlers (via createCommandContext). waitForIdle / navigateTree / compact
     * / sendMessage route to this owner's live harness; the renderer-driven
     * lifecycle actions (newSession / fork / switchSession / reload) can't be
     * performed in-process and resolve as cancelled/no-op.
     */
    private buildCommandHost(): ExtensionCommandHost {
        const cancelled = (): Promise<{ cancelled: boolean }> => Promise.resolve({ cancelled: true });
        return {
            waitForIdle: () => this.host.harness.waitForIdle(),
            reload: () => Promise.resolve(),
            navigateTree: async (targetId, options) => {
                const result = await this.host.harness.navigateTree(targetId, {
                    summarize: options?.summarize ?? false,
                    customInstructions: options?.customInstructions,
                    replaceInstructions: options?.replaceInstructions,
                    label: options?.label,
                });
                if (!result.cancelled) {
                    await this.rebuildFromCurrentBranch();
                    this.emitSessionState();
                }
                return { cancelled: result.cancelled };
            },
            newSession: cancelled,
            fork: cancelled,
            switchSession: cancelled,
            sendMessage: async (text, options) => {
                const deliverAs = options?.deliverAs;
                if (deliverAs === "steer") {
                    await this.host.harness.steer(text);
                } else if (deliverAs === "nextTurn") {
                    await this.host.harness.nextTurn(text);
                } else {
                    await this.send(text);
                }
            },
        };
    }

    async getLeafId(): Promise<string | null> {
        return this.host.session.getLeafId();
    }

    async dispose(reason: "reload" | "dispose" = "dispose"): Promise<void> {
        this.unsubscribeHarness();
        this.listeners.clear();
        // Reject any send() promises still awaiting a userEntryId — the
        // abort below tears down the run, so their user message_end will
        // never arrive.
        this.rejectPendingSends(new Error("session disposed before the user message was committed"));
        this.terminatePendingUiRequests(reason);
        this.extensionUiBridge?.dispose();
        const lifecycleOwnerId = this.host.extensionLifecycleOwnerId ?? this.path;
        const lifecycleHost = this.host.extensionLifecycleHost;
        let cleanupError: unknown;
        if (lifecycleHost) {
            try {
                await lifecycleHost.disposeOwner(lifecycleOwnerId);
            } catch (err) {
                console.error(`[agent-session] extension cleanup error for ${this.path}:`, err);
                cleanupError = err;
            } finally {
                unregisterExtensionLifecycleHost(lifecycleHost);
            }
        }
        await this.host.harness.abort().catch(() => {
            // best-effort on teardown
        });
        if (cleanupError) {
            throw cleanupError;
        }
    }

    private rejectPendingSends(err: unknown): void {
        const pending = this.pendingEntryIdResolvers;
        this.pendingEntryIdResolvers = [];
        for (const { reject } of pending) {
            reject(err);
        }
    }

    private onSendError(where: "prompt" | "followUp", err: unknown): void {
        this.running = false;
        this.status = "error";
        this.errorMessage = err instanceof Error ? err.message : String(err);
        const turn = this.getActiveTurn();
        if (turn) {
            turn.status = "error";
            turn.errorMessage = this.errorMessage;
            this.turns = this.turns.map((t) => (t.turnId === turn.turnId ? turn : t));
        }
        // The user message_end that would resolve a waiting send() will never
        // arrive on a prompt/followUp failure — reject the oldest pending
        // resolver so callers don't hang forever.
        const pending = this.pendingEntryIdResolvers.shift();
        pending?.reject(err);
        console.error(`[agent-session] ${where} error for ${this.path}:`, err);
    }

    private async startPromptTurn(text: string): Promise<void> {
        try {
            await this.host.harness.prompt(text);
        } catch (err) {
            this.onSendError("prompt", err);
        } finally {
            this.running = false;
        }
    }

    private ensureTurn(turnId: string): AgentTurn {
        const existing = this.turns.find((turn) => turn.turnId === turnId);
        if (existing) return existing;
        const turn: AgentTurn = { turnId, responseMessages: [], status: "streaming" };
        this.turns = [...this.turns, turn];
        return turn;
    }

    private getActiveTurn(): AgentTurn | undefined {
        if (!this.activeTurnId) return undefined;
        return this.turns.find((turn) => turn.turnId === this.activeTurnId);
    }

    private setTurn(nextTurn: AgentTurn): void {
        this.turns = this.turns.map((turn) => (turn.turnId === nextTurn.turnId ? nextTurn : turn));
    }

    setTurnChangeOutline(turnId: string, changeOutline: ChangeOutline | undefined): void {
        const turn = this.turns.find((item) => item.turnId === turnId);
        if (!turn) return;
        this.setTurn({ ...turn, changeOutline });
        this.emitTurnUpdate();
    }

    private applyMessageStartToTurn(message: AgentMessage): void {
        const role = (message as { role?: string }).role;
        // User turns open on message_end (where the entryId — the turn
        // identity — is available), not here. A user message_start only
        // accumulates the transcript; we defer turn bookkeeping.
        if (role === "user") return;
        const turn = this.getActiveTurn();
        if (!turn) return;
        this.setTurn({
            ...turn,
            responseMessages: [...turn.responseMessages, message],
            status: "streaming",
            errorMessage: undefined,
        });
    }

    private applyMessageUpdateToTurn(message: AgentMessage, isEnd: boolean, entryId?: string): void {
        const role = (message as { role?: string }).role;
        if (role === "user") {
            // The turn's identity IS the user message's session entry id. It
            // only becomes known on message_end, so we open/identify the turn
            // here and resolve the matching send() promise.
            if (isEnd && entryId) {
                this.activeTurnId = entryId;
                const turn = this.ensureTurn(entryId);
                this.setTurn({ ...turn, userMessage: message, status: "streaming", errorMessage: undefined });
                const pending = this.pendingEntryIdResolvers.shift();
                pending?.resolve(entryId);
                return;
            }
            const turn = this.getActiveTurn();
            if (!turn) return;
            this.setTurn({ ...turn, userMessage: message });
            return;
        }
        const turn = this.getActiveTurn();
        if (!turn) return;
        const responseMessages = turn.responseMessages.length === 0 ? [message] : turn.responseMessages.slice();
        responseMessages[responseMessages.length - 1] = message;
        const errored = isEnd && isErroredAssistant(message);
        this.setTurn({
            ...turn,
            responseMessages,
            status: errored ? "error" : turn.status,
            errorMessage: errored
                ? ((message as { errorMessage?: string }).errorMessage ?? "agent error")
                : turn.errorMessage,
        });
    }

    private finishActiveTurn(notifyFinished = true): void {
        const turn = this.getActiveTurn();
        let finishedTurn = turn;
        if (turn && turn.status !== "error") {
            finishedTurn = { ...turn, status: "done" };
            this.setTurn(finishedTurn);
        }
        this.activeTurnId = undefined;
        if (notifyFinished && finishedTurn?.status === "done") {
            this.notifyTurnFinished(finishedTurn);
        }
    }

    private notifyTurnFinished(turn: AgentTurn): void {
        if (!this.onTurnFinished) return;
        void Promise.resolve(this.onTurnFinished(turn)).catch((err) => {
            console.error(`[agent-session] onTurnFinished error for ${this.path}:`, err);
        });
    }

    private async rebuildFromCurrentBranch(): Promise<void> {
        const entries = await this.host.session.getBranch();
        this.messages = entries
            .filter((entry): entry is Extract<SessionTreeEntry, { type: "message" }> => entry.type === "message")
            .map((entry) => entry.message as AgentMessage);
        this.turns = buildPersistedTurnsFromSessionEntries(entries);
        this.steerQueue = [];
        this.followUpQueue = [];
        this.status = "idle";
        this.errorMessage = undefined;
        this.activeTurnId = undefined;
        this.running = false;
    }

    private emitSessionState(): void {
        const event: AgentSessionRuntimeStateEvent = {
            type: "session_state",
            messages: this.messages,
            turns: this.turns,
            status: this.status,
            steer: this.steerQueue,
            followUp: this.followUpQueue,
            extensionUi: cloneExtensionUiSnapshot(this.extensionUi),
        };
        for (const listener of this.listeners) {
            try {
                listener(event as unknown as AgentHarnessEvent);
            } catch (err) {
                console.error(`[agent-session] listener error for ${this.path}:`, err);
            }
        }
    }

    private emitTurnUpdate(): void {
        const event = { type: "agent_turn_update" } as unknown as AgentHarnessEvent;
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                console.error(`[agent-session] listener error for ${this.path}:`, err);
            }
        }
    }

    // ---- ctx.ui host (ExtensionUiHost) ----
    // The bridge (created in agent-ipc, wired into the harness) attaches this
    // session as its host. Single-direction pushes fan out as events the
    // renderer maps to a toast / inline status / inline widget; requestUi does
    // a round-trip resolved by respondUi() once the renderer answers.

    notify(message: string, level: "info" | "warn" | "error"): void {
        this.emitExtUiEvent({ type: "ext_ui_notify", message, level });
    }

    setStatus(key: string, text: string | undefined): void {
        const statuses = { ...this.extensionUi.statuses };
        if (text == null) delete statuses[key];
        else statuses[key] = text;
        this.extensionUi = { ...this.extensionUi, statuses };
        this.emitExtUiEvent({ type: "ext_ui_status", key, text });
    }

    setWidget(key: string, value: string[] | WidgetNode | undefined): void {
        const widgets = { ...this.extensionUi.widgets };
        const widgetnodes = { ...this.extensionUi.widgetnodes };
        if (value == null) {
            delete widgets[key];
            delete widgetnodes[key];
            this.extensionUi = { ...this.extensionUi, widgets, widgetnodes };
            this.emitExtUiEvent({ type: "ext_ui_widget", key, lines: undefined });
            return;
        }
        if (Array.isArray(value)) {
            widgets[key] = [...value];
            delete widgetnodes[key];
            this.extensionUi = { ...this.extensionUi, widgets, widgetnodes };
            this.emitExtUiEvent({ type: "ext_ui_widget", key, lines: value });
            return;
        }
        widgetnodes[key] = cloneWidgetNode(value);
        delete widgets[key];
        this.extensionUi = { ...this.extensionUi, widgets, widgetnodes };
        this.emitExtUiEvent({ type: "ext_ui_widget", key, widget: value });
    }

    setHeader(value: WidgetNode | undefined): void {
        this.extensionUi = {
            ...this.extensionUi,
            header: value == null ? undefined : cloneWidgetNode(value),
        };
        this.emitExtUiEvent({ type: "ext_ui_header", widget: value });
    }

    setFooter(value: WidgetNode | undefined): void {
        this.extensionUi = {
            ...this.extensionUi,
            footer: value == null ? undefined : cloneWidgetNode(value),
        };
        this.emitExtUiEvent({ type: "ext_ui_footer", widget: value });
    }

    requestUi(request: ExtUiRequest): Promise<unknown> {
        const requestId = `extui-${this.nextUiRequestId++}`;
        const promise = new Promise<unknown>((resolve, reject) => {
            this.pendingUiRequests.set(requestId, { resolve, reject });
        });
        if (request.kind === "custom") {
            this.customWidgetRequestIds.set(request.widget.id, requestId);
        }
        this.emitExtUiEvent({ type: "ext_ui_request", requestId, request });
        return promise;
    }

    updateCustomWidget(widget: WidgetNode): void {
        const requestId = this.customWidgetRequestIds.get(widget.id);
        if (!requestId || !this.pendingUiRequests.has(requestId)) return;
        this.emitExtUiEvent({ type: "ext_ui_request_update", requestId, widget });
    }

    /**
     * Resolve a pending ctx.ui request with the renderer's answer. `result` is
     * the raw value the renderer collected (boolean for confirm, chosen option
     * string / undefined for select, string / undefined for input). Cancelling
     * (dismissing the panel) resolves with undefined (→ confirm false path is
     * handled renderer-side; select/input map undefined = cancelled).
     */
    respondUi(requestId: string, result: unknown): void {
        const pending = this.pendingUiRequests.get(requestId);
        if (!pending) return;
        this.pendingUiRequests.delete(requestId);
        for (const [widgetId, mappedRequestId] of this.customWidgetRequestIds) {
            if (mappedRequestId === requestId) {
                this.customWidgetRequestIds.delete(widgetId);
            }
        }
        pending.resolve(result);
        this.emitExtUiEvent({ type: "ext_ui_resolved", requestId });
    }

    resolveCustomWidget(widgetId: string, result: unknown): boolean {
        const requestId = this.customWidgetRequestIds.get(widgetId);
        if (!requestId) return false;
        this.respondUi(requestId, result);
        return true;
    }

    respondWidgetEvent(event: WidgetEvent): boolean {
        return this.extensionUiBridge?.dispatchWidgetEvent(event) ?? false;
    }

    private terminatePendingUiRequests(reason: ExtensionUiTerminationReason): void {
        const pending = [...this.pendingUiRequests.values()];
        this.pendingUiRequests.clear();
        this.customWidgetRequestIds.clear();
        const error = new ExtensionUiRequestTerminatedError(reason);
        for (const { reject } of pending) {
            reject(error);
        }
    }

    private emitExtUiEvent(event: AgentExtensionUiEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                console.error(`[agent-session] ext-ui listener error for ${this.path}:`, err);
            }
        }
    }
}
