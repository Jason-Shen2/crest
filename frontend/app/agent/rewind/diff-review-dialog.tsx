// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

"use client";

import { DiffViewer } from "@/app/agent/assistant-ui/diff-viewer";
import { getFileIcon } from "@/app/fileexplorer/file-icon";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shadcn/ui/dialog";
import { cn } from "@/util/util";
import type { KeyboardEvent, ReactNode } from "react";

export interface DiffReviewDialogProps {
    open: boolean;
    title: string;
    description: string;
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

export function DiffReviewDialog({
    open,
    title,
    description,
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
    const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0];
    const selectedIndex = selectedFile ? files.indexOf(selectedFile) : -1;
    const optionId = (index: number) => `diff-review-file-${index}`;
    const fileReasons = new Set(files.flatMap((file) => (file.reason ? [file.reason] : [])));
    const uniqueWarnings = [...new Set(warnings.filter((warning) => warning && !fileReasons.has(warning)))];
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
                className="grid h-[min(720px,calc(100vh-4rem))] max-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-[min(1100px,calc(100vw-4rem))]"
            >
                <DialogHeader className="shrink-0 gap-1 border-b border-border px-5 py-4">
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                    {uniqueWarnings.map((warning) => (
                        <p key={warning} className="text-sm text-destructive">
                            {warning}
                        </p>
                    ))}
                    {errorMessage && (
                        <p role="alert" className="text-sm text-destructive">
                            {errorMessage}
                        </p>
                    )}
                </DialogHeader>

                <div className="grid min-h-0 grid-rows-[minmax(120px,35%)_minmax(0,1fr)] md:grid-cols-[minmax(220px,30%)_minmax(0,1fr)] md:grid-rows-1">
                    <aside className="min-h-0 overflow-y-auto border-b border-border p-2 md:border-r md:border-b-0">
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
                    </aside>
                    <main className="min-h-0 overflow-auto bg-muted/10 p-3">
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
