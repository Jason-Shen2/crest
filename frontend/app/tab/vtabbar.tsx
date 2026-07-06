// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UIcon } from "@/app/element/ui-icon";
import { Tooltip } from "@/app/element/tooltip";
import { getTabBadgeAtom } from "@/app/store/badge";
import { getApi, globalStore } from "@/app/store/global";
import { getTabModelByTabId } from "@/app/store/tab-model";
import { TabCmdStateStore, getTabRunningKind } from "@/app/store/tabcmdstate";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { useResolvedTabFlagColor } from "./tab-color-utils";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildTabBarContextMenu, buildVtabMenuItems } from "./tabcontextmenu";
import { VTab, VTabItem } from "./vtab";
import { VTabBarEnv } from "./vtabbarenv";
import { VtabContextMenu, VtabMenuItem } from "./vtab-context-menu";
import {
    DefaultGranularity,
    DefaultPrimaryInfo,
    DefaultShowDiffStats,
    DefaultShowDetailsOnHover,
    DefaultViewMode,
    resolveCompactSubtitle,
    VtabCompactSubtitle,
    VtabGranularity,
    VtabPrimaryInfo,
    VtabSettingsPopover,
    VtabViewMode,
} from "./vtab-settings-popover";
import { VtabDetailSidecar } from "./vtab-detail-sidecar";
import { getSettingsKeyAtom } from "@/app/store/global";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { blockViewToName } from "@/app/block/blockutil";
import { getFileBackedBlockLabel, isTabAutoNamed } from "./vtab-file-label";
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
    totalTabs: number;
    viewMode: VtabViewMode;
    primaryInfo: VtabPrimaryInfo;
    compactSubtitle: VtabCompactSubtitle;
    showDiffStats: boolean;
    onSelect: () => void;
    onClose: () => void;
    onRename: (newName: string) => void;
    // Context-menu callbacks built at the bar level so they can reach
    // workspace-wide operations (close-others, reorder via
    // UpdateWorkspaceTabIdsCommand) without each wrapper subscribing
    // to the full tab list.
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    onCloseOtherTabs?: () => void;
    onCloseTabsBelow?: () => void;
    onResetTabName: () => void;
    // Custom-menu opener (renders VtabContextMenu in a portal).
    onOpenMenu: (
        items: VtabMenuItem[],
        position: { x: number; y: number } | { anchorRect: DOMRect },
        toggleKey?: string
    ) => void;
    onDragStart: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
    onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragEnd: () => void;
    onHoverChanged: (isHovered: boolean) => void;
    matchesQuery: (item: VTabItem) => boolean;
    onReportMatched: (tabId: string, matched: boolean) => void;
}

