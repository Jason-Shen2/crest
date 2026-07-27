// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UIcon } from "@/app/element/ui-icon";
import { getFileIcon } from "@/app/fileexplorer/file-icon";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { useWorkspaceTopTabController } from "@/app/workspace/top-tab-controller-context";
import type { WorkspaceTopTabController } from "@/app/workspace/top-tab-controller";
import { getApi } from "@/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bundledLanguages, codeToHtml } from "shiki/bundle/web";
import { DiffLine, DiffMode, FileStats, GitChangedFile, GitModel, ReviewComment, statusGroup } from "./git-model";

const ShikiTheme = "github-dark-high-contrast";
const FileSidebar_DefaultWidth = 250;
const FileSidebar_MinWidth = 160;
const FileSidebar_MaxWidth = 480;

export function openCodeReviewGitDiff(
    controller: Pick<WorkspaceTopTabController, "openGitDiff">,
    repoRoot: string,
    file: Pick<GitChangedFile, "path" | "origPath">,
    diffMode: DiffMode
): void {
    controller.openGitDiff({
        repoRoot,
        path: file.path,
        mode: diffMode === "Head" ? "-" : "+",
        originalPath: file.origPath,
    });
}

// ---- Extension → Shiki language mapping ----
const ExtToShikiLang: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    go: "go",
    rs: "rust",
    py: "python",
    rb: "ruby",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yml: "yaml",
    yaml: "yaml",
    json: "json",
    toml: "toml",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    less: "less",
    md: "markdown",
    sql: "sql",
    vue: "vue",
    svelte: "svelte",
    lua: "lua",
    dart: "dart",
    proto: "proto",
    r: "r",
    scala: "scala",
    hs: "haskell",
    ex: "elixir",
    exs: "elixir",
};

function resolveShikiLang(path: string): string | null {
    const name = path.split("/").pop()?.toLowerCase() ?? "";
    if (name === "dockerfile") return "dockerfile" in bundledLanguages ? "dockerfile" : null;
    if (name === "makefile") return "makefile" in bundledLanguages ? "makefile" : null;
    const ext = name.includes(".") ? name.split(".").pop()! : "";
    const lang = ExtToShikiLang[ext];
    return lang && lang in bundledLanguages ? lang : null;
}

// ---- Header icon button ----
const HeaderIconButton = memo(
    ({
        icon,
        onClick,
        title,
        danger,
        active,
    }: {
        icon: string;
        onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
        title?: string;
        danger?: boolean;
        active?: boolean;
    }) => (
        <button
            type="button"
            onClick={onClick}
            title={title}
            aria-label={title}
            className={cn(
                "flex h-7 w-7 cursor-pointer items-center justify-center rounded transition-colors",
                "text-secondary hover:bg-fg-overlay-2 hover:text-foreground",
                danger && "hover:text-rose-400",
                active && "bg-fg-overlay-2 text-foreground"
            )}
        >
            <UIcon name={icon} size={14} />
        </button>
    )
);
HeaderIconButton.displayName = "HeaderIconButton";

// ---- Status badge label (modified / added / deleted / renamed) ----
function statusLabel(status: string): { label: string; color: string } | null {
    const g = statusGroup(status);
    if (g === "modified") return null;
    if (g === "added") return { label: "Added", color: "text-emerald-400" };
    if (g === "deleted") return { label: "Deleted", color: "text-rose-400" };
    if (g === "renamed") return { label: "Renamed", color: "text-sky-400" };
    return null;
}

// ---- Stat badge: `+494 −0` ----
const StatBadge = memo(
    ({ add, del, loading, muted }: { add: number; del: number; loading?: boolean; muted?: boolean }) => {
        if (loading) {
            return <span className="h-4 w-[60px] shrink-0 animate-pulse rounded-sm bg-fg-overlay-1" />;
        }
        if (add === 0 && del === 0) return null;
        const addClass = muted ? "text-emerald-300/80" : "text-emerald-400";
        const delClass = muted ? "text-rose-300/80" : "text-rose-400";
        return (
            <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums">
                {add > 0 && <span className={addClass}>+{add}</span>}
                {del > 0 && <span className={delClass}>−{del}</span>}
            </span>
        );
    }
);
StatBadge.displayName = "StatBadge";

