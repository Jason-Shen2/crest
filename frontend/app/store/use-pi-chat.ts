// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// usePiChat — React hook that consumes the integrated agent runtime
// via Electron IPC (window.api.agent.*). Replaces the legacy
// @ai-sdk/react useChat path; see docs/agent-runtime-architecture.md.
//
// What the hook gives consumers:
//
//   const {
//     messages,        // AgentMessage[]  — same shape pi emits
//     status,          // "idle" | "streaming" | "error"
//     errorMessage,    // string | undefined
//     sessionMetadata, // AgentSessionMeta | undefined (after first send)
//     send,            // (text, opts?) => Promise<void>
//     abort,           // () => void
//   } = usePiChat({ initialSession, paneContext, modelSelection });
//
// Subscribe lifecycle: the hook subscribes via window.api.agent.subscribe
// only AFTER a session metadata is known (either passed in via
// initialSession or returned by the first send). Pre-session messages
// are kept locally and merged in once the subscription starts.
//

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppNotification } from "@/app/notifications/notifications-model";
import { ToastModel } from "@/app/notifications/toast-model";
import type {
    RenderedExtensionEntryNode,
    WidgetEventDispatchResult,
    WidgetNode,
} from "../../../emain/agent/extensions/pi-gui/crest/widget-tree";

/**
 * Mirror of pi's AgentMessage at the renderer boundary. Kept as a
 * structural type rather than imported from emain/agent/types because
 * the renderer must not pull main-process modules. Stays in sync with
 * emain/agent/types.ts AgentMessage by review during the wiring task.
 */
export interface PiAgentMessageBase {
    role: "user" | "assistant" | "toolResult" | string;
    timestamp?: number;
}

export type PiAgentMessage = PiAgentMessageBase & {
    // Loose typing on content — AgentMessage's union is wide
    // (text / toolCall / toolResult / image / ...) and the rendering
    // code will discriminate on inner type. Hook just transports.
    content?: Array<{ type: string; [field: string]: unknown }>;
    // Assistant-specific fields:
    api?: string;
    provider?: string;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    usage?: unknown;
    // ToolResultMessage fields live at the message top level in pi.
    toolCallId?: string;
    toolUseId?: string;
    toolName?: string;
    details?: unknown;
    isError?: boolean;
};

export type PiTurnStatus = "streaming" | "done" | "error";

export interface PiChangeOutlineFile {
    path: string;
    hunkIds?: string[];
}

export interface PiChangeOutlineModule {
    id: string;
    title: string;
    summary?: string;
    files: PiChangeOutlineFile[];
}

export interface PiChangeOutline {
    modules?: PiChangeOutlineModule[];
}

export interface PiTurn {
    turnId: string;
    userMessage?: PiAgentMessage;
    responseMessages: PiAgentMessage[];
    status: PiTurnStatus;
    errorMessage?: string;
    changeOutline?: PiChangeOutline;
}

/**
 * Mirror of pi's AgentEvent + AgentHarnessEvent at the renderer
 * boundary. Flat shape (one field per known variant + a string-indexed
 * fallback) instead of a discriminated union so TS narrowing under
 * strict:false stays predictable. Known AgentEvent variants carry the
 * fields named below; AgentHarness-own variants come through with
 * type only and the rest in the [field: string] index slot.
 */
export interface PiAgentEvent {
    type: string;
    /** message_start / message_update / message_end / turn_end carry this. */
    message?: PiAgentMessage;
    /** agent_end + session_state carry this. */
    messages?: PiAgentMessage[];
    /** session_state carries main-owned turns keyed by the user entry id. */
    turns?: PiTurn[];
    /** session_state carries the owner's status (idle/streaming/error). */
    status?: string;
    /** queue_update + session_state carry the pending queues (user messages). */
    steer?: PiAgentMessage[];
    followUp?: PiAgentMessage[];
    /** turn_end carries this. */
    toolResults?: PiAgentMessage[];
    /** message_update carries this. */
    assistantMessageEvent?: { type: string; [field: string]: unknown };
    /** tool_execution_* carry these. */
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    partialResult?: unknown;
    result?: unknown;
    isError?: boolean;
    [field: string]: unknown;
}

/** Identifies the model the agent should use for the next send. */
export interface UsePiChatModel {
    provider: string;
    model: string;
    reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    /**
     * Credential reference from the ai-resolver, forwarded to main so it
     * can resolve the provider API key. Exactly one is typically set.
     */
    token?: string;
    tokenSecretName?: string;
}

