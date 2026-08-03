// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

"use client";

import { getFileIcon } from "@/app/fileexplorer/file-icon";
import { Button } from "@/shadcn/ui/button";
import { cn } from "@/util/util";
import { ChevronDownIcon, Redo2Icon, Undo2Icon } from "lucide-react";
import { useId, useState } from "react";

export interface RedoDockProps {
    redo: AgentRedoView;
    busy: boolean;
    onRedo: () => void;
}

function countLabel(count: number, singular: string): string {
    return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function splitPath(path: string): { directory: string; basename: string } {
    const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (separator < 0) return { directory: "", basename: path };
    return {
        directory: path.slice(0, separator + 1),
        basename: path.slice(separator + 1),
    };
}

function operationLabel(operation: AgentRewindFileRowView["operation"]): "A" | "M" | "D" {
    if (operation === "create") return "A";
    if (operation === "delete") return "D";
    return "M";
}

function RedoFileSummary({ file }: { file: AgentRewindFileRowView }) {
    const { directory, basename } = splitPath(file.path);
    const FileIcon = getFileIcon(basename, false, false);
    const operation = operationLabel(file.operation);

    return (
        <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition-colors hover:bg-muted/40">
            <FileIcon aria-hidden="true" className="shrink-0 text-muted-foreground" size={16} />
            <span className="min-w-0 break-all">
                {directory ? <span className="text-muted-foreground">{directory}</span> : null}
                <span className="text-foreground">{basename}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 tabular-nums">
                {file.additions != null ? <span className="text-success">+{file.additions}</span> : null}
                {file.deletions != null ? <span className="text-destructive">-{file.deletions}</span> : null}
                <span
                    className={cn(
                        "w-4 text-center text-[10px] font-semibold",
                        operation === "A"
                            ? "text-success"
                            : operation === "D"
                              ? "text-destructive"
                              : "text-muted-foreground"
                    )}
                >
                    {operation}
                </span>
            </span>
        </li>
    );
}

export function RedoDock({ redo, busy, onRedo }: RedoDockProps) {
    const [expanded, setExpanded] = useState(false);
    const detailsId = useId();

    return (
        <section
            aria-label="Reverted workspace changes"
            aria-busy={busy}
            className="overflow-hidden rounded-2xl border border-border bg-card"
        >
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-2 px-3 py-2.5 max-sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                <span
                    aria-hidden="true"
                    className="grid size-8 shrink-0 place-items-center rounded-lg bg-orange-500/15 text-orange-400"
                >
                    <Undo2Icon className="size-4" />
                </span>
                <div className="flex min-w-0 items-baseline gap-2 whitespace-nowrap max-sm:block">
                    <p className="shrink-0 text-sm font-medium text-foreground">Changes reverted</p>
                    <p className="truncate text-xs text-muted-foreground">
                        {countLabel(redo.messageCount, "message")} · {countLabel(redo.fileCount, "file")}
                    </p>
                </div>
                <Button
                    className="cursor-pointer max-sm:col-span-3 max-sm:row-start-2 max-sm:w-full"
                    disabled={busy}
                    onClick={onRedo}
                    size="sm"
                    type="button"
                >
                    <Redo2Icon aria-hidden="true" />
                    Redo
                </Button>
                <button
                    aria-expanded={expanded}
                    aria-controls={detailsId}
                    aria-label={expanded ? "Hide reverted details" : "Show reverted details"}
                    className="grid size-8 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-sm:col-start-3 max-sm:row-start-1"
                    onClick={() => setExpanded((current) => !current)}
                    type="button"
                >
                    <ChevronDownIcon
                        aria-hidden="true"
                        className={cn(
                            "size-4 transition-transform duration-200 motion-reduce:transition-none",
                            expanded && "rotate-180"
                        )}
                    />
                </button>
            </div>
            <div
                aria-hidden={!expanded}
                aria-label={expanded ? "Reverted operation details" : undefined}
                className={cn(
                    "grid border-t border-border transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
                    expanded ? "grid-rows-[1fr] opacity-100" : "pointer-events-none grid-rows-[0fr] opacity-0"
                )}
                id={detailsId}
                role={expanded ? "region" : undefined}
            >
                <div className="min-h-0 overflow-hidden">
                    <div className="max-h-64 overflow-y-auto px-3 py-3">
                        <div className="grid gap-3">
                            <div className="grid gap-1">
                                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                    Reverted request
                                </p>
                                <blockquote className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
                                    {redo.targetPrompt}
                                </blockquote>
                            </div>
                            <div className="grid gap-1.5">
                                <div className="flex items-center justify-between gap-2">
                                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                        Files
                                    </p>
                                    <span className="text-xs text-muted-foreground">
                                        {countLabel(redo.fileCount, "file")}
                                    </span>
                                </div>
                                {redo.files.length > 0 ? (
                                    <ul className="grid gap-0.5">
                                        {redo.files.map((file, index) => (
                                            <RedoFileSummary
                                                file={file}
                                                key={`${file.oldPath ?? ""}\u0000${file.path}\u0000${index}`}
                                            />
                                        ))}
                                    </ul>
                                ) : null}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}
