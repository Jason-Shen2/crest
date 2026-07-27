// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { workspaceDirAtom } from "@/app/fileexplorer/file-explorer-atoms";
import { getFileIcon } from "@/app/fileexplorer/file-icon";
import { Icon } from "@/app/icon/Icon";
import { useWorkspaceTopTabController } from "@/app/workspace/top-tab-controller-context";
import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SourceControlFileEntry, SourceControlModel } from "./source-control-model";
import { CommitGraphPanel } from "./commit-graph-panel";
import type { OpenGitDiffTabInput } from "./open-git-diff-tab";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const ROW_HEIGHTS = {
    banner: 32,
    header: 30,
    entry: 30,
} as const;

type RowDescriptor =
    | { kind: "banner-diverged"; key: string }
    | { kind: "list-header"; key: string; count: number }
    | { kind: "entry"; key: string; entry: SourceControlFileEntry };

function basename(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : path;
}

function dirname(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    const index = normalized.lastIndexOf("/");
    if (index <= 0) return "";
    return normalized.slice(0, index);
}

function entryPathLabel(entry: SourceControlFileEntry): string {
    if (entry.originalpath) return `${entry.originalpath} → ${entry.path}`;
    return dirname(entry.path);
}

function upstreamBadgeLabel(upstream: string | null | undefined): string {
    if (!upstream) return "No upstream";
    return upstream;
}

function statusAccent(code: string): string {
    switch (code) {
        case "A":
            return "bg-emerald-500/85";
        case "U":
            return "bg-teal-500/85";
        case "M":
            return "bg-amber-500/85";
        case "D":
            return "bg-rose-500/85";
        case "R":
            return "bg-sky-500/85";
        default:
            return "bg-muted-foreground/40";
    }
}

const Tooltip = memo(({ label, children, side = "bottom", className }: { label: string; children: ReactNode; side?: "left" | "top" | "right" | "bottom"; className?: string }) => {
    const [show, setShow] = useState(false);
    const timeoutRef = useRef<number | null>(null);

    const showTooltip = () => {
        if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(() => setShow(true), 600);
    };
    const hideTooltip = () => {
        if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
        setShow(false);
    };

    useEffect(() => {
        return () => {
            if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
        };
    }, []);

    const posClass = side === "bottom" ? "top-full left-1/2 -translate-x-1/2 mt-1"
        : side === "top" ? "bottom-full left-1/2 -translate-x-1/2 mb-1"
        : side === "left" ? "right-full top-1/2 -translate-y-1/2 mr-1"
        : "left-full top-1/2 -translate-y-1/2 ml-1";

    return (
        <div className={cn("relative inline-flex", className)} onMouseEnter={showTooltip} onMouseLeave={hideTooltip}>
            {children}
            {show && (
                <div className={cn("pointer-events-none absolute z-[var(--zindex-modal-wrapper)] whitespace-nowrap rounded border border-border bg-background px-2 py-1 text-[10.5px] text-foreground shadow-lg shadow-black/30", posClass)}>
                    {label}
                </div>
            )}
        </div>
    );
});
Tooltip.displayName = "Tooltip";

function Spinner({ size = 12 }: { size?: number }) {
    return <Icon name="loading-03" size={size} spin className="text-muted-foreground" />;
}

