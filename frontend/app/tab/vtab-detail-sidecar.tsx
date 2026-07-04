// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UIcon } from "@/app/element/ui-icon";
import { getApi } from "@/app/store/global";
import { TabCmdStateStore, getTabRunningKind, type AgentKind } from "@/app/store/tabcmdstate";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { cn, fireAndForget } from "@/util/util";
import { FloatingPortal } from "@floating-ui/react";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { getFileBackedBlockLabel, isTabAutoNamed, type FileBackedBlockLabel } from "./vtab-file-label";
import type { VTabBarEnv } from "./vtabbarenv";
import { isTabAutoNamed } from "./tab-name";

// Mirrors `render_detail_sidecar` (warp vertical_tabs.rs 5874-6033) —
// a ~320px right-anchored panel that fills in metadata for the row the
// cursor is currently over.  We don't replicate the full warp inventory
// (per-pane breakdowns, Warp Drive sections), just the parts that map
// onto crest's per-tab data: name, cwd, git, agent status.
const SidecarWidth = 320;
const SidecarMaxHeight = 420;
const GapToRow = 8;

const AgentLabels: Record<AgentKind, string> = {
    claude: "Claude Code",
    codex: "Codex",
    ai: "AI agent",
    generic: "Command",
};

function shortenHome(cwd: string, home: string): string {
    if (!cwd) return "";
    if (home && cwd === home) return "~";
    if (home && cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
    return cwd;
}

interface VtabDetailSidecarProps {
    tabId: string;
    blockId?: string | null;
    anchorRect: DOMRect;
    onPointerEnter: () => void;
    onPointerLeave: () => void;
}

// blockViewToUIcon — duplicated here (rather than imported from
// vtabbar.tsx) to keep this component standalone and avoid a circular
// dep.  Stays in sync with the version in vtabbar.tsx; both pull from
// the same crest UIcon name set.
function blockViewToUIcon(view: string): string {
    switch (view) {
        case "term":
        case "termblocks":
            return "terminal";
        case "preview":
        case "codeeditor":
            return "file";
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

export function resolveVtabDetailHeaderTitle({
    isPaneMode,
    isAutoNamed,
    tabName,
    cwdShort,
    fileLabel,
    view,
    webUrl,
}: {
    isPaneMode: boolean;
    isAutoNamed: boolean;
    tabName: string;
    cwdShort: string;
    fileLabel: FileBackedBlockLabel | null;
    view: string;
    webUrl: string;
}): string {
    if (!isPaneMode) {
        return (
            (isAutoNamed && (fileLabel?.basename || fileLabel?.fallbackTitle)) ||
            (!isAutoNamed && tabName) ||
            cwdShort ||
            "Terminal"
        );
    }
    if (view === "term" || view === "termblocks" || view === "") {
        return cwdShort || (!isAutoNamed && tabName) || "Terminal";
    }
    if (fileLabel) {
        return fileLabel.basename || fileLabel.fallbackTitle;
    }
    if (view === "web") {
        return webUrl || "Web";
    }
    return viewToName(view);
}

function viewToName(view: string): string {
    switch (view) {
        case "term":
        case "termblocks":
            return "Terminal";
        case "preview":
            return "Preview";
        case "codeeditor":
            return "Code editor";
        case "web":
            return "Web";
        case "help":
            return "Help";
        case "tips":
            return "Tips";
        case "processviewer":
            return "Processes";
        case "sysinfo":
        case "cpuplot":
            return "System info";
        case "waveconfig":
            return "Settings";
        case "vdom":
            return "VDOM";
        case "tsunami":
            return "Tsunami";
        default:
            return view || "Block";
    }
}

export function VtabDetailSidecar({
    tabId,
    blockId,
    anchorRect,
    onPointerEnter,
    onPointerLeave,
}: VtabDetailSidecarProps) {
    const env = useWaveEnv<VTabBarEnv>();
    const [tabData] = env.wos.useWaveObjectValue<Tab>(makeORef("tab", tabId));

    // Pane-mode source-of-truth.  When the parent passed a blockId, we
    // anchor every per-block field (icon, cwd, git, running-kind) to
    // that exact block.  Otherwise we fall back to the tab's first
    // block, matching the original Tabs-mode behavior — second block
    // acts as a cwd-fallback for those edge cases where the first
    // block doesn't have shell integration populated yet.
    const firstBlockId = tabData?.blockids?.[0];
    const secondBlockId = tabData?.blockids?.[1];
    const effectiveBlockId = blockId ?? firstBlockId ?? null;
    const [effectiveBlock] = env.wos.useWaveObjectValue<Block>(
        effectiveBlockId ? makeORef("block", effectiveBlockId) : null
    );
    const [fallbackBlock] = env.wos.useWaveObjectValue<Block>(
        // Only used in Tabs mode for the cwd fallback chain.  In panes
        // mode we trust the chosen block — there's no point reaching
        // into a sibling.
        blockId == null && secondBlockId ? makeORef("block", secondBlockId) : null
    );
    const cwd = (effectiveBlock?.meta?.["cmd:cwd"] as string) || (fallbackBlock?.meta?.["cmd:cwd"] as string) || "";
    const view = (effectiveBlock?.meta?.["view"] as string) || "";
    const fileLabel = getFileBackedBlockLabel(effectiveBlock?.meta);
    const webUrl = (effectiveBlock?.meta?.["url"] as string) || "";

    const home = useMemo(() => {
        try {
            return getApi().getHomeDir() ?? "";
        } catch {
            return "";
        }
    }, []);
    const cwdShort = shortenHome(cwd, home);

    const tabCmdStore = TabCmdStateStore.getInstance();
    useEffect(() => {
        tabCmdStore.ensureSubscribed();
    }, []);
    const blockCmdState = useAtomValue(tabCmdStore.blockCmdStateAtom);
    // In panes mode "is anything running" is a single-block question;
    // in tabs mode we keep the existing "any block in this tab is
    // running" semantics so the indicator matches the row's badge.
    const runningKind = getTabRunningKind(blockId ? [blockId] : (tabData?.blockids ?? []), blockCmdState);

    const [gitInfo, setGitInfo] = useState<GitInfoResponse | null>(null);
    useEffect(() => {
        if (!cwd) {
            setGitInfo(null);
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const info = await RpcApi.GetGitInfoCommand(TabRpcClient, cwd);
                if (!cancelled) setGitInfo(info ?? null);
            } catch {
                if (!cancelled) setGitInfo(null);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [cwd]);

    // Anchor at the right edge of the hovered row.  Clamp inside the
    // viewport on the right so the sidecar never disappears off-screen
    // for wide window setups.  Bottom-clamping mirrors warp's height
    // ceiling — the sidecar grows up to 420px and scrolls past that.
    const top = Math.min(Math.max(8, anchorRect.top - 4), window.innerHeight - SidecarMaxHeight - 8);
    const left = Math.min(anchorRect.right + GapToRow, window.innerWidth - SidecarWidth - 8);

    const isRepo = !!gitInfo?.isrepo;
    const branch = gitInfo?.branch ?? "";
    const adds = gitInfo?.additions ?? 0;
    const dels = gitInfo?.deletions ?? 0;
    const changedFiles = gitInfo?.changedfiles ?? 0;

    const tabName = tabData?.name ?? "";
    const isAutoNamed = isTabAutoNamed(tabData);
    const blockCount = tabData?.blockids?.length ?? 0;
    const isPaneMode = blockId != null;

    // Header title — when anchored to a specific pane, use the pane's
    // view-specific label (cwd, file basename, URL) and surface the
    // parent tab name in the footer.  In Tabs mode we keep the
    // original "tab name → first block cwd → 'Terminal'" cascade.
    let headerIcon = "terminal";
    const headerTitle = resolveVtabDetailHeaderTitle({
        isPaneMode,
        isAutoNamed,
        tabName,
        cwdShort,
        fileLabel,
        view,
        webUrl,
    });
    if (isPaneMode) {
        headerIcon = blockViewToUIcon(view);
    }

    // FloatingPortal escapes the VTabBar's backdrop-filter stacking
    // context so the sidecar can overlay the file-explorer panel and
    // any other workspace children to its right.
    return (
        <FloatingPortal>
            <div
                role="dialog"
                aria-label="Tab details"
                onMouseEnter={onPointerEnter}
                onMouseLeave={onPointerLeave}
                className={cn(
                    "fixed z-40 flex flex-col gap-3 overflow-hidden rounded-md border border-fg-overlay-2 bg-background p-3",
                    "shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
                )}
                style={{ top, left, width: SidecarWidth, maxHeight: SidecarMaxHeight }}
            >
                <div className="flex items-center gap-2">
                    <UIcon name={headerIcon} size={16} className="text-secondary" />
                    <div className="flex min-w-0 flex-1 flex-col">
                        <div className="truncate text-[15px] font-medium text-foreground" title={headerTitle}>
                            {headerTitle}
                        </div>
                        {/* In panes mode, surface the parent tab name on a
                        second line so the user can still see which tab
                        this pane belongs to. */}
                        {isPaneMode && !isAutoNamed && tabName && (
                            <div className="truncate text-[12px] text-secondary" title={tabName}>
                                in {tabName}
                            </div>
                        )}
                    </div>
                    {runningKind && (
                        <span className="inline-flex items-center gap-1 rounded bg-fg-overlay-2 px-1.5 py-0.5 text-[12px] uppercase tracking-wide text-secondary">
                            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                            {AgentLabels[runningKind]}
                        </span>
                    )}
                </div>

                {/* Panes mode: surface the view type as a small chip — gives
                the user a clear signal that the sidecar is anchored to
                this specific pane, not just the parent tab. */}
                {isPaneMode && view && view !== "term" && view !== "termblocks" && (
                    <div className="flex flex-col gap-1">
                        <div className="text-[12px] uppercase tracking-wide text-secondary">View</div>
                        <div className="text-[15px] text-foreground">{viewToName(view)}</div>
                    </div>
                )}

                {isPaneMode && fileLabel && (
                    <div className="flex flex-col gap-1">
                        <div className="text-[12px] uppercase tracking-wide text-secondary">File</div>
                        <div
                            className="overflow-hidden text-ellipsis whitespace-nowrap text-[15px] text-foreground"
                            title={fileLabel.path}
                        >
                            {fileLabel.path}
                        </div>
                    </div>
                )}

                {isPaneMode && view === "web" && webUrl && (
                    <div className="flex flex-col gap-1">
                        <div className="text-[12px] uppercase tracking-wide text-secondary">URL</div>
                        <div
                            className="overflow-hidden text-ellipsis whitespace-nowrap text-[15px] text-foreground"
                            title={webUrl}
                        >
                            {webUrl}
                        </div>
                    </div>
                )}

                {cwd && (
                    <div className="flex flex-col gap-1">
                        <div className="text-[12px] uppercase tracking-wide text-secondary">Working directory</div>
                        <div
                            className="overflow-hidden text-ellipsis whitespace-nowrap text-[15px] text-foreground"
                            title={cwd}
                        >
                            {cwdShort}
                        </div>
                    </div>
                )}

                {isRepo && (
                    <div className="flex flex-col gap-1">
                        <div className="text-[12px] uppercase tracking-wide text-secondary">Git</div>
                        <div className="flex items-center gap-2 text-[15px] text-foreground">
                            <UIcon name="git-branch-02" size={12} className="text-secondary" />
                            <span className="truncate">{branch || "(no branch)"}</span>
                        </div>
                        {(adds > 0 || dels > 0 || changedFiles > 0) && (
                            <div className="flex items-center gap-3 text-[13px] tabular-nums text-secondary">
                                {changedFiles > 0 && (
                                    <span>
                                        {changedFiles} file{changedFiles === 1 ? "" : "s"}
                                    </span>
                                )}
                                {adds > 0 && <span style={{ color: "var(--color-add-strong)" }}>+{adds}</span>}
                                {dels > 0 && <span style={{ color: "var(--color-remove-strong)" }}>−{dels}</span>}
                            </div>
                        )}
                    </div>
                )}

                <div className="flex items-center gap-3 border-t border-fg-overlay-1 pt-2 text-[13px] text-secondary">
                    <span>
                        {blockCount} block{blockCount === 1 ? "" : "s"}
                    </span>
                    <span className="opacity-60">·</span>
                    <span className="truncate" title={isPaneMode && effectiveBlockId ? effectiveBlockId : tabId}>
                        {(isPaneMode && effectiveBlockId ? effectiveBlockId : tabId).slice(0, 8)}…
                    </span>
                </div>
            </div>
        </FloatingPortal>
    );
}
