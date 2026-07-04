import { getFileIcon } from "@/app/fileexplorer/file-icon";
import { Icon } from "@/app/icon/Icon";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn } from "@/util/util";
import { autoUpdate, flip, FloatingPortal, offset, shift, useFloating } from "@floating-ui/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EMPTY_GRAPH_STATE, layoutGraph, type GraphRow } from "./lib/graph";
import { commitWebUrl, hostLabel, parseRemoteWebUrl, type RemoteWebInfo } from "./lib/remoteWebUrl";
import { GraphRail, MAX_VISIBLE_LANES, railWidth } from "./graph-rail";

const PAGE_SIZE = 50;
const ROW_HEIGHT = 32;
const NEAR_BOTTOM_PX = 240;
const FILES_CACHE_LIMIT = 64;
const HOVER_PREFETCH_DELAY_MS = 70;
const WARMUP_COMMIT_COUNT = 5;
const RAIL_RESERVED_PX = railWidth(MAX_VISIBLE_LANES);
// rail | sha | subject(capped) | spacer(absorbs slack) | author(hugs) | date | changes
const GRID_TEMPLATE = `${RAIL_RESERVED_PX + 4}px 60px minmax(0, 560px) minmax(12px, 1fr) minmax(140px, max-content) 96px 116px`;

type LoadStatus = "idle" | "initial" | "more" | "error";
type FilesEntry =
    | { state: "loading" }
    | { state: "loaded"; files: GitCommitFileChange[] }
    | { state: "error"; error: string };
type CommitRowClickAction = "select" | "clear";

function commitRowClickAction(openSha: string | null | undefined, suppressNextRowSelect: boolean): CommitRowClickAction {
    if (suppressNextRowSelect || openSha) return "clear";
    return "select";
}

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

function normalizeError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (err && typeof err === "object" && "message" in err) {
        const message = (err as { message?: unknown }).message;
        if (typeof message === "string") return message;
    }
    return "Unknown error";
}