// ---- Diff mode selector ----
function diffModeLabel(mode: DiffMode, mainBranch: string): string {
    if (mode === "Head") return "Uncommitted changes";
    if (mode === "MainBranch") return mainBranch ? `vs. ${mainBranch}` : "vs. main";
    return "Other branch…";
}

const DiffModeSelector = memo(({ mode, mainBranch }: { mode: DiffMode; mainBranch: string }) => {
    const model = GitModel.getInstance();
    const handleClick = useCallback(
        (e: React.MouseEvent<HTMLButtonElement>) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const items: ContextMenuItem[] = [
                {
                    label: "Uncommitted changes",
                    type: "checkbox",
                    checked: mode === "Head",
                    click: () => model.setDiffMode("Head"),
                },
                {
                    label: mainBranch ? `vs. ${mainBranch}` : "vs. main (no remote default)",
                    type: "checkbox",
                    checked: mode === "MainBranch",
                    click: () => model.setDiffMode("MainBranch"),
                },
            ];
            ContextMenuModel.getInstance().showContextMenu(items, e, {
                position: { x: rect.left, y: rect.bottom + 4 },
            });
        },
        [mode, mainBranch, model]
    );
    return (
        <button
            type="button"
            onClick={handleClick}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border border-fg-overlay-2 bg-fg-overlay-1 px-2 text-[12px] text-foreground transition-colors hover:bg-fg-overlay-2"
        >
            <span className="truncate max-w-[180px]">{diffModeLabel(mode, mainBranch)}</span>
            <UIcon name="chevron-down" size={11} className="text-secondary" />
        </button>
    );
});
DiffModeSelector.displayName = "DiffModeSelector";

// ---- Compute per-line old/new numbers by walking hunk headers ----
type NumberedLine = { line: DiffLine; oldNum?: number; newNum?: number };

function numberDiffLines(diff: DiffLine[]): NumberedLine[] {
    const out: NumberedLine[] = [];
    let oldNum = 0;
    let newNum = 0;
    const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
    for (const line of diff) {
        if (line.type === "hunk") {
            const m = hunkRe.exec(line.content);
            if (m) {
                oldNum = parseInt(m[1], 10);
                newNum = parseInt(m[2], 10);
            }
            out.push({ line });
            continue;
        }
        if (line.type === "header") {
            out.push({ line });
            continue;
        }
        if (line.type === "add") {
            out.push({ line, newNum });
            newNum++;
        } else if (line.type === "remove") {
            out.push({ line, oldNum });
            oldNum++;
        } else {
            out.push({ line, oldNum, newNum });
            oldNum++;
            newNum++;
        }
    }
    return out;
}

// ---- Single diff line ----
const DiffLineRow = memo(
    ({
        item,
        highlighted,
        onAddComment,
    }: {
        item: NumberedLine;
        highlighted?: string;
        onAddComment?: (line: number) => void;
    }) => {
        const { line, oldNum, newNum } = item;
        if (line.type === "header") return null;
        if (line.type === "hunk") {
            return (
                <div className="border-y border-fg-overlay-1 bg-sky-400/[0.04] px-3 py-1 font-mono text-[10px] text-sky-300/70">
                    {line.content}
                </div>
            );
        }
        const isAdd = line.type === "add";
        const isDel = line.type === "remove";
        const codeClass = cn(
            "flex-1 whitespace-pre-wrap break-all pr-3",
            isAdd && "text-emerald-100",
            isDel && "text-rose-100",
            !isAdd && !isDel && "text-foreground/80"
        );
        const targetLine = isAdd ? newNum : isDel ? oldNum : newNum;
        return (
            <div
                className={cn(
                    "group/line relative flex font-mono text-[11px] leading-[18px]",
                    isAdd && "bg-emerald-400/[0.06]",
                    isDel && "bg-rose-400/[0.06]"
                )}
            >
                {(isAdd || isDel) && (
                    <span
                        className={cn(
                            "absolute bottom-0 left-0 top-0 w-[2px]",
                            isAdd ? "bg-emerald-400" : "bg-rose-400"
                        )}
                    />
                )}
                <span className="w-9 shrink-0 select-none pl-2 pr-1 text-right text-[10px] tabular-nums text-secondary/45">
                    {isAdd ? "" : (oldNum ?? "")}
                </span>
                <span className="relative w-9 shrink-0 select-none pr-2 text-right text-[10px] tabular-nums text-secondary/45">
                    {isDel ? "" : (newNum ?? "")}
                    {onAddComment && targetLine != null && (
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                onAddComment(targetLine);
                            }}
                            className="absolute -right-1 top-[1px] hidden h-4 w-4 cursor-pointer items-center justify-center rounded-sm bg-fg-overlay-3 text-foreground hover:bg-accent group-hover/line:flex"
                            title="Add comment on this line"
                            aria-label="Add comment on this line"
                        >
                            <UIcon name="plus" size={10} />
                        </button>
                    )}
                </span>
                {highlighted ? (
                    <span className={codeClass} dangerouslySetInnerHTML={{ __html: highlighted }} />
                ) : (
                    <span className={codeClass}>{line.content}</span>
                )}
            </div>
        );
    }
);
DiffLineRow.displayName = "DiffLineRow";

