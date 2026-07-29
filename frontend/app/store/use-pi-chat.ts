// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// usePiChat — React hook that consumes the integrated agent runtime
// via the injected Workspace Agent runtime client. Replaces the legacy
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
//   } = usePiChat({ client, initialSession, executionContext, modelSelection });
//
// Subscribe lifecycle: the hook subscribes through the runtime client
// only AFTER a session metadata is known (either passed in via
// initialSession or returned by the first send). Pre-session messages
// are kept locally and merged in once the subscription starts.
//

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
    contextSendDisabledReason,
    contextTargetIdentity,
    createContextReferenceState,
    reduceContextReferenceState,
    type ContextReferenceAction,
    type ContextReferenceRendererState,
    type ContextReferenceTargetIdentity,
} from "./context-references";

/**
 * Mirror of pi's AgentMessage at the renderer boundary. Kept as a
 * structural type rather than imported from packages/agent/types because
 * the renderer must not pull main-process modules. Stays in sync with
 * packages/agent/types.ts AgentMessage by review during the wiring task.
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
    contextProjection?: AgentContextProjectionReportView;
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
    /** session_state carries hosted PTY command snapshots. */
    commands?: AgentPtySnapshot[];
    /** turn_end carries this. */
    toolResults?: PiAgentMessage[];
    /** session_state carries committed context state. */
    contextReports?: AgentContextProjectionReportView[];
    /** session_state carries authoritative workspace rewind availability. */
    rewindState?: AgentRewindSessionStateView;
    /** context_projection carries the committed per-turn report. */
    report?: AgentContextProjectionReportView;
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

export interface UsePiChatActivity {
    getActive(): boolean;
    subscribe(listener: (active: boolean) => void): () => void;
}

const AlwaysActivePiChatActivity: UsePiChatActivity = {
    getActive: () => true,
    subscribe: () => () => {},
};

export interface UsePiChatOptions {
    client: AgentApiSurface;
    /**
     * Existing session metadata. Undefined means "no session yet — first
     * send mints one".
     */
    initialSession?: AgentSessionMeta;
    /**
     * Presence marks the session as externally controlled. Unlike
     * initialSession, an empty metadata value explicitly clears the active
     * session. The wrapper keeps an omitted initial value distinct from a
     * later authoritative clear after a locally minted session.
     */
    controlledSession?: { metadata?: AgentSessionMeta; revision?: number };
    /**
     * Workspace execution context sampled per send. It is workspace-scoped;
     * Agent runtime ownership no longer depends on Terminal Block identity.
     */
    executionContext: AgentExecutionContext;
    /** Current model selection, sampled per send. */
    modelSelection: UsePiChatModel;
    /**
     * Renderer-local resource lifecycle. Activity changes must not be represented
     * as hook render state.
     */
    activity?: UsePiChatActivity;
    /** Called when the runtime creates or returns a different active session. */
    onSessionChange?: (meta: AgentSessionMeta) => void;
    /** Optional tool allowlist; when omitted, main defaults to allowAll. */
    allowedTools?: string[];
    /** Renderer control state; main remains authoritative for every mutation and send. */
    contextReferencesEnabled?: boolean;
}

export type UsePiChatStatus = "idle" | "streaming" | "error";

export type UsePiChatPrepareContextInput = Omit<AgentPrepareContextDraftInput, "targetSessionPath"> & {
    expectedTarget?: ContextReferenceTargetIdentity;
    deliveryScope?: AgentContextDeliveryScope;
    requestedRepresentation?: AgentContextRepresentation;
};

export interface ContextSendRecovery {
    text: string;
    images?: string[];
    draftIds: string[];
    errorMessage: string;
}

const ComposerRestoreText = Symbol("composerRestoreText");

type ComposerRestoreMarkedError = {
    [ComposerRestoreText]?: string;
};

