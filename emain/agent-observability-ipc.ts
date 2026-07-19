// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";

import type { AgentHarness } from "./agent/harness/agent-harness";
import { LangfuseTraceBuilder } from "./agent/observability/trace-builder";
import { SqliteTraceStore, type TraceStore } from "./agent/observability/sqlite-trace-store";
import type { TraceGraph } from "./agent/observability/types";

type SubKey = string;

const builder = new LangfuseTraceBuilder();
const observedSessions = new Set<string>();
const subscriptions = new Map<SubKey, { sender: electron.WebContents; sessionId?: string }>();
const subscriptionsBySender = new Map<number, Set<SubKey>>();

let traceStore: TraceStore | undefined;

function getTraceStore(): TraceStore {
    if (!traceStore) {
        traceStore = new SqliteTraceStore();
    }
    return traceStore;
}

function makeSubscriptionKey(senderId: number, sessionId?: string): SubKey {
    return `${senderId}:${sessionId ?? "*"}`;
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

function publishGraph(graph: TraceGraph): void {
    for (const [key, subscription] of subscriptions) {
        if (subscription.sender.isDestroyed()) {
            subscriptions.delete(key);
            continue;
        }
        if (subscription.sessionId != null && subscription.sessionId !== graph.trace.sessionId) {
            continue;
        }
        subscription.sender.send("agent-observability:event", {
            traceId: graph.trace.id,
            sessionId: graph.trace.sessionId,
            graph,
        });
    }
}

// Observability is a second, symmetric subscriber on the AgentHarness
// canonical event bus — peer to PaneAgentSession, not layered on top of
// it. AgentHarness.subscribe() delivers the full AgentHarnessEvent union
// (raw AgentEvent + AgentHarnessOwnEvent) via emitAny/emitOwn; the
// LangfuseTraceBuilder folds that stream into a Langfuse TraceGraph. We
// subscribe here (not in PaneAgentSession) so the trace reflects the
// agent runtime directly, independent of any UI aggregation.
export function attachAgentObservability(sessionPath: string, harness: AgentHarness): void {
    if (observedSessions.has(sessionPath)) {
        return;
    }
    observedSessions.add(sessionPath);
    harness.subscribe((event) => {
        const graph = builder.applyEvent({ sessionPath, event: event as { type: string; [key: string]: unknown } });
        if (!graph) return;
        try {
            getTraceStore().saveGraph(graph);
        } catch (error) {
            console.error("[agent-observability] failed to save trace graph:", error);
        }
        publishGraph(graph);
    });
}

export function registerAgentObservabilityIpcHandlers(): void {
    electron.ipcMain.handle("agent-observability:list-traces", (_event, sessionId?: string) => {
        return getTraceStore().listTraces(typeof sessionId === "string" && sessionId ? sessionId : undefined);
    });

    electron.ipcMain.handle("agent-observability:get-trace", (_event, traceId: string) => {
        if (typeof traceId !== "string" || traceId.trim() === "") {
            throw new Error("agent-observability IPC: traceId must be a non-empty string");
        }
        return getTraceStore().getTraceGraph(traceId);
    });

    electron.ipcMain.on("agent-observability:subscribe", (event, sessionId?: string) => {
        const normalizedSessionId = typeof sessionId === "string" && sessionId ? sessionId : undefined;
        const key = makeSubscriptionKey(event.sender.id, normalizedSessionId);
        subscriptions.set(key, { sender: event.sender, sessionId: normalizedSessionId });
        trackSenderKey(event.sender, key);
    });

    electron.ipcMain.on("agent-observability:unsubscribe", (event, sessionId?: string) => {
        const normalizedSessionId = typeof sessionId === "string" && sessionId ? sessionId : undefined;
        const key = makeSubscriptionKey(event.sender.id, normalizedSessionId);
        subscriptions.delete(key);
        const keys = subscriptionsBySender.get(event.sender.id);
        keys?.delete(key);
        if (keys?.size === 0) {
            subscriptionsBySender.delete(event.sender.id);
        }
    });
}

export function _resetAgentObservabilityForTests(): void {
    observedSessions.clear();
    subscriptions.clear();
    subscriptionsBySender.clear();
    traceStore = undefined;
}
