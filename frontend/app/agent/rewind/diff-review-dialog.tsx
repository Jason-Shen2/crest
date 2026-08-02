// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

"use client";

import { DiffViewer } from "@/app/agent/assistant-ui/diff-viewer";
import { getFileIcon } from "@/app/fileexplorer/file-icon";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/shadcn/ui/dialog";
import { cn } from "@/util/util";
import { FileDiffIcon } from "lucide-react";
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type KeyboardEvent,
    type ReactNode,
} from "react";

const FilePane_DefaultWidth = 250;
const FilePane_MinWidth = 160;
const FilePane_MaxWidth = 480;

export interface DiffReviewDialogProps {
    open: boolean;
    title: string;
    files: AgentRewindFileRowView[];
    selectedPath?: string;
    loading?: boolean;
    errorMessage?: string;
    warnings?: string[];
    locked?: boolean;
    emptyMessage?: string;
    footer: ReactNode;
    onSelectedPathChange(path: string): void;
    onOpenChange(open: boolean): void;
}

function splitPath(path: string): { directory: string; basename: string } {
    const parts = path.split(/[\\/]/);
    const basename = parts.pop() ?? path;
    const directory = parts.join("/");
    return { basename, directory: directory ? `${directory}/` : "" };
}

function operationLabel(operation: AgentRewindFileRowView["operation"]): "A" | "M" | "D" {
    if (operation === "create") return "A";
    if (operation === "delete") return "D";
    return "M";
}

function FileStats({ file }: { file: AgentRewindFileRowView }) {
    return (
        <span className="flex shrink-0 gap-1.5 text-[11px] tabular-nums">
            {file.additions == null ? (
                <span
                    aria-label="Additions unavailable"
                    title="Additions unavailable"
                    className="text-muted-foreground"
                >
                    +—
                </span>
            ) : (
                <span className="text-success">+{file.additions}</span>
            )}
            {file.deletions == null ? (
                <span
                    aria-label="Deletions unavailable"
                    title="Deletions unavailable"
                    className="text-muted-foreground"
                >
                    -—
                </span>
            ) : (
                <span className="text-destructive">-{file.deletions}</span>
            )}
        </span>
    );
}

function aggregateStats(files: AgentRewindFileRowView[]): { additions: number | null; deletions: number | null } {
    let additions: number | null = 0;
    let deletions: number | null = 0;

    for (const file of files) {
        if (file.additions == null) {
            additions = null;
        } else if (additions != null) {
            additions += file.additions;
        }

        if (file.deletions == null) {
            deletions = null;
        } else if (deletions != null) {
            deletions += file.deletions;
        }
    }

    return { additions, deletions };
}

function AggregateStats({ additions, deletions }: { additions: number | null; deletions: number | null }) {
    return (
        <span className="flex shrink-0 gap-1.5 tabular-nums">
            {additions == null ? (
                <span aria-label="Additions unavailable" className="text-muted-foreground">
                    +—
                </span>
            ) : (
                <span className="text-success">+{additions}</span>
            )}
            {deletions == null ? (
                <span aria-label="Deletions unavailable" className="text-muted-foreground">
                    -—
                </span>
            ) : (
                <span className="text-destructive">-{deletions}</span>
            )}
        </span>
    );
}

function FileListRow({
    file,
    optionId,
    selected,
    onSelect,
}: {
    file: AgentRewindFileRowView;
    optionId: string;
    selected: boolean;
    onSelect(): void;
}) {
    const { basename, directory } = splitPath(file.path);
    const FileIcon = getFileIcon(basename, false, false);
    const conflict = file.conflict !== "none";

    return (
        <button
            id={optionId}
            type="button"
            role="option"
            aria-selected={selected}
            tabIndex={-1}
            title={file.path}
            onClick={onSelect}
            className={cn(
                "mb-1 grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-transparent px-2 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40",
                selected && "bg-muted/40 text-foreground",
                conflict &&
                    "border-destructive/40 text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10"
            )}
        >
            <FileIcon size={16} className="shrink-0" />
            <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-foreground">{basename}</span>
                {directory && <span className="truncate text-[10px] text-muted-foreground">{directory}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-2">
                <FileStats file={file} />
                <span
                    className={cn(
                        "w-4 text-center text-[10px] font-semibold",
                        file.operation === "create"
                            ? "text-success"
                            : file.operation === "delete"
                              ? "text-destructive"
                              : "text-muted-foreground"
                    )}
                >
                    {operationLabel(file.operation)}
                </span>
            </span>
            {file.reason && (
                <span
                    className={cn(
                        "col-start-2 col-end-4 text-xs text-muted-foreground",
                        conflict && "text-destructive"
                    )}
                >
                    {file.reason}
                </span>
            )}
        </button>
    );
}

function SelectedFileDiff({ file }: { file?: AgentRewindFileRowView }) {
    if (!file) return null;

    if (file.previewUnavailableReason) {
        return (
            <div className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground">
                {file.previewUnavailableReason}
            </div>
        );
    }

    if (!file.diff) {
        return (
            <div className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground">
                No diff content is available for this file.
            </div>
        );
    }

    return <DiffViewer patch={file.diff} size="sm" className="m-0" />;
}

function FilePaneResizeHandle({ onResize }: { onResize(clientX: number): void }) {
    const [dragging, setDragging] = useState(false);

    useEffect(() => {
        if (!dragging) return;

        const onMouseMove = (event: MouseEvent) => onResize(event.clientX);
        const onMouseUp = () => setDragging(false);
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
        return () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
        };
    }, [dragging, onResize]);

    return (
        <div
            role="separator"
            aria-label="Resize file list"
            aria-orientation="vertical"
            onMouseDown={() => setDragging(true)}
            className="absolute top-0 right-0 hidden md:block h-full w-1 cursor-col-resize bg-transparent hover:bg-fg-overlay-2"
        />
    );
}

