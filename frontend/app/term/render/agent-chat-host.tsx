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
import { ResolvedAIConfig, ResolveError } from "@/app/store/ai-types";

export interface AgentChatHostProps {
    model: TerminalModel;
    chatId: string;
    outerBlockId: string;
    tabId?: string;
    // Resolved AI config — the backend ingests this directly via
    // BuildAIOptsFromConfig, no further catalog / settings lookups.
    // Null while the resolver failed; companion `aiConfigError` carries
    // the structured reason so we can render an inline error block
    // instead of a self-dismissing toast.
    aiConfig?: ResolvedAIConfig | null;
    // Resolver failure (or "no selection") carried alongside aiConfig.
    // When submit fires with no config, we read this to populate the
    // user-visible error message in the agent block.  Null when
    // aiConfig is non-null (happy path).
    aiConfigError?: ResolveError | null;
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
    aiConfigError,
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
    const aiConfigErrorRef = useRef(aiConfigError);
    const cwdRef = useRef(cwd);
    const connRef = useRef(connection);
    const recentCmdsRef = useRef(recentCmds);
    const agentModeRef = useRef(agentMode);
    useEffect(() => {
        tabIdRef.current = tabId;
        aiConfigRef.current = aiConfig;
        aiConfigErrorRef.current = aiConfigError;
        cwdRef.current = cwd;
        connRef.current = connection;
        recentCmdsRef.current = recentCmds;
        agentModeRef.current = agentMode;
    }, [tabId, aiConfig, aiConfigError, cwd, connection, recentCmds, agentMode]);

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
            // The backend hard-requires it (would 400). Instead of a
            // self-dismissing toast, append an agent block in the
            // timeline with the resolver's specific error message so:
            //   1. the user actually sees the failure (toast was 3.5s);
            //   2. the message itself is preserved (not silently dropped);
            //   3. the error is addressable (specific reason, not a
            //      generic "configure ai.json" — e.g. "No API key for
            //      provider openrouter").
            if (!aiConfigRef.current) {
                const errMsg =
                    aiConfigErrorRef.current?.message ??
                    "AI is not configured. Open the model picker to set up a provider and pick a model.";
                const exchangeId = model.submitAgentMessage(trimmed);
                model.applyAgentStatus(exchangeId, "error", errMsg);
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