/** Pane state threaded to the agent for system-prompt composition. */
export interface UsePiChatPaneContext {
    cwd: string;
    gitBranch?: string;
    recentCmds?: string[];
    connection?: string;
}

export interface UsePiChatOptions {
    /**
     * Existing session metadata (e.g. from block.meta["agent:session"]).
     * Undefined means "no session yet — first send mints one".
     */
    initialSession?: AgentSessionMeta;
    /**
     * Called once when the runtime returns a new session metadata
     * (from first send). Consumer typically writes it to block.meta
     * so subsequent renders pass the same metadata as initialSession.
     */
    onSessionMinted?: (meta: AgentSessionMeta) => void;
    /** Current pane state, sampled per send. */
    paneContext: UsePiChatPaneContext;
    /** Current model selection, sampled per send. */
    modelSelection: UsePiChatModel;
    /** Optional tool allowlist; when omitted, main defaults to allowAll. */
    allowedTools?: string[];
    /** Parent terminal block ID for tool/UI integrations that need pane identity. */
    blockId?: string;
}

export type UsePiChatStatus = "idle" | "streaming" | "error";

/**
 * A pending interactive ctx.ui request (confirm/select/input) surfaced from
 * an extension. Mirrors main's ExtUiRequest + the requestId used to answer it
 * via api.respondUi. The renderer shows an inline panel; when the user acts,
 * respondExtUi(requestId, result) sends the answer back.
 */
export type PiExtUiRequest =
    | { requestId: string; kind: "confirm"; title: string; message?: string }
    | { requestId: string; kind: "select"; title: string; options: string[] }
    | { requestId: string; kind: "input"; title: string; initial?: string }
    | { requestId: string; kind: "editor"; title: string; prefill?: string }
    | { requestId: string; kind: "custom"; widget: WidgetNode; options?: unknown };

/** Non-interactive ctx.ui surface: keyed status lines + widget line blocks. */
export interface PiExtUiState {
    /** setStatus(key, text) — one short status line per key. */
    statuses: Record<string, string>;
    /** setWidget(key, lines) — a multi-line block per key. */
    widgets: Record<string, string[]>;
    /** setWidget(key, component) — semantic pi-gui widget blocks. */
    widgetnodes: Record<string, WidgetNode>;
    /** Renderer output for persisted custom session entries. */
    renderedEntries: RenderedExtensionEntryNode[];
    header?: WidgetNode;
    footer?: WidgetNode;
    /** The single active confirm/select/input prompt, or null when none. */
    request: PiExtUiRequest | null;
}

export function makeEmptyPiExtUiState(): PiExtUiState {
    return { statuses: {}, widgets: {}, widgetnodes: {}, renderedEntries: [], request: null };
}

export interface UsePiChatReturn {
    messages: PiAgentMessage[];
    turns: PiTurn[];
    status: UsePiChatStatus;
    errorMessage: string | undefined;
    sessionMetadata: AgentSessionMeta | undefined;
    /**
     * Messages waiting to run after the current turn — concurrent sends are
     * queued via the harness's steer/followUp queues (not run in parallel).
     * Mirrored from the owner's `queue_update` events; ordered steer-first
     * (injected sooner) then followUp. Empty while idle / nothing pending.
     */
    queuedMessages: PiAgentMessage[];
    /** Extension ctx.ui state: statuses / widgets / the active prompt. */
    extUi: PiExtUiState;
    send: (text: string) => Promise<void>;
    abort: () => void;
    /** Answer the active ctx.ui prompt (confirm/select/input). */
    respondExtUi: (requestId: string, result: unknown) => void;
    /** Deliver a widget interaction from renderer to the live ctx.ui surface. */
    respondWidgetEvent: (event: AgentWidgetEvent) => Promise<WidgetEventDispatchResult>;
}

interface AgentApiSurface {
    createSession: (cwd: string) => Promise<AgentSessionMeta>;
    listSessionsForCwd: (cwd: string) => Promise<AgentSessionMeta[]>;
    send: (opts: AgentSendOptions) => Promise<{ sessionMetadata: AgentSessionMeta; turnId: string }>;
    abort: (sessionPath: string) => void;
    respondUi: (sessionPath: string, requestId: string, result: unknown) => Promise<void>;
    respondWidgetEvent: (
        sessionPath: string,
        event: AgentWidgetEvent
    ) => Promise<WidgetEventDispatchResult>;
    subscribe: (sessionPath: string, callback: (event: unknown) => void, opts?: { blockId?: string }) => () => void;
}

