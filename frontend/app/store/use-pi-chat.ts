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
    send: (text: string, options?: UsePiChatSendOptions) => Promise<void>;
    abort: () => void;
}

export interface UsePiChatSendOptions {
    images?: string[];
}

interface AgentApiSurface {
    createSession: (cwd: string) => Promise<AgentSessionMeta>;
    listSessionsForCwd: (cwd: string) => Promise<AgentSessionMeta[]>;
    getSessionState: (sessionMetadata: AgentSessionMeta) => Promise<PiAgentEvent>;
    send: (opts: AgentSendOptions) => Promise<{ sessionMetadata: AgentSessionMeta; turnId: string }>;
    abort: (sessionPath: string) => void;
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
        let cancelled = false;
        void Promise.resolve()
            .then(() => api.getSessionState(sessionMetadata))
            .then((event) => {
                if (cancelled) return;
                setMessages((prev) => reducePiChatEvent(prev, event));
                setTurns((prev) => reducePiTurnsEvent(prev, event));
                applySessionState(event, setStatus, setErrorMessage, setQueuedMessages);
            })
            .catch((err) => {
                if (cancelled) return;
                console.warn("[agent] failed to pull session_state", err);
            });
        const unsubscribe = api.subscribe(
            sessionPath,
            (raw) => {
                const event = raw as PiAgentEvent;
                setMessages((prev) => reducePiChatEvent(prev, event));
                setTurns((prev) => reducePiTurnsEvent(prev, event));
                switch (event.type) {
                    case "session_state": {
                        applySessionState(event, setStatus, setErrorMessage, setQueuedMessages);
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
                    default:
                        break;
                }
            },
            { blockId: blockIdRef.current }
        );
        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [sessionMetadata, sessionPath]);

    const send = useCallback(
        async (text: string, options?: UsePiChatSendOptions): Promise<void> => {
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
                    images: options?.images,
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

    return useMemo(
        () => ({ messages, turns, status, errorMessage, sessionMetadata, queuedMessages, send, abort }),
        [messages, turns, status, errorMessage, sessionMetadata, queuedMessages, send, abort]
    );
}
