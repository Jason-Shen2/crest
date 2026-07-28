// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentRuntimeClient } from "@/app/agent/agent-runtime-client";
import { Icon } from "@/app/icon/Icon";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { getResumeSessionDisplayText } from "@/app/view/cmdblock/session-selector";
import type { WorkspaceAgentModel } from "@/app/workspace/workspace-agent-model";
import type { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import type { WorkspaceModel } from "@/app/workspace/workspace-model";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useRef, useState } from "react";

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

export interface AgentSessionsPanelProps {
    runtimeClient: AgentRuntimeClient;
    agentModel: WorkspaceAgentModel;
    workspaceModel: WorkspaceModel;
    layoutModel: WorkspaceLayoutModel;
}

export const AgentSessionsPanel = memo(
    ({ runtimeClient, agentModel, workspaceModel, layoutModel }: AgentSessionsPanelProps) => {
        const agentState = useAtomValue(agentModel.stateAtom);
        const [sessions, setSessions] = useState<AgentSessionDetail[]>([]);
        const [loading, setLoading] = useState(false);
        const [activeIdx, setActiveIdx] = useState(0);
        const listRef = useRef<HTMLDivElement>(null);

        const activateSession = useCallback(
            (session: AgentSessionMeta) => {
                agentModel.selectSession(session);
                workspaceModel.activateAgent();
                layoutModel.showLeftPanel("sessions");
            },
            [agentModel, workspaceModel, layoutModel]
        );

        const loadSessions = useCallback(async () => {
            setLoading(true);
            try {
                const list = await runtimeClient.listSessionDetails(50);
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
        }, [runtimeClient]);

        useEffect(() => {
            void loadSessions();
        }, [loadSessions]);

        const onClose = useCallback(() => {
            layoutModel.toggleLeftPanel("sessions");
        }, [layoutModel]);

        const onNewSession = useCallback(async () => {
            try {
                const meta = await runtimeClient.createSession();
                activateSession(meta);
                void loadSessions();
            } catch (e) {
                console.warn("Failed to create agent session:", e);
            }
        }, [runtimeClient, activateSession, loadSessions]);

        const makeSessionMeta = useCallback(
            (session: AgentSessionDetail): AgentSessionMeta => ({
                id: session.id,
                createdAt: session.createdAt,
                cwd: session.cwd,
                path: session.path,
            }),
            []
        );

        const clearIfActive = useCallback(
            (session: AgentSessionMeta) => {
                if (agentState.activeSession?.path !== session.path) {
                    return;
                }
                agentModel.selectSession(undefined);
            },
            [agentModel, agentState.activeSession?.path]
        );

        const handleSelect = useCallback(
            (session: AgentSessionDetail) => {
                activateSession(makeSessionMeta(session));
            },
            [activateSession, makeSessionMeta]
        );

        const handleContextMenu = useCallback(
            (event: React.MouseEvent, session: AgentSessionDetail) => {
                const meta = makeSessionMeta(session);
                const menu: ContextMenuItem[] = [
                    {
                        label: "Rename",
                        click: () => {
                            const name = globalThis.prompt?.("Rename session", getResumeSessionDisplayText(session));
                            if (!name?.trim()) return;
                            void runtimeClient
                                .renameSession(meta, name.trim())
                                .then(loadSessions)
                                .catch((e) => console.warn("Failed to rename agent session:", e));
                        },
                    },
                    {
                        label: "Archive",
                        click: () => {
                            void runtimeClient
                                .archiveSession(meta)
                                .then(() => {
                                    clearIfActive(meta);
                                    return loadSessions();
                                })
                                .catch((e) => console.warn("Failed to archive agent session:", e));
                        },
                    },
                    {
                        label: "Delete",
                        click: () => {
                            void runtimeClient
                                .deleteSession(meta)
                                .then(() => {
                                    clearIfActive(meta);
                                    return loadSessions();
                                })
                                .catch((e) => console.warn("Failed to delete agent session:", e));
                        },
                    },
                    {
                        label: "Stop Run",
                        click: () => {
                            void runtimeClient.abort(meta.path).catch((e) => console.warn("Failed to stop agent run:", e));
                        },
                    },
                ];
                ContextMenuModel.getInstance().showContextMenu(menu, event);
            },
            [runtimeClient, makeSessionMeta, loadSessions, clearIfActive]
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
                    const session = sessions[activeIdx];
                    if (session) handleSelect(session);
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    onClose();
                }
            },
            [sessions, activeIdx, handleSelect, onClose]
        );

        useEffect(() => {
            if (!agentState.activeSession) {
                setActiveIdx(0);
            }
        }, [agentState.activeSession, sessions]);

        const activePath = agentState.activeSession?.path ?? "";

        return (
            <div className="flex h-full w-full flex-col overflow-hidden border-r border-border/60 bg-card text-primary">
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
                    className="aui-thread-list flex-grow overflow-auto p-2 outline-none"
                    onKeyDown={handleKeyDown}
                >
                    {loading && sessions.length === 0 ? (
                        <div className="px-3 py-5 text-center text-xs text-muted-foreground">Loading...</div>
                    ) : null}
                    {!loading && sessions.length === 0 ? (
                        <div className="px-3 py-5 text-center text-xs text-muted-foreground">No sessions yet.</div>
                    ) : null}
                    {sessions.map((session, idx) => {
                        const title = getResumeSessionDisplayText(session);
                        const time = formatRelativeTime(session.modifiedAt);
                        const isActive = session.path === activePath;
                        const isFocused = idx === activeIdx;
                        return (
                            <button
                                key={session.id}
                                type="button"
                                data-active={isActive ? "true" : undefined}
                                data-focused={isFocused ? "true" : undefined}
                                className={
                                    "aui-thread-list-item group relative flex min-h-[34px] w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-foreground/85 transition-colors " +
                                    (isActive
                                        ? "bg-sidebar-accent text-sidebar-accent-foreground "
                                        : isFocused
                                          ? "bg-sidebar-accent/70 "
                                          : "hover:bg-sidebar-accent/60 ")
                                }
                                onClick={() => handleSelect(session)}
                                onContextMenu={(event) => handleContextMenu(event, session)}
                                onMouseEnter={() => setActiveIdx(idx)}
                            >
                                <span className="min-w-0 flex-1 truncate text-[13px] leading-[1.4]">{title}</span>
                                <span className="shrink-0 text-[11px] leading-[1.4] text-muted-foreground/50">
                                    {time}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>
        );
    }
);

AgentSessionsPanel.displayName = "AgentSessionsPanel";
