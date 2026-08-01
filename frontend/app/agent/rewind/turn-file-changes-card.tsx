// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

"use client";

import { getFileIcon } from "@/app/fileexplorer/file-icon";
import { Button } from "@/shadcn/ui/button";
import { FileDiffIcon, Redo2Icon, Undo2Icon } from "lucide-react";

export interface TurnFileChangesCardProps {
    summary: AgentTurnChangeSummaryView;
    action: "undo" | "redo";
    disabled: boolean;
    onOpenFile(path: string): void;
    onReview(): void;
    onUndo(): void;
    onRedo(): void;
}

function splitPath(path: string): { directory: string; basename: string } {
    const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (separator < 0) return { directory: "", basename: path };
    return {
        directory: path.slice(0, separator + 1),
        basename: path.slice(separator + 1),
    };
}

function Addition({ value }: { value: number | null }) {
    if (value == null) {
        return (
            <span className="text-muted-foreground" aria-label="Additions unavailable" title="Additions unavailable">
                +—
            </span>
        );
    }
    return <span className="text-success">+{value}</span>;
}

function Deletion({ value }: { value: number | null }) {
    if (value == null) {
        return (
            <span className="text-muted-foreground" aria-label="Deletions unavailable" title="Deletions unavailable">
                -—
            </span>
        );
    }
    return <span className="text-destructive">-{value}</span>;
}

export function TurnFileChangesCard({
    summary,
    action,
    disabled,
    onOpenFile,
    onReview,
    onUndo,
    onRedo,
}: TurnFileChangesCardProps) {
    return (
        <section className="overflow-hidden rounded-2xl border border-border bg-card">
            <header aria-label="Turn file changes" className="flex items-center justify-between gap-4 px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                    <div
                        data-testid="turn-file-changes-icon"
                        className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted/40 text-muted-foreground"
                    >
                        <FileDiffIcon className="size-5" />
                    </div>
                    <div className="min-w-0">
                        <p className="font-medium">已编辑 {summary.fileCount} 个文件</p>
                        <div className="flex gap-1.5 text-sm tabular-nums">
                            <Addition value={summary.additions} />
                            <Deletion value={summary.deletions} />
                        </div>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {action === "undo" ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="cursor-pointer"
                            disabled={disabled}
                            onClick={onUndo}
                        >
                            撤销 <Undo2Icon />
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="cursor-pointer"
                            disabled={disabled}
                            onClick={onRedo}
                        >
                            重做 <Redo2Icon />
                        </Button>
                    )}
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="cursor-pointer"
                        disabled={disabled}
                        onClick={onReview}
                    >
                        审核
                    </Button>
                </div>
            </header>
            <div className="border-t border-border py-0.5">
                {summary.files.map((file) => {
                    const { directory, basename } = splitPath(file.path);
                    const FileIcon = getFileIcon(file.path, false, false);
                    return (
                        <button
                            key={file.path}
                            type="button"
                            disabled={disabled}
                            className="flex w-full cursor-pointer items-center justify-between gap-4 px-4 py-3 text-left hover:bg-muted/40 focus-visible:bg-muted/40"
                            onClick={() => onOpenFile(file.path)}
                        >
                            <span className="flex min-w-0 items-center gap-2 break-all">
                                <FileIcon size={16} className="shrink-0 text-muted-foreground" />
                                <span className="min-w-0">
                                    {directory && <span className="text-muted-foreground">{directory}</span>}
                                    <span>{basename}</span>
                                </span>
                            </span>
                            <span className="flex shrink-0 gap-1.5 tabular-nums">
                                <Addition value={file.additions} />
                                <Deletion value={file.deletions} />
                            </span>
                        </button>
                    );
                })}
            </div>
        </section>
    );
}
