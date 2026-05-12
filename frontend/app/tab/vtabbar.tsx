// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UIcon } from "@/app/element/ui-icon";
import { Tooltip } from "@/app/element/tooltip";
import { getTabBadgeAtom } from "@/app/store/badge";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { getApi } from "@/app/store/global";
import { getTabModelByTabId } from "@/app/store/tab-model";
import { TabCmdStateStore, getTabRunningKind } from "@/app/store/tabcmdstate";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { validateCssColor } from "@/util/color-validator";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildTabBarContextMenu, buildTabContextMenu } from "./tabcontextmenu";
import { VTab, VTabItem } from "./vtab";
import { VTabBarEnv } from "./vtabbarenv";
export type { VTabItem } from "./vtab";

interface VTabBarProps {
    workspace: Workspace;
    className?: string;
}

interface VTabWrapperProps {
    tabId: string;
    active: boolean;
    showDivider: boolean;
    isDragging: boolean;
    isReordering: boolean;
    hoverResetVersion: number;
    index: number;
    onSelect: () => void;
    onClose: () => void;
    onRename: (newName: string) => void;
    onDragStart: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
    onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragEnd: () => void;
    onHoverChanged: (isHovered: boolean) => void;
    matchesQuery: (item: VTabItem) => boolean;
}

function shortenHome(cwd: string, home: string): string {
    if (!cwd) return "";
    if (home && cwd === home) return "~";
    if (home && cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
    return cwd;
}

// Shared git-info poller: one interval + one RPC per unique cwd for all tabs.
// Previously every VTab spun its own 8s setInterval; that scaled O(tabs) RPCs.
const GitInfoPollIntervalMs = 8000;
const gitInfoCache = new Map<string, GitInfoResponse | null>();
const gitInfoSubs = new Map<string, Set<(info: GitInfoResponse | null) => void>>();
let gitInfoTimer: ReturnType<typeof setInterval> | null = null;

function fanout(cwd: string, info: GitInfoResponse | null) {
    gitInfoCache.set(cwd, info);
    const subs = gitInfoSubs.get(cwd);
    if (!subs) return;
    for (const cb of subs) {
        try { cb(info); } catch { /* ignore */ }
    }
}

async function pollOne(cwd: string) {
    try {
        const info = await RpcApi.GetGitInfoCommand(TabRpcClient, cwd);
        fanout(cwd, info ?? null);
    } catch {
        fanout(cwd, null);
    }
}

function pollAll() {
    for (const cwd of gitInfoSubs.keys()) fireAndForget(() => pollOne(cwd));
}

function subscribeGitInfo(cwd: string, cb: (info: GitInfoResponse | null) => void): () => void {
    let subs = gitInfoSubs.get(cwd);
    if (!subs) {
        subs = new Set();
        gitInfoSubs.set(cwd, subs);
        fireAndForget(() => pollOne(cwd));
    } else if (gitInfoCache.has(cwd)) {
        cb(gitInfoCache.get(cwd) ?? null);
    }
    subs.add(cb);
    if (gitInfoTimer == null) {
        gitInfoTimer = setInterval(pollAll, GitInfoPollIntervalMs);
    }
    return () => {
        const s = gitInfoSubs.get(cwd);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) {
            gitInfoSubs.delete(cwd);
            gitInfoCache.delete(cwd);
        }
        if (gitInfoSubs.size === 0 && gitInfoTimer != null) {
            clearInterval(gitInfoTimer);
            gitInfoTimer = null;
        }
    };
}

