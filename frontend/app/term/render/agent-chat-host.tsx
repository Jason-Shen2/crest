// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AgentChatHost — owns the React hook lifecycle for one pane's agent
// session. It watches the message array, slices it into runs, and
// persists marker rows so TerminalModel can rehydrate them like shell
// cmdblocks.
//
// Replaces the pre-pi version which mounted @ai-sdk/react useChat and
// translated UIMessage parts into ai-sdk's WaveUIDataToolUse shape
// via TerminalModel.applyAgentParts. Post-pi: messages live in
// usePiChat state, runs are derived via slicePiRuns, and rendering
// looks them up directly — TerminalModel just holds the marker blocks.
//
// Returns null — purely a state-bridge component. UI lives in
// AgentBlockElement (mounted by BlockListElement per agent block).

import { useEffect, useRef } from "react";

import {
    type PiAgentMessage,
    type PiRun,
    type UsePiChatModel,
    type UsePiChatPaneContext,
    type UsePiChatStatus,
    usePiChat,
} from "@/app/store/use-pi-chat";
import type { ResolveError } from "@/app/store/ai-types";

export interface AgentChatHostProps {
    outerBlockId: string;
    /** Persisted session metadata from block.meta["agent:session"]. Undefined → first send mints one. */
    sessionMetadata?: AgentSessionMeta;
    /** Called once when usePiChat receives the new metadata after first send. */
    onSessionMinted?: (meta: AgentSessionMeta) => void;
    /** Resolved model selection (provider/model/reasoning) from the picker + resolver. */
    modelSelection?: UsePiChatModel;
    /** Pane context (cwd / git / recent cmds / connection) fed into the system prompt. */
    paneContext: UsePiChatPaneContext;
    /**
     * When the model selection failed to resolve (no API key, unknown model,
     * etc.), this carries the structured error so submit attempts can be
     * routed to an inline error block instead of silently dropped.
     */
    selectionError?: ResolveError | null;
    /** Wired once with a send fn the input bar can call. Mirrors the previous useChat host's pattern. */
    onReady?: (api: AgentChatHostApi) => void;
    /** Called on every runs change so the parent can feed AgentBlockElement via BlockListElement. */
    onRunsChange?: (runs: PiRun[]) => void;
    /**
     * Called when the agent's live status or pending queue changes. Drives the
     * activity bar above the input (streaming indicator + Stop + queued chips).
     */
    onStateChange?: (state: AgentHostState) => void;
    /** Per-pane tool allowlist; undefined = main defaults to allowAll (v1). */
    allowedTools?: string[];
    /** Notification atom setter — surface user-facing errors when send can't proceed. */
    onUserError?: (message: string) => void;
}

/** Reactive agent state surfaced to the parent for the activity bar. */
export interface AgentHostState {
    status: UsePiChatStatus;
    /** Messages queued behind the current run (ordered steer-first). */
    queuedMessages: PiAgentMessage[];
}

/** Functions exposed via onReady for the input bar / parent. */
export interface AgentChatHostApi {
    /** Send a user prompt. Idempotent if called twice with the same text — pi will queue. */
    send: (text: string) => boolean;
    /** Abort the in-flight run, if any. */
    abort: () => void;
    /** Snapshot of runs for diagnostics / future selectors. */
    getRuns: () => PiRun[];
}

export function AgentChatHost({
    outerBlockId,
    sessionMetadata,
    onSessionMinted,
    modelSelection,
    paneContext,
    selectionError,
    onReady,
    onRunsChange,
    onStateChange,
    allowedTools,
    onUserError,
}: AgentChatHostProps) {
    // usePiChat doesn't accept a undefined modelSelection (send needs
    // provider+model). We feed it a synthetic placeholder when the
    // resolver hasn't produced one yet so the hook can mount; send()
    // below short-circuits with an error before actually calling the
    // hook's send if the real selection isn't ready.
    const effectiveSelection: UsePiChatModel = modelSelection ?? {
        provider: "",
        model: "",
    };

    const chat = usePiChat({
        initialSession: sessionMetadata,
        onSessionMinted,
        paneContext,
        modelSelection: effectiveSelection,
        allowedTools,
        blockId: outerBlockId,
    });

    const runs = chat.runs;
    const onRunsChangeRef = useRef(onRunsChange);
    onRunsChangeRef.current = onRunsChange;
    const onUserErrorRef = useRef(onUserError);
    onUserErrorRef.current = onUserError;
    useEffect(() => {
        onRunsChangeRef.current?.(runs);
    }, [runs]);

    // Expose the send/abort API to the parent via onReady. Refs keep
    // the callback closure stable across renders while still reading
    // the latest model state, selection error, and chat handle.
    const sendRef = useRef(chat.send);
    const abortRef = useRef(chat.abort);
    const runsRef = useRef(runs);
    const selectionErrorRef = useRef(selectionError);
    const modelSelectionRef = useRef(modelSelection);
    useEffect(() => {
        sendRef.current = chat.send;
        abortRef.current = chat.abort;
        runsRef.current = runs;
        selectionErrorRef.current = selectionError;
        modelSelectionRef.current = modelSelection;
    }, [chat.send, chat.abort, runs, selectionError, modelSelection]);

    const onReadyRef = useRef(onReady);
    onReadyRef.current = onReady;
    // Surface live status + pending queue to the parent (the activity bar).
    const onStateChangeRef = useRef(onStateChange);
    onStateChangeRef.current = onStateChange;
    useEffect(() => {
        onStateChangeRef.current?.({ status: chat.status, queuedMessages: chat.queuedMessages });
    }, [chat.status, chat.queuedMessages]);

    // One-shot wiring of the API. Stable identity so re-renders don't
    // tear down whatever the parent stored.
    useEffect(() => {
        const api: AgentChatHostApi = {
            send: (text) => {
                const trimmed = text.trim();
                if (!trimmed) return false;
                // Block sends when no model is resolved (e.g. ai.json
                // missing, no API key). Surface the resolver error so
                // the user sees a specific reason rather than nothing.
                if (!modelSelectionRef.current) {
                    const msg =
                        selectionErrorRef.current?.message ??
                        "AI is not configured. Open the model picker to set up a provider and pick a model.";
                    onUserErrorRef.current?.(msg);
                    return false;
                }
                void sendRef.current(trimmed);
                return true;
            },
            abort: () => {
                abortRef.current();
            },
            getRuns: () => runsRef.current,
        };
        onReadyRef.current?.(api);
        // Re-fire when the API identity is stable; we want one-shot,
        // but tolerating an extra fire on remount is harmless because
        // the parent overwrites the ref unconditionally.
    }, []);

    return null;
}
