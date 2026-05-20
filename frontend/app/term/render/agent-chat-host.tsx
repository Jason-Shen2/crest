// Copyright 2026, Crest contributors. SPDX-License-Identifier: Apache-2.0
//
// AgentChatHost — ai-sdk useChat host that bridges agent SSE chunks into
// TerminalModel.  Structure derived from warp:
//   app/src/ai/blocklist/controller/response_stream.rs:45-117 (event flow)
//   app/src/ai/blocklist/history_model.rs:2177-2203 (UpdatedStreamingExchange)
// Warp is © 2020-2026 Denver Technologies, Inc., MIT licensed.
//
// Responsibilities:
//   1. Owns the useChat hook keyed off a stable per-pane chatId.
//   2. Translates ai-sdk's UIMessage[] stream into per-block agent state on
//      TerminalModel (one block per exchange, addressed by message id).
//   3. Builds the request body for /api/post-agent-message — pulls
//      chatid / tabid / blockid / mode / aimode / context from props.
//   4. Exposes `submit(text)` to the input bar via a callback ref so the
//      cmdblock-input can fire useChat without owning the hook lifecycle.
//
// Rendering: this component returns null.  All visual output lives in
// AgentBlockElement (rendered by BlockListElement when block.kind ===
// "agent").  The host's only DOM responsibility is to be a stable place
// in the React tree where useChat can mount.

import { useEffect, useMemo, useRef } from "react";
import { DefaultChatTransport } from "ai";
import { useChat } from "@ai-sdk/react";

import { TerminalModel } from "../terminal-model";
import { WaveUIMessage } from "@/app/store/aitypes";
import { ResolvedAIConfig } from "@/app/store/ai-types";
import { globalStore } from "@/app/store/jotaiStore";

export interface AgentChatHostProps {
    model: TerminalModel;
    chatId: string;
    outerBlockId: string;
    tabId?: string;
    // Resolved AI config — the backend ingests this directly via
    // BuildAIOptsFromConfig, no further catalog / settings lookups.
    // Null while user hasn't picked a model and ai.json has no
    // default; in that state submitting is a no-op (we just log).
    aiConfig?: ResolvedAIConfig | null;
    cwd?: string;
    connection?: string;
    recentCmds?: string[];
    // Mode-string the backend expects on PostAgentMessageRequest.  Valid
    // values match agent.NormalizeMode: "ask" | "plan" | "do" | "bench".
    // v1 defaults to "do" — the broadest-permission mode, matches what a
    // user picking "agent" via NLD implicitly asks for.
    agentMode?: string;
    // Set by the parent.  Invoked once on mount with a `submit(text)`
    // function that fires useChat.sendMessage.  Lets cmdblock-input.tsx
    // submit without owning the useChat hook.
    onReady?: (submit: (text: string) => void) => void;
}

