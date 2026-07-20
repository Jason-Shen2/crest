// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";

import type { AgentHarness } from "./agent/harness/agent-harness";
import { SqliteTraceStore, type TraceStore } from "./agent/observability/sqlite-trace-store";
import { TraceBuilder } from "./agent/observability/trace-builder";
import type { TraceDetail } from "./agent/observability/types";

type SubKey = string;

const builder = new TraceBuilder();
let observedHarnesses = new WeakSet<AgentHarness>();
const subscriptions = new Map<SubKey, { sender: electron.WebContents; sessionId?: string }>();
const subscriptionsBySender = new Map<number, Set<SubKey>>();

let traceStore: TraceStore | undefined;

interface TraceEventCoalescerOptions {
    builder: TraceBuilder;
    saveTraceDetail: (detail: TraceDetail) => void;
    publishTraceDetail: (detail: TraceDetail) => void;
    updateIntervalMs?: number;
}

interface PendingMessageUpdate {
    detail: TraceDetail;
    timer: ReturnType<typeof setTimeout>;
}

export class TraceEventCoalescer {
    private readonly builder: TraceBuilder;
    private readonly saveTraceDetail: (detail: TraceDetail) => void;
    private readonly publishTraceDetail: (detail: TraceDetail) => void;
    private readonly updateIntervalMs: number;
    private readonly pendingUpdates = new Map<string, PendingMessageUpdate>();

    constructor(options: TraceEventCoalescerOptions) {
        this.builder = options.builder;
        this.saveTraceDetail = options.saveTraceDetail;
        this.publishTraceDetail = options.publishTraceDetail;
        this.updateIntervalMs = options.updateIntervalMs ?? 50;
    }

    handle(sessionPath: string, event: { type: string; [key: string]: unknown }): void {
        if (event.type === "message_update") {
            const detail = this.builder.applyEvent({ sessionPath, event });
            if (!detail) return;
            const pending = this.pendingUpdates.get(sessionPath);
            if (pending) {
                pending.detail = detail;
                return;
            }
            const timer = setTimeout(() => this.flushSession(sessionPath), this.updateIntervalMs);
            this.pendingUpdates.set(sessionPath, { detail, timer });
            return;
        }

        this.flushSession(sessionPath);
        const detail = this.builder.applyEvent({ sessionPath, event });
        if (!detail) return;
        this.saveTraceDetail(detail);
        this.publishTraceDetail(detail);
    }

    dispose(): void {
        for (const pending of this.pendingUpdates.values()) {
            clearTimeout(pending.timer);
        }
        this.pendingUpdates.clear();
    }

    private flushSession(sessionPath: string): void {
        const pending = this.pendingUpdates.get(sessionPath);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingUpdates.delete(sessionPath);
        this.publishTraceDetail(pending.detail);
    }
}

function getTraceStore(): TraceStore {
    if (!traceStore) {
        traceStore = new SqliteTraceStore();
    }
    return traceStore;
}

function requireSessionScope(sessionId: unknown): string {
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
        throw new Error("agent-observability IPC: sessionId must be a non-empty string");
    }
    return sessionId;
}

function makeSubscriptionKey(senderId: number, sessionId: string): SubKey {
    return `${senderId}:${sessionId}`;
}

function trackSenderKey(sender: electron.WebContents, key: SubKey): void {
    let keys = subscriptionsBySender.get(sender.id);
    if (!keys) {
        keys = new Set();
        subscriptionsBySender.set(sender.id, keys);
        sender.once("destroyed", () => releaseAllForSender(sender.id));
    }
    keys.add(key);
}

function releaseAllForSender(senderId: number): void {
    const keys = subscriptionsBySender.get(senderId);
    if (!keys) return;
    for (const key of keys) {
        subscriptions.delete(key);
    }
    subscriptionsBySender.delete(senderId);
}

function publishTraceDetail(detail: TraceDetail): void {
    for (const [key, subscription] of subscriptions) {
        if (subscription.sender.isDestroyed()) {
            subscriptions.delete(key);
            continue;
        }
        if (subscription.sessionId != null && subscription.sessionId !== detail.trace.sessionId) {
            continue;
        }
        subscription.sender.send("agent-observability:event", {
            traceId: detail.trace.id,
            sessionId: detail.trace.sessionId,
            detail,
        });
    }
}

function saveTraceDetail(detail: TraceDetail): void {
    try {
        getTraceStore().saveTraceDetail(detail);
    } catch (error) {
        console.error("[agent-observability] failed to save trace detail:", error);
    }
}

const eventCoalescer = new TraceEventCoalescer({
    builder,
    saveTraceDetail,
    publishTraceDetail,
});

// Observability is a second, symmetric subscriber on the AgentHarness
// canonical event bus — peer to AgentSessionRuntime, not layered on top of
// it. AgentHarness.subscribe() delivers the full AgentHarnessEvent union
// (raw AgentEvent + AgentHarnessOwnEvent) via emitAny/emitOwn; the
// TraceBuilder folds that stream into a Langfuse TraceDetail. We
// subscribe here (not in PaneAgentSession) so the trace reflects the
// agent runtime directly, independent of any UI aggregation.
export function attachAgentObservability(sessionPath: string, harness: AgentHarness): void {
    if (observedHarnesses.has(harness)) {
        return;
    }
    observedHarnesses.add(harness);
    harness.subscribe((event) => {
        eventCoalescer.handle(sessionPath, event as { type: string; [key: string]: unknown });
    });
}

export function registerAgentObservabilityIpcHandlers(): void {
    electron.ipcMain.handle("agent-observability:list-traces", (_event, sessionId: unknown) => {
        return getTraceStore().listTraces(requireSessionScope(sessionId));
    });

    electron.ipcMain.handle("agent-observability:get-trace", (_event, traceId: string, sessionId: unknown) => {
        if (typeof traceId !== "string" || traceId.trim() === "") {
            throw new Error("agent-observability IPC: traceId must be a non-empty string");
        }
        return getTraceStore().getTraceDetail(traceId, requireSessionScope(sessionId));
    });

    electron.ipcMain.on("agent-observability:subscribe", (event, sessionId: unknown) => {
        let requiredSessionId: string;
        try {
            requiredSessionId = requireSessionScope(sessionId);
        } catch (error) {
            console.error("[agent-observability] subscribe validation error:", error);
            return;
        }
        const key = makeSubscriptionKey(event.sender.id, requiredSessionId);
        subscriptions.set(key, { sender: event.sender, sessionId: requiredSessionId });
        trackSenderKey(event.sender, key);
    });

    electron.ipcMain.on("agent-observability:unsubscribe", (event, sessionId: unknown) => {
        let requiredSessionId: string;
        try {
            requiredSessionId = requireSessionScope(sessionId);
        } catch (error) {
            console.error("[agent-observability] unsubscribe validation error:", error);
            return;
        }
        const key = makeSubscriptionKey(event.sender.id, requiredSessionId);
        subscriptions.delete(key);
        const keys = subscriptionsBySender.get(event.sender.id);
        keys?.delete(key);
        if (keys?.size === 0) {
            subscriptionsBySender.delete(event.sender.id);
        }
    });
}

export function _resetAgentObservabilityForTests(): void {
    eventCoalescer.dispose();
    observedHarnesses = new WeakSet();
    subscriptions.clear();
    subscriptionsBySender.clear();
    traceStore = undefined;
}
