// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// agent-ipc.ts — Electron main IPC surface for the integrated agent
// runtime. Holds the harness cache (Map<sessionPath, PaneHarness>),
// registers ipcMain handlers, and fans pi AgentHarness events out to
// per-sender subscribers via a single "agent:event" channel.
//
// See docs/agent-runtime-architecture.md §2 for the topology and
// §6 for the per-pane lifecycle this layer implements.
//
// IPC contract (mirrored in preload.ts + ElectronApi.agent typings):
//
//   handle "agent:create-session"      (cwd) → AgentSessionMeta
//   handle "agent:list-sessions-for-cwd" (cwd) → AgentSessionMeta[]
//   handle "agent:send"                (opts) → { sessionMetadata }
//     - opts.sessionMetadata? null → main mints a fresh session
//     - prompt() runs in background; events stream via "agent:event"
//     - returns the resolved sessionMetadata (renderer writes it to
//       block.meta after first send)
//   on     "agent:abort"               (sessionPath)
//   on     "agent:subscribe"           (sessionPath)
//     - subscriber tracked per-sender; renderer must call unsubscribe
//       on cleanup, but sender 'destroyed' also releases automatically
//   on     "agent:unsubscribe"         (sessionPath)
//
// Event stream payload (sent on "agent:event"):
//   { sessionPath: string, event: AgentHarnessEvent }
//
// Single channel + payload-identified subscriptions matches the
// "dir-changed" pattern in emain-ipc.ts (security: renderer-supplied
// strings never end up in channel names).

import * as electron from "electron";

import type { Api, Model } from "./ai";
import { getModel } from "./ai";
import { buildPaneHarness, type PaneHarness } from "./agent/harness-factory";
import type { SystemPromptInputs } from "./agent/build-system-prompt";
import { buildPermissionsHook, isBenchMode } from "./agent/permissions";
import { getDefaultTools } from "./agent/tools";
import { getSecret } from "./aiconfig/secrets";
import {
    createPaneSession,
    listSessionsForCwd,
    openPaneSession,
} from "./agent/sessions";
import { AgentHarnessError, type JsonlSessionMetadata } from "./agent/harness/types";
import type { AgentMessage, ThinkingLevel } from "./agent/types";

// Per-pane harness instances, keyed by session JSONL path (the natural
// session identity — same path always reopens the same conversation).
const harnessCache = new Map<string, PaneHarness>();

// Authoritative per-session transcript (the source of truth the renderer
// mirrors). Maintained by an internal harness subscription attached at
// build time — BEFORE prompt() runs — so it never misses events, even for
// a turn that completes before the renderer subscribes. Replayed as a
// `snapshot` to each new subscriber. See docs/agent-rendering-architecture.md.
const sessionMessages = new Map<string, AgentMessage[]>();

// Per-(sender, sessionPath) subscriptions. The value is the unsubscribe
// fn returned by PaneHarness.harness.subscribe(). On sender destroy we
// walk this map and release everything that sender held.
type SubKey = string; // `${senderId}:${sessionPath}`
const subscriptions = new Map<SubKey, () => void>();
const subscriptionsBySender = new Map<number, Set<SubKey>>();

interface SendOptions {
    /** Existing session, if any. null on first send → main mints a fresh one. */
    sessionMetadata?: JsonlSessionMetadata | null;
    /** Pane's current cwd. Drives system prompt + tool execution dir. */
    cwd: string;
    /** Prompt text. */
    text: string;
    /** Resolved provider id (e.g. "openrouter"). */
    provider: string;
    /** Resolved model id (e.g. "anthropic/claude-opus-4-7"). */
    model: string;
    /** Reasoning level, when the model supports it. */
    reasoning?: ThinkingLevel;
    /**
     * Credential reference resolved by the renderer's ai-resolver.
     * Exactly one is typically set: a literal `token` (testing / unauthed
     * local endpoints) or a `tokenSecretName` to look up in the
     * safeStorage secret store. Main resolves these into the actual API
     * key passed to pi-ai — the renderer never sees the plaintext key.
     */
    token?: string;
    tokenSecretName?: string;
    /** Optional pane context. */
    gitBranch?: string;
    recentCmds?: string[];
    connection?: string;
    /**
     * Per-pane tool allowlist. Optional in v1 — when omitted, permissions
     * default to allowAll:true (no approval UI exists yet; the agent
     * stays functional). Bench mode (CREST_AGENT_BENCH=1) also forces
     * allowAll regardless of this value. See emain/agent/permissions.ts.
     */
    allowedTools?: string[];
}

function resolveModelOrThrow(provider: string, modelId: string): Model<Api> {
    // pi's getModel is typed with literal generics; our renderer-supplied
    // strings can't satisfy them. Cast — runtime accepts any registered id.
    const model = (getModel as unknown as (p: string, m: string) => Model<Api> | undefined)(
        provider,
        modelId,
    );
    if (!model) {
        throw new Error(`agent: unknown provider/model "${provider}/${modelId}"`);
    }
    return model;
}