export function AgentChatHost({
    model,
    chatId,
    outerBlockId,
    tabId,
    aiConfig,
    cwd,
    connection,
    recentCmds,
    agentMode = "do",
    onReady,
}: AgentChatHostProps) {
    // Refs hold the latest values without retriggering useChat construction
    // (the transport is built once on mount; per-request fields read from
    // refs inside prepareSendMessagesRequest).
    const tabIdRef = useRef(tabId);
    const aiConfigRef = useRef(aiConfig);
    const cwdRef = useRef(cwd);
    const connRef = useRef(connection);
    const recentCmdsRef = useRef(recentCmds);
    const agentModeRef = useRef(agentMode);
    useEffect(() => {
        tabIdRef.current = tabId;
        aiConfigRef.current = aiConfig;
        cwdRef.current = cwd;
        connRef.current = connection;
        recentCmdsRef.current = recentCmds;
        agentModeRef.current = agentMode;
    }, [tabId, aiConfig, cwd, connection, recentCmds, agentMode]);

    const transport = useMemo(
        () =>
            new DefaultChatTransport<WaveUIMessage>({
                api: "/api/post-agent-message",
                prepareSendMessagesRequest: ({ messages, id }) => {
                    // Pull the most recent user message — that's the one
                    // the backend expects in `msg`.  Earlier messages were
                    // already sent in prior turns; the chatstore (server-
                    // side) reconstructs the rest of the conversation
                    // from chatId.
                    const lastUser = [...messages].reverse().find((m) => m.role === "user");
                    const textParts = (lastUser?.parts ?? [])
                        .filter((p): p is { type: "text"; text: string } => p.type === "text")
                        .map((p) => ({ type: "text", text: p.text }));
                    return {
                        body: {
                            chatid: id,
                            tabid: tabIdRef.current ?? "",
                            blockid: outerBlockId,
                            mode: agentModeRef.current ?? "do",
                            aiconfig: aiConfigRef.current ?? undefined,
                            msg: {
                                messageid: lastUser?.id ?? "",
                                parts: textParts,
                            },
                            context: {
                                cwd: cwdRef.current ?? "",
                                connection: connRef.current ?? "",
                                last_command: (recentCmdsRef.current ?? []).slice(-1)[0] ?? "",
                                recent_cmds: recentCmdsRef.current ?? [],
                            },
                        },
                    };
                },
            }),
        [outerBlockId]
    );

    const { messages, status, error, sendMessage } = useChat<WaveUIMessage>({
        id: chatId,
        transport,
    });

    // Sync assistant message text + parts → corresponding agent block.
    // useChat gives cumulative text on each chunk, so we replace (not
    // append).  exchangeId is the id of the user message that precedes
    // this assistant message (= the value we passed via messageId on
    // sendMessage, so the model knows where to address deltas).
    useEffect(() => {
        for (const msg of messages) {
            if (msg.role !== "assistant") continue;
            const idx = messages.indexOf(msg);
            let exchangeId: string | undefined;
            for (let i = idx - 1; i >= 0; i--) {
                if (messages[i].role === "user") {
                    exchangeId = messages[i].id;
                    break;
                }
            }
            if (!exchangeId) continue;
            // Push the full parts snapshot — AgentBlockElement reads
            // these to render interleaved markdown + tool-use cards.
            model.applyAgentParts(exchangeId, msg.parts);
            // Also maintain the flat assistantText projection as a
            // fallback / preview (used pre-P0.4 and for find-bar text
            // indexing).
            const textParts = msg.parts.filter(
                (p): p is { type: "text"; text: string; state?: "streaming" | "done" } =>
                    p.type === "text"
            );
            const full = textParts.map((p) => p.text).join("");
            model.applyAgentText(exchangeId, full);
        }
    }, [messages, model]);

    // Status & error → terminal model.  ai-sdk's status values are
    // "submitted" | "streaming" | "ready" | "error" (v5).  Map onto
    // crest's "streaming" | "idle" | "error".
    useEffect(() => {
        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
        const exchangeId = lastUserMsg?.id;
        if (!exchangeId) return;
        if (status === "error" && error) {
            model.applyAgentStatus(exchangeId, "error", error.message);
        } else if (status === "streaming" || status === "submitted") {
            model.applyAgentStatus(exchangeId, "streaming");
        } else if (status === "ready") {
            model.applyAgentStatus(exchangeId, "done");
        }
    }, [status, error, messages, model]);

    // Expose a submit fn to the parent.  Stable ref-callback would be
    // nicer but plumbing through React refs across the boundary adds
    // moving parts; a one-shot onReady is enough for v1.
    useEffect(() => {
        if (!onReady) return;
        const submit = (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return;
            // Refuse to submit when no resolved aiConfig is available.
            // The backend now requires it unconditionally (Phase E
            // cutover), so sending without it would produce a 400.
            // Surface a clear visible toast (not just a console warn)
            // so the user knows why nothing happened.
            if (!aiConfigRef.current) {
                globalStore.set(
                    model.notificationAtom,
                    "Configure ~/.config/crest/ai.json to enable the agent"
                );
                return;
            }
            // Mint an exchangeId on the model side so the agent block is
            // appended *before* sendMessage races back deltas.  Pass the
            // same id to useChat as the user message id so the bridge can
            // correlate.
            const exchangeId = model.submitAgentMessage(trimmed);
            void sendMessage({
                text: trimmed,
                messageId: exchangeId,
            });
        };
        onReady(submit);
    }, [onReady, sendMessage, model]);

    return null;
}