function getAgentApi(): AgentApiSurface | undefined {
    if (typeof window === "undefined") return undefined;
    const api = (window as unknown as { api?: { agent?: AgentApiSurface } }).api;
    return api?.agent;
}

export function resolveAbortSessionPath(
    sessionMetadata: AgentSessionMeta | undefined,
    activeSessionPath: string
): string {
    return sessionMetadata?.path || activeSessionPath;
}

/**
 * Reduce an event into the messages array. Returns the new array (or
 * the same reference if no change). Keeps reducers pure so the test
 * suite can exercise the merge logic without standing up React.
 *
 * Strategy: rebuild the assistant message from message_update events
 * by replacing the in-progress entry; commit on message_end. user /
 * toolResult messages are appended on message_start.
 */
export function reducePiChatEvent(messages: PiAgentMessage[], event: PiAgentEvent): PiAgentMessage[] {
    switch (event.type) {
        case "message_start": {
            if (!event.message) return messages;
            // Append unless we already have an in-progress message
            // with the same role at the tail (defensive).
            return [...messages, event.message];
        }
        case "message_update": {
            if (!event.message) return messages;
            // Replace the tail message with the latest streaming state.
            if (messages.length === 0) return [event.message];
            const next = messages.slice();
            next[next.length - 1] = event.message;
            return next;
        }
        case "message_end": {
            if (!event.message) return messages;
            // Replace the tail with the final message (carries
            // stopReason / errorMessage on assistant turns).
            if (messages.length === 0) return [event.message];
            const next = messages.slice();
            next[next.length - 1] = event.message;
            return next;
        }
        case "session_state": {
            if (!event.messages) return messages;
            // The owner's FULL accumulated transcript, sent once on
            // (re)subscribe so a renderer that attached late still mirrors
            // the whole conversation. Replace to reconcile any drift /
            // back-fill missed history (see docs/agent-rendering-architecture.md).
            return event.messages;
        }
        case "agent_end":
            // agent_end.messages is turn-scoped (only the latest prompt()'s
            // messages, not the whole conversation — agent-loop.ts builds it
            // as `[...prompts]` + responses). Replacing here would wipe every
            // prior turn. The message_start/_end stream already appended this
            // turn's messages, so do nothing.
            return messages;
        default:
            return messages;
    }
}