function shortenHome(cwd: string, home: string): string {
    if (!cwd) return "";
    if (home && cwd === home) return "~";
    if (home && cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
    return cwd;
}

export async function resetVTabName(env: Pick<VTabBarEnv, "rpc">, tabId: string, resetName: string) {
    await env.rpc.ResetTabNameCommand(TabRpcClient, tabId, resetName);
}

// blockViewToUIcon — pane-row icon for each block view type.  Mirrors
// `blockViewToIcon` in @/app/block/blockutil.tsx but returns names from
// our local SVG set (frontend/app/asset/ui-icons) instead of the
// FontAwesome class names used by legacy code.  Unmapped views fall
// back to a neutral file/code glyph.
function blockViewToUIcon(view: string): string {
    switch (view) {
        case "term":
        case "termblocks":
            return "terminal";
        case "preview":
        case "codeeditor":
            return "file";
        case "gitdiff":
            return "git-branch-02";
        case "web":
            return "compass-3";
        case "help":
            return "alert-circle";
        case "tips":
            return "sparkle";
        case "processviewer":
            return "workflow";
        case "launcher":
            return "plus";
        case "sysinfo":
        case "cpuplot":
            return "workflow";
        case "waveconfig":
            return "settings";
        case "vdom":
            return "grid";
        case "tsunami":
            return "lightning-02";
        default:
            return "code-02";
    }
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
    index,
    totalTabs,
    viewMode,
    primaryInfo,
    compactSubtitle,
    showDiffStats,
    onSelect,
    onClose,
    onRename,
    onMoveUp,
    onMoveDown,
    onCloseOtherTabs,
    onCloseTabsBelow,
    onResetTabName,
    onOpenMenu,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
    onHoverChanged,
    matchesQuery,
    onReportMatched,
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

    const rawFlagColor = (tabData?.meta?.["tab:flagcolor"] as string | undefined) ?? null;
    // Resolves to a hex regardless of whether the stored value is a
    // TabColorId ("red", "green", …) or a legacy literal ("#RRGGBB").
    // Hooked into the active terminal theme so the row tint follows
    // theme switches automatically — same behavior as warp.
    const flagColor = useResolvedTabFlagColor(rawFlagColor);

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
    const gitBranchName = isRepo ? gitInfo?.branch : undefined;

    // Auto-named tabs keep an empty persistent name and derive their visible
    // title from block metadata. Prefer the real cwd, fall back to ~ (shells
    // almost always start there) or a generic "Terminal" label when even the
    // home dir is unknown. The real cwd replaces the standin when OSC 7 lands.
    const rawName = tabData?.name ?? "";
    const isAutoNamed = isTabAutoNamed(tabData);
    const userTitle = isAutoNamed ? "" : rawName;
    const fileLabel = isAutoNamed ? getFileBackedBlockLabel(firstBlock?.meta) : null;
    // commandText — warp's "command / conversation" line.  For crest
    // (no CLI-agent telemetry yet) we use the user-set tab title and
    // fall back to cwd / "~" / "Terminal" so the field is never blank.
    const commandText = fileLabel?.basename || userTitle || cwdShort || (home ? "~" : "") || "Terminal";
    const workingDirectoryText = fileLabel?.path || cwdShort || userTitle || "Terminal";

    // 3-column compositor — direct port of the table in
    // `render_terminal_row_content` (vertical_tabs.rs:3284-3288).
    //
    // | Pane title as    | Line 1 (title)        | Line 2 (description)  | Line 3 left      |
    // |------------------|-----------------------|-----------------------|------------------|
    // | Command          | commandText           | workingDirectory      | gitBranch        |
    // | WorkingDirectory | workingDirectory      | commandText           | gitBranch        |
    // | Branch           | gitBranch||workingDir | commandText           | workingDirectory |
    let primaryName: string;
    let expandedSubtitle: string;
    let metadataLeftKind: "branch" | "workingdir" | undefined;
    let metadataLeftValue: string | undefined;
    if (primaryInfo === "workingdir") {
        primaryName = workingDirectoryText;
        expandedSubtitle = commandText;
        metadataLeftKind = "branch";
        metadataLeftValue = gitBranchName;
    } else if (primaryInfo === "branch") {
        primaryName = gitBranchName || workingDirectoryText;
        expandedSubtitle = commandText;
        metadataLeftKind = "workingdir";
        metadataLeftValue = workingDirectoryText;
    } else {
        primaryName = commandText;
        expandedSubtitle = workingDirectoryText;
        metadataLeftKind = "branch";
        metadataLeftValue = gitBranchName;
    }

    // Compact subtitle (line 2) is the user's "Additional metadata"
    // choice — independent of primaryInfo (warp `render_compact_pane_row`
    // 6107-6147).  resolveCompactSubtitle in the popover guarantees
    // we never get "same field as primary" here.
    let compactLineTwo = "";
    switch (compactSubtitle) {
        case "command":
            compactLineTwo = commandText;
            break;
        case "workingdir":
            compactLineTwo = workingDirectoryText;
            break;
        case "branch":
            compactLineTwo = gitBranchName || "";
            break;
        default:
            compactLineTwo = "";
    }

    const isCompact = viewMode === "compact";
    const tab: VTabItem = {
        id: tabId,
        name: primaryName,
        badges,
        flagColor,
        subtitle: isCompact ? compactLineTwo : expandedSubtitle,
        metadataLeftKind: isCompact ? undefined : metadataLeftKind,
        metadataLeftValue: isCompact ? undefined : metadataLeftValue,
        gitAdds: !isCompact && isRepo && showDiffStats ? gitInfo?.additions : undefined,
        gitDels: !isCompact && isRepo && showDiffStats ? gitInfo?.deletions : undefined,
        gitChangedFiles:
            !isCompact && isRepo && showDiffStats ? gitInfo?.changedfiles : undefined,
        runningKind,
    };

    const matched = matchesQuery(tab);

    // Report match state up so the parent can render the "no matches"
    // empty state without duplicating the filter logic (which depends on
    // tab data only this wrapper subscribes to).
    useEffect(() => {
        onReportMatched(tabId, matched);
        return () => onReportMatched(tabId, false);
    }, [tabId, matched, onReportMatched]);

    // Bundle the context-menu params in one place — same shape used
    // by both the right-click and the kebab "..." button.  Centralizing
    // keeps both menus identical, which is the warp behavior (right-
    // click on the row and the kebab anchor render the same menu).
    const menuParams = useMemo(
        () => ({
            id: tabId,
            renameRef,
            env,
            // Resolved display title (custom name OR cwd-derived
            // fallback) — matches warp's `pane_group.display_title`
            // which always yields something even for auto-named tabs.
            tabTitle: primaryName,
            hasCustomName: !isAutoNamed,
            cwd,
            gitBranch: gitBranchName,
            tabIndex: index,
            totalTabs,
            isVerticalTabs: true,
            onCloseTab: () => onClose(),
            onCloseOtherTabs,
            onCloseTabsBelow,
            onMoveUp,
            onMoveDown,
            onResetTabName,
        }),
        [
            tabId,
            renameRef,
            env,
            primaryName,
            isAutoNamed,
            cwd,
            gitBranchName,
            index,
            totalTabs,
            onClose,
            onCloseOtherTabs,
            onCloseTabsBelow,
            onMoveUp,
            onMoveDown,
            onResetTabName,
        ]
    );

    const handleContextMenu = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            e.preventDefault();
            e.stopPropagation();
            const items = buildVtabMenuItems(menuParams);
            onOpenMenu(items, { x: e.clientX, y: e.clientY });
        },
        [menuParams, onOpenMenu]
    );

    const handleMoreButtonClick = useCallback(
        (e: React.MouseEvent<HTMLButtonElement>) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const items = buildVtabMenuItems(menuParams);
            // toggleKey makes a second click on the same kebab close
            // the menu (paired with `data-vtab-menu-trigger` on the
            // button, which keeps the outside-click handler from
            // closing-then-reopening on the same gesture).
            onOpenMenu(items, { anchorRect: rect }, `kebab:tab:${tabId}`);
        },
        [menuParams, onOpenMenu, tabId]
    );

    if (!matched) {
        return null;
    }

    return (
        <VTab
            tab={tab}
            active={active}
            viewMode={viewMode}
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

interface VPaneGroupProps {
    tabId: string;
    activeTabId: string;
    focusedBlockId: string | null;
    isLastTab: boolean;
    workspaceId: string;
    tabIndex: number;
    totalTabs: number;
    isReordering: boolean;
    hoverResetVersion: number;
    viewMode: VtabViewMode;
    primaryInfo: VtabPrimaryInfo;
    compactSubtitle: VtabCompactSubtitle;
    showDiffStats: boolean;
    matchesQuery: (item: VTabItem) => boolean;
    // Receives the (tabId, blockId) pair so the sidecar can both find
    // the right DOM row (blockId matches data-tabid on pane rows) and
    // bind detail content to the specific block under the cursor.
    onPaneHoverChanged: (tabId: string, blockId: string, isHovered: boolean) => void;
    onReportMatched: (key: string, matched: boolean) => void;
    // Bar-level tab operations forwarded so each pane row's right-
    // click menu can offer Move / Close-others / Reset-name on the
    // parent tab (warp shows these in panes-mode menus too).
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    onCloseOtherTabs?: () => void;
    onCloseTabsBelow?: () => void;
    onResetTabName: () => void;
    onOpenMenu: (
        items: VtabMenuItem[],
        position: { x: number; y: number } | { anchorRect: DOMRect },
        toggleKey?: string
    ) => void;
}

// VPaneGroup — subscribes to a single tab so it can list its blocks
// without forcing the whole VTabBar to subscribe to every tab.  Emits
// one VPaneWrapper per block plus a faint group divider after the
// last pane of each tab so panes from different tabs read as visually
// separate (warp's `render_groups` does the same with explicit gaps).
function VPaneGroup({
    tabId,
    activeTabId,
    focusedBlockId,
    isLastTab,
    workspaceId,
    tabIndex,
    totalTabs,
    isReordering,
    hoverResetVersion,
    viewMode,
    primaryInfo,
    compactSubtitle,
    showDiffStats,
    matchesQuery,
    onPaneHoverChanged,
    onReportMatched,
    onMoveUp,
    onMoveDown,
    onCloseOtherTabs,
    onCloseTabsBelow,
    onResetTabName,
    onOpenMenu,
}: VPaneGroupProps) {
    const env = useWaveEnv<VTabBarEnv>();
    const [tabData] = env.wos.useWaveObjectValue<Tab>(makeORef("tab", tabId));
    const blockIds = tabData?.blockids ?? [];
    const isTabActive = tabId === activeTabId;

    const handleClick = useCallback(
        (blockId: string) => {
            if (!isTabActive) {
                env.electron.setActiveTab(tabId);
                return;
            }
            // Same-tab pane click: focus the block within the active
            // tab's layout instead of just no-oping.  Warp's
            // `FocusPane` action does the same.
            const layoutModel = getLayoutModelForStaticTab();
            if (!layoutModel) return;
            const node = layoutModel.getNodeByBlockId(blockId);
            if (node) layoutModel.focusNode(node.id);
        },
        [env, isTabActive, tabId]
    );

    const handleClose = useCallback(
        (blockId: string) => {
            // Single-block tab → close the tab itself.  Multi-block
            // tab with this tab currently active → close just the
            // block via the layout model.  Multi-block tab not active
            // → fall back to closing the tab (we can't reach a
            // non-active tab's layout model without making one).
            if (blockIds.length <= 1) {
                fireAndForget(() => env.electron.closeTab(workspaceId, tabId, false));
                return;
            }
            if (!isTabActive) {
                fireAndForget(() => env.electron.closeTab(workspaceId, tabId, false));
                return;
            }
            const layoutModel = getLayoutModelForStaticTab();
            if (!layoutModel) return;
            const node = layoutModel.getNodeByBlockId(blockId);
            if (node) fireAndForget(() => layoutModel.closeNode(node.id));
        },
        [env, isTabActive, tabId, workspaceId, blockIds.length]
    );

    if (blockIds.length === 0) return null;

    return (
        <>
            {blockIds.map((blockId) => (
                <VPaneWrapper
                    key={`${tabId}:${blockId}`}
                    tabId={tabId}
                    blockId={blockId}
                    active={isTabActive && focusedBlockId === blockId}
                    isReordering={isReordering}
                    hoverResetVersion={hoverResetVersion}
                    viewMode={viewMode}
                    primaryInfo={primaryInfo}
                    compactSubtitle={compactSubtitle}
                    showDiffStats={showDiffStats}
                    tabIndex={tabIndex}
                    totalTabs={totalTabs}
                    onClick={() => handleClick(blockId)}
                    onClose={() => handleClose(blockId)}
                    onHoverChanged={(isHovered) => onPaneHoverChanged(tabId, blockId, isHovered)}
                    matchesQuery={matchesQuery}
                    onReportMatched={onReportMatched}
                    onMoveUp={onMoveUp}
                    onMoveDown={onMoveDown}
                    onCloseOtherTabs={onCloseOtherTabs}
                    onCloseTabsBelow={onCloseTabsBelow}
                    onResetTabName={onResetTabName}
                    onOpenMenu={onOpenMenu}
                />
            ))}
            {!isLastTab && (
                // Thin separator between tab groups so the bar reads
                // as "panes grouped by tab" instead of one flat list.
                <div className="mx-3 my-1 h-px bg-fg-overlay-1" aria-hidden />
            )}
        </>
    );
}

interface VPaneWrapperProps {
    tabId: string;
    blockId: string;
    active: boolean;
    isReordering: boolean;
    hoverResetVersion: number;
    viewMode: VtabViewMode;
    primaryInfo: VtabPrimaryInfo;
    compactSubtitle: VtabCompactSubtitle;
    showDiffStats: boolean;
    // Position info for the tab the pane belongs to — propagated
    // through so the pane's context menu can show the same
    // Move/Close-others items the tab menu does.
    tabIndex: number;
    totalTabs: number;
    onClick: () => void;
    onClose: () => void;
    onHoverChanged: (isHovered: boolean) => void;
    matchesQuery: (item: VTabItem) => boolean;
    onReportMatched: (key: string, matched: boolean) => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    onCloseOtherTabs?: () => void;
    onCloseTabsBelow?: () => void;
    onResetTabName: () => void;
    onOpenMenu: (
        items: VtabMenuItem[],
        position: { x: number; y: number } | { anchorRect: DOMRect },
        toggleKey?: string
    ) => void;
}

// VPaneWrapper — one row per block in Panes mode (warp's
// VerticalTabsDisplayGranularity::Panes; see vertical_tabs.rs
// 1546-1761 for the parallel rendering branch).  Subscribes to the
// block's own data and derives its title/icon from `block.meta.view`,
// rather than reusing the parent tab's name like VTabWrapper does.
function VPaneWrapper({
    tabId,
    blockId,
    active,
    isReordering,
    hoverResetVersion,
    viewMode,
    primaryInfo,
    compactSubtitle,
    showDiffStats,
    tabIndex,
    totalTabs,
    onClick,
    onClose,
    onHoverChanged,
    matchesQuery,
    onReportMatched,
    onMoveUp,
    onMoveDown,
    onCloseOtherTabs,
    onCloseTabsBelow,
    onResetTabName,
    onOpenMenu,
}: VPaneWrapperProps) {
    const env = useWaveEnv<VTabBarEnv>();
    const [block] = env.wos.useWaveObjectValue<Block>(makeORef("block", blockId));
    const [tabData] = env.wos.useWaveObjectValue<Tab>(makeORef("tab", tabId));
    const tabCmdStore = TabCmdStateStore.getInstance();
    useEffect(() => {
        tabCmdStore.ensureSubscribed();
    }, []);
    const blockCmdState = useAtomValue(tabCmdStore.blockCmdStateAtom);
    const runningKind = getTabRunningKind([blockId], blockCmdState);

    const view = (block?.meta?.["view"] as string) || "";
    const cwd = (block?.meta?.["cmd:cwd"] as string) || "";
    const home = useMemo(() => {
        try {
            return getApi().getHomeDir() ?? "";
        } catch {
            return "";
        }
    }, []);
    const cwdShort = shortenHome(cwd, home);

    const [gitInfo, setGitInfo] = useState<GitInfoResponse | null>(null);
    useEffect(() => {
        if (!cwd) {
            setGitInfo(null);
            return;
        }
        return subscribeGitInfo(cwd, setGitInfo);
    }, [cwd]);
    const isRepo = !!gitInfo?.isrepo;
    const gitBranchName = isRepo ? gitInfo?.branch : undefined;

    // For terminal blocks: full 3-line warp layout (title + subtitle
    // + metadata).  For non-terminal blocks (preview/web/etc.) warp
    // uses a simpler 2-line layout (title + view-specific subtitle)
    // with no third metadata row.
    const fileLabel = getFileBackedBlockLabel(block?.meta);
    const webUrl = (block?.meta?.["url"] as string) || "";
    const isCompact = viewMode === "compact";

    let primaryName: string;
    let expandedSubtitle = "";
    let compactLineTwo = "";
    let metadataLeftKind: "branch" | "workingdir" | undefined;
    let metadataLeftValue: string | undefined;

    if (view === "term" || view === "termblocks") {
        const commandText = cwdShort || "Terminal";
        const workingDirectoryText = cwdShort || "Terminal";
        if (primaryInfo === "workingdir") {
            primaryName = workingDirectoryText;
            expandedSubtitle = commandText;
            metadataLeftKind = "branch";
            metadataLeftValue = gitBranchName;
        } else if (primaryInfo === "branch") {
            primaryName = gitBranchName || workingDirectoryText;
            expandedSubtitle = commandText;
            metadataLeftKind = "workingdir";
            metadataLeftValue = workingDirectoryText;
        } else {
            primaryName = commandText;
            expandedSubtitle = workingDirectoryText;
            metadataLeftKind = "branch";
            metadataLeftValue = gitBranchName;
        }
        switch (compactSubtitle) {
            case "command":
                compactLineTwo = commandText;
                break;
            case "workingdir":
                compactLineTwo = workingDirectoryText;
                break;
            case "branch":
                compactLineTwo = gitBranchName || "";
                break;
            default:
                compactLineTwo = "";
        }
    } else if (fileLabel) {
        primaryName = fileLabel.basename || fileLabel.fallbackTitle;
        expandedSubtitle = fileLabel.path !== fileLabel.basename ? fileLabel.path : "";
        compactLineTwo = ""; // non-terminal panes have no compact-subtitle setting
    } else if (view === "web") {
        primaryName = webUrl || blockViewToName(view) || "Web";
        expandedSubtitle = "";
    } else {
        primaryName = blockViewToName(view) || "Block";
        expandedSubtitle = "";
    }

    const rawFlagColor = (tabData?.meta?.["tab:flagcolor"] as string | undefined) ?? null;
    const flagColor = useResolvedTabFlagColor(rawFlagColor);

    const tab: VTabItem = {
        id: blockId,
        name: primaryName,
        flagColor,
        subtitle: isCompact ? compactLineTwo : expandedSubtitle,
        metadataLeftKind: isCompact ? undefined : metadataLeftKind,
        metadataLeftValue: isCompact ? undefined : metadataLeftValue,
        gitAdds: !isCompact && isRepo && showDiffStats ? gitInfo?.additions : undefined,
        gitDels: !isCompact && isRepo && showDiffStats ? gitInfo?.deletions : undefined,
        gitChangedFiles:
            !isCompact && isRepo && showDiffStats ? gitInfo?.changedfiles : undefined,
        runningKind,
        iconName: blockViewToUIcon(view),
    };

    const matched = matchesQuery(tab);
    // Match key namespaced under the parent tab id so a search that
    // matches one pane keeps the tab visible even when other panes
    // under the same tab don't match — preserves the "search any pane,
    // tab stays alive" expectation when many panes share a tab.
    const matchKey = `${tabId}:${blockId}`;
    useEffect(() => {
        onReportMatched(matchKey, matched);
        return () => onReportMatched(matchKey, false);
    }, [matchKey, matched, onReportMatched]);

    // Pane right-click menu — same warp section structure as the tab
    // menu, but with the "Copy pane title" label (isPanesMode=true).
    // The parent tab still owns Move / Close-others / Reset-name
    // semantics since panes don't have an independent ordering or
    // identity beyond their block.
    const paneRenameRef = useRef<(() => void) | null>(null);
    const tabIsAutoNamed = isTabAutoNamed(tabData);
    const paneMenuParams = useMemo(
        () => ({
            id: tabId,
            renameRef: paneRenameRef,
            env,
            tabTitle: primaryName,
            hasCustomName: !tabIsAutoNamed,
            cwd,
            gitBranch: gitBranchName,
            isPanesMode: true,
            tabIndex,
            totalTabs,
            isVerticalTabs: true,
            onCloseTab: onClose,
            onCloseOtherTabs,
            onCloseTabsBelow,
            onMoveUp,
            onMoveDown,
            onResetTabName,
        }),
        [
            tabId,
            env,
            primaryName,
            tabIsAutoNamed,
            cwd,
            gitBranchName,
            tabIndex,
            totalTabs,
            onClose,
            onCloseOtherTabs,
            onCloseTabsBelow,
            onMoveUp,
            onMoveDown,
            onResetTabName,
        ]
    );
    const handlePaneContextMenu = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            e.preventDefault();
            e.stopPropagation();
            const items = buildVtabMenuItems(paneMenuParams);
            onOpenMenu(items, { x: e.clientX, y: e.clientY });
        },
        [paneMenuParams, onOpenMenu]
    );
    const handlePaneMoreClick = useCallback(
        (e: React.MouseEvent<HTMLButtonElement>) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const items = buildVtabMenuItems(paneMenuParams);
            // Per-pane toggleKey — see VTabWrapper for the rationale.
            onOpenMenu(items, { anchorRect: rect }, `kebab:pane:${tabId}:${blockId}`);
        },
        [paneMenuParams, onOpenMenu, tabId, blockId]
    );

    if (!matched) {
        return null;
    }

    // Drag/drop is disabled in Panes mode — reordering blocks across
    // tabs isn't a meaningful operation yet, so we hand stub no-op
    // handlers to VTab.  Renaming is also disabled (blocks don't have
    // a user-rename concept in crest today).
    const noopDrag = () => {};

    return (
        <VTab
            tab={tab}
            active={active}
            viewMode={viewMode}
            isDragging={false}
            isReordering={isReordering}
            hoverResetVersion={hoverResetVersion}
            onSelect={onClick}
            onClose={onClose}
            onContextMenu={handlePaneContextMenu}
            onMoreButtonClick={handlePaneMoreClick}
            onDragStart={noopDrag}
            onDragOver={noopDrag}
            onDrop={noopDrag}
            onDragEnd={noopDrag}
            onHoverChanged={onHoverChanged}
        />
    );
}