function absoluteTime(secs: number): string {
    if (!secs) return "";
    return new Date(secs * 1000).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function compactDate(secs: number): string {
    if (!secs) return "";
    const d = new Date(secs * 1000);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    const month = d.toLocaleString(undefined, { month: "short" });
    const day = String(d.getDate()).padStart(2, "0");
    if (sameYear) {
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `${month} ${day}  ${hh}:${mm}`;
    }
    return `${month} ${day} ${d.getFullYear()}`;
}

function authorInitials(name: string): string {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return "?";
    const parts = trimmed.split(/\s+/);
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

const AUTHOR_TINTS = [
    "#7aa2f7",
    "#bb9af7",
    "#9ece6a",
    "#e0af68",
    "#f7768e",
    "#73daca",
    "#ff9e64",
    "#b4f9f8",
];

function authorTint(key: string): string {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }
    return AUTHOR_TINTS[Math.abs(hash) % AUTHOR_TINTS.length];
}

function statusTone(code: string): string {
    switch (code.toUpperCase()) {
        case "A":
            return "text-emerald-400";
        case "M":
            return "text-amber-300";
        case "D":
            return "text-rose-400";
        case "R":
        case "C":
            return "text-sky-300";
        default:
            return "text-[#a1a1aa]";
    }
}

export function CommitGraphPanel({
    repoRoot,
    remoteUrl,
    onBack,
}: {
    repoRoot: string;
    remoteUrl?: string;
    onBack: () => void;
}) {
    const [commits, setCommits] = useState<GitLogEntry[]>([]);
    const [loadStatus, setLoadStatus] = useState<LoadStatus>("idle");
    const [error, setError] = useState<string | null>(null);
    const [endReached, setEndReached] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const requestIdRef = useRef(0);
    const inflightMoreRef = useRef(false);
    const filesInflightRef = useRef(new Set<string>());
    const filesCacheRef = useRef(new Map<string, FilesEntry>());
    const prefetchHoverTimerRef = useRef<number | null>(null);
    const suppressNextRowSelectRef = useRef(false);
    const [filesTick, setFilesTick] = useState(0);
    const [openAnchor, setOpenAnchor] = useState<{
        sha: string;
        top: number;
        left: number;
        width: number;
        height: number;
    } | null>(null);
    const remoteWeb = useMemo(() => parseRemoteWebUrl(remoteUrl), [remoteUrl]);
    const bumpFiles = useCallback(() => setFilesTick((n) => n + 1), []);

    const graphCacheRef = useRef<{
        rows: GraphRow[];
        byCommit: Map<string, GraphRow>;
        tail: { lanes: (string | null)[] };
        firstSha: string | null;
        len: number;
        maxLaneCount: number;
    }>({
        rows: [],
        byCommit: new Map(),
        tail: EMPTY_GRAPH_STATE,
        firstSha: null,
        len: 0,
        maxLaneCount: 1,
    });

    const { graphByCommit, maxLaneCount } = useMemo(() => {
        const cache = graphCacheRef.current;
        if (commits.length === 0) {
            cache.rows = [];
            cache.byCommit = new Map();
            cache.tail = EMPTY_GRAPH_STATE;
            cache.firstSha = null;
            cache.len = 0;
            cache.maxLaneCount = 1;
            return { graphByCommit: cache.byCommit, maxLaneCount: 1 };
        }
        const firstSha = commits[0].sha;
        const canAppend = cache.firstSha === firstSha && commits.length >= cache.len;
        if (!canAppend) {
            const { rows, state } = layoutGraph(commits);
            const byCommit = new Map<string, GraphRow>();
            let max = 1;
            for (const row of rows) {
                byCommit.set(row.sha, row);
                if (row.laneCount > max) max = row.laneCount;
            }
            cache.rows = rows;
            cache.byCommit = byCommit;
            cache.tail = state;
            cache.firstSha = firstSha;
            cache.len = commits.length;
            cache.maxLaneCount = max;
            return { graphByCommit: byCommit, maxLaneCount: max };
        }
        if (commits.length > cache.len) {
            const delta = commits.slice(cache.len);
            const { rows: newRows, state } = layoutGraph(delta, cache.tail);
            let max = cache.maxLaneCount;
            for (const row of newRows) {
                cache.byCommit.set(row.sha, row);
                if (row.laneCount > max) max = row.laneCount;
            }
            cache.rows = cache.rows.concat(newRows);
            cache.tail = state;
            cache.len = commits.length;
            cache.maxLaneCount = max;
        }
        return { graphByCommit: cache.byCommit, maxLaneCount: cache.maxLaneCount };
    }, [commits]);

    const fetchFiles = useCallback(
        async (sha: string) => {
            if (filesInflightRef.current.has(sha)) return;
            const cache = filesCacheRef.current;
            const existing = cache.get(sha);
            if (existing && existing.state !== "error") return;
            filesInflightRef.current.add(sha);
            cache.set(sha, { state: "loading" });
            bumpFiles();
            try {
                const files = await RpcApi.GitGetCommitFilesCommand(TabRpcClient, { cwd: repoRoot, message: "", sha });
                cache.set(sha, { state: "loaded", files });
                while (cache.size > FILES_CACHE_LIMIT) {
                    const oldest = cache.keys().next().value;
                    if (oldest === undefined || oldest === sha) break;
                    cache.delete(oldest);
                }
                bumpFiles();
            } catch (err) {
                cache.set(sha, { state: "error", error: normalizeError(err) });
                bumpFiles();
            } finally {
                filesInflightRef.current.delete(sha);
            }
        },
        [bumpFiles, repoRoot]
    );

    const loadInitial = useCallback(async () => {
        const requestId = ++requestIdRef.current;
        filesInflightRef.current.clear();
        filesCacheRef.current.clear();
        if (prefetchHoverTimerRef.current !== null) {
            window.clearTimeout(prefetchHoverTimerRef.current);
            prefetchHoverTimerRef.current = null;
        }
        setOpenAnchor(null);
        bumpFiles();
        setLoadStatus("initial");
        setError(null);
        setEndReached(false);
        try {
            const entries = await RpcApi.GitGetLogCommand(TabRpcClient, { cwd: repoRoot, limit: PAGE_SIZE });
            if (requestId !== requestIdRef.current) return;
            setCommits(entries);
            setLoadStatus("idle");
            if (entries.length < PAGE_SIZE) setEndReached(true);
            for (let i = 0; i < Math.min(entries.length, WARMUP_COMMIT_COUNT); i++) {
                void fetchFiles(entries[i].sha);
            }
        } catch (err: any) {
            if (requestId !== requestIdRef.current) return;
            setError(normalizeError(err));
            setLoadStatus("error");
        }
    }, [bumpFiles, fetchFiles, repoRoot]);

    const loadMore = useCallback(async () => {
        if (inflightMoreRef.current || endReached) return;
        if (loadStatus !== "idle") return;
        const last = commits[commits.length - 1];
        if (!last) return;
        inflightMoreRef.current = true;
        setLoadStatus("more");
        try {
            const entries = await RpcApi.GitGetLogCommand(TabRpcClient, {
                cwd: repoRoot,
                limit: PAGE_SIZE,
                cursorsha: last.sha,
            });
            setCommits((prev) => {
                const seen = new Set(prev.map((c) => c.sha));
                const merged = [...prev];
                for (const e of entries) if (!seen.has(e.sha)) merged.push(e);
                return merged;
            });
            if (entries.length < PAGE_SIZE) setEndReached(true);
            setLoadStatus("idle");
        } catch (err: any) {
            setError(normalizeError(err));
            setLoadStatus("error");
        } finally {
            inflightMoreRef.current = false;
        }
    }, [commits, endReached, loadStatus, repoRoot]);

    const handleRowClick = useCallback(
        (sha: string, event: React.MouseEvent<HTMLElement>) => {
            const action = commitRowClickAction(openAnchor?.sha, suppressNextRowSelectRef.current);
            if (action === "clear") {
                suppressNextRowSelectRef.current = false;
                setOpenAnchor(null);
                return;
            }
            const popoverWidth = 420;
            const padding = 16;
            const maxLeft = window.innerWidth - popoverWidth - padding;
            const left = Math.max(padding, Math.min(event.clientX, maxLeft));
            setOpenAnchor({
                sha,
                top: event.clientY,
                left,
                width: 1,
                height: 1,
            });
            void fetchFiles(sha);
        },
        [fetchFiles, openAnchor?.sha]
    );

    const closePopover = useCallback(() => {
        suppressNextRowSelectRef.current = true;
        window.setTimeout(() => {
            suppressNextRowSelectRef.current = false;
        }, 0);
        setOpenAnchor(null);
    }, []);

    const scheduleHoverPrefetch = useCallback(
        (sha: string) => {
            if (prefetchHoverTimerRef.current !== null) {
                window.clearTimeout(prefetchHoverTimerRef.current);
            }
            prefetchHoverTimerRef.current = window.setTimeout(() => {
                prefetchHoverTimerRef.current = null;
                void fetchFiles(sha);
            }, HOVER_PREFETCH_DELAY_MS);
        },
        [fetchFiles]
    );

    const cancelHoverPrefetch = useCallback(() => {
        if (prefetchHoverTimerRef.current !== null) {
            window.clearTimeout(prefetchHoverTimerRef.current);
            prefetchHoverTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        return () => cancelHoverPrefetch();
    }, [cancelHoverPrefetch]);

    const openFilesEntry = useMemo(() => {
        if (!openAnchor) return null;
        return filesCacheRef.current.get(openAnchor.sha) ?? null;
    }, [openAnchor, filesTick]);

    const handleFileOpen = useCallback((_commit: GitLogEntry, _file: GitCommitFileChange) => {
        setOpenAnchor(null);
    }, []);

    const copyToClipboard = useCallback(async (value: string) => {
        try {
            await navigator.clipboard.writeText(value);
        } catch {
            /* noop */
        }
    }, []);

    useEffect(() => {
        void loadInitial();
    }, [loadInitial]);

    useEffect(() => {
        if (loadStatus !== "idle") return;
        if (endReached) return;
        if (commits.length === 0) return;
        const el = scrollRef.current;
        if (!el) return;
        const scrollable = el.scrollHeight - el.clientHeight;
        if (scrollable > NEAR_BOTTOM_PX) return;
        const id = window.setTimeout(() => {
            void loadMore();
        }, 0);
        return () => window.clearTimeout(id);
    }, [commits.length, endReached, loadMore, loadStatus]);

    const handleScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        setOpenAnchor((prev) => (prev ? null : prev));
        const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (remaining < NEAR_BOTTOM_PX) {
            void loadMore();
        }
    }, [loadMore]);

    const virtualizer = useVirtualizer({
        count: commits.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 8,
        getItemKey: (index) => commits[index]?.sha ?? index,
    });

    return (
        <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col bg-[#1f2023] [contain:layout_style]">
            <div className="flex shrink-0 items-center gap-2 border-b border-[#3f3f46]/50 px-3 pb-2.5 pt-3">
                <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-[#a1a1aa] transition-colors hover:bg-[#27272a] hover:text-[#f4f4f5]"
                    title="Back to Source Control"
                >
                    <Icon name="arrow-left-01" size={14} strokeWidth={1.9} />
                </button>
                <Icon name="git-branch-01" size={13} strokeWidth={1.85} className="shrink-0 text-[#a1a1aa]" />
                <span className="text-[12px] font-medium text-[#f4f4f5]">Commit Graph</span>
                <button
                    type="button"
                    onClick={() => void loadInitial()}
                    className="ml-auto inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-[#a1a1aa] transition-colors hover:bg-[#27272a] hover:text-[#f4f4f5]"
                    title="Refresh"
                >
                    <Icon name="refresh-01" size={13} strokeWidth={1.9} />
                </button>
            </div>

            {loadStatus === "initial" && commits.length === 0 ? (
                <CenterPlaceholder>
                    <Icon name="loading-03" size={14} spin className="text-[#a1a1aa]" />
                    <span className="text-[11.5px] text-[#a1a1aa]">Loading commits…</span>
                </CenterPlaceholder>
            ) : loadStatus === "error" && commits.length === 0 ? (
                <CenterPlaceholder>
                    <div className="text-[13px] font-medium text-[#f4f4f5]">Could not load history</div>
                    <div className="max-w-md text-[11px] leading-relaxed text-[#a1a1aa]">{error ?? "Unknown error"}</div>
                    <button
                        type="button"
                        onClick={() => void loadInitial()}
                        className="mt-1 inline-flex h-7 cursor-pointer items-center justify-center rounded-full border border-transparent bg-[#92724F] px-3.5 text-[11px] font-semibold text-[#1a1410] transition-colors hover:bg-[#a0805c]"
                    >
                        Retry
                    </button>
                </CenterPlaceholder>
            ) : commits.length === 0 ? (
                <CenterPlaceholder>
                    <div className="text-[13px] font-medium text-[#f4f4f5]">No commits yet</div>
                    <div className="max-w-md text-[11px] leading-relaxed text-[#a1a1aa]">This branch has no commits.</div>
                </CenterPlaceholder>
            ) : (
                <>
                    <div
                        className="grid shrink-0 items-center gap-3 border-b border-[#3f3f46]/40 bg-[#1f2023]/55 pr-3 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-[#a1a1aa]/70"
                        style={{ height: 24, gridTemplateColumns: GRID_TEMPLATE }}
                    >
                        <div />
                        <div className="pl-px">SHA</div>
                        <div className="min-w-0">Subject</div>
                        <div />
                        <div className="ml-2">Author</div>
                        <div className="text-right">Date</div>
                        <div className="text-right">Changes</div>
                    </div>
                    <div
                        ref={scrollRef}
                        onScroll={handleScroll}
                        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
                    >
                        <div
                            style={{
                                height: virtualizer.getTotalSize(),
                                position: "relative",
                                width: "100%",
                            }}
                        >
                            {virtualizer.getVirtualItems().map((virtualRow) => {
                                const commit = commits[virtualRow.index];
                                if (!commit) return null;
                                return (
                                    <CommitRowMemo
                                        key={virtualRow.key}
                                        commit={commit}
                                        graphRow={graphByCommit.get(commit.sha) ?? null}
                                        maxLaneCount={maxLaneCount}
                                        start={virtualRow.start}
                                        active={openAnchor?.sha === commit.sha}
                                        onClick={handleRowClick}
                                        onHoverEnter={scheduleHoverPrefetch}
                                        onHoverLeave={cancelHoverPrefetch}
                                    />
                                );
                            })}
                        </div>

                        {loadStatus === "more" ? (
                            <div className="flex items-center justify-center gap-2 py-3 text-[11px] text-[#a1a1aa]">
                                <Icon name="loading-03" size={12} spin />
                                Loading more…
                            </div>
                        ) : null}
                        {endReached ? (
                            <div className="py-3 text-center text-[10.5px] text-[#a1a1aa]/65">End of history</div>
                        ) : null}
                    </div>
                </>
            )}
            <CommitDetailPopover
                anchor={openAnchor}
                commit={openAnchor ? (commits.find((c) => c.sha === openAnchor.sha) ?? null) : null}
                filesEntry={openFilesEntry}
                remoteWeb={remoteWeb}
                onClose={closePopover}
                onCopySha={copyToClipboard}
                onOpenFile={handleFileOpen}
                onRetryFiles={() => {
                    if (openAnchor) void fetchFiles(openAnchor.sha);
                }}
            />
        </div>
    );
}

function CenterPlaceholder({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">{children}</div>
    );
}

type CommitRowProps = {
    commit: GitLogEntry;
    graphRow: GraphRow | null;
    maxLaneCount: number;
    start: number;
    active: boolean;
    onClick: (sha: string, event: React.MouseEvent<HTMLElement>) => void;
    onHoverEnter: (sha: string) => void;
    onHoverLeave: () => void;
};

const CommitRow = memo(function CommitRow({ commit, graphRow, maxLaneCount, start, active, onClick, onHoverEnter, onHoverLeave }: CommitRowProps) {
    const date = compactDate(commit.timestampsecs);
    const initials = authorInitials(commit.author);
    const totalStat = commit.insertions + commit.deletions;
    return (
        <div
            style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: ROW_HEIGHT,
                transform: `translateY(${start}px)`,
            }}
        >
            <button
                type="button"
                onClick={(event) => onClick(commit.sha, event)}
                onMouseEnter={() => onHoverEnter(commit.sha)}
                onMouseLeave={onHoverLeave}
                className={cn(
                    "group relative grid h-full w-full cursor-pointer items-center gap-3 border-l-2 pr-3 text-left transition-colors",
                    active ? "border-l-[#92724F]/80 bg-[#f4f4f5]/[0.08]" : "border-transparent hover:bg-[#f4f4f5]/[0.06]"
                )}
                style={{ gridTemplateColumns: GRID_TEMPLATE }}
            >
                <div className="flex items-center justify-start pl-1">
                    {graphRow ? (
                        <GraphRail row={graphRow} rowHeight={ROW_HEIGHT} maxLaneCount={maxLaneCount} active={active} />
                    ) : null}
                </div>
                <span className="pl-px font-mono text-[10.5px] tabular-nums text-[#a1a1aa]/80">
                    {commit.shortsha}
                </span>
                <span
                    className={cn(
                        "min-w-0 truncate text-[12px] leading-tight",
                        active ? "font-semibold text-[#f4f4f5]" : "font-medium text-[#f4f4f5]/95"
                    )}
                >
                    {commit.subject || <span className="text-[#a1a1aa]">(no subject)</span>}
                </span>
                <span aria-hidden />
                <span
                    className="ml-2 inline-flex h-[18px] max-w-full min-w-0 items-center gap-1.5 justify-self-start self-center overflow-hidden rounded-md bg-[#f4f4f5]/6 pl-1 pr-1.5 text-[10.5px] font-medium text-[#f4f4f5]/85"
                    title={commit.authoremail || commit.author}
                >
                    <span
                        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] font-mono text-[8.5px] font-bold uppercase tabular-nums text-[#09090b]"
                        style={{
                            backgroundColor: authorTint(commit.authoremail || commit.author),
                        }}
                    >
                        {initials}
                    </span>
                    <span className="min-w-0 truncate">{commit.author || "Unknown"}</span>
                </span>
                <span className="text-right font-mono text-[10.5px] tabular-nums text-[#a1a1aa]/75">
                    {date}
                </span>
                <span className="flex min-w-0 items-center justify-end gap-1.5 font-mono text-[10px] tabular-nums">
                    {commit.fileschanged > 0 ? (
                        <span
                            className="inline-flex items-center gap-1 text-[#a1a1aa]/75"
                            title={`${commit.fileschanged} ${commit.fileschanged === 1 ? "file" : "files"} changed`}
                        >
                            <Icon name="file-01" size={10.5} strokeWidth={1.7} className="opacity-70" />
                            <span className="font-medium">{commit.fileschanged}</span>
                        </span>
                    ) : null}
                    {commit.fileschanged > 0 && totalStat > 0 ? (
                        <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-[#a1a1aa]/30" />
                    ) : null}
                    {totalStat > 0 ? (
                        <span className="inline-flex items-center gap-1">
                            {commit.insertions > 0 ? (
                                <span className="font-semibold text-emerald-400/85">+{commit.insertions}</span>
                            ) : null}
                            {commit.deletions > 0 ? (
                                <span className="font-semibold text-rose-400/85">−{commit.deletions}</span>
                            ) : null}
                        </span>
                    ) : commit.fileschanged === 0 ? (
                        <span className="text-[#a1a1aa]/40">—</span>
                    ) : null}
                </span>
            </button>
        </div>
    );
});

const CommitRowMemo = CommitRow;

type CommitDetailPopoverProps = {
    anchor: { sha: string; top: number; left: number; width: number; height: number } | null;
    commit: GitLogEntry | null;
    filesEntry: FilesEntry | null;
    remoteWeb: RemoteWebInfo | null;
    onClose: () => void;
    onCopySha: (value: string) => Promise<void> | void;
    onOpenFile: (commit: GitLogEntry, file: GitCommitFileChange) => Promise<void> | void;
    onRetryFiles: () => void;
};

function CommitDetailPopover({
    anchor,
    commit,
    filesEntry,
    remoteWeb,
    onClose,
    onCopySha,
    onOpenFile,
    onRetryFiles,
}: CommitDetailPopoverProps) {
    const floatingRef = useRef<HTMLDivElement | null>(null);
    const { refs, floatingStyles } = useFloating({
        placement: "bottom-start",
        open: !!anchor,
        middleware: [offset(4), flip({ padding: 16 }), shift({ padding: 16 })],
        whileElementsMounted: autoUpdate,
    });
    const setFloatingRef = useCallback(
        (node: HTMLDivElement | null) => {
            floatingRef.current = node;
            refs.setFloating(node);
        },
        [refs]
    );

    useEffect(() => {
        if (!anchor) return;
        refs.setReference({
            getBoundingClientRect: () =>
                ({
                    x: anchor.left,
                    y: anchor.top,
                    top: anchor.top,
                    left: anchor.left,
                    right: anchor.left + anchor.width,
                    bottom: anchor.top + anchor.height,
                    width: anchor.width,
                    height: anchor.height,
                }) as DOMRect,
        });
    }, [anchor, refs]);

    useEffect(() => {
        if (!anchor) return;
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Node && floatingRef.current?.contains(target)) return;
            onClose();
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [anchor, onClose]);

    if (!anchor || !commit) return null;
    return (
        <FloatingPortal>
            <div
                ref={setFloatingRef}
                className="z-50 flex flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-xl outline-none"
                style={{
                    ...floatingStyles,
                    width: 420,
                    maxWidth: "calc(100vw - 2rem)",
                    backgroundColor: "#202124",
                    border: "1px solid rgba(63, 63, 70, 0.7)",
                    boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.45), 0 8px 10px -6px rgba(0, 0, 0, 0.45)",
                }}
                role="dialog"
                aria-label="Commit detail"
            >
                <CommitDetail
                    commit={commit}
                    filesEntry={filesEntry}
                    remoteWeb={remoteWeb}
                    onCopySha={onCopySha}
                    onOpenFile={onOpenFile}
                    onRetryFiles={onRetryFiles}
                />
            </div>
        </FloatingPortal>
    );
}

