// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { TabCmdStateStore } from "@/app/store/tabcmdstate";
import * as WOS from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { atoms, getApi, refocusNode } from "@/store/global";
import * as jotai from "jotai";
import { routeAppNotification, shouldSuppressVisibleNotification } from "./notification-router";
import { ToastModel } from "./toast-model";

export type AgentNotificationSource = "crest-agent" | "agent-cli";
export type AgentNotificationKind = "completed" | "needs-action" | "failed" | "info";

export type AgentNotification = {
    id: string;
    source: AgentNotificationSource;
    kind: AgentNotificationKind;
    agentName?: string;
    blockId?: string;
    tabId?: string;
    title?: string;
    body: string;
    ts: number;
    read: boolean;
};

export type AppNotification = AgentNotification;

const MAX_NOTIFICATIONS = 50;
const AgentNotificationTitle = "crest://agent-notification";

type CliAgentPayload = {
    agent?: string;
    event?: string;
    title?: string;
    body?: string;
    message?: string;
    summary?: string;
    error?: string;
    requires_user_action?: boolean;
    needs_user_action?: boolean;
    awaiting_input?: boolean;
    approval_required?: boolean;
};

type NormalizedNotification = {
    source: AgentNotificationSource;
    kind: AgentNotificationKind;
    agentName?: string;
    blockId?: string;
    tabId?: string;
    title?: string;
    body: string;
};

export type AgentNotificationEventPayload = {
    source?: string;
    kind?: string;
    agentname?: string;
    blockid?: string;
    tabid?: string;
    title?: string;
    body?: string;
};

function parseCliAgentPayload(title: string | undefined, body: string): CliAgentPayload | null {
    if (!title?.startsWith(AgentNotificationTitle)) {
        return null;
    }
    try {
        const parsed = JSON.parse(body);
        if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        return parsed as CliAgentPayload;
    } catch {
        return null;
    }
}

function formatCliAgentName(agent: string | undefined): string {
    const normalized = agent?.trim().toLowerCase();
    if (!normalized) {
        return "CLI Agent";
    }
    if (normalized === "claude") {
        return "Claude Code";
    }
    return normalized
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join(" ");
}

function isCliAgentUserActionEvent(eventName: string): boolean {
    return /(attention|input|approval|confirm|permission|auth|login|question|prompt|choose|required|review)/.test(
        eventName
    );
}

function isCliAgentCompletionEvent(eventName: string): boolean {
    return /(complete|completed|finish|finished|end|ended|done|stop|stopped|cancel|cancelled|abort|aborted|exit|exited|error|failed|blocked)/.test(
        eventName
    );
}

function isCliAgentFailedEvent(eventName: string): boolean {
    return /(error|failed|blocked|abort|aborted|cancel|cancelled)/.test(eventName);
}

function isAgentNotificationSource(source: string | undefined): source is AgentNotificationSource {
    return source === "crest-agent" || source === "agent-cli";
}

function isAgentNotificationKind(kind: string | undefined): kind is AgentNotificationKind {
    return kind === "completed" || kind === "needs-action" || kind === "failed" || kind === "info";
}

// Agent CLIs can emit a stream of lifecycle notifications (session_start,
// turn_start, etc.). Those are noisy in Crest; only surface completion or
// explicit user-attention events.
export function normalizeCmdBlockNotification(title: string | undefined, body: string): NormalizedNotification | null {
    const payload = parseCliAgentPayload(title, body);
    if (payload == null) {
        return { source: "agent-cli", kind: "info", title: title || undefined, body };
    }

    const eventName = payload.event?.trim().toLowerCase() ?? "";
    const needsUserAction =
        payload.requires_user_action === true ||
        payload.needs_user_action === true ||
        payload.awaiting_input === true ||
        payload.approval_required === true ||
        (eventName !== "" && isCliAgentUserActionEvent(eventName));
    const isCompletion = eventName !== "" && isCliAgentCompletionEvent(eventName);
    const isFailed = eventName !== "" && isCliAgentFailedEvent(eventName);
    if (!needsUserAction && !isCompletion && eventName !== "") {
        return null;
    }

    const agentName = formatCliAgentName(payload.agent);
    const detail =
        payload.message?.trim() || payload.summary?.trim() || payload.body?.trim() || payload.error?.trim() || "";

    if (detail !== "") {
        return {
            source: "agent-cli",
            kind: needsUserAction ? "needs-action" : isFailed ? "failed" : isCompletion ? "completed" : "info",
            agentName,
            title: agentName,
            body: detail,
        };
    }
    if (needsUserAction) {
        return {
            source: "agent-cli",
            kind: "needs-action",
            agentName,
            title: agentName,
            body: `${agentName} needs your attention`,
        };
    }
    if (isCompletion) {
        return {
            source: "agent-cli",
            kind: isFailed ? "failed" : "completed",
            agentName,
            title: agentName,
            body: `${agentName} task finished`,
        };
    }
    if (eventName !== "") {
        return {
            source: "agent-cli",
            kind: "info",
            agentName,
            title: agentName,
            body: `${agentName}: ${eventName.replace(/[_-]+/g, " ")}`,
        };
    }
    return { source: "agent-cli", kind: "info", agentName, title: agentName, body };
}