function VTabWrapper({
    tabId,
    active,
    showDivider,
    isDragging,
    isReordering,
    hoverResetVersion,
    onSelect,
    onClose,
    onRename,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
    onHoverChanged,
    matchesQuery,
}: VTabWrapperProps) {
    const env = useWaveEnv<VTabBarEnv>();
    const [tabData] = env.wos.useWaveObjectValue<Tab>(makeORef("tab", tabId));
    const badges = useAtomValue(getTabBadgeAtom(tabId, env));
    const renameRef = useRef<(() => void) | null>(null);
    const tabModel = getTabModelByTabId(tabId, env);
    const tabCmdStore = TabCmdStateStore.getInstance();
    useEffect(() => { tabCmdStore.ensureSubscribed(); }, []);
    const blockCmdState = useAtomValue(tabCmdStore.blockCmdStateAtom);
    const runningKind = getTabRunningKind(tabData?.blockids ?? [], blockCmdState);

    useEffect(() => {
        const cb = () => renameRef.current?.();
        tabModel.startRenameCallback = cb;
        return () => {
            if (tabModel.startRenameCallback === cb) {
                tabModel.startRenameCallback = null;
            }
        };
    }, [tabModel]);

    const rawFlagColor = tabData?.meta?.["tab:flagcolor"];
    let flagColor: string | null = null;
    if (rawFlagColor) {
        try {
            validateCssColor(rawFlagColor);
            flagColor = rawFlagColor;
        } catch {
            flagColor = null;
        }
    }

    // Pick a representative cwd: the first block in the tab that has
    // shell integration populated.  Subscribing to every block's meta
    // would double the re-render load for crowded tabs; we cap at the
    // first two.
    const firstBlockId = tabData?.blockids?.[0];
    const secondBlockId = tabData?.blockids?.[1];
    const [firstBlock] = env.wos.useWaveObjectValue<Block>(
        firstBlockId ? makeORef("block", firstBlockId) : null
    );
    const [secondBlock] = env.wos.useWaveObjectValue<Block>(
        secondBlockId ? makeORef("block", secondBlockId) : null
    );
    const cwd = (firstBlock?.meta?.["cmd:cwd"] as string) || (secondBlock?.meta?.["cmd:cwd"] as string) || "";
    const home = useMemo(() => {
        try {
            return getApi().getHomeDir() ?? "";
        } catch {
            return "";
        }
    }, []);
    const [gitInfo, setGitInfo] = useState<GitInfoResponse | null>(null);
    useEffect(() => {
        if (!cwd) {
            setGitInfo(null);
            return;
        }
        return subscribeGitInfo(cwd, setGitInfo);
    }, [cwd]);

    const cwdShort = shortenHome(cwd, home);
    const isRepo = !!gitInfo?.isrepo;
    // Auto-generated tab names follow the "T<number>" pattern from
    // pkg/wcore.getNextTabName.  Hide that placeholder completely:
    // prefer the real cwd, fall back to ~ (shells almost always start
    // there) or a generic "Terminal" label when even the home dir is
    // unknown.  The real cwd replaces whatever standin is showing the
    // moment OSC 7 lands.
    const rawName = tabData?.name ?? "";
    const isAutoNamed = /^T\d+$/.test(rawName);
    let primaryName: string;
    if (isAutoNamed) {
        if (cwdShort) {
            primaryName = cwdShort;
        } else if (home) {
            primaryName = "~";
        } else {
            primaryName = "Terminal";
        }
    } else {
        primaryName = rawName;
    }
    const subtitle = isAutoNamed ? "" : cwdShort;

    const tab: VTabItem = {
        id: tabId,
        name: primaryName,
        badges,
        flagColor,
        subtitle,
        gitBranch: isRepo ? gitInfo?.branch : undefined,
        gitAdds: isRepo ? gitInfo?.additions : undefined,
        gitDels: isRepo ? gitInfo?.deletions : undefined,
        gitChangedFiles: isRepo ? gitInfo?.changedfiles : undefined,
        runningKind,
    };

    const matched = matchesQuery(tab);

    const handleContextMenu = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            e.preventDefault();
            e.stopPropagation();
            const menu = buildTabContextMenu(tabId, renameRef, () => onClose(), env);
            env.showContextMenu(menu, e);
        },
        [tabId, onClose, env]
    );

    // Toggle + offset for the "..." button: open the menu anchored just below
    // the button; clicking while open closes it.  Native menus don't expose an
    // "is open" state, so we track when the last menu closed (Electron fires
    // the callback via contextmenu-click null on outside-click).  If a click
    // on the button lands within MoreBtnToggleMs of that close, we treat it
    // as the close action and skip reopening.
    const menuClosedAtRef = useRef<number>(0);
    const handleMoreButtonClick = useCallback(
        (e: React.MouseEvent<HTMLButtonElement>) => {
            const MoreBtnToggleMs = 200;
            if (Date.now() - menuClosedAtRef.current < MoreBtnToggleMs) {
                return;
            }
            const rect = e.currentTarget.getBoundingClientRect();
            const menu = buildTabContextMenu(tabId, renameRef, () => onClose(), env);
            ContextMenuModel.getInstance().showContextMenu(menu, e, {
                position: { x: rect.left, y: rect.bottom + 12 },
                onCancel: () => {
                    menuClosedAtRef.current = Date.now();
                },
            });
        },
        [tabId, onClose, env]
    );

    if (!matched) {
        return null;
    }

    return (
        <VTab
            tab={tab}
            active={active}
            showDivider={showDivider}
            isDragging={isDragging}
            isReordering={isReordering}
            hoverResetVersion={hoverResetVersion}
            onSelect={onSelect}
            onClose={onClose}
            onRename={onRename}
            onContextMenu={handleContextMenu}
            onMoreButtonClick={handleMoreButtonClick}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
            onHoverChanged={onHoverChanged}
            renameRef={renameRef}
        />
    );
}