function buildPromptInputs(opts: SendOptions): SystemPromptInputs {
    return {
        cwd: opts.cwd,
        gitBranch: opts.gitBranch,
        connection: opts.connection,
        recentCmds: opts.recentCmds,
    };
}

async function ensureSession(opts: SendOptions): Promise<{
    metadata: JsonlSessionMetadata;
    isNew: boolean;
}> {
    if (opts.sessionMetadata) {
        return { metadata: opts.sessionMetadata, isNew: false };
    }
    const { metadata } = await createPaneSession(opts.cwd);
    return { metadata, isNew: true };
}

async function resolveApiKey(opts: SendOptions): Promise<string | undefined> {
    const literal = opts.token?.trim();
    if (literal) return literal;
    if (opts.tokenSecretName) {
        const value = await getSecret(opts.tokenSecretName);
        if (value) return value;
    }
    // No credential resolved — let pi-ai try its own env-var fallback
    // (returning undefined means we don't override it). The provider's
    // own "no API key" error surfaces to the renderer if that also fails.
    return undefined;
}

async function ensurePaneHarness(
    metadata: JsonlSessionMetadata,
    opts: SendOptions,
): Promise<PaneHarness> {
    const existing = harnessCache.get(metadata.path);
    if (existing) {
        existing.update(buildPromptInputs(opts));
        return existing;
    }
    const session = await openPaneSession(metadata);
    // Resolve the provider API key once for this session's harness: a
    // literal token wins, else look up the secret in safeStorage. pi-ai
    // would otherwise fall back to provider env vars (which crest doesn't
    // set), failing with "No API key for provider: <provider>".
    const apiKey = await resolveApiKey(opts);
    const model = resolveModelOrThrow(opts.provider, opts.model);
    // Diagnostic: the agent's LLM request goes out from the MAIN process
    // (Node fetch in pi-ai), so it never shows in the renderer's Network
    // tab. Log the resolved model config (never the key itself) so the
    // provider/model/baseUrl/key wiring is verifiable from the main
    // console (the `task electron:quickdev` terminal).
    console.log(
        `[agent-ipc] send → provider=${model.provider} model=${model.id} api=${model.api} ` +
            `baseUrl=${(model as { baseUrl?: string }).baseUrl ?? "(provider default)"} ` +
            `reasoning=${opts.reasoning ?? "off"} apiKey=${apiKey ? "present" : "MISSING"} ` +
            `(tokenSecretName=${opts.tokenSecretName ?? "-"})`,
    );
    const pane = buildPaneHarness({
        session,
        model,
        thinkingLevel: opts.reasoning,
        promptInputs: buildPromptInputs(opts),
        tools: getDefaultTools(opts.cwd),
        getApiKeyAndHeaders: apiKey == null ? undefined : async () => ({ apiKey }),
        // Bench mode (eval harness sets CREST_AGENT_BENCH=1) bypasses
        // the allowlist entirely. Otherwise: v1 defaults to allowAll
        // when the renderer didn't pass an allowedTools list (no
        // approval UI yet); future task wires this to a per-pane
        // setting written from the renderer.
        toolCallHook: buildPermissionsHook(
            isBenchMode()
                ? { allowAll: true }
                : opts.allowedTools
                  ? { allowAll: false, allowedTools: opts.allowedTools }
                  : { allowAll: true },
        ),
    });
    harnessCache.set(metadata.path, pane);
    // Maintain the authoritative transcript from inside main, attached now
    // (before any prompt() runs) so it never misses events. agent_end
    // carries the full conversation after each turn — that's our snapshot
    // source for late/re-subscribing renderers.
    pane.harness.subscribe((ev) => {
        if (ev.type === "agent_end" && Array.isArray(ev.messages)) {
            sessionMessages.set(metadata.path, ev.messages as AgentMessage[]);
        }
    });
    return pane;
}

function releaseSubscription(key: SubKey): void {
    const unsub = subscriptions.get(key);
    if (!unsub) return;
    try {
        unsub();
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[agent-ipc] unsubscribe error:", err);
    }
    subscriptions.delete(key);
}

function releaseAllForSender(senderId: number): void {
    const keys = subscriptionsBySender.get(senderId);
    if (!keys) return;
    for (const key of keys) releaseSubscription(key);
    subscriptionsBySender.delete(senderId);
}

/**
 * Wire the agent IPC handlers. Call once at app startup from
 * emain-ipc.ts initIpcHandlers().
 */