export function markSendErrorForComposerRestore(error: unknown, text: string): unknown {
    if ((typeof error === "object" && error != null) || typeof error === "function") {
        try {
            Object.defineProperty(error, ComposerRestoreText, {
                configurable: true,
                value: text,
            });
            return error;
        } catch {
            // Frozen rejection values need a wrapper so the recovery marker remains authoritative.
        }
    }
    const wrapped = new Error(getErrorMessage(error), { cause: error });
    Object.defineProperty(wrapped, ComposerRestoreText, { value: text });
    return wrapped;
}

export function composerRestoreTextFromSendError(error: unknown): string | undefined {
    if ((typeof error !== "object" || error == null) && typeof error !== "function") {
        return undefined;
    }
    try {
        return (error as ComposerRestoreMarkedError)[ComposerRestoreText];
    } catch {
        return undefined;
    }
}

interface ContextSendRecoveryRecord {
    id: number;
    target: ContextReferenceTargetIdentity;
    value: ContextSendRecovery;
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
    commands: AgentPtySnapshot[];
    rewindState: AgentRewindSessionStateView;
    send: (text: string, options?: UsePiChatSendOptions) => Promise<void>;
    abort: () => void;
    contextState: ContextReferenceRendererState;
    contextSendRecovery?: ContextSendRecovery;
    prepareContextDraft: (input: UsePiChatPrepareContextInput) => Promise<void>;
    discardContextDraft: (draftId: string) => Promise<void>;
    summarizeContextDraft: (draftId: string) => Promise<void>;
    retryContextSend: () => Promise<void>;
}

export const EmptyRewindState: AgentRewindSessionStateView = {
    enabled: false,
    semanticLeafId: null,
    displayLeafId: null,
    eligibleTurnIds: [],
    busy: false,
    frozen: false,
    quota: {
        status: "ok",
        usedBytes: 0,
        softQuotaBytes: 5 * 1024 ** 3,
        cleanupAvailable: false,
    },
};

export interface UsePiChatSendOptions {
    images?: string[];
}