export function reducePiTurnsEvent(turns: PiTurn[], event: PiAgentEvent): PiTurn[] {
    if (event.type === "snapshot") return turns;
    if (!event.turns) return turns;
    return event.turns;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

function normalizeStatuses(value: unknown): Record<string, string> {
    if (!isRecord(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function normalizeLineWidgets(value: unknown): Record<string, string[]> {
    if (!isRecord(value)) return {};
    return Object.fromEntries(
        Object.entries(value)
            .filter((entry): entry is [string, string[]] => {
                return Array.isArray(entry[1]) && entry[1].every((line) => typeof line === "string");
            })
            .map(([key, lines]) => [key, [...lines]])
    );
}

function normalizeWidgetNode(value: unknown): WidgetNode | undefined {
    if (!isRecord(value) || typeof value.kind !== "string" || typeof value.id !== "string") return undefined;
    return structuredClone(value) as unknown as WidgetNode;
}

function normalizeWidgetNodes(value: unknown): Record<string, WidgetNode> {
    if (!isRecord(value)) return {};
    const widgets: Record<string, WidgetNode> = {};
    for (const [key, candidate] of Object.entries(value)) {
        const widget = normalizeWidgetNode(candidate);
        if (widget) widgets[key] = widget;
    }
    return widgets;
}

function normalizeRenderedEntries(value: unknown): RenderedExtensionEntryNode[] {
    if (!Array.isArray(value)) return [];
    const entries: RenderedExtensionEntryNode[] = [];
    for (const candidate of value) {
        if (
            !isRecord(candidate) ||
            typeof candidate.id !== "string" ||
            typeof candidate.customtype !== "string" ||
            (candidate.source !== "entry" && candidate.source !== "message")
        ) {
            continue;
        }
        const widget = normalizeWidgetNode(candidate.widget);
        if (!widget) continue;
        entries.push({
            id: candidate.id,
            customtype: candidate.customtype,
            source: candidate.source,
            widget,
        });
    }
    return entries;
}

/**
 * Fold an ext_ui_* event into the ctx.ui state. Pure so the wiring is
 * testable without React. Unknown types pass through unchanged.
 *
 * - ext_ui_status: set/clear a keyed status line (text undefined → delete)
 * - ext_ui_widget: set/clear a keyed widget block (lines undefined → delete)
 * - ext_ui_request: raise the active confirm/select/input prompt
 * - ext_ui_resolved: clear the active prompt (main resolved/rejected it)
 *
 * notify is intentionally NOT handled here — it's a fire-and-forget toast,
 * routed at the subscribe callback, not part of the persistent ext-ui state.
 */
export function reducePiExtUiEvent(state: PiExtUiState, event: PiAgentEvent): PiExtUiState {
    switch (event.type) {
        case "session_state": {
            const snapshot = isRecord(event.extensionUi) ? event.extensionUi : {};
            return {
                statuses: normalizeStatuses(snapshot.statuses),
                widgets: normalizeLineWidgets(snapshot.widgets),
                widgetnodes: normalizeWidgetNodes(snapshot.widgetnodes),
                renderedEntries: normalizeRenderedEntries(event.renderedEntries),
                header: normalizeWidgetNode(snapshot.header),
                footer: normalizeWidgetNode(snapshot.footer),
                request: null,
            };
        }
        case "ext_ui_status": {
            const key = event.key as string;
            const text = event.text as string | undefined;
            const statuses = { ...state.statuses };
            if (text === undefined || text === null) delete statuses[key];
            else statuses[key] = text;
            return { ...state, statuses };
        }
        case "ext_ui_widget": {
            const key = event.key as string;
            const lines = event.lines as string[] | undefined;
            const widget = event.widget as WidgetNode | undefined;
            if (widget != null) {
                const widgetnodes = { ...state.widgetnodes, [key]: widget };
                const widgets = { ...state.widgets };
                delete widgets[key];
                return { ...state, widgets, widgetnodes };
            }
            const widgets = { ...state.widgets };
            const widgetnodes = { ...state.widgetnodes };
            if (lines === undefined || lines === null) {
                delete widgets[key];
                delete widgetnodes[key];
            } else {
                widgets[key] = lines;
                delete widgetnodes[key];
            }
            return { ...state, widgets, widgetnodes };
        }
        case "ext_ui_header": {
            return { ...state, header: event.widget as WidgetNode | undefined };
        }
        case "ext_ui_footer": {
            return { ...state, footer: event.widget as WidgetNode | undefined };
        }
        case "ext_ui_request": {
            const requestId = event.requestId as string;
            const request = event.request as { kind: string; [field: string]: unknown } | undefined;
            if (!requestId || !request) return state;
            return { ...state, request: { requestId, ...request } as PiExtUiRequest };
        }
        case "ext_ui_request_update": {
            const requestId = event.requestId as string;
            const widget = event.widget as WidgetNode | undefined;
            if (!requestId || !widget || state.request?.requestId !== requestId || state.request.kind !== "custom") {
                return state;
            }
            return { ...state, request: { ...state.request, widget } };
        }
        case "ext_ui_resolved": {
            const requestId = event.requestId as string;
            if (state.request?.requestId !== requestId) return state;
            return { ...state, request: null };
        }
        default:
            return state;
    }
}

/**
 * Build the toast notification for a fire-and-forget ctx.ui `notify(message,
 * level)` event. Maps the extension's info/warn/error level onto the
 * AppNotification kind the toast/feed UI understands. Kept pure + exported so
 * the mapping is unit-testable without React.
 */
export function makeExtUiNotification(event: PiAgentEvent): AppNotification {
    const message = (event.message as unknown as string | undefined) ?? "";
    const level = (event.level as string | undefined) ?? "info";
    const kind = level === "error" ? "failed" : level === "warn" ? "needs-action" : "info";
    const now = Date.now();
    return {
        id: `ext-ui:${now}:${Math.random().toString(36).slice(2, 7)}`,
        source: "crest-agent",
        kind,
        title: "Extension",
        body: message,
        ts: now,
        read: false,
    };
}

export function shouldReducePiExtUiSubscriptionEvent(type: string): boolean {
    switch (type) {
        case "ext_ui_status":
        case "ext_ui_widget":
        case "ext_ui_header":
        case "ext_ui_footer":
        case "ext_ui_request":
        case "ext_ui_request_update":
        case "ext_ui_resolved":
            return true;
        default:
            return false;
    }
}

export function adoptInitialSessionMetadata(
    current: AgentSessionMeta | undefined,
    incoming: AgentSessionMeta | undefined
): AgentSessionMeta | undefined {
    if (!incoming?.path) return current;
    if (current?.path === incoming.path) return current;
    return incoming;
}

export function getOptimisticAbortStatus(status: UsePiChatStatus): UsePiChatStatus {
    if (status !== "streaming") return status;
    return "idle";
}

function applySessionState(
    event: PiAgentEvent,
    setStatus: (status: UsePiChatStatus) => void,
    setErrorMessage: (message: string | undefined) => void,
    setQueuedMessages: (messages: PiAgentMessage[]) => void
): void {
    const stateStatus = event.status as UsePiChatStatus | undefined;
    if (stateStatus) {
        setStatus(stateStatus);
        setErrorMessage(stateStatus === "error" ? "agent error" : undefined);
    }
    setQueuedMessages([...(event.steer ?? []), ...(event.followUp ?? [])]);
}

export function usePiChat(opts: UsePiChatOptions): UsePiChatReturn {
    const [messages, setMessages] = useState<PiAgentMessage[]>([]);
    const [turns, setTurns] = useState<PiTurn[]>([]);
    const [status, setStatus] = useState<UsePiChatStatus>("idle");
    const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
    const [queuedMessages, setQueuedMessages] = useState<PiAgentMessage[]>([]);
    const [extUi, setExtUi] = useState<PiExtUiState>(makeEmptyPiExtUiState());
    const [sessionMetadata, setSessionMetadata] = useState<AgentSessionMeta | undefined>(opts.initialSession);
    const sessionMetadataRef = useRef<AgentSessionMeta | undefined>(opts.initialSession);
    const activeSessionPathRef = useRef(opts.initialSession?.path ?? "");

    // Refs hold the latest values without re-subscribing.
    const onSessionMintedRef = useRef(opts.onSessionMinted);
    const paneContextRef = useRef(opts.paneContext);
    const modelSelectionRef = useRef(opts.modelSelection);
    const allowedToolsRef = useRef(opts.allowedTools);
    const blockIdRef = useRef(opts.blockId);
    useEffect(() => {
        onSessionMintedRef.current = opts.onSessionMinted;
        paneContextRef.current = opts.paneContext;
        modelSelectionRef.current = opts.modelSelection;
        allowedToolsRef.current = opts.allowedTools;
        blockIdRef.current = opts.blockId;
    }, [opts.onSessionMinted, opts.paneContext, opts.modelSelection, opts.allowedTools, opts.blockId]);

    useEffect(() => {
        setSessionMetadata((current) => adoptInitialSessionMetadata(current, opts.initialSession));
    }, [opts.initialSession?.path]);

    const sessionPath = sessionMetadata?.path;
    useEffect(() => {
        sessionMetadataRef.current = sessionMetadata;
        if (sessionMetadata?.path) {
            activeSessionPathRef.current = sessionMetadata.path;
        }
    }, [sessionMetadata]);

    // Subscribe to the session's event stream — only after we have a
    // sessionPath. Pre-session sends are still possible; they mint a
    // session and then the next render this effect picks up.
    useEffect(() => {
        if (!sessionPath) return;
        const api = getAgentApi();
        if (!api) return;
        const unsubscribe = api.subscribe(
            sessionPath,
            (raw) => {
                const event = raw as PiAgentEvent;
                setMessages((prev) => reducePiChatEvent(prev, event));
                setTurns((prev) => reducePiTurnsEvent(prev, event));
                switch (event.type) {
                    case "session_state": {
                        applySessionState(event, setStatus, setErrorMessage, setQueuedMessages);
                        setExtUi((prev) => reducePiExtUiEvent(prev, event));
                        break;
                    }
                    case "queue_update":
                        // Authoritative pending-queue state from the owner; the
                        // harness emits this on every enqueue AND drain, so the
                        // mirror stays exact (empty when nothing is pending).
                        setQueuedMessages([...(event.steer ?? []), ...(event.followUp ?? [])]);
                        break;
                    case "agent_start":
                    case "turn_start":
                        setStatus("streaming");
                        setErrorMessage(undefined);
                        break;
                    case "message_end": {
                        const m = event.message;
                        if (m.role === "assistant" && m.stopReason === "error") {
                            setStatus("error");
                            setErrorMessage(m.errorMessage ?? "agent error");
                        }
                        break;
                    }
                    case "agent_end":
                    case "abort":
                        // Turn finished or was stopped. abort() also clears the
                        // queues and emits queue_update, so queuedMessages empties
                        // on its own; here we just settle the status.
                        setStatus("idle");
                        break;
                    case "ext_ui_notify":
                        // Fire-and-forget: surface as a toast, not part of the
                        // persistent ext-ui state.
                        ToastModel.getInstance().push(makeExtUiNotification(event));
                        break;
                    default:
                        if (shouldReducePiExtUiSubscriptionEvent(event.type)) {
                            setExtUi((prev) => reducePiExtUiEvent(prev, event));
                        }
                        break;
                }
            },
            { blockId: blockIdRef.current }
        );
        return unsubscribe;
    }, [sessionPath]);

    const send = useCallback(
        async (text: string): Promise<void> => {
            const api = getAgentApi();
            if (!api) {
                setStatus("error");
                setErrorMessage("Electron agent IPC not available (window.api.agent missing)");
                return;
            }
            setErrorMessage(undefined);
            try {
                let sendSessionMetadata = sessionMetadata;
                if (!sendSessionMetadata) {
                    sendSessionMetadata = await api.createSession(paneContextRef.current.cwd);
                    setSessionMetadata(sendSessionMetadata);
                    activeSessionPathRef.current = sendSessionMetadata.path;
                    onSessionMintedRef.current?.(sendSessionMetadata);
                } else {
                    activeSessionPathRef.current = sendSessionMetadata.path;
                }
                const result = await api.send({
                    sessionMetadata: sendSessionMetadata,
                    blockId: blockIdRef.current,
                    cwd: paneContextRef.current.cwd,
                    text,
                    provider: modelSelectionRef.current.provider,
                    model: modelSelectionRef.current.model,
                    reasoning: modelSelectionRef.current.reasoning,
                    token: modelSelectionRef.current.token,
                    tokenSecretName: modelSelectionRef.current.tokenSecretName,
                    gitBranch: paneContextRef.current.gitBranch,
                    recentCmds: paneContextRef.current.recentCmds,
                    connection: paneContextRef.current.connection,
                    allowedTools: allowedToolsRef.current,
                });
                setStatus("streaming");
                activeSessionPathRef.current = result.sessionMetadata.path;
                // If main minted a new session for us, surface it to
                // the consumer so they can persist it to block.meta.
                if (!sessionMetadata || sessionMetadata.path !== result.sessionMetadata.path) {
                    setSessionMetadata(result.sessionMetadata);
                    onSessionMintedRef.current?.(result.sessionMetadata);
                }
            } catch (err) {
                setStatus("error");
                setErrorMessage(err instanceof Error ? err.message : String(err));
            }
        },
        [sessionMetadata]
    );

    const abort = useCallback((): void => {
        const api = getAgentApi();
        const abortSessionPath = resolveAbortSessionPath(sessionMetadataRef.current, activeSessionPathRef.current);
        setStatus((current) => getOptimisticAbortStatus(current));
        setQueuedMessages([]);
        if (!api || !abortSessionPath) return;
        api.abort(abortSessionPath);
    }, []);

    const respondExtUi = useCallback((requestId: string, result: unknown): void => {
        // Optimistically clear the prompt so the inline panel dismisses
        // immediately; main also emits ext_ui_resolved which reconciles.
        setExtUi((prev) => (prev.request?.requestId === requestId ? { ...prev, request: null } : prev));
        const api = getAgentApi();
        const sessionPath = resolveAbortSessionPath(sessionMetadataRef.current, activeSessionPathRef.current);
        if (!api || !sessionPath) return;
        void api.respondUi(sessionPath, requestId, result);
    }, []);

    const respondWidgetEvent = useCallback(async (
        event: AgentWidgetEvent
    ): Promise<WidgetEventDispatchResult> => {
        const api = getAgentApi();
        const sessionPath = resolveAbortSessionPath(sessionMetadataRef.current, activeSessionPathRef.current);
        if (!api || !sessionPath) return { handled: false, published: false };
        return await api.respondWidgetEvent(sessionPath, event);
    }, []);

    return useMemo(
        () => ({
            messages,
            turns,
            status,
            errorMessage,
            sessionMetadata,
            queuedMessages,
            extUi,
            send,
            abort,
            respondExtUi,
            respondWidgetEvent,
        }),
        [
            messages,
            turns,
            status,
            errorMessage,
            sessionMetadata,
            queuedMessages,
            extUi,
            send,
            abort,
            respondExtUi,
            respondWidgetEvent,
        ]
    );
}