interface ControlBarProps {
    query: string;
    onQueryChange: (q: string) => void;
    onNewTab: () => void;
    onSettingsClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

function ControlBar({ query, onQueryChange, onNewTab, onSettingsClick }: ControlBarProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    return (
        <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
            <div
                className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 text-secondary focus-within:bg-fg-overlay-1 focus-within:text-foreground hover:bg-fg-overlay-1"
                onClick={() => inputRef.current?.focus()}
            >
                <UIcon name="search-small" size={12} className="opacity-80" />
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => onQueryChange(e.target.value)}
                    placeholder="Search tabs"
                    className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-secondary/50"
                    aria-label="Search tabs"
                />
                {query && (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onQueryChange("");
                        }}
                        className="cursor-pointer text-secondary/70 hover:text-foreground"
                        aria-label="Clear search"
                    >
                        <UIcon name="x-close" size={12} />
                    </button>
                )}
            </div>
            <Tooltip content="Tab settings" placement="bottom" divClassName="shrink-0">
                <button
                    type="button"
                    onClick={onSettingsClick}
                    className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-secondary transition-colors hover:bg-fg-overlay-2 hover:text-foreground"
                    aria-label="Tab settings"
                >
                    <UIcon name="settings" size={14} />
                </button>
            </Tooltip>
            <Tooltip content="New tab" placement="bottom" divClassName="shrink-0">
                <button
                    type="button"
                    onClick={onNewTab}
                    className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-secondary transition-colors hover:bg-fg-overlay-2 hover:text-foreground"
                    aria-label="New tab"
                >
                    <UIcon name="plus" size={14} />
                </button>
            </Tooltip>
        </div>
    );
}