type CommitDetailProps = {
    commit: GitLogEntry;
    filesEntry: FilesEntry | null;
    remoteWeb: RemoteWebInfo | null;
    onCopySha: (value: string) => Promise<void> | void;
    onOpenFile: (commit: GitLogEntry, file: GitCommitFileChange) => Promise<void> | void;
    onRetryFiles: () => void;
};

function CommitDetail({ commit, filesEntry, remoteWeb, onCopySha, onOpenFile, onRetryFiles }: CommitDetailProps) {
    const absolute = absoluteTime(commit.timestampsecs);
    const webUrl = remoteWeb ? commitWebUrl(remoteWeb, commit.sha) : null;
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const t = window.setTimeout(() => setCopied(false), 1100);
        return () => window.clearTimeout(t);
    }, [copied]);

    return (
        <div className="flex max-h-[60vh] min-h-0 flex-col">
            <div className="shrink-0 border-b border-[#3f3f46]/45 p-3">
                <div className="flex items-start gap-2">
                    <span className="mt-px shrink-0 rounded bg-[#f4f4f5]/10 px-1.5 py-0.5 font-mono text-[10.5px] leading-none tabular-nums text-[#a1a1aa]">
                        {commit.shortsha}
                    </span>
                    <div className="min-w-0 flex-1 text-[12.5px] font-semibold leading-snug text-[#f4f4f5]">
                        {commit.subject || <span className="text-[#a1a1aa]">(no subject)</span>}
                    </div>
                </div>
                <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[10.5px] text-[#a1a1aa]">
                    <span className="truncate">{commit.author || "Unknown"}</span>
                    {commit.authoremail ? (
                        <>
                            <span className="text-[#a1a1aa]/45">·</span>
                            <span className="truncate text-[#a1a1aa]/85">{commit.authoremail}</span>
                        </>
                    ) : null}
                    <span className="text-[#a1a1aa]/45">·</span>
                    <span className="shrink-0 tabular-nums">{absolute}</span>
                </div>

                <div className="mt-2.5 flex items-center gap-1">
                    <button
                        type="button"
                        className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[11px] font-semibold text-[#a1a1aa] transition-colors hover:bg-[#f4f4f5]/[0.06] hover:text-[#f4f4f5]"
                        onClick={() => {
                            void onCopySha(commit.sha);
                            setCopied(true);
                        }}
                    >
                        <Icon name="copy" size={11} strokeWidth={1.9} />
                        {copied ? "Copied" : "Copy SHA"}
                    </button>
                    {webUrl ? (
                        <button
                            type="button"
                            className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[11px] font-semibold text-[#a1a1aa] transition-colors hover:bg-[#f4f4f5]/[0.06] hover:text-[#f4f4f5]"
                            onClick={() => window.open(webUrl, "_blank", "noopener,noreferrer")}
                        >
                            <Icon name="link-square-02" size={11} strokeWidth={1.9} />
                            {hostLabel(remoteWeb)}
                        </button>
                    ) : null}
                </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <CommitFiles commit={commit} filesEntry={filesEntry} onOpenFile={onOpenFile} onRetry={onRetryFiles} />
            </div>
        </div>
    );
}

function CommitFiles({
    commit,
    filesEntry,
    onOpenFile,
    onRetry,
}: {
    commit: GitLogEntry;
    filesEntry: FilesEntry | null;
    onOpenFile: (commit: GitLogEntry, file: GitCommitFileChange) => Promise<void> | void;
    onRetry: () => void;
}) {
    if (!filesEntry || filesEntry.state === "loading") {
        return (
            <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-[#a1a1aa]">
                <Icon name="loading-03" size={12} spin />
                Loading files…
            </div>
        );
    }
    if (filesEntry.state === "error") {
        return (
            <div className="flex items-center justify-between gap-2 px-3 py-3 text-[11px] text-rose-400">
                <span className="truncate">{filesEntry.error}</span>
                <button
                    type="button"
                    className="inline-flex h-6 cursor-pointer items-center rounded-md px-2 text-[11px] text-[#a1a1aa] transition-colors hover:bg-[#f4f4f5]/[0.06] hover:text-[#f4f4f5]"
                    onClick={onRetry}
                >
                    Retry
                </button>
            </div>
        );
    }
    if (filesEntry.files.length === 0) {
        return <div className="px-3 py-3 text-[11px] text-[#a1a1aa]">No file changes.</div>;
    }
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#a1a1aa]/85">
                <span>Files</span>
                <span className="rounded-sm bg-[#f4f4f5]/10 px-1 py-px text-[9.5px] tabular-nums text-[#a1a1aa]/85 normal-case tracking-normal">
                    {filesEntry.files.length}
                </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]">
                <ul className="space-y-px px-1.5 pb-2">
                    {filesEntry.files.map((file) => (
                        <li key={file.path}>
                            <FileRow file={file} onOpen={() => void onOpenFile(commit, file)} />
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}

const FileRow = memo(function FileRow({ file, onOpen }: { file: GitCommitFileChange; onOpen: () => void }) {
    const fileName = basename(file.path);
    const dir = dirname(file.path);
    const FileIcon = getFileIcon(fileName, false, false);
    return (
        <button
            type="button"
            onClick={onOpen}
            className="group flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-[#f4f4f5]/[0.06]"
        >
            <FileIcon className="size-3.5 shrink-0" />
            <div className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-none">
                <span className="truncate text-[11.5px] font-medium leading-tight text-[#f4f4f5]">{fileName}</span>
                {dir ? (
                    <span className="min-w-0 flex-1 truncate text-[10px] leading-tight text-[#a1a1aa]/80">{dir}</span>
                ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
                {file.isbinary ? (
                    <span className="text-[#a1a1aa]/70">binary</span>
                ) : (
                    <>
                        {file.added > 0 ? <span className="text-emerald-400">+{file.added}</span> : null}
                        {file.removed > 0 ? <span className="text-rose-400">−{file.removed}</span> : null}
                    </>
                )}
            </div>
            <span
                className={cn("inline-flex w-4 shrink-0 justify-center text-[9.5px] font-bold leading-none tabular-nums", statusTone(file.status))}
                title={file.statuslabel}
            >
                {file.status.toUpperCase()}
            </span>
        </button>
    );
});

export const CommitDetailForTest = CommitDetail;
export const CommitRowForTest = CommitRow;
export const commitRowClickActionForTest = commitRowClickAction;
