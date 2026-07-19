// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AgentSessionsPanel — left sidebar panel listing agent sessions for the
// current cwd.  Modeled after FileExplorer (h-8 header + scroll body) and
// visually/behaviorally aligned with assistant-ui's ThreadListPrimitive:
// single-line items, button triggers, ↑↓ keyboard nav, data-active marking,
// truncation with ellipsis.

import { Icon } from "@/app/icon/Icon";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { getResumeSessionDisplayText } from "@/app/view/cmdblock/session-selector";
import { workspaceDirAtom } from "@/app/fileexplorer/file-explorer-atoms";
import { pendingResumeSessionAtom } from "@/app/term/render/assistant-ui/agent-sessions-atoms";
import { useAtomValue, useSetAtom } from "jotai";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

interface AgentSessionsApi {
    listSessionDetailsForCwd: (cwd: string, limit?: number) => Promise<AgentSessionDetail[]>;
    createSession: (cwd: string) => Promise<AgentSessionMeta>;
}

function getAgentSessionsApi(): AgentSessionsApi | undefined {
    if (typeof window === "undefined") return undefined;
    const api = (window as unknown as { api?: { agent?: AgentSessionsApi } }).api;
    return api?.agent;
}

function formatRelativeTime(iso: string): string {
    if (!iso) return "";
    const then = new Date(iso).getTime();
    if (isNaN(then)) return "";
    const now = Date.now();
    const diff = now - then;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return "Now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d`;
    const d = new Date(then);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}-${dd}`;
}

export const AgentSessionsPanel = memo(() => {
    const cwd = useAtomValue(workspaceDirAtom);
    const setPendingSession = useSetAtom(pendingResumeSessionAtom);
    const pendingSession = useAtomValue(pendingResumeSessionAtom);
    const [sessions, setSessions] = useState<AgentSessionDetail[]>([]);
    const [loading, setLoading] = useState(false);
    const [activeIdx, setActiveIdx] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    const loadSessions = useCallback(async () => {
        if (!cwd) {
            setSessions([]);
            return;
        }
        const api = getAgentSessionsApi();
        if (!api) return;
        setLoading(true);
        try {
            const list = await api.listSessionDetailsForCwd(cwd, 50);
            const sorted = [...list].sort((a, b) => {
                const at = new Date(a.modifiedAt).getTime();
                const bt = new Date(b.modifiedAt).getTime();
                return bt - at;
            });
            setSessions(sorted);
        } catch (e) {
            console.warn("Failed to load agent sessions:", e);
            setSessions([]);
        } finally {
            setLoading(false);
        }
    }, [cwd]);

    useEffect(() => {
        void loadSessions();
    }, [loadSessions]);

    const onClose = useCallback(() => {
        WorkspaceLayoutModel.getInstance().setSessionsPanelVisible(false);
    }, []);

    const onNewSession = useCallback(async () => {
        if (!cwd) return;
        const api = getAgentSessionsApi();
        if (!api) return;
        try {
            const meta = await api.createSession(cwd);
            setPendingSession(meta);
            void WorkspaceLayoutModel.getInstance().openAgentTab(meta);
            void loadSessions();
        } catch (e) {
            console.warn("Failed to create agent session:", e);
        }
    }, [cwd, setPendingSession, loadSessions]);

    const handleSelect = useCallback(
        (session: AgentSessionDetail) => {
            const meta: AgentSessionMeta = {
                id: session.id,
                createdAt: session.createdAt,
                cwd: session.cwd,
                path: session.path,
            };
            setPendingSession(meta);
            void WorkspaceLayoutModel.getInstance().openAgentTab(meta);
        },
        [setPendingSession]
    );

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIdx((i) => Math.min(sessions.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIdx((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
                e.preventDefault();
                const s = sessions[activeIdx];
                if (s) handleSelect(s);
            } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
        },
        [sessions, activeIdx, handleSelect, onClose]
    );

    useEffect(() => {
        if (!pendingSession) {
            setActiveIdx(0);
        }
    }, [pendingSession, sessions]);

    const activeId = useMemo(() => pendingSession?.path ?? null, [pendingSession]);

    return (
        <div
            className="flex flex-col h-full w-full bg-card text-primary overflow-hidden border-r border-border/60"
        >
            <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <Icon name="message-01" size={14} className="shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs font-medium text-foreground/80">Agent Sessions</span>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                    <button
                        type="button"
                        title="New Session"
                        onClick={onNewSession}
                        className="grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground"
                    >
                        <span className="text-[14px] leading-none">+</span>
                    </button>
                    <button
                        type="button"
                        title="Close"
                        onClick={onClose}
                        className="grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground"
                    >
                        <Icon name="cancel-01" size={14} strokeWidth={1.75} />
                    </button>
                </div>
            </div>
            <div
                ref={listRef}
                tabIndex={0}
                className="aui-thread-list flex-grow overflow-auto outline-none"
                onKeyDown={handleKeyDown}
            >
                {loading && sessions.length === 0 && (
                    <div className="px-3 py-4 text-xs text-muted-foreground">Loading…</div>
                )}
                {!loading && sessions.length === 0 && (
                    <div className="px-3 py-4 text-xs text-muted-foreground">No sessions yet.</div>
                )}
                {sessions.map((session, idx) => {
                    const title = getResumeSessionDisplayText(session);
                    const time = formatRelativeTime(session.modifiedAt);
                    const isActive = session.path === activeId;
                    const isFocused = idx === activeIdx;
                    return (
                        <button
                            key={session.id}
                            type="button"
                            data-active={isActive ? "true" : undefined}
                            data-focused={isFocused ? "true" : undefined}
                            className={
                                "aui-thread-list-item group relative flex w-full items-center gap-2 border-0 bg-transparent px-[10px] py-[6px] text-left " +
                                "cursor-pointer transition-colors " +
                                (isActive
                                    ? "bg-white/[0.08] "
                                    : isFocused
                                      ? "bg-white/[0.05] "
                                      : "hover:bg-white/[0.05] ")
                            }
                            onClick={() => handleSelect(session)}
                            onMouseEnter={() => setActiveIdx(idx)}
                        >
                            <span className="min-w-0 flex-1 truncate text-[13px] leading-[1.4] text-foreground/85">
                                {title}
                            </span>
                            <span className="shrink-0 text-[11px] leading-[1.4] text-muted-foreground/60">{time}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
});

AgentSessionsPanel.displayName = "AgentSessionsPanel";