export function DiffReviewDialog({
    open,
    title,
    files,
    selectedPath,
    loading = false,
    errorMessage,
    warnings = [],
    locked = false,
    emptyMessage = "No workspace files will change.",
    footer,
    onSelectedPathChange,
    onOpenChange,
}: DiffReviewDialogProps) {
    const [filePaneWidth, setFilePaneWidth] = useState(FilePane_DefaultWidth);
    const reviewBodyRef = useRef<HTMLDivElement>(null);
    const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0];
    const selectedIndex = selectedFile ? files.indexOf(selectedFile) : -1;
    const stats = aggregateStats(files);
    const optionId = (index: number) => `diff-review-file-${index}`;
    const fileReasons = new Set(files.flatMap((file) => (file.reason ? [file.reason] : [])));
    const uniqueWarnings = [...new Set(warnings.filter((warning) => warning && !fileReasons.has(warning)))];
    const announcedWarnings = [...new Set(warnings.filter(Boolean))];
    const handleFilePaneResize = useCallback((clientX: number) => {
        if (!reviewBodyRef.current) return;
        const rect = reviewBodyRef.current.getBoundingClientRect();
        const maximumWidth = Math.min(FilePane_MaxWidth, rect.width * 0.6);
        const nextWidth = clientX - rect.left;
        setFilePaneWidth(Math.max(FilePane_MinWidth, Math.min(nextWidth, maximumWidth)));
    }, []);
    const onFileListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        if (files.length === 0) return;
        event.preventDefault();
        const currentIndex = selectedIndex < 0 ? 0 : selectedIndex;
        const nextIndex =
            event.key === "ArrowDown" ? Math.min(currentIndex + 1, files.length - 1) : Math.max(currentIndex - 1, 0);
        onSelectedPathChange(files[nextIndex].path);
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (locked) return;
                onOpenChange(nextOpen);
            }}
        >
            <DialogContent
                showCloseButton={false}
                aria-describedby={undefined}
                className="grid h-[calc(100vh-1rem)] max-h-[calc(100vh-1rem)] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden border-0 p-0 shadow-2xl sm:h-[94vh] sm:max-h-[94vh] sm:w-[96vw] sm:max-w-[96vw]"
            >
                <DialogHeader className="shrink-0 gap-1 border-b border-border px-5 py-4">
                    <div className="flex items-start gap-3">
                        <div
                            data-testid="diff-review-header-icon"
                            className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted/40 text-muted-foreground"
                        >
                            <FileDiffIcon size={18} />
                        </div>
                        <div className="min-w-0 space-y-1">
                            <DialogTitle className="text-base leading-tight">{title}</DialogTitle>
                            <div
                                role="status"
                                aria-atomic="true"
                                className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground"
                            >
                                {loading ? (
                                    <span>Loading files…</span>
                                ) : (
                                    <>
                                        <span>{files.length === 1 ? "1 file" : `${files.length} files`}</span>
                                        <AggregateStats additions={stats.additions} deletions={stats.deletions} />
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                    {uniqueWarnings.map((warning) => (
                        <p key={warning} className="text-sm text-destructive">
                            {warning}
                        </p>
                    ))}
                    <div role="status" aria-label="Review warnings" aria-atomic="true" className="sr-only">
                        {announcedWarnings.map((warning) => (
                            <p key={warning}>{warning}</p>
                        ))}
                    </div>
                    {errorMessage && (
                        <p role="alert" className="text-sm text-destructive">
                            {errorMessage}
                        </p>
                    )}
                </DialogHeader>

                <div
                    ref={reviewBodyRef}
                    data-testid="diff-review-body"
                    style={{ "--diff-review-file-pane-width": `${filePaneWidth}px` } as CSSProperties}
                    className="flex min-h-0 flex-col md:flex-row"
                >
                    <aside className="relative flex min-h-0 w-full shrink-0 basis-[35%] flex-col border-b border-border md:w-[var(--diff-review-file-pane-width)] md:basis-auto md:border-r md:border-b-0">
                        <div className="flex-1 overflow-y-auto p-2">
                            {files.length === 0 ? (
                                <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">
                                    {emptyMessage}
                                </div>
                            ) : (
                                <div
                                    role="listbox"
                                    aria-label="Workspace files"
                                    aria-activedescendant={selectedIndex >= 0 ? optionId(selectedIndex) : undefined}
                                    tabIndex={0}
                                    onKeyDown={onFileListKeyDown}
                                >
                                    {files.map((file, index) => (
                                        <FileListRow
                                            key={file.path}
                                            file={file}
                                            optionId={optionId(index)}
                                            selected={selectedFile?.path === file.path}
                                            onSelect={() => onSelectedPathChange(file.path)}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                        <FilePaneResizeHandle onResize={handleFilePaneResize} />
                    </aside>
                    <main className="min-h-0 min-w-0 flex-1 overflow-auto bg-muted/10 p-3">
                        {loading ? (
                            <div className="grid h-full place-items-center text-sm text-muted-foreground">
                                Loading diff…
                            </div>
                        ) : (
                            <SelectedFileDiff file={selectedFile} />
                        )}
                    </main>
                </div>

                <DialogFooter className="shrink-0 border-t border-border px-5 py-3">{footer}</DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