function IconActionButton({
    label,
    disabled,
    side = "left",
    onClick,
    children,
}: {
    label: string;
    disabled?: boolean;
    side?: "left" | "top" | "right" | "bottom";
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <Tooltip label={label} side={side}>
            <button
                type="button"
                aria-label={label}
                disabled={disabled}
                onClick={onClick}
                className={cn(
                    "flex size-6 cursor-pointer items-center justify-center rounded-md p-0 text-muted-foreground transition-colors hover:bg-fg-overlay-2 hover:text-foreground",
                    "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                )}
            >
                {children}
            </button>
        </Tooltip>
    );
}

function Checkbox({ checked, disabled, onChange }: { checked: boolean | "indeterminate"; disabled?: boolean; onChange: () => void }) {
    const isChecked = checked === true;
    const isIndeterminate = checked === "indeterminate";
    return (
        <button
            type="button"
            role="checkbox"
            aria-checked={isIndeterminate ? "mixed" : isChecked}
            disabled={disabled}
            onClick={onChange}
            className={cn(
                "flex size-[14px] shrink-0 cursor-pointer items-center justify-center rounded-[3px] border transition-all duration-100",
                isChecked || isIndeterminate
                    ? "border-accent bg-accent text-on-accent"
                    : "border-border bg-transparent hover:border-muted-foreground",
                "disabled:cursor-default disabled:opacity-40"
            )}
        >
            {isChecked ? (
                <Icon name="tick-02" size={10} strokeWidth={2.5} />
            ) : isIndeterminate ? (
                <span className="size-[6px] rounded-[1px] bg-current" />
            ) : null}
        </button>
    );
}

function BranchDropdown({
    repoLabel,
    onRefresh,
    actionBusy,
}: {
    repoLabel: string;
    onRefresh: () => void;
    actionBusy: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [branches, setBranches] = useState<GitBranchEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [checkingOut, setCheckingOut] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const requestRef = useRef(0);

    const loadBranches = useCallback(async () => {
        const model = SourceControlModel.getInstance();
        const id = ++requestRef.current;
        setLoading(true);
        try {
            const result = await model.listBranches();
            if (id !== requestRef.current) return;
            setBranches(result.branches);
        } catch (e) {
            if (id !== requestRef.current) return;
            setBranches([]);
        } finally {
            if (id === requestRef.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (open) {
            void loadBranches();
        }
    }, [open, loadBranches]);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [open]);

    const handleCheckout = useCallback(async (branch: string) => {
        const model = SourceControlModel.getInstance();
        setCheckingOut(true);
        try {
            await model.checkoutBranch(branch);
            setBranches([]);
            setOpen(false);
            onRefresh();
        } catch (e) {
            console.error("checkout failed:", e);
        } finally {
            setCheckingOut(false);
        }
    }, [onRefresh]);

    const localBranches = branches.filter((b) => b.kind === "local");
    const worktrees = branches.filter((b) => b.kind === "worktree");

    return (
        <div ref={containerRef} className="relative inline-block">
            <button
                type="button"
                disabled={checkingOut || actionBusy}
                onClick={() => setOpen(!open)}
                className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md bg-fg-overlay-1/60 px-2 py-1 text-[11.5px] font-medium leading-none text-foreground transition-colors hover:bg-fg-overlay-2 disabled:cursor-default disabled:opacity-70"
            >
                <Icon name="folder-git-two" size={12} strokeWidth={1.9} className="shrink-0 text-muted-foreground" />
                <span className="max-w-[8rem] truncate">{repoLabel}</span>
            </button>
            {open && (
                <div className="absolute left-0 top-full z-[var(--zindex-modal-wrapper)] mt-1 w-56 rounded-lg border border-border bg-background p-1 shadow-2xl">
                    {loading ? (
                        <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-muted-foreground">
                            <Spinner size={12} />
                            Loading branches
                        </div>
                    ) : (
                        <>
                            {localBranches.length > 0 && (
                                <>
                                    <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
                                        Local Branches
                                    </div>
                                    {localBranches.map((b) => (
                                        <button
                                            key={b.name}
                                            type="button"
                                            onClick={() => void handleCheckout(b.name)}
                                            className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-fg-overlay-2"
                                        >
                                            {b.ishead ? (
                                                <Icon name="tick-02" size={14} strokeWidth={1.8} className="shrink-0" />
                                            ) : (
                                                <span className="w-3.5 shrink-0" />
                                            )}
                                            <span className="min-w-0 flex-1 truncate">{b.name}</span>
                                        </button>
                                    ))}
                                </>
                            )}
                            {worktrees.length > 0 && (
                                <>
                                    {localBranches.length > 0 && <div className="my-1 h-px bg-border" />}
                                    <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
                                        Worktrees
                                    </div>
                                    {worktrees.map((b) => (
                                        <div
                                            key={b.worktreepath ?? b.name}
                                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] text-muted-foreground/70"
                                        >
                                            <Icon name="folder-01" size={14} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
                                            <div className="flex min-w-0 flex-col">
                                                <span className="truncate text-foreground">{b.name}</span>
                                                {b.worktreepath && (
                                                    <span className="truncate text-[10px]">{b.worktreepath}</span>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </>
                            )}
                            {branches.length === 0 && (
                                <div className="px-3 py-3 text-[11px] text-muted-foreground">No branches found.</div>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

function PanelCenter({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <div className="text-sm font-medium text-foreground">{title}</div>
            {body ? (
                <div className="max-w-64 text-[11px] leading-relaxed text-muted-foreground">{body}</div>
            ) : null}
            {action}
        </div>
    );
}

function CleanTreeHint({ repoLabel }: { repoLabel: string }) {
    return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center">
            <div className="flex size-8 items-center justify-center rounded-full border border-border text-muted-foreground">
                <Icon name="checkmark-circle-01" size={16} strokeWidth={1.6} />
            </div>
            <div className="text-[12px] font-medium text-foreground">Working tree clean</div>
            <div className="text-[10.5px] leading-snug text-muted-foreground">
                on <span className="font-mono text-foreground/80">{repoLabel}</span>
            </div>
        </div>
    );
}

function DivergedBanner() {
    return (
        <div className="mx-2 mt-1 flex h-7 items-center gap-1.5 rounded-md border border-border bg-fg-overlay-1/40 px-2 text-[10.5px] leading-none text-muted-foreground">
            <Icon name="alert-02" size={11} strokeWidth={1.9} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-foreground/85">Diverged from upstream</span>
                <span className="ml-1 opacity-75"> — resolve in terminal</span>
            </span>
        </div>
    );
}

function ListHeader({
    count,
    actionBusy,
    headerCheckState,
    onToggleAll,
}: {
    count: number;
    actionBusy: boolean;
    headerCheckState: "checked" | "indeterminate" | "unchecked";
    onToggleAll: () => void;
}) {
    return (
        <div className="flex h-7 items-center gap-2 px-3">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/85">Changes</span>
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-border px-1 text-[9.5px] font-semibold tabular-nums text-muted-foreground">
                {count}
            </span>
            <label className="ml-auto flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-[10.5px] font-medium text-muted-foreground hover:text-foreground">
                <span>All</span>
                <Checkbox
                    aria-label="Stage all changes"
                    checked={headerCheckState === "checked" ? true : headerCheckState === "indeterminate" ? "indeterminate" : false}
                    disabled={actionBusy}
                    onChange={onToggleAll}
                />
            </label>
        </div>
    );
}

const EntryRow = memo(function EntryRow({
    entry,
    focused,
    selectedPath,
    actionBusy,
    onFocus,
    onSelect,
    onToggleStage,
    onDiscard,
}: {
    entry: SourceControlFileEntry;
    focused: boolean;
    selectedPath: string | null;
    actionBusy: string | null;
    onFocus: () => void;
    onSelect: () => void;
    onToggleStage: () => void;
    onDiscard: () => void;
}) {
    const isSelected = selectedPath === entry.path;
    const fileName = basename(entry.path);
    const pathLabel = entryPathLabel(entry);
    const showDiscard = entry.unstaged;
    const isStageBusy = actionBusy === `stage:${entry.path}` || actionBusy === `unstage:${entry.path}`;
    const isDiscardBusy = actionBusy === `discard:${entry.path}`;
    const disabled = actionBusy !== null;
    const FileIconComp = getFileIcon(fileName, false, false);

    return (
        <div
            id={`scm-row-${entry.key}`}
            data-focused={focused || undefined}
            data-selected={isSelected || undefined}
            role="option"
            aria-selected={isSelected}
            onMouseDown={onFocus}
            className={cn(
                "group relative flex h-[30px] items-center gap-2 rounded-md pl-2 pr-2 transition-colors duration-100",
                focused
                    ? "bg-fg-overlay-2"
                    : isSelected
                      ? "bg-fg-overlay-2/80 text-foreground"
                      : "hover:bg-fg-overlay-1"
            )}
        >
            <span
                className={cn(
                    "pointer-events-none absolute inset-y-1 left-0 w-[2px] rounded-full transition-opacity",
                    statusAccent(entry.statuscode),
                    isSelected || focused ? "opacity-100" : "opacity-55 group-hover:opacity-95"
                )}
                aria-hidden
            />
            <button
                type="button"
                onClick={() => {
                    onFocus();
                    onSelect();
                }}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
            >
                <FileIconComp size={14} className="shrink-0" />
                <div className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-none">
                    <span
                        className={cn(
                            "truncate text-[12px] leading-tight",
                            isSelected || focused
                                ? "font-semibold text-foreground"
                                : "font-medium text-foreground/95",
                            pathLabel ? "max-w-[58%] shrink-0" : "min-w-0 flex-1"
                        )}
                    >
                        {fileName}
                    </span>
                    {pathLabel ? (
                        <span className="min-w-0 flex-1 truncate text-[10.5px] leading-tight text-muted-foreground/75">
                            {pathLabel}
                        </span>
                    ) : null}
                </div>
            </button>

            {showDiscard ? (
                <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-data-[focused=true]:opacity-100 group-data-[selected=true]:opacity-100">
                    <IconActionButton
                        label={`Discard ${entry.path}`}
                        disabled={disabled}
                        side="top"
                        onClick={onDiscard}
                    >
                        {isDiscardBusy ? (
                            <Spinner size={12} />
                        ) : (
                            <Icon name="trash" size={12} strokeWidth={1.8} />
                        )}
                    </IconActionButton>
                </div>
            ) : null}

            <span className="flex size-5 shrink-0 items-center justify-center">
                {isStageBusy ? (
                    <Spinner size={12} />
                ) : (
                    <Checkbox
                        aria-label={`Stage ${entry.path}`}
                        checked={entry.checkstate === "checked" ? true : entry.checkstate === "indeterminate" ? "indeterminate" : false}
                        disabled={disabled}
                        onChange={onToggleStage}
                    />
                )}
            </span>
        </div>
    );
});
EntryRow.displayName = "EntryRow";

function CommitFeedback({ feedback }: { feedback: { tone: "error" | "success"; message: string } | null }) {
    const [visibleFeedback, setVisibleFeedback] = useState(feedback);
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        if (!feedback) {
            setIsVisible(false);
            return;
        }
        setVisibleFeedback(feedback);
        setIsVisible(true);
        const hideTimer = window.setTimeout(() => setIsVisible(false), 3600);
        const clearTimer = window.setTimeout(() => {
            setVisibleFeedback((current) =>
                current?.message === feedback.message && current.tone === feedback.tone ? null : current
            );
        }, 3900);
        return () => {
            window.clearTimeout(hideTimer);
            window.clearTimeout(clearTimer);
        };
    }, [feedback]);

    if (!visibleFeedback) return null;

    const isError = visibleFeedback.tone === "error";
    return (
        <div
            className={cn(
                "pointer-events-none absolute inset-x-3 top-[calc(100%-0.25rem)] z-20 flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug shadow-lg shadow-black/15 backdrop-blur transition-all duration-200",
                isVisible ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
                isError
                    ? "border-rose-500/30 bg-panel/95 text-rose-400"
                    : "border-border bg-panel/95 text-muted-foreground"
            )}
        >
            <span
                className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    isError ? "bg-rose-500" : "bg-foreground/70"
                )}
            />
            <span className={cn("min-w-0 flex-1 truncate", isError ? "text-rose-400" : "text-muted-foreground")}>
                {visibleFeedback.message}
            </span>
        </div>
    );
}

function DiscardDialog({
    pending,
    onCancel,
    onConfirm,
}: {
    pending: { scope: "single" | "all"; label: string } | null;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    if (!pending) return null;
    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
            <div className="w-[90%] max-w-[400px] rounded-lg border border-border bg-panel p-5 shadow-2xl">
                <h3 className="text-[14px] font-semibold text-foreground">Discard changes?</h3>
                <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                    {pending.scope === "all"
                        ? `This will discard ${pending.label} and cannot be undone.`
                        : `Discard changes in "${pending.label}"? This cannot be undone.`}
                </p>
                <div className="mt-4 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="cursor-pointer rounded px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-fg-overlay-2 hover:text-foreground"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="cursor-pointer rounded bg-rose-600/90 px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-rose-600"
                    >
                        Discard
                    </button>
                </div>
            </div>
        </div>
    );
}

export const SourceControlPanel = memo(function SourceControlPanel() {
    const model = SourceControlModel.getInstance();
    const topTabController = useWorkspaceTopTabController();
    const panelState = useAtomValue(model.panelstateAtom);
    const repo = useAtomValue(model.repoAtom);
    const status = useAtomValue(model.statusAtom);
    const commitMessage = useAtomValue(model.commitmessageAtom);
    const actionBusy = useAtomValue(model.actionbusyAtom);
    const statusError = useAtomValue(model.statuserrorAtom);
    const actionError = useAtomValue(model.actionerrorAtom);
    const actionMessage = useAtomValue(model.actionmessageAtom);
    const pendingDiscard = useAtomValue(model.pendingdiscardAtom);
    const selectedPath = useAtomValue(model.selectedpathAtom);
	const [view, setView] = useAtom(model.viewAtom);
    const focusedCwd = useAtomValue(workspaceDirAtom);
    const workspaceActions = useMemo(
        () => ({
            openGitDiff: (input: OpenGitDiffTabInput) =>
                void topTabController.openGitDiff({ ...input, originalPath: input.originalPath ?? undefined }),
        }),
        [topTabController]
    );

    useEffect(() => model.bindWorkspaceActions(workspaceActions), [model, workspaceActions]);

    useEffect(() => {
        model.syncCwd();
    }, [model, focusedCwd]);

    const scrollRef = useRef<HTMLDivElement>(null);
    const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
    const refreshAnimationRef = useRef<number | null>(null);
    const [refreshAnimating, setRefreshAnimating] = useState(false);
	const graphOpen = view === "graph";

    useEffect(() => {
        return () => {
            if (refreshAnimationRef.current) {
                window.clearTimeout(refreshAnimationRef.current);
            }
        };
    }, []);

    const fileEntries = useMemo(() => model.getFileEntries(), [status, model]);
    const headerCheckState = useMemo(() => model.getHeaderCheckState(), [fileEntries, model]);
    const stagedCount = useMemo(() => model.getStagedCount(), [fileEntries, model]);
    const allClean = useMemo(() => model.getAllClean(), [fileEntries, model]);
    const canPush = useMemo(() => model.canPush(), [repo, status, model]);
    const pushHint = useMemo(() => model.getPushHint(), [repo, status, model]);

    const isRefreshing = panelState === "loading";
    const repoLabel = useMemo(() => {
        if (!status) return repo?.isdetached ? "detached" : (repo?.branch ?? "Source Control");
        return status.isdetached ? "detached" : status.branch;
    }, [repo, status]);

    const commitShortcut = IS_MAC ? "\u2318\u21a9" : "Ctrl+Enter";
    const canCommit = stagedCount > 0 && commitMessage.trim().length > 0 && !actionBusy;
    const commitDisabledReason = actionBusy
        ? "Wait for the current Git action to finish."
        : stagedCount === 0
          ? "Stage changes to enable commit."
          : commitMessage.trim().length === 0
            ? "Enter a commit message to enable commit."
            : null;
    const commitHint = canCommit
        ? `Commit with ${commitShortcut}.`
        : (commitDisabledReason ?? `Commit with ${commitShortcut}.`);
    const changedCount = fileEntries.length;
    const pushStatusLabel = upstreamBadgeLabel(repo?.upstream);
    const hasUpstream = !!repo?.upstream;
    const isDiverged = !!status && status.ahead > 0 && status.behind > 0;

    const canPull = hasUpstream && !!status && status.behind > 0 && !isDiverged && !actionBusy;
    const canFetch = hasUpstream && !actionBusy;

    const footerFeedback = useMemo(() => {
        if (actionError) return { tone: "error" as const, message: actionError };
        if (actionMessage) return { tone: "success" as const, message: actionMessage };
        return null;
    }, [actionError, actionMessage]);

    const handleCommitShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canCommit) {
            event.preventDefault();
            void model.commit(commitMessage);
            return;
        }
    };

    const handleRefresh = useCallback(() => {
        setRefreshAnimating(true);
        if (refreshAnimationRef.current) {
            window.clearTimeout(refreshAnimationRef.current);
        }
        void model.refresh().finally(() => {
            refreshAnimationRef.current = window.setTimeout(() => {
                setRefreshAnimating(false);
                refreshAnimationRef.current = null;
            }, 450);
        });
    }, [model]);

    const handleFetch = useCallback(() => {
        void model.fetch();
    }, [model]);

    const handlePull = useCallback(() => {
        void model.pull();
    }, [model]);

    const rows = useMemo<RowDescriptor[]>(() => {
        const result: RowDescriptor[] = [];
        if (isDiverged) {
            result.push({ kind: "banner-diverged", key: "banner-diverged" });
        }
        if (changedCount > 0) {
            result.push({ kind: "list-header", key: "list-header", count: changedCount });
            for (const entry of fileEntries) {
                result.push({ kind: "entry", key: entry.key, entry });
            }
        }
        return result;
    }, [changedCount, isDiverged, fileEntries]);

    const rowKeyToIndex = useMemo(() => {
        const map = new Map<string, number>();
        rows.forEach((row, index) => map.set(row.key, index));
        return map;
    }, [rows]);

    useEffect(() => {
        if (!focusedRowKey) return;
        if (!rowKeyToIndex.has(focusedRowKey)) {
            setFocusedRowKey(null);
        }
    }, [focusedRowKey, rowKeyToIndex]);

    const focusableIndices = useMemo(() => {
        const out: number[] = [];
        rows.forEach((row, index) => {
            if (row.kind === "entry") out.push(index);
        });
        return out;
    }, [rows]);

    const estimateSize = useCallback(
        (index: number) => {
            const row = rows[index];
            if (!row) return ROW_HEIGHTS.entry;
            switch (row.kind) {
                case "banner-diverged":
                    return ROW_HEIGHTS.banner;
                case "list-header":
                    return ROW_HEIGHTS.header;
                case "entry":
                    return ROW_HEIGHTS.entry;
            }
        },
        [rows]
    );

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        estimateSize,
        overscan: 12,
        getItemKey: (index) => rows[index]?.key ?? index,
    });

    const moveFocus = useCallback(
        (direction: 1 | -1) => {
            if (focusableIndices.length === 0) return;
            const currentIndex = focusedRowKey === null ? -1 : (rowKeyToIndex.get(focusedRowKey) ?? -1);
            let pos = focusableIndices.findIndex((i) => i === currentIndex);
            if (pos === -1) pos = direction > 0 ? -1 : focusableIndices.length;
            let nextPos = pos + direction;
            if (nextPos < 0) nextPos = 0;
            if (nextPos > focusableIndices.length - 1) nextPos = focusableIndices.length - 1;
            const targetRowIndex = focusableIndices[nextPos];
            const target = rows[targetRowIndex];
            if (!target) return;
            setFocusedRowKey(target.key);
            virtualizer.scrollToIndex(targetRowIndex, { align: "auto" });
        },
        [focusableIndices, focusedRowKey, rowKeyToIndex, rows, virtualizer]
    );

    const focusedEntry = useCallback((): SourceControlFileEntry | null => {
        if (!focusedRowKey) return null;
        const index = rowKeyToIndex.get(focusedRowKey);
        if (index === undefined) return null;
        const row = rows[index];
        return row && row.kind === "entry" ? row.entry : null;
    }, [focusedRowKey, rowKeyToIndex, rows]);

    const handlePanelKeyDown = useCallback(
        (event: KeyboardEvent<HTMLDivElement>) => {
            const target = event.target as HTMLElement | null;
            if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.closest("button"))) {
                return;
            }
            const meta = event.metaKey || event.ctrlKey;
            if (meta && (event.key === "r" || event.key === "R")) {
                event.preventDefault();
                handleRefresh();
                return;
            }
            switch (event.key) {
                case "ArrowDown":
                    event.preventDefault();
                    moveFocus(1);
                    break;
                case "ArrowUp":
                    event.preventDefault();
                    moveFocus(-1);
                    break;
                case "Enter": {
                    const entry = focusedEntry();
                    if (entry) {
                        event.preventDefault();
                        model.selectEntry(entry);
                    }
                    break;
                }
                case " ":
                case "s":
                case "S": {
                    if (meta) break;
                    const entry = focusedEntry();
                    if (entry) {
                        event.preventDefault();
                        void model.toggleStageFile(entry);
                    }
                    break;
                }
                case "d":
                case "D": {
                    if (meta) break;
                    const entry = focusedEntry();
                    if (entry && entry.unstaged) {
                        event.preventDefault();
                        model.requestDiscardFile(entry);
                    }
                    break;
                }
            }
        },
        [focusedEntry, handleRefresh, model, moveFocus]
    );

    const fetchBusy = actionBusy === "fetch";
    const pullBusy = actionBusy === "pull";

    return (
        <div className="flex h-full min-w-0 flex-col bg-transparent [contain:layout_style]">
            {graphOpen && repo ? (
                <div className="flex h-full min-h-0 w-full min-w-0 flex-1">
					<CommitGraphPanel repoRoot={repo.reporoot} remoteUrl={repo.remoteurl} onBack={() => setView("changes")} />
                </div>
            ) : (
            <>
            <header className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2.5 pt-3">
                <div className="flex min-w-0 items-center gap-1.5">
                    <BranchDropdown repoLabel={repoLabel} onRefresh={handleRefresh} actionBusy={!!actionBusy} />
                    {status && (status.ahead > 0 || status.behind > 0) ? (
                        <div className="flex shrink-0 items-center gap-0.5 text-[10px] font-semibold tabular-nums leading-none text-muted-foreground">
                            {status.ahead > 0 ? (
                                <span className="inline-flex items-center gap-0.5 rounded-md border border-border px-1 py-0.5">
                                    <Icon name="arrow-up-01" size={9} strokeWidth={2.2} />
                                    {status.ahead}
                                </span>
                            ) : null}
                            {status.behind > 0 ? (
                                <span className="inline-flex items-center gap-0.5 rounded-md border border-border px-1 py-0.5">
                                    <Icon name="arrow-down-01" size={9} strokeWidth={2.2} />
                                    {status.behind}
                                </span>
                            ) : null}
                        </div>
                    ) : null}
                    {status?.isdetached ? (
                        <span className="rounded bg-fg-overlay-1/55 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            detached
                        </span>
                    ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                    <IconActionButton
                        label={fetchBusy ? "Fetching..." : "Fetch from remote"}
                        disabled={!canFetch}
                        onClick={handleFetch}
                        side="bottom"
                    >
                        {fetchBusy ? <Spinner size={12} /> : <Icon name="folder-cloud" size={14} strokeWidth={1.85} />}
                    </IconActionButton>
                    <IconActionButton
                        label={
                            pullBusy
                                ? "Pulling..."
                                : isDiverged
                                  ? "Branch diverged - resolve in terminal"
                                  : !hasUpstream
                                    ? "No upstream configured"
                                    : (status?.behind ?? 0) === 0
                                      ? "Already up to date"
                                      : `Pull ${status?.behind ?? 0} commits (fast-forward)`
                        }
                        disabled={!canPull}
                        onClick={handlePull}
                        side="bottom"
                    >
                        {pullBusy ? <Spinner size={12} /> : <Icon name="download-01" size={14} strokeWidth={1.9} />}
                    </IconActionButton>
                    <IconActionButton
                        label="Refresh source control"
                        disabled={isRefreshing || !!actionBusy}
                        onClick={handleRefresh}
                        side="bottom"
                    >
                        {isRefreshing ? (
                            <Spinner size={14} />
                        ) : (
                            <Icon name="refresh-01" size={14} strokeWidth={1.9} className={cn(refreshAnimating && "animate-spin")} />
                        )}
                    </IconActionButton>
                </div>
            </header>

            <button
                type="button"
				onClick={() => setView("graph")}
                className="group flex shrink-0 cursor-pointer items-center gap-2 px-3 py-2 text-left text-muted-foreground transition-colors hover:bg-fg-overlay-1 hover:text-foreground"
            >
                <Icon name="git-branch-01" size={13} strokeWidth={1.85} className="shrink-0" />
                <span className="flex-1 text-[12px] font-medium">Commit Graph</span>
                <Icon name="arrow-right-01" size={12} strokeWidth={2} className="shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5" />
            </button>

            {panelState === "loading" || panelState === "closed" ? <PanelCenter title="Loading repository" /> : null}

            {panelState === "no-repo" ? (
                <PanelCenter title="No repository" body="The active workspace is not inside a Git repository." />
            ) : null}

            {panelState === "error" ? (
                <PanelCenter
                    title="Source control error"
                    body={statusError ?? "Unknown source control error"}
                    action={
                        <button
                            type="button"
                            onClick={() => void model.refresh()}
                            className="mt-2 inline-flex h-7 cursor-pointer items-center justify-center rounded-full border border-transparent bg-accent/80 px-3.5 text-[11px] font-semibold text-primary transition-colors hover:bg-accent"
                        >
                            Retry
                        </button>
                    }
                />
            ) : null}

            {panelState === "ready" && status ? (
                <>
                    <div className="relative shrink-0 space-y-2 bg-gradient-to-b from-panel/65 to-transparent px-2.5 pb-2.5 pt-2.5">
                        <div
                            className={cn(
                                "relative rounded-lg border bg-panel/95 shadow-sm transition-colors",
                                commitMessage.length > 0 ? "border-border" : "border-border/70",
                                "focus-within:border-accent/45 focus-within:shadow-md focus-within:shadow-accent/5"
                            )}
                        >
                            <textarea
                                value={commitMessage}
                                onChange={(event) => model.setCommitMessage(event.target.value)}
                                onKeyDown={handleCommitShortcut}
                                placeholder="Commit message"
                                rows={3}
                                className={cn(
                                    "min-h-[72px] w-full resize-none rounded-lg border-0 bg-transparent px-3 pb-7 pt-2.5 text-[12.5px] leading-snug text-foreground shadow-none outline-none placeholder:text-muted-foreground/65"
                                )}
                            />
                            <div className="pointer-events-none absolute inset-x-3 bottom-1.5 flex items-center justify-between gap-2 p-1 text-[10px] tabular-nums text-muted-foreground/55">
                                {commitMessage.length > 0 ? (
                                    <span>Ch: {commitMessage.length}</span>
                                ) : (
                                    <span className="flex items-center gap-2">
                                        {commitShortcut} <span>to commit</span>
                                    </span>
                                )}
                            </div>
                            <div className="absolute right-1 top-1">
                                <Tooltip label="Generate commit message (AI)" side="left">
                                    <button
                                        type="button"
                                        disabled={stagedCount === 0 || !!actionBusy}
                                        className={cn(
                                            "inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/65 transition-colors",
                                            "hover:bg-fg-overlay-1 hover:text-foreground",
                                            "disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/65"
                                        )}
                                    >
                                        <Icon name="ai-content-generator-02" size={14} strokeWidth={1.75} />
                                    </button>
                                </Tooltip>
                            </div>
                        </div>

                        <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
                            <span
                                className={cn(
                                    "size-1.5 shrink-0 rounded-full transition-colors",
                                    canCommit
                                        ? "bg-foreground/80"
                                        : stagedCount > 0
                                          ? "bg-muted-foreground/60"
                                          : "bg-muted-foreground/30"
                                )}
                            />
                            <span className="truncate font-medium text-foreground/85">
                                {stagedCount === 0
                                    ? "Nothing staged"
                                    : `${stagedCount} ${stagedCount === 1 ? "file" : "files"} staged`}
                            </span>
                            <span className="ml-auto shrink-0 truncate text-muted-foreground/65">{pushStatusLabel}</span>
                        </div>

                        <div className="grid w-full grid-cols-2 gap-1.5">
                            <Tooltip label={commitHint} side="bottom" className="w-full">
                                <button
                                    type="button"
                                    disabled={!canCommit}
                                    onClick={() => void model.commit(commitMessage)}
                                    className="inline-flex h-7 w-full cursor-pointer items-center justify-center rounded-full border border-transparent bg-accent/80 px-2.5 text-[11.5px] font-semibold tracking-tight text-primary shadow-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:cursor-default disabled:opacity-50 disabled:shadow-none"
                                >
                                    {actionBusy === "commit" ? "Committing..." : "Commit"}
                                </button>
                            </Tooltip>
                            <Tooltip label={pushHint ?? "Push is unavailable right now."} side="bottom" className="w-full">
                                <button
                                    type="button"
                                    disabled={!canPush || !!actionBusy}
                                    onClick={() => void model.push()}
                                    className="inline-flex h-7 w-full cursor-pointer items-center justify-center rounded-full border border-transparent bg-fg-overlay-2 px-2.5 text-[11.5px] font-medium text-foreground transition-colors hover:bg-fg-overlay-3 disabled:pointer-events-none disabled:cursor-default disabled:opacity-50"
                                >
                                    {actionBusy === "push" ? "Pushing..." : "Push"}
                                </button>
                            </Tooltip>
                        </div>

                        <CommitFeedback feedback={footerFeedback} />
                    </div>

                    {allClean ? (
                        <CleanTreeHint repoLabel={repoLabel} />
                    ) : (
                        <div
                            tabIndex={0}
                            role="listbox"
                            aria-label="Changed files"
                            aria-activedescendant={focusedRowKey ? `scm-row-${focusedRowKey}` : undefined}
                            onKeyDown={handlePanelKeyDown}
                            className="relative min-h-0 flex-1 outline-none focus-visible:ring-1 focus-visible:ring-accent/30"
                        >
                            <div
                                ref={scrollRef}
                                className="h-full overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
                            >
                                <div
                                    style={{
                                        height: virtualizer.getTotalSize(),
                                        position: "relative",
                                        width: "100%",
                                    }}
                                >
                                    {virtualizer.getVirtualItems().map((virtualRow) => {
                                        const row = rows[virtualRow.index];
                                        if (!row) return null;
                                        return (
                                            <div
                                                key={virtualRow.key}
                                                style={{
                                                    position: "absolute",
                                                    top: 0,
                                                    left: 0,
                                                    width: "100%",
                                                    height: virtualRow.size,
                                                    transform: `translateY(${virtualRow.start}px)`,
                                                }}
                                            >
                                                {row.kind === "banner-diverged" && <DivergedBanner />}
                                                {row.kind === "list-header" && (
                                                    <ListHeader
                                                        count={row.count}
                                                        actionBusy={!!actionBusy}
                                                        headerCheckState={headerCheckState}
                                                        onToggleAll={() => void model.toggleAll()}
                                                    />
                                                )}
                                                {row.kind === "entry" && (
                                                    <EntryRow
                                                        entry={row.entry}
                                                        focused={focusedRowKey === row.key}
                                                        selectedPath={selectedPath}
                                                        actionBusy={actionBusy}
                                                        onFocus={() => setFocusedRowKey(row.key)}
                                                        onSelect={() => model.selectEntry(row.entry)}
                                                        onToggleStage={() => void model.toggleStageFile(row.entry)}
                                                        onDiscard={() => model.requestDiscardFile(row.entry)}
                                                    />
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    )}
                </>
            ) : null}

            <DiscardDialog
                pending={pendingDiscard ? { scope: pendingDiscard.scope, label: pendingDiscard.label } : null}
                onCancel={() => model.cancelPendingDiscard()}
                onConfirm={() => void model.confirmPendingDiscard()}
            />
            </>
            )}
        </div>
    );
});
SourceControlPanel.displayName = "SourceControlPanel";