interface ControlBarProps {
    query: string;
    onQueryChange: (q: string) => void;
    onNewTab: () => void;
    onSettingsClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    settingsActive: boolean;
}

function ControlBar({ query, onQueryChange, onNewTab, onSettingsClick, settingsActive }: ControlBarProps) {
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
                    className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-secondary/50"
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
            <Tooltip content="View options" placement="bottom" divClassName="shrink-0">
                <button
                    type="button"
                    onClick={onSettingsClick}
                    aria-label="View options"
                    aria-pressed={settingsActive}
                    className={cn(
                        "flex h-6 w-6 cursor-pointer items-center justify-center rounded transition-colors",
                        settingsActive
                            ? "bg-fg-overlay-3 text-foreground"
                            : "text-secondary hover:bg-fg-overlay-2 hover:text-foreground"
                    )}
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

    // View-mode settings — single subscription per setting at the bar
    // level keeps each row from spinning up its own atom subscription.
    const granularity =
        (useAtomValue(getSettingsKeyAtom("vtab:granularity")) as VtabGranularity) || DefaultGranularity;
    const viewMode =
        (useAtomValue(getSettingsKeyAtom("vtab:viewmode")) as VtabViewMode) || DefaultViewMode;
    const primaryInfo =
        (useAtomValue(getSettingsKeyAtom("vtab:primaryinfo")) as VtabPrimaryInfo) || DefaultPrimaryInfo;
    const compactSubtitle = resolveCompactSubtitle(
        primaryInfo,
        (useAtomValue(getSettingsKeyAtom("vtab:compactsubtitle")) as VtabCompactSubtitle) ||
            "workingdir"
    );
    const showDiffStats =
        useAtomValue(getSettingsKeyAtom("vtab:showdiffstats")) ?? DefaultShowDiffStats;
    const showDetailsOnHover =
        useAtomValue(getSettingsKeyAtom("vtab:showdetailsonhover")) ?? DefaultShowDetailsOnHover;

    const [orderedTabIds, setOrderedTabIds] = useState<string[]>(tabIds);
    const [dragTabId, setDragTabId] = useState<string | null>(null);
    const [dropIndex, setDropIndex] = useState<number | null>(null);
    const [dropLineTop, setDropLineTop] = useState<number | null>(null);
    const [hoverResetVersion, setHoverResetVersion] = useState(0);
    const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);
    // Panes-mode only: which specific block is under the cursor.
    // Drives both the DOM anchor lookup (pane rows expose blockId in
    // data-tabid) and the sidecar's block-level content.
    const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [matchedSet, setMatchedSet] = useState<Set<string>>(new Set());
    // Active block id for the *currently active* tab.  Used in Panes
    // mode to mark exactly one pane row as active per tab — without
    // this, every pane in the active tab would highlight.  Re-subscribes
    // on tab switch (the layout model is per-tab and changes with it).
    const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
    useEffect(() => {
        const layoutModel = getLayoutModelForStaticTab();
        if (!layoutModel) {
            setFocusedBlockId(null);
            return;
        }
        const sync = () => {
            const node = globalStore.get(layoutModel.focusedNode);
            setFocusedBlockId(node?.data?.blockId ?? null);
        };
        sync();
        return globalStore.sub(layoutModel.focusedNode, sync);
    }, [activeTabId]);
    const [settingsAnchorRect, setSettingsAnchorRect] = useState<DOMRect | null>(null);
    // Debounce reopen after the popover's outside-click handler already
    // closed it.  Without this, clicking the gear while open would: (1)
    // popover mousedown listener closes; (2) click handler reopens.  Same
    // pattern as the kebab "..." menu just above.
    const settingsClosedAtRef = useRef<number>(0);
    // Single open-menu state shared by every row's right-click and
    // kebab handler.  `toggleKey` is set by kebab callers (per-row
    // unique) so a second click on the SAME kebab dismisses the menu
    // instead of reopening it — right-click handlers don't pass a
    // key, so right-clicking different rows always swaps the menu.
    const [openMenu, setOpenMenu] = useState<
        | {
              items: VtabMenuItem[];
              position: { x: number; y: number } | { anchorRect: DOMRect };
              toggleKey?: string;
          }
        | null
    >(null);
    const handleOpenMenu = useCallback(
        (
            items: VtabMenuItem[],
            position: { x: number; y: number } | { anchorRect: DOMRect },
            toggleKey?: string
        ) => {
            setOpenMenu((current) => {
                if (toggleKey && current?.toggleKey === toggleKey) {
                    return null;
                }
                return { items, position, toggleKey };
            });
        },
        []
    );
    // Detail sidecar — pinned tab id + cached rect so the sidecar
    // keeps rendering against the right edge of the hovered row even
    // when the row briefly loses CSS :hover during cursor transit.
    // `detailBlockId` is populated in panes mode so the sidecar can
    // show block-specific content (cwd, view, git for that block).
    const [detailTabId, setDetailTabId] = useState<string | null>(null);
    const [detailBlockId, setDetailBlockId] = useState<string | null>(null);
    const [detailAnchorRect, setDetailAnchorRect] = useState<DOMRect | null>(null);
    const detailLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const sidecarHoverRef = useRef(false);
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

    const handleReportMatched = useCallback((tabId: string, matched: boolean) => {
        setMatchedSet((prev) => {
            const has = prev.has(tabId);
            if (matched && has) return prev;
            if (!matched && !has) return prev;
            const next = new Set(prev);
            if (matched) {
                next.add(tabId);
            } else {
                next.delete(tabId);
            }
            return next;
        });
    }, []);

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

    // Swap a tab with its immediate neighbor.  Used by the right-click
    // "Move Tab Up / Down" items (warp's `MoveTabRight`/`MoveTabLeft`
    // actions — labels swap by orientation in the menu builder).
    const swapWithNeighbor = useCallback(
        (sourceIndex: number, neighborIndex: number) => {
            if (
                sourceIndex < 0 ||
                neighborIndex < 0 ||
                sourceIndex >= orderedTabIds.length ||
                neighborIndex >= orderedTabIds.length
            ) {
                return;
            }
            const next = [...orderedTabIds];
            [next[sourceIndex], next[neighborIndex]] = [next[neighborIndex], next[sourceIndex]];
            setOrderedTabIds(next);
            fireAndForget(() =>
                env.rpc.UpdateWorkspaceTabIdsCommand(TabRpcClient, workspace.oid, next)
            );
        },
        [orderedTabIds, env, workspace.oid]
    );

    // Bulk close helpers used by "Close other tabs" / "Close Tabs Below".
    // Closes are issued in parallel via env.electron.closeTab so the
    // user sees the panel collapse atomically; failures (e.g. a tab
    // refuses close via a save prompt) are surfaced by the electron
    // side itself.
    const closeTabsByIds = useCallback(
        (ids: string[]) => {
            for (const id of ids) {
                fireAndForget(() => env.electron.closeTab(workspace.oid, id, false));
            }
        },
        [env, workspace.oid]
    );

    const handleTabBarContextMenu = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            e.preventDefault();
            const menu = buildTabBarContextMenu(env);
            env.showContextMenu(menu, e);
        },
        [env]
    );

    // Warp's settings button toggles a rich view-options popover
    // (render_settings_popup, vertical_tabs.rs 4565-4952).  We track the
    // anchor rect rather than open/close as a boolean so the popover can
    // re-anchor if the button moves (window resize while open).
    const handleSettingsClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
        const SettingsToggleMs = 200;
        if (Date.now() - settingsClosedAtRef.current < SettingsToggleMs) {
            return;
        }
        const rect = e.currentTarget.getBoundingClientRect();
        setSettingsAnchorRect(rect);
    }, []);

    const handleSettingsClose = useCallback(() => {
        settingsClosedAtRef.current = Date.now();
        setSettingsAnchorRect(null);
    }, []);

    // Sidecar lifecycle — driven off hoveredTabId, gated by the
    // "Show details on hover" setting.  We grant a 120ms grace period
    // after the row loses hover so the cursor can travel into the
    // sidecar (warp uses a SafeTriangle; the grace period is the
    // poor-man's equivalent and feels fine in practice).
    const scheduleDetailDismiss = useCallback(() => {
        if (detailLeaveTimerRef.current != null) {
            clearTimeout(detailLeaveTimerRef.current);
        }
        detailLeaveTimerRef.current = setTimeout(() => {
            if (!sidecarHoverRef.current) {
                setDetailTabId(null);
                setDetailBlockId(null);
                setDetailAnchorRect(null);
            }
            detailLeaveTimerRef.current = null;
        }, 120);
    }, []);

    const cancelDetailDismiss = useCallback(() => {
        if (detailLeaveTimerRef.current != null) {
            clearTimeout(detailLeaveTimerRef.current);
            detailLeaveTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        if (!showDetailsOnHover) {
            cancelDetailDismiss();
            setDetailTabId(null);
            setDetailBlockId(null);
            setDetailAnchorRect(null);
            return;
        }
        if (hoveredTabId == null) {
            scheduleDetailDismiss();
            return;
        }
        cancelDetailDismiss();
        // DOM rows expose `data-tabid` = tab.id from the VTabItem.  In
        // Tabs mode that's the parent tab's id; in Panes mode it's the
        // block id (VPaneWrapper builds the item with id = blockId).
        // So the lookup key is whichever id maps to the hovered row.
        const lookupId = hoveredBlockId ?? hoveredTabId;
        const el = scrollContainerRef.current?.querySelector<HTMLDivElement>(
            `[data-tabid="${lookupId}"]`
        );
        if (el != null) {
            setDetailTabId(hoveredTabId);
            setDetailBlockId(hoveredBlockId);
            setDetailAnchorRect(el.getBoundingClientRect());
        }
    }, [hoveredTabId, hoveredBlockId, showDetailsOnHover, scheduleDetailDismiss, cancelDetailDismiss]);

    const handleSidecarEnter = useCallback(() => {
        sidecarHoverRef.current = true;
        cancelDetailDismiss();
    }, [cancelDetailDismiss]);

    const handleSidecarLeave = useCallback(() => {
        sidecarHoverRef.current = false;
        scheduleDetailDismiss();
    }, [scheduleDetailDismiss]);

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
                settingsActive={settingsAnchorRect != null}
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
                {granularity === "panes"
                    ? orderedTabIds.map((tabId, index) => (
                          <VPaneGroup
                              key={tabId}
                              tabId={tabId}
                              activeTabId={activeTabId}
                              focusedBlockId={focusedBlockId}
                              isLastTab={index === orderedTabIds.length - 1}
                              workspaceId={workspace.oid}
                              tabIndex={index}
                              totalTabs={orderedTabIds.length}
                              isReordering={dragTabId != null}
                              hoverResetVersion={hoverResetVersion}
                              viewMode={viewMode}
                              primaryInfo={primaryInfo}
                              compactSubtitle={compactSubtitle}
                              showDiffStats={showDiffStats}
                              matchesQuery={matchesQuery}
                              onPaneHoverChanged={(hoveredTab, hoveredBlock, isHovered) => {
                                  setHoveredTabId(isHovered ? hoveredTab : null);
                                  setHoveredBlockId(isHovered ? hoveredBlock : null);
                              }}
                              onReportMatched={handleReportMatched}
                              onMoveUp={index > 0 ? () => swapWithNeighbor(index, index - 1) : undefined}
                              onMoveDown={
                                  index < orderedTabIds.length - 1
                                      ? () => swapWithNeighbor(index, index + 1)
                                      : undefined
                              }
                              onCloseOtherTabs={
                                  orderedTabIds.length > 1
                                      ? () =>
                                            closeTabsByIds(orderedTabIds.filter((id) => id !== tabId))
                                      : undefined
                              }
                              onCloseTabsBelow={
                                  index < orderedTabIds.length - 1
                                      ? () => closeTabsByIds(orderedTabIds.slice(index + 1))
                                      : undefined
                              }
                              onResetTabName={() => fireAndForget(() => resetVTabName(env, tabId, ""))}
                              onOpenMenu={handleOpenMenu}
                          />
                      ))
                    : orderedTabIds.map((tabId, index) => {
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
                                  totalTabs={orderedTabIds.length}
                                  viewMode={viewMode}
                                  primaryInfo={primaryInfo}
                                  compactSubtitle={compactSubtitle}
                                  showDiffStats={showDiffStats}
                                  matchesQuery={matchesQuery}
                                  onSelect={() => env.electron.setActiveTab(tabId)}
                                  onClose={() =>
                                      fireAndForget(() => env.electron.closeTab(workspace.oid, tabId, false))
                                  }
                                  onRename={(newName) =>
                                      fireAndForget(() =>
                                          env.rpc.UpdateTabNameCommand(TabRpcClient, tabId, newName)
                                      )
                                  }
                                  onMoveUp={index > 0 ? () => swapWithNeighbor(index, index - 1) : undefined}
                                  onMoveDown={
                                      index < orderedTabIds.length - 1
                                          ? () => swapWithNeighbor(index, index + 1)
                                          : undefined
                                  }
                                  onCloseOtherTabs={
                                      orderedTabIds.length > 1
                                          ? () =>
                                                closeTabsByIds(
                                                    orderedTabIds.filter((id) => id !== tabId)
                                                )
                                          : undefined
                                  }
                                  onCloseTabsBelow={
                                      index < orderedTabIds.length - 1
                                          ? () => closeTabsByIds(orderedTabIds.slice(index + 1))
                                          : undefined
                                  }
                                  onResetTabName={() => fireAndForget(() => resetVTabName(env, tabId, ""))}
                                  onOpenMenu={handleOpenMenu}
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
                                              : event.currentTarget.offsetTop +
                                                    event.currentTarget.offsetHeight
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
                                  onHoverChanged={(isHovered) => {
                                      setHoveredTabId(isHovered ? tabId : null);
                                      // No block-level row in Tabs mode;
                                      // clearing keeps the sidecar's
                                      // lookup keyed on tabId only.
                                      setHoveredBlockId(null);
                                  }}
                                  onReportMatched={handleReportMatched}
                              />
                          );
                      })}
                {orderedTabIds.length === 0 && (
                    <div className="px-4 py-3 text-[15px] text-secondary/80 italic">No tabs open</div>
                )}
                {orderedTabIds.length > 0 && normalizedQuery.length > 0 && matchedSet.size === 0 && (
                    <div className="px-4 py-3 text-[15px] text-secondary/80 italic">
                        {granularity === "panes"
                            ? "No panes match your search."
                            : "No tabs match your search."}
                    </div>
                )}
                {dragTabId != null && dropIndex != null && dropLineTop != null && dragReorderEnabled && (
                    <div
                        className="pointer-events-none absolute left-2 right-2 border-t-2 border-accent/80"
                        style={{ top: dropLineTop, transform: "translateY(-1px)" }}
                    />
                )}
            </div>
            {settingsAnchorRect && (
                <VtabSettingsPopover
                    anchorRect={settingsAnchorRect}
                    onClose={handleSettingsClose}
                />
            )}
            {openMenu && (
                <VtabContextMenu
                    items={openMenu.items}
                    position={openMenu.position}
                    onClose={() => setOpenMenu(null)}
                />
            )}
            {/* Detail sidecar — works in both Tabs and Panes mode now.
                In Panes mode `detailBlockId` is set, so the sidecar
                pulls the hovered pane's own data instead of falling
                back to the tab's first block. */}
            {showDetailsOnHover && detailTabId && detailAnchorRect && (
                <VtabDetailSidecar
                    tabId={detailTabId}
                    blockId={detailBlockId}
                    anchorRect={detailAnchorRect}
                    onPointerEnter={handleSidecarEnter}
                    onPointerLeave={handleSidecarLeave}
                />
            )}
        </div>
    );
}