export function normalizeAgentNotificationEvent(
    event: AgentNotificationEventPayload | undefined
): NormalizedNotification | null {
    if (!event?.body) return null;
    const normalized: NormalizedNotification = {
        source: isAgentNotificationSource(event.source) ? event.source : "crest-agent",
        kind: isAgentNotificationKind(event.kind) ? event.kind : "info",
        body: event.body,
    };
    if (event.agentname) normalized.agentName = event.agentname;
    if (event.blockid) normalized.blockId = event.blockid;
    if (event.tabid) normalized.tabId = event.tabid;
    if (event.title || event.agentname) normalized.title = event.title || event.agentname;
    return normalized;
}

export class NotificationsModel {
    private static instance: NotificationsModel | null = null;
    private unsubscribeCmdBlock: (() => void) | null = null;
    private unsubscribeAgent: (() => void) | null = null;

    notificationsAtom: jotai.PrimitiveAtom<AppNotification[]>;
    unreadCountAtom: jotai.Atom<number>;

    private constructor() {
        this.notificationsAtom = jotai.atom([]) as jotai.PrimitiveAtom<AppNotification[]>;
        this.unreadCountAtom = jotai.atom((get) => get(this.notificationsAtom).filter((n) => !n.read).length);
    }

    // Called lazily when Notifications panel first opens, and also ensured at
    // app startup (so completions that happen before the panel is first opened
    // still surface as toasts + populate the feed).
    ensureSubscribed(): void {
        TabCmdStateStore.getInstance().ensureSubscribed();
        if (this.unsubscribeCmdBlock && this.unsubscribeAgent) return;
        this.subscribe();
    }

    static getInstance(): NotificationsModel {
        if (!NotificationsModel.instance) {
            NotificationsModel.instance = new NotificationsModel();
        }
        return NotificationsModel.instance;
    }

    private subscribe(): void {
        if (!this.unsubscribeCmdBlock) {
            this.unsubscribeCmdBlock = waveEventSubscribeSingle({
                eventType: "cmdblock:notify",
                handler: (event) => {
                    const ev = event.data as CmdBlockNotifyEvent | undefined;
                    if (!ev?.blockid || !ev.body) return;
                    const normalized = normalizeCmdBlockNotification(ev.title, ev.body);
                    if (normalized == null) return;

                    this.pushNotification({
                        ...normalized,
                        blockId: ev.blockid,
                        tabId: this.findTabIdForBlock(ev.blockid),
                    });
                },
            });
        }

        if (!this.unsubscribeAgent) {
            this.unsubscribeAgent = waveEventSubscribeSingle({
                eventType: "agent:notification",
                handler: (event) => {
                    const normalized = normalizeAgentNotificationEvent(
                        event.data as AgentNotificationEventPayload | undefined
                    );
                    if (normalized == null) return;
                    this.pushNotification(normalized);
                },
            });
        }
    }

    private pushNotification(normalized: NormalizedNotification): void {
        const now = Date.now();
        const note: AppNotification = {
            id: `${normalized.blockId ?? normalized.source}:${now}:${Math.random().toString(36).slice(2, 7)}`,
            source: normalized.source,
            kind: normalized.kind,
            agentName: normalized.agentName,
            blockId: normalized.blockId,
            tabId: normalized.tabId,
            title: normalized.title,
            body: normalized.body,
            ts: now,
            read: false,
        };

        const focused = globalStore.get(atoms.documentHasFocus);
        const visible = this.isNotificationTargetVisible(note);
        if (shouldSuppressVisibleNotification({ focused, visible })) {
            return;
        }

        routeAppNotification(note, {
            focused,
            visible,
            pushToast: (note) => ToastModel.getInstance().push(note),
        });

        const current = globalStore.get(this.notificationsAtom);
        const next = [note, ...current].slice(0, MAX_NOTIFICATIONS);
        globalStore.set(this.notificationsAtom, next);
    }

    private findTabIdForBlock(blockId: string): string | undefined {
        const ws = globalStore.get(atoms.workspace);
        for (const tid of ws?.tabids ?? []) {
            const tabAtom = WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tid));
            const tab = globalStore.get(tabAtom);
            if (tab?.blockids?.includes(blockId)) {
                return tid;
            }
        }
        return undefined;
    }

    private isNotificationTargetVisible(note: AppNotification): boolean {
        const activeTabId = globalStore.get(atoms.staticTabId);
        if (note.tabId && note.tabId === activeTabId) {
            return true;
        }
        if (!note.blockId) {
            return false;
        }
        const activeTabAtom = WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", activeTabId));
        const activeTab = globalStore.get(activeTabAtom);
        return activeTab?.blockids?.includes(note.blockId) === true;
    }

    markRead(id: string): void {
        globalStore.set(
            this.notificationsAtom,
            globalStore.get(this.notificationsAtom).map((n) => (n.id === id ? { ...n, read: true } : n))
        );
    }

    markAllRead(): void {
        globalStore.set(
            this.notificationsAtom,
            globalStore.get(this.notificationsAtom).map((n) => ({ ...n, read: true }))
        );
    }

    clearAll(): void {
        globalStore.set(this.notificationsAtom, []);
    }

    focusBlock(blockId: string | undefined, tabId?: string): void {
        if (!blockId) return;
        const activeTabId = globalStore.get(atoms.staticTabId);
        if (tabId && tabId !== activeTabId) {
            // Switch to the tab that owns this block, then focus it once the
            // staticTabId atom settles (main-process round-trip).
            getApi().setActiveTab(tabId);
            let tries = 20;
            const poll = () => {
                if (globalStore.get(atoms.staticTabId) === tabId) {
                    refocusNode(blockId);
                    return;
                }
                if (--tries > 0) setTimeout(poll, 50);
                else refocusNode(blockId);
            };
            setTimeout(poll, 50);
            return;
        }
        refocusNode(blockId);
    }
}