export function registerAgentIpcHandlers(): void {
    electron.ipcMain.handle(
        "agent:create-session",
        async (_event, cwd: string): Promise<JsonlSessionMetadata> => {
            const { metadata } = await createPaneSession(cwd);
            return metadata;
        },
    );

    electron.ipcMain.handle(
        "agent:list-sessions-for-cwd",
        async (_event, cwd: string): Promise<JsonlSessionMetadata[]> => {
            return await listSessionsForCwd(cwd);
        },
    );

    electron.ipcMain.handle(
        "agent:send",
        async (
            _event,
            opts: SendOptions,
        ): Promise<{ sessionMetadata: JsonlSessionMetadata }> => {
            // Per-send trace of the renderer-supplied selection (the
            // harness build logs the fully-resolved model on first send;
            // an existing session reuses it and skips that log).
            console.log(
                `[agent-ipc] agent:send provider=${opts.provider} model=${opts.model} ` +
                    `reasoning=${opts.reasoning ?? "off"} ` +
                    `cred=${opts.token ? "token" : opts.tokenSecretName ? `secret:${opts.tokenSecretName}` : "NONE"} ` +
                    `textLen=${opts.text?.length ?? 0}`,
            );
            const { metadata } = await ensureSession(opts);
            const pane = await ensurePaneHarness(metadata, opts);
            // Concurrent sends: pi's harness rejects a second prompt() while
            // a turn is streaming (code "busy"). That's by design — pi wants
            // followUp() (queue after the current turn) or steer() instead of
            // interrupting. So: try prompt(); if busy, route to followUp so
            // the message runs after the current turn completes (pi drains
            // its own follow-up queue). See docs/agent-rendering-architecture.md.
            // Fire-and-forget: real LLM errors surface via the event stream's
            // stop reason; we only log unexpected wiring throws.
            void pane.harness.prompt(opts.text).catch((err) => {
                if (err instanceof AgentHarnessError && err.code === "busy") {
                    void pane.harness.followUp(opts.text).catch((e) => {
                        console.error(`[agent-ipc] followUp error for ${metadata.path}:`, e);
                    });
                    return;
                }
                console.error(`[agent-ipc] prompt error for ${metadata.path}:`, err);
            });
            return { sessionMetadata: metadata };
        },
    );

    electron.ipcMain.on("agent:abort", (_event, sessionPath: string) => {
        if (typeof sessionPath !== "string" || !sessionPath) return;
        const pane = harnessCache.get(sessionPath);
        // AgentHarness.abort() returns a Promise<AbortResult>; we don't
        // need to await it here — caller fired an abort intent, not a
        // synchronous request for completion.
        if (pane) void pane.harness.abort();
    });

    electron.ipcMain.on("agent:subscribe", (event, sessionPath: string) => {
        if (typeof sessionPath !== "string" || !sessionPath) return;
        const pane = harnessCache.get(sessionPath);
        // Subscribe-before-send is legal: the harness may not exist yet.
        // Renderer should retry subscribe after the first `agent:send`
        // returns. For v1 we drop early subscribes silently; future
        // improvement is a pending-subs queue keyed by sessionPath.
        if (!pane) return;
        const key: SubKey = `${event.sender.id}:${sessionPath}`;
        if (subscriptions.has(key)) return;
        const unsub = pane.harness.subscribe((agentEvent) => {
            if (event.sender.isDestroyed()) return;
            event.sender.send("agent:event", { sessionPath, event: agentEvent });
        });
        subscriptions.set(key, unsub);
        // Seed the new subscriber with the authoritative transcript so a
        // late/re-subscribing renderer never misses pre-subscribe history
        // (e.g. a turn that finished before the renderer subscribed). The
        // renderer reduces `snapshot` by replacing its mirror. Sent after
        // attaching the live listener so no event in between is dropped.
        const snapshot = sessionMessages.get(sessionPath);
        if (snapshot && !event.sender.isDestroyed()) {
            event.sender.send("agent:event", {
                sessionPath,
                event: { type: "snapshot", messages: snapshot },
            });
        }
        let set = subscriptionsBySender.get(event.sender.id);
        if (!set) {
            set = new Set();
            subscriptionsBySender.set(event.sender.id, set);
            event.sender.once("destroyed", () => releaseAllForSender(event.sender.id));
        }
        set.add(key);
    });

    electron.ipcMain.on("agent:unsubscribe", (event, sessionPath: string) => {
        if (typeof sessionPath !== "string" || !sessionPath) return;
        const key: SubKey = `${event.sender.id}:${sessionPath}`;
        releaseSubscription(key);
        const set = subscriptionsBySender.get(event.sender.id);
        if (set) {
            set.delete(key);
            if (set.size === 0) subscriptionsBySender.delete(event.sender.id);
        }
    });
}

/** Test-only escape hatch: clear the harness cache + subscriptions. */
export function _resetAgentIpcForTests(): void {
    for (const unsub of subscriptions.values()) {
        try {
            unsub();
        } catch {
            // ignore
        }
    }
    subscriptions.clear();
    subscriptionsBySender.clear();
    for (const pane of harnessCache.values()) {
        try {
            void pane.harness.abort();
        } catch {
            // ignore
        }
    }
    harnessCache.clear();
    sessionMessages.clear();
}