// ---- Inline comment composer at a specific line ----
function LineCommentComposer({ path, line, onClose }: { path: string; line: number | null; onClose: () => void }) {
    const [body, setBody] = useState("");
    const inputRef = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        inputRef.current?.focus();
    }, []);
    const submit = () => {
        const trimmed = body.trim();
        if (!trimmed) {
            onClose();
            return;
        }
        GitModel.getInstance().addComment(path, line, trimmed);
        onClose();
    };
    return (
        <div className="border-y border-fg-overlay-2 bg-surface-2 px-3 py-2">
            <textarea
                ref={inputRef}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={line == null ? "File-level comment…" : `Comment on line ${line}…`}
                className="min-h-[60px] w-full resize-y rounded border border-fg-overlay-2 bg-fg-overlay-1 px-2 py-1.5 text-[12px] text-foreground outline-none focus:border-fg-overlay-3"
                onKeyDown={(e) => {
                    if (e.key === "Escape") {
                        e.preventDefault();
                        onClose();
                    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        submit();
                    }
                }}
            />
            <div className="mt-2 flex justify-end gap-2">
                <button
                    type="button"
                    onClick={onClose}
                    className="cursor-pointer rounded px-2 py-1 text-[11px] text-secondary hover:bg-fg-overlay-1 hover:text-foreground"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={submit}
                    disabled={!body.trim()}
                    className="cursor-pointer rounded bg-accent/80 px-3 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                    Add comment
                </button>
            </div>
        </div>
    );
}

// ---- File card in the diff viewer ----
type FileCardProps = {
    file: GitChangedFile;
    expanded: boolean;
    selected: boolean;
    loading: boolean;
    stats?: FileStats;
    diff?: DiffLine[];
    comments: ReviewComment[];
};