export function VTabBar({ workspace, className }: VTabBarProps) {
    const env = useWaveEnv<VTabBarEnv>();
    const activeTabId = useAtomValue(env.atoms.staticTabId);
    const reinitVersion = useAtomValue(env.atoms.reinitVersion);
    const documentHasFocus = useAtomValue(env.atoms.documentHasFocus);
    const tabIds = workspace?.tabids ?? [];

    const [orderedTabIds, setOrderedTabIds] = useState<string[]>(tabIds);
    const [dragTabId, setDragTabId] = useState<string | null>(null);
    const [dropIndex, setDropIndex] = useState<number | null>(null);
    const [dropLineTop, setDropLineTop] = useState<number | null>(null);
    const [hoverResetVersion, setHoverResetVersion] = useState(0);
    const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const dragSourceRef = useRef<string | null>(null);
    const didResetHoverForDragRef = useRef(false);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const scrollAnimFrameRef = useRef<number | null>(null);
    const scrollDirectionRef = useRef<number>(0);
    const scrollSpeedRef = useRef<number>(0);

    const normalizedQuery = searchQuery.trim().toLowerCase();
    const matchesQuery = useCallback(
        (item: VTabItem) => {
            if (!normalizedQuery) return true;
            if (item.name.toLowerCase().includes(normalizedQuery)) return true;
            if (item.subtitle && item.subtitle.toLowerCase().includes(normalizedQuery)) return true;
            if (item.gitBranch && item.gitBranch.toLowerCase().includes(normalizedQuery)) return true;
            return false;
        },
        [normalizedQuery]
    );

    const dragReorderEnabled = normalizedQuery.length === 0;

    useEffect(() => {
        setOrderedTabIds(tabIds);
    }, [workspace?.tabids]);

    useEffect(() => {
        if (reinitVersion > 0) {
            setOrderedTabIds(workspace?.tabids ?? []);
        }
    }, [reinitVersion]);

    useEffect(() => {
        if (activeTabId == null || scrollContainerRef.current == null) {
            return;
        }
        const el = scrollContainerRef.current.querySelector(`[data-tabid="${activeTabId}"]`);
        el?.scrollIntoView({ block: "nearest" });
    }, [activeTabId]);

    useEffect(() => {
        if (!documentHasFocus || activeTabId == null || scrollContainerRef.current == null) {
            return;
        }
        const el = scrollContainerRef.current.querySelector(`[data-tabid="${activeTabId}"]`);
        el?.scrollIntoView({ block: "nearest" });
    }, [documentHasFocus]);

    const stopScrollLoop = useCallback(() => {
        if (scrollAnimFrameRef.current != null) {
            cancelAnimationFrame(scrollAnimFrameRef.current);
            scrollAnimFrameRef.current = null;
        }
        scrollDirectionRef.current = 0;
    }, []);

    const startScrollLoop = useCallback(() => {
        if (scrollAnimFrameRef.current != null) {
            return;
        }
        const loop = () => {
            const container = scrollContainerRef.current;
            if (container == null || scrollDirectionRef.current === 0) {
                scrollAnimFrameRef.current = null;
                return;
            }
            container.scrollTop += scrollDirectionRef.current * scrollSpeedRef.current;
            scrollAnimFrameRef.current = requestAnimationFrame(loop);
        };
        scrollAnimFrameRef.current = requestAnimationFrame(loop);
    }, []);

    const updateScrollFromDragY = useCallback(
        (clientY: number) => {
            const container = scrollContainerRef.current;
            if (container == null) {
                return;
            }
            const EdgeZone = 60;
            const MaxScrollSpeed = 12;
            const rect = container.getBoundingClientRect();
            const relY = clientY - rect.top;
            const height = rect.height;
            if (relY < EdgeZone) {
                scrollDirectionRef.current = -1;
                scrollSpeedRef.current = MaxScrollSpeed * (1 - relY / EdgeZone);
                startScrollLoop();
            } else if (relY > height - EdgeZone) {
                scrollDirectionRef.current = 1;
                scrollSpeedRef.current = MaxScrollSpeed * (1 - (height - relY) / EdgeZone);
                startScrollLoop();
            } else {
                scrollDirectionRef.current = 0;
                stopScrollLoop();
            }
        },
        [startScrollLoop, stopScrollLoop]
    );

    const clearDragState = () => {
        stopScrollLoop();
        if (dragSourceRef.current != null && !didResetHoverForDragRef.current) {
            didResetHoverForDragRef.current = true;
            setHoverResetVersion((version) => version + 1);
        }
        dragSourceRef.current = null;
        setDragTabId(null);
        setDropIndex(null);
        setDropLineTop(null);
    };

    const reorder = (targetIndex: number) => {
        const sourceTabId = dragSourceRef.current;
        if (sourceTabId == null) {
            return;
        }
        const sourceIndex = orderedTabIds.findIndex((id) => id === sourceTabId);
        if (sourceIndex === -1) {
            return;
        }
        const boundedTargetIndex = Math.max(0, Math.min(targetIndex, orderedTabIds.length));
        const adjustedTargetIndex = sourceIndex < boundedTargetIndex ? boundedTargetIndex - 1 : boundedTargetIndex;
        if (sourceIndex === adjustedTargetIndex) {
            return;
        }
        const nextTabIds = [...orderedTabIds];
        const [movedId] = nextTabIds.splice(sourceIndex, 1);
        nextTabIds.splice(adjustedTargetIndex, 0, movedId);
        setOrderedTabIds(nextTabIds);
        fireAndForget(() => env.rpc.UpdateWorkspaceTabIdsCommand(TabRpcClient, workspace.oid, nextTabIds));
    };

    const handleTabBarContextMenu = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            e.preventDefault();
            const menu = buildTabBarContextMenu(env);
            env.showContextMenu(menu, e);
        },
        [env]
    );

    const handleSettingsClick = useCallback(
        (e: React.MouseEvent<HTMLButtonElement>) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const menu = buildTabBarContextMenu(env);
            ContextMenuModel.getInstance().showContextMenu(menu, e, {
                position: { x: rect.left, y: rect.bottom + 6 },
            });
        },
        [env]
    );

    return (
        <div
            className={cn("flex h-full flex-col overflow-hidden bg-panel", className)}
            style={{ backdropFilter: "blur(20px)" }}
            onContextMenu={handleTabBarContextMenu}
        >
            <ControlBar
                query={searchQuery}
                onQueryChange={setSearchQuery}
                onNewTab={() => env.electron.createTab()}
                onSettingsClick={handleSettingsClick}
            />
            <div
                ref={scrollContainerRef}
                className="relative flex min-h-0 flex-col overflow-y-auto pb-2"
                onDragOver={(event) => {
                    if (!dragReorderEnabled) return;
                    event.preventDefault();
                    updateScrollFromDragY(event.clientY);
                    if (event.target === event.currentTarget) {
                        setDropIndex(orderedTabIds.length);
                        setDropLineTop(event.currentTarget.scrollHeight);
                    }
                }}
                onDrop={(event) => {
                    if (!dragReorderEnabled) return;
                    event.preventDefault();
                    if (dropIndex != null) {
                        reorder(dropIndex);
                    }
                    clearDragState();
                }}
            >
                {orderedTabIds.map((tabId, index) => {
                    const isActive = tabId === activeTabId;
                    const isHovered = tabId === hoveredTabId;
                    const isLast = index === orderedTabIds.length - 1;
                    const nextTabId = orderedTabIds[index + 1];
                    const isNextActive = nextTabId === activeTabId;
                    const isNextHovered = nextTabId === hoveredTabId;
                    return (
                        <VTabWrapper
                            key={tabId}
                            tabId={tabId}
                            active={isActive}
                            showDivider={
                                !isActive &&
                                !isNextActive &&
                                !isHovered &&
                                !isNextHovered &&
                                !isLast
                            }
                            isDragging={dragTabId === tabId}
                            isReordering={dragTabId != null}
                            hoverResetVersion={hoverResetVersion}
                            index={index}
                            matchesQuery={matchesQuery}
                            onSelect={() => env.electron.setActiveTab(tabId)}
                            onClose={() => fireAndForget(() => env.electron.closeTab(workspace.oid, tabId, false))}
                            onRename={(newName) =>
                                fireAndForget(() => env.rpc.UpdateTabNameCommand(TabRpcClient, tabId, newName))
                            }
                            onDragStart={(event) => {
                                if (!dragReorderEnabled) {
                                    event.preventDefault();
                                    return;
                                }
                                didResetHoverForDragRef.current = false;
                                dragSourceRef.current = tabId;
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData("text/plain", tabId);
                                setDragTabId(tabId);
                                setDropIndex(index);
                                setDropLineTop(event.currentTarget.offsetTop);
                            }}
                            onDragOver={(event) => {
                                if (!dragReorderEnabled) return;
                                event.preventDefault();
                                const rect = event.currentTarget.getBoundingClientRect();
                                const relativeY = event.clientY - rect.top;
                                const midpoint = event.currentTarget.offsetHeight / 2;
                                const insertBefore = relativeY < midpoint;
                                setDropIndex(insertBefore ? index : index + 1);
                                setDropLineTop(
                                    insertBefore
                                        ? event.currentTarget.offsetTop
                                        : event.currentTarget.offsetTop + event.currentTarget.offsetHeight
                                );
                            }}
                            onDrop={(event) => {
                                if (!dragReorderEnabled) return;
                                event.preventDefault();
                                if (dropIndex != null) {
                                    reorder(dropIndex);
                                }
                                clearDragState();
                            }}
                            onDragEnd={clearDragState}
                            onHoverChanged={(isHovered) => setHoveredTabId(isHovered ? tabId : null)}
                        />
                    );
                })}
                {dragTabId != null && dropIndex != null && dropLineTop != null && dragReorderEnabled && (
                    <div
                        className="pointer-events-none absolute left-2 right-2 border-t-2 border-accent/80"
                        style={{ top: dropLineTop, transform: "translateY(-1px)" }}
                    />
                )}
            </div>
        </div>
    );
}
