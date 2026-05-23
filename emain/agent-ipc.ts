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
import {
    createPaneSession,
    listSessionsForCwd,
    openPaneSession,
} from "./agent/sessions";
import type { JsonlSessionMetadata } from "./agent/harness/types";
import type { ThinkingLevel } from "./agent/types";

// Per-pane harness instances, keyed by session JSONL path (the natural
// session identity — same path always reopens the same conversation).
const harnessCache = new Map<string, PaneHarness>();

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
    /** Optional pane context. */
    gitBranch?: string;
    recentCmds?: string[];
    connection?: string;
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
    const pane = buildPaneHarness({
        session,
        model: resolveModelOrThrow(opts.provider, opts.model),
        thinkingLevel: opts.reasoning,
        promptInputs: buildPromptInputs(opts),
        tools: [], // task #10 will wire crest tools
    });
    harnessCache.set(metadata.path, pane);
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
            const { metadata } = await ensureSession(opts);
            const pane = await ensurePaneHarness(metadata, opts);
            // Fire-and-forget: pi emits errors via the assistant-message
            // stop reason on the event stream. We log unexpected throws
            // (which would be bugs in our wiring, not LLM errors).
            void pane.harness.prompt(opts.text).catch((err) => {
                // eslint-disable-next-line no-console
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
}