interface AgentApiSurface {
    createSession: () => Promise<AgentSessionMeta>;
    getSessionState: (sessionMetadata: AgentSessionMeta) => Promise<PiAgentEvent>;
    prepareContextDraft: (input: AgentPrepareContextDraftInput) => Promise<AgentPrepareContextDraftResult>;
    summarizeContextDraft: (input: AgentSummarizeContextDraftInput) => Promise<AgentSummarizeContextDraftResult>;
    discardContextDraft: (input: AgentDiscardContextDraftInput) => Promise<AgentDiscardContextDraftResult>;
    listReferencePoints: (input: AgentListReferencePointsInput) => Promise<AgentReferencePointView[]>;
    listContextState: (input: AgentListContextStateInput) => Promise<AgentContextState>;
    send: (opts: AgentSendOptions) => Promise<{ sessionMetadata: AgentSessionMeta; turnId: string }>;
    abort: (sessionPath: string) => Promise<void>;
    subscribe: (sessionPath: string, callback: (event: unknown) => void) => () => void;
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

export function attachContextReportsToTurns(
    turns: PiTurn[],
    reports: readonly AgentContextProjectionReportView[]
): PiTurn[] {
    if (turns.length === 0 || reports.length === 0) return turns;
    const reportsByTurn = new Map(reports.map((report) => [report.targetTurnId, report]));
    let changed = false;
    const next = turns.map((turn) => {
        const report = reportsByTurn.get(turn.turnId);
        if (!report || turn.contextProjection === report) return turn;
        changed = true;
        return { ...turn, contextProjection: report };
    });
    return changed ? next : turns;
}

export function adoptInitialSessionMetadata(
    current: AgentSessionMeta | undefined,
    incoming: AgentSessionMeta | undefined
): AgentSessionMeta | undefined {
    if (!incoming?.path) return undefined;
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
    setQueuedMessages: (messages: PiAgentMessage[]) => void,
    setCommands: (commands: AgentPtySnapshot[]) => void,
    setRewindState: (rewindState: AgentRewindSessionStateView) => void
): void {
    const stateStatus = event.status as UsePiChatStatus | undefined;
    if (stateStatus) {
        setStatus(stateStatus);
        setErrorMessage(stateStatus === "error" ? "agent error" : undefined);
    }
    setQueuedMessages([...(event.steer ?? []), ...(event.followUp ?? [])]);
    setCommands([...(event.commands ?? [])]);
    setRewindState(event.rewindState ?? EmptyRewindState);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function contextStateFromEvent(event: PiAgentEvent): Pick<AgentContextState, "contextReports"> {
    return {
        contextReports: event.contextReports ?? [],
    };
}

function matchesContextTarget(
    current: ContextReferenceTargetIdentity,
    expected: ContextReferenceTargetIdentity
): boolean {
    return (
        current.targetSessionPath === expected.targetSessionPath &&
        current.targetGeneration === expected.targetGeneration
    );
}

function sameOrderedValues(left: string[] | undefined, right: string[] | undefined): boolean {
    if (left == null || right == null) {
        return left == null && right == null;
    }
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function matchesContextRecovery(
    recovery: ContextSendRecoveryRecord | undefined,
    target: ContextReferenceTargetIdentity,
    text: string,
    images: string[] | undefined,
    draftIds: string[]
): boolean {
    return (
        !!recovery &&
        matchesContextTarget(recovery.target, target) &&
        recovery.value.text === text &&
        sameOrderedValues(recovery.value.images, images) &&
        sameOrderedValues(recovery.value.draftIds, draftIds)
    );
}

export function usePiChat(opts: UsePiChatOptions): UsePiChatReturn {
    const activity = opts.activity ?? AlwaysActivePiChatActivity;
    const initialSessionMetadata =
        opts.controlledSession != null ? opts.controlledSession.metadata : opts.initialSession;
    const controlledSessionPath = opts.controlledSession?.metadata?.path;
    const controlledSessionRevision = opts.controlledSession?.revision ?? 0;
    const hasControlledSession = opts.controlledSession != null;
    const [messages, setMessages] = useState<PiAgentMessage[]>([]);
    const [turns, setTurns] = useState<PiTurn[]>([]);
    const [status, setStatus] = useState<UsePiChatStatus>("idle");
    const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
    const [queuedMessages, setQueuedMessages] = useState<PiAgentMessage[]>([]);
    const [commands, setCommands] = useState<AgentPtySnapshot[]>([]);
    const [rewindState, setRewindState] = useState<AgentRewindSessionStateView>(EmptyRewindState);
    const [sessionMetadata, setSessionMetadata] = useState<AgentSessionMeta | undefined>(initialSessionMetadata);
    const [contextState, setContextState] = useState<ContextReferenceRendererState>(() => ({
        ...createContextReferenceState(initialSessionMetadata?.path),
        enabled: opts.contextReferencesEnabled !== false,
    }));
    const [contextSendRecovery, setContextSendRecovery] = useState<ContextSendRecovery | undefined>();
    const sessionMetadataRef = useRef<AgentSessionMeta | undefined>(initialSessionMetadata);
    const activeSessionPathRef = useRef(initialSessionMetadata?.path ?? "");
    const contextStateRef = useRef(contextState);
    const sendCaptureSequenceRef = useRef(0);
    const recoverySequenceRef = useRef(0);
    const contextSendRecoveryRecordRef = useRef<ContextSendRecoveryRecord | undefined>(undefined);

    // Refs hold the latest values without re-subscribing.
    const onSessionChangeRef = useRef(opts.onSessionChange);
    const modelSelectionRef = useRef(opts.modelSelection);
    const allowedToolsRef = useRef(opts.allowedTools);
    const runtimeClientRef = useRef<AgentApiSurface | undefined>(opts.client);
    const executionContextRef = useRef(opts.executionContext);
    const subscriptionEpochRef = useRef(0);
    const requestEpochRef = useRef(0);
    const controlledSessionBoundaryRef = useRef({
        controlled: hasControlledSession,
        path: controlledSessionPath,
        revision: controlledSessionRevision,
    });
    const pendingLocalSessionAckPathRef = useRef("");
    const createSessionRequestRef = useRef<{
        epoch: number;
        promise: Promise<AgentSessionMeta>;
    }>(undefined);
    useEffect(() => {
        onSessionChangeRef.current = opts.onSessionChange;
        modelSelectionRef.current = opts.modelSelection;
        allowedToolsRef.current = opts.allowedTools;
        runtimeClientRef.current = opts.client;
        executionContextRef.current = opts.executionContext;
    }, [opts.onSessionChange, opts.modelSelection, opts.allowedTools, opts.client, opts.executionContext]);

    const dispatchContext = useCallback((action: ContextReferenceAction): ContextReferenceRendererState => {
        const next = reduceContextReferenceState(contextStateRef.current, action);
        if (next === contextStateRef.current) {
            return next;
        }
        contextStateRef.current = next;
        setContextState(next);
        return next;
    }, []);

    const setContextRecovery = useCallback((record?: ContextSendRecoveryRecord): void => {
        contextSendRecoveryRecordRef.current = record;
        setContextSendRecovery(record?.value);
    }, []);

    useEffect(() => {
        dispatchContext({
            type: "enabled_changed",
            enabled: opts.contextReferencesEnabled !== false,
        });
    }, [dispatchContext, opts.contextReferencesEnabled]);

    useLayoutEffect(() => {
        const previousBoundary = controlledSessionBoundaryRef.current;
        controlledSessionBoundaryRef.current = {
            controlled: hasControlledSession,
            path: controlledSessionPath,
            revision: controlledSessionRevision,
        };
        const ownershipChanged = previousBoundary.controlled !== hasControlledSession;
        const revisionChanged = previousBoundary.revision !== controlledSessionRevision;
        const isLocalMintAcknowledgement =
            revisionChanged &&
            !!controlledSessionPath &&
            controlledSessionPath === pendingLocalSessionAckPathRef.current &&
            controlledSessionPath === sessionMetadataRef.current?.path;
        if (isLocalMintAcknowledgement) {
            pendingLocalSessionAckPathRef.current = "";
        }
        const explicitIdentityChange = revisionChanged && !isLocalMintAcknowledgement;
        if (ownershipChanged || explicitIdentityChange) {
            requestEpochRef.current++;
        }
        if (!hasControlledSession) return;
        const next = adoptInitialSessionMetadata(sessionMetadataRef.current, opts.controlledSession?.metadata);
        const pathChanged = sessionMetadataRef.current?.path !== next?.path;
        if (!pathChanged && !explicitIdentityChange) return;
        subscriptionEpochRef.current++;
        if (pathChanged && !ownershipChanged && !explicitIdentityChange) {
            requestEpochRef.current++;
        }
        sessionMetadataRef.current = next;
        activeSessionPathRef.current = next?.path ?? "";
        setMessages([]);
        setTurns([]);
        setStatus("idle");
        setErrorMessage(undefined);
        setQueuedMessages([]);
        setCommands([]);
        setRewindState(EmptyRewindState);
        setSessionMetadata(next);
        dispatchContext({ type: "target_changed", targetSessionPath: next?.path });
        setContextRecovery(undefined);
    }, [controlledSessionPath, controlledSessionRevision, dispatchContext, hasControlledSession, setContextRecovery]);

    const sessionPath = sessionMetadata?.path;
    useEffect(() => {
        sessionMetadataRef.current = sessionMetadata;
        activeSessionPathRef.current = sessionMetadata?.path ?? "";
    }, [sessionMetadata]);

    const ensureSessionResolution = useCallback(async (): Promise<{
        metadata: AgentSessionMeta;
        acceptedMint: boolean;
    }> => {
        if (sessionMetadataRef.current?.path) {
            return { metadata: sessionMetadataRef.current, acceptedMint: false };
        }
        const api = runtimeClientRef.current;
        if (!api) {
            throw new Error("Workspace Agent runtime client is unavailable");
        }
        const requestEpoch = requestEpochRef.current;
        const mintTarget = contextTargetIdentity(contextStateRef.current);
        let createRequest = createSessionRequestRef.current;
        if (!createRequest || createRequest.epoch !== requestEpoch) {
            createRequest = { epoch: requestEpoch, promise: api.createSession() };
            createSessionRequestRef.current = createRequest;
            void createRequest.promise.catch(() => {
                if (createSessionRequestRef.current === createRequest) {
                    createSessionRequestRef.current = undefined;
                }
            });
        }
        const metadata = await createRequest.promise;
        if (requestEpoch !== requestEpochRef.current || !matchesContextTarget(contextStateRef.current, mintTarget)) {
            const current = sessionMetadataRef.current;
            if (current?.path) {
                dispatchContext({ type: "target_changed", targetSessionPath: current.path });
                return { metadata: current, acceptedMint: false };
            }
            return { metadata, acceptedMint: false };
        }
        if (sessionMetadataRef.current?.path !== metadata.path) {
            sessionMetadataRef.current = metadata;
            activeSessionPathRef.current = metadata.path;
            setSessionMetadata(metadata);
            pendingLocalSessionAckPathRef.current = metadata.path;
            dispatchContext({ type: "target_changed", targetSessionPath: metadata.path });
            onSessionChangeRef.current?.(metadata);
        }
        return { metadata, acceptedMint: true };
    }, [dispatchContext]);

    // Subscribe to the session's event stream — only after we have a
    // sessionPath. Pre-session sends are still possible; they mint a
    // session and then the next render this effect picks up.
    useEffect(() => {
        if (!sessionPath) return;
        const api = runtimeClientRef.current;
        if (!api) return;
        const targetState = dispatchContext({ type: "target_changed", targetSessionPath: sessionPath });
        setContextRecovery(undefined);
        const targetIdentity = contextTargetIdentity(targetState);
        let cancelled = false;
        let unsubscribeSession: (() => void) | undefined;
        const startSubscription = (): void => {
            if (unsubscribeSession) return;
            const epoch = ++subscriptionEpochRef.current;
            const isCurrentSubscription = (): boolean =>
                !cancelled &&
                subscriptionEpochRef.current === epoch &&
                activeSessionPathRef.current === sessionPath &&
                matchesContextTarget(contextStateRef.current, targetIdentity);
            unsubscribeSession = api.subscribe(sessionPath, (raw) => {
                if (!isCurrentSubscription()) return;
                const event = raw as PiAgentEvent;
                setMessages((prev) => reducePiChatEvent(prev, event));
                const reportMap = { ...contextStateRef.current.reportsByTurn };
                if (event.type === "session_state" && event.contextReports) {
                    for (const key of Object.keys(reportMap)) delete reportMap[key];
                    for (const report of event.contextReports ?? []) reportMap[report.targetTurnId] = report;
                } else if (event.type === "context_projection" && event.report) {
                    reportMap[event.report.targetTurnId] = event.report;
                }
                setTurns((prev) =>
                    attachContextReportsToTurns(reducePiTurnsEvent(prev, event), Object.values(reportMap))
                );
                switch (event.type) {
                    case "session_state": {
                        applySessionState(
                            event,
                            setStatus,
                            setErrorMessage,
                            setQueuedMessages,
                            setCommands,
                            setRewindState
                        );
                        const authoritative = contextStateFromEvent(event);
                        dispatchContext({
                            type: "authoritative_state_received",
                            ...targetIdentity,
                            reports: authoritative.contextReports,
                        });
                        break;
                    }
                    case "context_projection":
                        if (event.report) {
                            dispatchContext({
                                type: "projection_received",
                                ...targetIdentity,
                                report: event.report,
                            });
                        }
                        break;
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
                        // The owner may emit agent_end after an error message, but
                        // its authoritative status remains error until a retry.
                        setStatus((current) => (current === "error" ? current : "idle"));
                        break;
                    case "abort":
                        setStatus("idle");
                        setErrorMessage(undefined);
                        break;
                    default:
                        break;
                }
            });
        };
        const stopSubscription = (): void => {
            if (!unsubscribeSession) return;
            subscriptionEpochRef.current++;
            unsubscribeSession();
            unsubscribeSession = undefined;
        };
        if (activity.getActive()) {
            startSubscription();
        }
        const unsubscribeActivity = activity.subscribe((active) => {
            if (active) {
                startSubscription();
                return;
            }
            stopSubscription();
        });
        return () => {
            cancelled = true;
            unsubscribeActivity();
            stopSubscription();
        };
    }, [activity, controlledSessionRevision, dispatchContext, sessionPath, setContextRecovery]);

    const requireContextEnabled = useCallback((): void => {
        if (!contextStateRef.current.enabled) {
            throw new Error("Context references are disabled");
        }
    }, []);

    const prepareContextDraft = useCallback(
        async (input: UsePiChatPrepareContextInput): Promise<void> => {
            requireContextEnabled();
            const api = runtimeClientRef.current;
            if (!api) {
                throw new Error("Workspace Agent runtime client is unavailable");
            }
            if (input.expectedTarget && !matchesContextTarget(contextStateRef.current, input.expectedTarget)) {
                throw new Error("Agent session changed while the selector was open.");
            }
            const targetSessionResolution = await ensureSessionResolution();
            const targetSession = targetSessionResolution.metadata;
            const target = contextTargetIdentity(contextStateRef.current);
            if (input.expectedTarget && !matchesContextTarget(target, input.expectedTarget)) {
                const acceptedSharedMint =
                    input.expectedTarget.targetSessionPath == null &&
                    targetSessionResolution.acceptedMint &&
                    target.targetSessionPath === targetSession.path &&
                    target.targetGeneration === input.expectedTarget.targetGeneration + 1;
                if (!acceptedSharedMint) {
                    throw new Error("Agent session changed while the selector was open.");
                }
            }
            const mainInput = { ...input };
            delete mainInput.expectedTarget;
            const deliveryScope = mainInput.deliveryScope ?? "message";
            delete mainInput.deliveryScope;
            const requestedRepresentation = mainInput.requestedRepresentation ?? "full";
            delete mainInput.requestedRepresentation;
            const view = await api.prepareContextDraft({
                ...mainInput,
                targetSessionPath: targetSession.path,
            });
            if (!matchesContextTarget(contextStateRef.current, target)) {
                throw new Error("Agent session changed while the selector was open.");
            }
            dispatchContext({ type: "draft_prepared", ...target, view, deliveryScope, requestedRepresentation });
            if (requestedRepresentation !== "summary") {
                return;
            }
            dispatchContext({ type: "summary_began", draftId: view.draftId });
            void api
                .summarizeContextDraft({
                    targetSessionPath: targetSession.path,
                    draftId: view.draftId,
                })
                .then((summarizedView) => {
                    dispatchContext({
                        type: "summary_succeeded",
                        ...target,
                        draftId: view.draftId,
                        view: summarizedView,
                    });
                })
                .catch((error) => {
                    dispatchContext({
                        type: "summary_failed",
                        ...target,
                        draftId: view.draftId,
                        errorMessage: getErrorMessage(error),
                    });
                });
        },
        [dispatchContext, ensureSessionResolution, requireContextEnabled]
    );

    const discardContextDraft = useCallback(
        async (draftId: string): Promise<void> => {
            const api = runtimeClientRef.current;
            if (!api) {
                throw new Error("Workspace Agent runtime client is unavailable");
            }
            const target = contextTargetIdentity(contextStateRef.current);
            if (!target.targetSessionPath) return;
            const result = await api.discardContextDraft({
                targetSessionPath: target.targetSessionPath,
                draftId,
            });
            if (result.discarded) {
                dispatchContext({ type: "draft_discarded", ...target, draftId });
            }
        },
        [dispatchContext]
    );

    const summarizeContextDraft = useCallback(
        async (draftId: string): Promise<void> => {
            requireContextEnabled();
            const api = runtimeClientRef.current;
            if (!api) {
                throw new Error("Workspace Agent runtime client is unavailable");
            }
            const target = contextTargetIdentity(contextStateRef.current);
            if (!target.targetSessionPath) return;
            dispatchContext({ type: "summary_began", draftId });
            try {
                const view = await api.summarizeContextDraft({
                    targetSessionPath: target.targetSessionPath,
                    draftId,
                });
                dispatchContext({ type: "summary_succeeded", ...target, draftId, view });
            } catch (error) {
                dispatchContext({
                    type: "summary_failed",
                    ...target,
                    draftId,
                    errorMessage: getErrorMessage(error),
                });
                throw error;
            }
        },
        [dispatchContext, requireContextEnabled]
    );

    const send = useCallback(
        async (text: string, options?: UsePiChatSendOptions, retryRecoveryId?: number): Promise<void> => {
            const requestEpoch = requestEpochRef.current;
            const api = runtimeClientRef.current;
            if (!api) {
                const message = "Workspace Agent runtime client is unavailable";
                setStatus("error");
                setErrorMessage(message);
                throw markSendErrorForComposerRestore(new Error(message), text);
            }
            if (!executionContextRef.current) {
                const message = "Workspace Agent execution context is unavailable";
                setStatus("error");
                setErrorMessage(message);
                throw markSendErrorForComposerRestore(new Error(message), text);
            }
            const beforeSend = contextStateRef.current;
            const draftIds = beforeSend.drafts
                .filter((draft) => draft.status === "ready" || draft.status === "error")
                .map((draft) => draft.view.draftId);
            const hasReferences = beforeSend.drafts.length > 0;
            const disabledReason = hasReferences ? contextSendDisabledReason(beforeSend) : undefined;
            if (disabledReason) {
                throw new Error(`Context reference send is disabled: ${disabledReason}`);
            }
            let target = contextTargetIdentity(beforeSend);
            const recoveryAtCapture = contextSendRecoveryRecordRef.current;
            const matchingRecoveryId =
                retryRecoveryId ??
                (matchesContextRecovery(recoveryAtCapture, target, text, options?.images, draftIds)
                    ? recoveryAtCapture.id
                    : undefined);
            const captureId = `context-send-${++sendCaptureSequenceRef.current}`;
            if (hasReferences) {
                dispatchContext({ type: "send_began", ...target, captureId, draftIds });
            }
            const capture = contextStateRef.current.sendCapturesById[captureId];
            setErrorMessage(undefined);
            let sendSessionMetadata: AgentSessionMeta | undefined;
            try {
                sendSessionMetadata = (await ensureSessionResolution()).metadata;
                if (requestEpoch !== requestEpochRef.current) return;
                if (!target.targetSessionPath) {
                    target = contextTargetIdentity(contextStateRef.current);
                }
                const result = await api.send({
                    sessionMetadata: sendSessionMetadata,
                    context: executionContextRef.current,
                    text,
                    images: options?.images,
                    provider: modelSelectionRef.current.provider,
                    model: modelSelectionRef.current.model,
                    reasoning: modelSelectionRef.current.reasoning,
                    token: modelSelectionRef.current.token,
                    tokenSecretName: modelSelectionRef.current.tokenSecretName,
                    allowedTools: allowedToolsRef.current,
                    ...(capture?.attachments.length ? { contextAttachments: capture.attachments } : {}),
                });
                if (requestEpoch !== requestEpochRef.current) return;
                const isCurrentTarget =
                    matchesContextTarget(contextStateRef.current, target) &&
                    sessionMetadataRef.current?.path === sendSessionMetadata.path;
                if (capture && isCurrentTarget) {
                    dispatchContext({ type: "send_succeeded", ...target, captureId });
                }
                if (!isCurrentTarget) {
                    return;
                }
                setStatus("streaming");
                activeSessionPathRef.current = result.sessionMetadata.path;
                if (sessionMetadataRef.current?.path !== result.sessionMetadata.path) {
                    sessionMetadataRef.current = result.sessionMetadata;
                    setSessionMetadata(result.sessionMetadata);
                    pendingLocalSessionAckPathRef.current = result.sessionMetadata.path;
                    onSessionChangeRef.current?.(result.sessionMetadata);
                }
                if (matchingRecoveryId != null && contextSendRecoveryRecordRef.current?.id === matchingRecoveryId) {
                    setContextRecovery(undefined);
                }
            } catch (error) {
                if (requestEpoch !== requestEpochRef.current) return;
                const message = getErrorMessage(error);
                const isCurrentTarget =
                    matchesContextTarget(contextStateRef.current, target) &&
                    (!sendSessionMetadata || sessionMetadataRef.current?.path === sendSessionMetadata.path);
                if (isCurrentTarget) {
                    setStatus("error");
                    setErrorMessage(message);
                }
                if (capture && isCurrentTarget) {
                    dispatchContext({ type: "send_failed", ...target, captureId, errorMessage: message });
                    const retryRecord = contextSendRecoveryRecordRef.current;
                    if (matchingRecoveryId == null || retryRecord?.id === matchingRecoveryId) {
                        const recoveryId = matchingRecoveryId ?? ++recoverySequenceRef.current;
                        setContextRecovery({
                            id: recoveryId,
                            target,
                            value: {
                                text,
                                images: options?.images,
                                draftIds: capture.attachments.map((attachment) => attachment.draftId),
                                errorMessage: message,
                            },
                        });
                    }
                }
                throw isCurrentTarget ? markSendErrorForComposerRestore(error, text) : error;
            }
        },
        [dispatchContext, ensureSessionResolution, setContextRecovery]
    );

    const retryContextSend = useCallback(async (): Promise<void> => {
        const recovery = contextSendRecoveryRecordRef.current;
        if (!recovery) return;
        if (
            !matchesContextTarget(contextStateRef.current, recovery.target) ||
            sessionMetadataRef.current?.path !== recovery.target.targetSessionPath
        ) {
            setContextRecovery(undefined);
            return;
        }
        await send(recovery.value.text, { images: recovery.value.images }, recovery.id);
    }, [send, setContextRecovery]);

    const abort = useCallback((): void => {
        const api = runtimeClientRef.current;
        const abortSessionPath = resolveAbortSessionPath(sessionMetadataRef.current, activeSessionPathRef.current);
        setStatus((current) => getOptimisticAbortStatus(current));
        setQueuedMessages([]);
        if (!api || !abortSessionPath) return;
        void api.abort(abortSessionPath);
    }, []);

    return useMemo(
        () => ({
            messages,
            turns,
            status,
            errorMessage,
            sessionMetadata,
            queuedMessages,
            commands,
            rewindState,
            send,
            abort,
            contextState,
            contextSendRecovery,
            prepareContextDraft,
            discardContextDraft,
            summarizeContextDraft,
            retryContextSend,
        }),
        [
            abort,
            commands,
            contextSendRecovery,
            contextState,
            discardContextDraft,
            errorMessage,
            messages,
            prepareContextDraft,
            queuedMessages,
            rewindState,
            retryContextSend,
            send,
            sessionMetadata,
            status,
            summarizeContextDraft,
            turns,
        ]
    );
}
