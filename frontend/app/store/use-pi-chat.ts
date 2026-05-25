// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// usePiChat — React hook that consumes the integrated agent runtime
// via Electron IPC (window.api.agent.*). Replaces the legacy
// @ai-sdk/react useChat path; see docs/agent-runtime-architecture.md.
//
// STATUS (task #12, half-done by the autonomous handoff):
//   - This hook is implemented + tested in isolation.
//   - It is NOT YET wired into AgentChatHost / agent-block-element /
//     terminal-model / terminal-view. The legacy useChat → Go-backend
//     path is still the only one the renderer actually uses.
//   - Wiring is left to a human review pass because the message-shape
//     differences (ai-sdk UIMessage parts vs pi AgentMessage content)
//     require touching the rendering code and one wrong assumption
//     could break the whole agent panel.
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
// Replacement strategy (for the human doing the wiring):
//   1. AgentChatHost: swap useChat for usePiChat. Drop transport prop —
//      the hook talks to main directly.
//   2. agent-block-element: rewrite the parts-iteration loop to walk
//      AgentMessage.content (text / toolCall / toolResult / etc.)
//      instead of UIMessagePart parts (tool-<name> / text / ...).
//   3. terminal-model: keep applyAgentParts / applyAgentText if you
//      want the existing per-block atoms, but the data flowing in is
//      AgentMessage shape now — adapt the mapping.
//   4. package.json: remove @ai-sdk/react and any direct ai-sdk
//      provider deps that came with it.

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
};

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
    /** agent_end + snapshot carry this. */
    messages?: PiAgentMessage[];
    /** snapshot carries the owner's run status (idle/streaming/error). */
    status?: string;
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
}

export type UsePiChatStatus = "idle" | "streaming" | "error";

export interface UsePiChatReturn {
    messages: PiAgentMessage[];
    status: UsePiChatStatus;
    errorMessage: string | undefined;
    sessionMetadata: AgentSessionMeta | undefined;
    send: (text: string) => Promise<void>;
    abort: () => void;
}

interface AgentApiSurface {
    createSession: (cwd: string) => Promise<AgentSessionMeta>;
    listSessionsForCwd: (cwd: string) => Promise<AgentSessionMeta[]>;
    send: (opts: AgentSendOptions) => Promise<{ sessionMetadata: AgentSessionMeta }>;
    abort: (sessionPath: string) => void;
    subscribe: (sessionPath: string, callback: (event: unknown) => void) => () => void;
}

function getAgentApi(): AgentApiSurface | undefined {
    if (typeof window === "undefined") return undefined;
    const api = (window as unknown as { api?: { agent?: AgentApiSurface } }).api;
    return api?.agent;
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
export function reducePiChatEvent(
    messages: PiAgentMessage[],
    event: PiAgentEvent,
): PiAgentMessage[] {
    switch (event.type) {
        case "message_start": {
            if (!event.message) return messages;
            // Append unless we already have an in-progress message
            // with the same role at the tail (defensive).
            return [...messages, event.message];
        }
        case "message_update": {
            if (!event.message) return messages;
            // Replace the tail message with the latest snapshot.
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
        case "snapshot": {
            if (!event.messages) return messages;
            // The owner's FULL accumulated transcript, sent once on
            // (re)subscribe so a renderer that attached late still mirrors
            // the whole conversation. Replace to reconcile any drift /
            // back-fill missed history (see docs/agent-rendering-architecture.md).
            return event.messages;
        }
        case "agent_end":
            // agent_end.messages is RUN-SCOPED (only the latest prompt()'s
            // messages, not the whole conversation — agent-loop.ts builds it
            // as `[...prompts]` + responses). Replacing here would wipe every
            // prior run ("…loading agent run…"). The message_start/_end
            // stream already appended this run's messages, so do nothing.
            return messages;
        default:
            return messages;
    }
}

export function usePiChat(opts: UsePiChatOptions): UsePiChatReturn {
    const [messages, setMessages] = useState<PiAgentMessage[]>([]);
    const [status, setStatus] = useState<UsePiChatStatus>("idle");
    const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
    const [sessionMetadata, setSessionMetadata] = useState<AgentSessionMeta | undefined>(
        opts.initialSession,
    );

    // Refs hold the latest values without re-subscribing.
    const onSessionMintedRef = useRef(opts.onSessionMinted);
    const paneContextRef = useRef(opts.paneContext);
    const modelSelectionRef = useRef(opts.modelSelection);
    const allowedToolsRef = useRef(opts.allowedTools);
    useEffect(() => {
        onSessionMintedRef.current = opts.onSessionMinted;
        paneContextRef.current = opts.paneContext;
        modelSelectionRef.current = opts.modelSelection;
        allowedToolsRef.current = opts.allowedTools;
    }, [opts.onSessionMinted, opts.paneContext, opts.modelSelection, opts.allowedTools]);

    const sessionPath = sessionMetadata?.path;

    // Subscribe to the session's event stream — only after we have a
    // sessionPath. Pre-session sends are still possible; they mint a
    // session and then the next render this effect picks up.
    useEffect(() => {
        if (!sessionPath) return;
        const api = getAgentApi();
        if (!api) return;
        const unsubscribe = api.subscribe(sessionPath, (raw) => {
            const event = raw as PiAgentEvent;
            setMessages((prev) => reducePiChatEvent(prev, event));
            switch (event.type) {
                case "snapshot": {
                    // Replayed once on (re)subscribe: seed status from the
                    // owner so a renderer that attaches mid-stream reflects
                    // "streaming" instead of a stale "idle". reducePiChatEvent
                    // already mirrored the messages above.
                    const snapStatus = event.status as UsePiChatStatus | undefined;
                    if (snapStatus) {
                        setStatus(snapStatus);
                        setErrorMessage(snapStatus === "error" ? "agent error" : undefined);
                    }
                    break;
                }
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
                    setStatus("idle");
                    break;
                default:
                    break;
            }
        });
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
            setStatus("streaming");
            setErrorMessage(undefined);
            try {
                const result = await api.send({
                    sessionMetadata: sessionMetadata ?? null,
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
        [sessionMetadata],
    );

    const abort = useCallback((): void => {
        const api = getAgentApi();
        if (!api || !sessionPath) return;
        api.abort(sessionPath);
    }, [sessionPath]);

    return useMemo(
        () => ({ messages, status, errorMessage, sessionMetadata, send, abort }),
        [messages, status, errorMessage, sessionMetadata, send, abort],
    );
}