const FileCard = memo(({ file, expanded, selected, loading, stats, diff, comments }: FileCardProps) => {
    const model = GitModel.getInstance();
    const parts = file.path.split("/");
    const name = parts.pop() ?? file.path;
    const dirPath = parts.join("/");
    const status = statusLabel(file.status);
    const [composerLine, setComposerLine] = useState<number | null | "file">(null);

    const numbered = useMemo(() => (diff ? numberDiffLines(diff) : []), [diff]);

    // Shiki highlighting — tokenize code lines together, then map back to diff indexes
    const [highlightedLines, setHighlightedLines] = useState<string[]>([]);
    const seqRef = useRef(0);

    useEffect(() => {
        if (!diff || diff.length === 0) {
            setHighlightedLines([]);
            return;
        }
        const lang = resolveShikiLang(file.path);
        if (!lang) {
            setHighlightedLines([]);
            return;
        }

        const codeLines: string[] = [];
        const codeIdxToDiffIdx: number[] = [];
        for (let i = 0; i < diff.length; i++) {
            const t = diff[i].type;
            if (t === "add" || t === "remove" || t === "context") {
                codeLines.push(diff[i].content);
                codeIdxToDiffIdx.push(i);
            }
        }
        if (codeLines.length === 0) {
            setHighlightedLines([]);
            return;
        }

        seqRef.current++;
        const seq = seqRef.current;
        let disposed = false;

        codeToHtml(codeLines.join("\n"), { lang, theme: ShikiTheme })
            .then((html) => {
                if (disposed || seq !== seqRef.current) return;
                const start = html.indexOf("<code");
                const open = html.indexOf(">", start);
                const end = html.lastIndexOf("</code>");
                if (start < 0 || open < 0 || end < 0) return;
                const inner = html.slice(open + 1, end);

                const tmp = document.createElement("div");
                tmp.innerHTML = inner;
                const lineHtml = Array.from(tmp.querySelectorAll("span.line")).map((el) => el.innerHTML);

                const full: string[] = new Array(diff.length).fill("");
                for (let i = 0; i < codeIdxToDiffIdx.length; i++) {
                    full[codeIdxToDiffIdx[i]] = lineHtml[i] ?? "";
                }
                setHighlightedLines(full);
            })
            .catch((e) => {
                if (disposed || seq !== seqRef.current) return;
                console.warn(`Shiki highlight failed for ${file.path}`, e);
            });

        return () => {
            disposed = true;
        };
    }, [diff, file.path]);

    return (
        <div
            data-filepath={file.path}
            className={cn(
                "shrink-0 overflow-hidden transition-colors",
                selected && "bg-surface-1"
            )}
        >
            {/* Header row */}
            <div
                className={cn(
                    "group flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-fg-overlay-1",
                    selected && "bg-fg-overlay-1"
                )}
                onClick={() => fireAndForget(() => model.toggleExpand(file.path))}
            >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors group-hover:bg-fg-overlay-2">
                    <UIcon name={expanded ? "chevron-down" : "chevron-right"} size={11} className="text-secondary" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px]" title={file.path}>
                    {dirPath && <span className="text-sub-text">{dirPath}/</span>}
                    <span className="font-medium text-foreground">{name}</span>
                </span>
                {status && (
                    <span className={cn("shrink-0 text-[10px] font-medium uppercase tracking-wide", status.color)}>
                        {status.label}
                    </span>
                )}
                <StatBadge add={stats?.add ?? 0} del={stats?.del ?? 0} loading={loading && !stats} />
                <div className="flex shrink-0 items-center gap-0.5 pl-1">
                    <button
                        type="button"
                        title="Add file diff as context"
                        onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(formatDiffForClipboard(file.path, diff));
                        }}
                        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-secondary hover:bg-fg-overlay-2 hover:text-foreground"
                    >
                        <UIcon name="paperclip" size={11} />
                    </button>
                    <button
                        type="button"
                        title="Comment on file"
                        onClick={(e) => {
                            e.stopPropagation();
                            setComposerLine("file");
                        }}
                        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-secondary hover:bg-fg-overlay-2 hover:text-foreground"
                    >
                        <UIcon name="new-conversation" size={12} />
                    </button>
                    <button
                        type="button"
                        title="Discard changes"
                        onClick={(e) => {
                            e.stopPropagation();
                            const ok = window.confirm(
                                `Discard all uncommitted changes to\n\n  ${file.path}\n\nThis cannot be undone.`
                            );
                            if (!ok) return;
                            fireAndForget(() => model.discardFile(file.path));
                        }}
                        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-secondary hover:bg-fg-overlay-2 hover:text-rose-400"
                    >
                        <UIcon name="reverse-left" size={12} />
                    </button>
                    <button
                        type="button"
                        title="Open file"
                        onClick={(e) => {
                            e.stopPropagation();
                            const cwd = globalStore.get(model.cwdAtom);
                            if (cwd) getApi().openNativePath(`${cwd}/${file.path}`);
                        }}
                        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-secondary hover:bg-fg-overlay-2 hover:text-foreground"
                    >
                        <UIcon name="share-01" size={11} />
                    </button>
                </div>
            </div>
            {/* File-level comment composer */}
            {composerLine === "file" && (
                <LineCommentComposer path={file.path} line={null} onClose={() => setComposerLine(null)} />
            )}
            {/* File-level inline comments */}
            {comments.filter((c) => c.line == null).length > 0 && (
                <div className="border-t border-fg-overlay-1 bg-surface-1 px-3 py-1.5">
                    {comments
                        .filter((c) => c.line == null)
                        .map((c) => (
                            <CommentCard key={c.id} comment={c} />
                        ))}
                </div>
            )}
            {/* Diff body */}
            {expanded && (
                <div className="border-t border-fg-overlay-1 bg-black/30">
                    {loading && !diff ? (
                        <div className="px-3 py-2 text-[11px] italic text-secondary/70">Loading diff…</div>
                    ) : numbered.length > 0 ? (
                        numbered.map((item, i) => {
                            const lineNumber =
                                item.line.type === "add"
                                    ? item.newNum
                                    : item.line.type === "remove"
                                      ? item.oldNum
                                      : item.newNum;
                            const lineComments = comments.filter((c) => c.line != null && c.line === lineNumber);
                            return (
                                <Fragment key={i}>
                                    <DiffLineRow
                                        item={item}
                                        highlighted={highlightedLines[i]}
                                        onAddComment={(ln) => setComposerLine(ln)}
                                    />
                                    {lineComments.length > 0 && (
                                        <div className="border-y border-fg-overlay-1 bg-surface-1 px-3 py-1.5">
                                            {lineComments.map((c) => (
                                                <CommentCard key={c.id} comment={c} />
                                            ))}
                                        </div>
                                    )}
                                    {composerLine === lineNumber && lineNumber != null && (
                                        <LineCommentComposer
                                            path={file.path}
                                            line={lineNumber}
                                            onClose={() => setComposerLine(null)}
                                        />
                                    )}
                                </Fragment>
                            );
                        })
                    ) : (
                        <div className="px-3 py-2 text-[11px] italic text-secondary/70">
                            {file.status === "??" ? "New empty file or unreadable" : "No diff available"}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
});
FileCard.displayName = "FileCard";

// ---- Comment card (rendered inline) ----
const CommentCard = memo(({ comment }: { comment: ReviewComment }) => {
    const ts = new Date(comment.createdAt);
    const time = ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return (
        <div className="group/comment flex items-start gap-2 rounded px-2 py-1.5 text-[12px] hover:bg-fg-overlay-1">
            <UIcon name="new-conversation" size={12} className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-center gap-2 text-[10px] text-secondary/70">
                    <span>You</span>
                    <span>{time}</span>
                    {comment.line != null && <span>line {comment.line}</span>}
                </div>
                <div className="whitespace-pre-wrap text-foreground">{comment.body}</div>
            </div>
            <button
                type="button"
                onClick={() => GitModel.getInstance().removeComment(comment.id)}
                className="hidden h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-secondary hover:bg-fg-overlay-2 hover:text-rose-400 group-hover/comment:flex"
                title="Delete comment"
                aria-label="Delete comment"
            >
                <UIcon name="x-close" size={10} />
            </button>
        </div>
    );
});
CommentCard.displayName = "CommentCard";

// ---- Helper: format diff for clipboard ----
function formatDiffForClipboard(path: string, diff?: DiffLine[]): string {
    const header = `--- ${path} ---`;
    if (!diff || diff.length === 0) return `${header}\n(no diff available)`;
    const lines: string[] = [header];
    for (const line of diff) {
        if (line.type === "add") lines.push("+" + line.content);
        else if (line.type === "remove") lines.push("-" + line.content);
        else if (line.type === "context") lines.push(" " + line.content);
        else lines.push(line.content);
    }
    return lines.join("\n");
}

// ---- File sidebar (resizable nav list) ----
function FileSidebar({
    files,
    selected,
    fileStats,
    onSelect,
    width,
    onResize,
}: {
    files: GitChangedFile[];
    selected: string | null;
    fileStats: Map<string, FileStats>;
    onSelect: (path: string) => void;
    width: number;
    onResize: (next: number) => void;
}) {
    const [dragging, setDragging] = useState(false);
    useEffect(() => {
        if (!dragging) return;
        const onMove = (e: MouseEvent) => {
            onResize(e.clientX);
        };
        const onUp = () => setDragging(false);
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
    }, [dragging, onResize]);

    return (
        <div
            className="relative flex shrink-0 flex-col border-r border-border bg-panel/60"
            data-code-review-file-sidebar="true"
            style={{ width }}
        >
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Changed files
                </span>
                <span className="ml-auto rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {files.length}
                </span>
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-2">
                {files.map((file) => {
                    const stats = fileStats.get(file.path);
                    const status = statusLabel(file.status);
                    const parts = file.path.split("/");
                    const name = parts.pop() ?? file.path;
                    const dir = parts.join("/");
                    const isSelected = selected === file.path;
                    const FileIconComp = getFileIcon(name, false, false);
                    return (
                        <div
                            key={file.path}
                            data-code-review-file-row="true"
                            onClick={() => onSelect(file.path)}
                            className={cn(
                                "group mb-1 grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border px-2 py-1.5 text-[12px] transition-colors",
                                isSelected
                                    ? "border-border bg-fg-overlay-2 text-foreground"
                                    : "border-transparent text-muted-foreground hover:border-border/70 hover:bg-fg-overlay-1 hover:text-foreground"
                            )}
                            title={file.path}
                        >
                            <FileIconComp size={14} className="shrink-0" />
                            <span className="flex min-w-0 flex-col gap-0.5">
                                <span className="truncate font-medium leading-tight text-foreground">{name}</span>
                                {dir && (
                                    <span className="truncate text-[10px] leading-tight text-muted-foreground" title={dir}>
                                        {dir}/
                                    </span>
                                )}
                            </span>
                            <span className="flex shrink-0 items-center gap-1">
                                <StatBadge add={stats?.add ?? 0} del={stats?.del ?? 0} muted={!isSelected} />
                                {status && (
                                    <span
                                        className={cn(
                                            "shrink-0 rounded border border-border px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide",
                                            status.color
                                        )}
                                    >
                                        {status.label[0]}
                                    </span>
                                )}
                            </span>
                        </div>
                    );
                })}
            </div>
            <div
                onMouseDown={() => setDragging(true)}
                className="absolute right-0 top-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-fg-overlay-2"
                aria-label="Resize file sidebar"
            />
        </div>
    );
}

// ---- Comments panel footer ----
function CommentsPanel({ comments }: { comments: ReviewComment[] }) {
    const model = GitModel.getInstance();
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (comments.length > 0 && !open) setOpen(true);
    }, [comments.length]);

    if (comments.length === 0) return null;
    return (
        <div className="shrink-0 border-t border-fg-overlay-2 bg-surface-1">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-[12px] hover:bg-fg-overlay-1"
            >
                <UIcon name={open ? "chevron-down" : "chevron-right"} size={11} className="text-secondary" />
                <span className="font-medium text-foreground">
                    {comments.length} comment{comments.length === 1 ? "" : "s"}
                </span>
                <span className="ml-auto text-secondary/70">{open ? "Hide" : "Show"}</span>
            </button>
            {open && (
                <>
                    <div className="max-h-[200px] overflow-y-auto px-2 py-1">
                        {comments.map((c) => (
                            <CommentCard key={c.id} comment={c} />
                        ))}
                    </div>
                    <div className="flex items-center justify-end gap-2 border-t border-fg-overlay-1 px-3 py-2">
                        <button
                            type="button"
                            onClick={() => model.clearComments()}
                            className="cursor-pointer rounded px-2 py-1 text-[12px] text-secondary hover:bg-fg-overlay-1 hover:text-foreground"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                const text = comments
                                    .map((c) => {
                                        const where = c.line != null ? `${c.path}:${c.line}` : c.path;
                                        return `[${where}] ${c.body}`;
                                    })
                                    .join("\n\n");
                                navigator.clipboard.writeText(text);
                            }}
                            className="inline-flex cursor-pointer items-center gap-1.5 rounded bg-accent/80 px-3 py-1 text-[12px] font-medium text-primary transition-colors hover:bg-accent"
                            title="Copy comments to clipboard for use in the agent"
                        >
                            <UIcon name="paperclip" size={11} />
                            Send to Agent
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}

// ---- Main panel ----
export const GitReviewSidebar = memo(() => {
    const model = GitModel.getInstance();
    const topTabController = useWorkspaceTopTabController();
    const isRepo = useAtomValue(model.isRepoAtom);
    const branch = useAtomValue(model.branchAtom);
    const mainBranch = useAtomValue(model.mainBranchAtom);
    const totalAdd = useAtomValue(model.totalAddAtom);
    const totalDel = useAtomValue(model.totalDelAtom);
    const files = useAtomValue(model.filesAtom);
    const expanded = useAtomValue(model.expandedFilesAtom);
    const diffs = useAtomValue(model.fileDiffsAtom);
    const fileStats = useAtomValue(model.fileStatsAtom);
    const loadingFiles = useAtomValue(model.loadingFilesAtom);
    const loading = useAtomValue(model.loadingAtom);
    const error = useAtomValue(model.errorAtom);
    const diffMode = useAtomValue(model.diffModeAtom);
    const selectedFile = useAtomValue(model.selectedFileAtom);
    const comments = useAtomValue(model.commentsAtom);
    const repoRoot = useAtomValue(model.cwdAtom);

    useEffect(() => {
        model.syncCwd();
        fireAndForget(() => model.refresh());
        model.startAutoRefresh();
        return () => model.stopAutoRefresh();
    }, []);

    const layoutModel = WorkspaceLayoutModel.getInstance();
    const rightToolPanelState = useAtomValue(layoutModel.rightToolPanelAtom);
    const fileSidebarExpanded = rightToolPanelState.magnified;

    // File sidebar width — local to the panel (per-tab persistence is a polish item).
    const [sidebarWidth, setSidebarWidth] = useState(FileSidebar_DefaultWidth);
    const containerRef = useRef<HTMLDivElement>(null);
    const handleSidebarResize = useCallback((clientX: number) => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const next = clientX - rect.left;
        const max = Math.min(FileSidebar_MaxWidth, rect.width * 0.6);
        setSidebarWidth(Math.max(FileSidebar_MinWidth, Math.min(next, max)));
    }, []);

    // Scroll to selected file's card when selection changes.
    const scrollHostRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!selectedFile || !scrollHostRef.current) return;
        const el = scrollHostRef.current.querySelector(`[data-filepath="${cssEscape(selectedFile)}"]`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, [selectedFile]);

    const fileCount = files.length;

    return (
        <div ref={containerRef} className="flex h-full w-full flex-col bg-transparent">
            {/* ---- Header ---- */}
            <div className="flex shrink-0 flex-col gap-2 px-3 py-2">
                <div
                    className="flex min-w-0 items-center gap-2"
                    data-code-review-header-main-row="true"
                >
                    <div className="flex min-w-0 items-center gap-2" data-code-review-branch="true">
                        {isRepo && (
                            <>
                                <UIcon name="git-branch-02" size={14} className="shrink-0 text-muted-foreground" />
                                <span className="truncate text-[14px] font-semibold text-foreground" title={branch}>
                                    {branch || "—"}
                                </span>
                            </>
                        )}
                    </div>
                    {isRepo && (
                        <div className="ml-auto flex shrink-0 items-center gap-2" data-code-review-branch-meta="true">
                            <StatBadge
                                add={totalAdd}
                                del={totalDel}
                                loading={loading && totalAdd === 0 && totalDel === 0}
                            />
                            <span className="shrink-0 text-[11px] tabular-nums text-secondary/70">
                                {fileCount} file{fileCount === 1 ? "" : "s"}
                            </span>
                        </div>
                    )}
                </div>

                <div
                    className="flex min-w-0 items-center gap-2"
                    data-code-review-header-control-row="true"
                >
                    {isRepo && fileCount > 0 && (
                        <span data-code-review-file-list-button="true">
                            <HeaderIconButton
                                icon={fileSidebarExpanded ? "left-panel-close" : "left-panel-open"}
                                title="Open file list"
                                active={fileSidebarExpanded}
                                onClick={() => {
                                    if (!rightToolPanelState.magnified) {
                                        layoutModel.setRightToolPanelMagnified(true);
                                    }
                                }}
                            />
                        </span>
                    )}
                    {isRepo && <DiffModeSelector mode={diffMode} mainBranch={mainBranch} />}
                    <div className="ml-auto flex shrink-0 items-center gap-1" data-code-review-header-actions="true">
                        {isRepo && fileCount > 0 && (
                            <HeaderIconButton
                                icon="reverse-left"
                                title="Discard all uncommitted changes"
                                danger
                                onClick={() => {
                                    const n = files.length;
                                    const ok = window.confirm(
                                        `Discard all uncommitted changes across ${n} file${n === 1 ? "" : "s"}?\n\nThis cannot be undone.`
                                    );
                                    if (!ok) return;
                                    fireAndForget(() => model.discardFiles(files.map((f) => f.path)));
                                }}
                            />
                        )}
                        {isRepo && fileCount > 0 && (
                            <HeaderIconButton
                                icon="paperclip"
                                title="Add all diffs as context"
                                onClick={() => {
                                    const all = files
                                        .map((f) => formatDiffForClipboard(f.path, diffs.get(f.path)))
                                        .join("\n\n");
                                    navigator.clipboard.writeText(all);
                                }}
                            />
                        )}
                    </div>
                </div>
            </div>

            {/* ---- Body ---- */}
            {loading && fileCount === 0 ? (
                <div className="flex flex-1 items-center justify-center p-8">
                    <div className="text-[12px] text-secondary/70">Loading…</div>
                </div>
            ) : error ? (
                <div className="flex flex-1 items-center justify-center p-8">
                    <div className="flex flex-col items-center gap-3 text-center">
                        <UIcon name="alert-triangle" size={20} className="text-rose-400/80" />
                        <span className="max-w-[260px] text-[12px] text-secondary/80">{error}</span>
                    </div>
                </div>
            ) : !isRepo ? (
                <div className="flex flex-1 items-center justify-center p-8">
                    <div className="flex flex-col items-center gap-3 text-secondary/70">
                        <UIcon name="git-branch-02" size={22} className="opacity-60" />
                        <span className="text-[12px]">Diffs only work for git repositories.</span>
                    </div>
                </div>
            ) : fileCount === 0 ? (
                <div className="flex flex-1 items-center justify-center p-8">
                    <div className="flex flex-col items-center gap-3 text-secondary/70">
                        <UIcon name="check-circle-broken" size={20} className="text-emerald-400/70" />
                        <span className="text-[12px]">Working tree clean.</span>
                    </div>
                </div>
            ) : (
                <div className="flex min-h-0 flex-1">
                    {fileSidebarExpanded && (
                        <FileSidebar
                            files={files}
                            selected={selectedFile}
                            fileStats={fileStats}
                            onSelect={(p) => {
                                model.selectFile(p);
                                const file = files.find((candidate) => candidate.path === p);
                                if (file) {
                                    openCodeReviewGitDiff(topTabController, repoRoot, file, diffMode);
                                }
                            }}
                            width={sidebarWidth}
                            onResize={handleSidebarResize}
                        />
                    )}
                    <div ref={scrollHostRef} className="flex-1 overflow-y-auto">
                        {files.map((file) => (
                            <FileCard
                                key={file.path}
                                file={file}
                                expanded={expanded.has(file.path)}
                                selected={selectedFile === file.path}
                                loading={loadingFiles.has(file.path)}
                                stats={fileStats.get(file.path)}
                                diff={diffs.get(file.path)}
                                comments={comments.filter((c) => c.path === file.path)}
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* ---- Comments footer ---- */}
            <CommentsPanel comments={comments} />
        </div>
    );
});
GitReviewSidebar.displayName = "GitReviewSidebar";

// CSS.escape polyfill for older webviews — Electron has it, but defensive fallback.
function cssEscape(s: string): string {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
    return s.replace(/(["\\])/g, "\\$1");
}

// Keep old export for compat
export { GitReviewSidebar as GitReviewPanel };
