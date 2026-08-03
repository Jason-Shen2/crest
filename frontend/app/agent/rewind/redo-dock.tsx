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
        <li className="-mx-1.5 grid min-h-9 grid-cols-[20px_minmax(0,1fr)_auto_16px] items-center gap-2 rounded-lg px-1.5 py-1 font-mono text-[11.5px] transition-colors hover:bg-muted/40">
            <FileIcon aria-hidden="true" className="shrink-0 text-muted-foreground" size={16} />
            <span className="min-w-0 truncate">
                {directory ? <span className="text-muted-foreground">{directory}</span> : null}
                <span className="text-foreground">{basename}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 tabular-nums">
                {file.additions != null ? <span className="text-success">+{file.additions}</span> : null}
                {file.deletions != null ? <span className="text-destructive">-{file.deletions}</span> : null}
            </span>
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
            className="overflow-hidden rounded-xl border border-border bg-card"
        >
            <div className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2.5 gap-y-2 py-2 pl-3 pr-2 max-sm:grid-cols-[auto_minmax(0,1fr)_auto] [@container(max-width:30rem)]:grid-cols-[auto_minmax(0,1fr)_auto]">
                <span
                    aria-hidden="true"
                    className="grid size-8 shrink-0 place-items-center rounded-lg bg-orange-500/15 text-orange-400"
                    data-slot="redo-status-icon"
                >
                    <Undo2Icon className="size-4" />
                </span>
                <div className="min-w-0 whitespace-nowrap max-sm:block [@container(max-width:30rem)]:block">
                    <p className="shrink-0 text-[13px] font-semibold leading-tight text-foreground">Changes reverted</p>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {countLabel(redo.messageCount, "message")} · {countLabel(redo.fileCount, "file")}
                    </p>
                </div>
                <Button
                    className="cursor-pointer max-sm:col-span-3 max-sm:row-start-2 max-sm:w-full [@container(max-width:30rem)]:col-span-3 [@container(max-width:30rem)]:row-start-2 [@container(max-width:30rem)]:w-full"
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
                    className="grid size-8 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-sm:col-start-3 max-sm:row-start-1 [@container(max-width:30rem)]:col-start-3 [@container(max-width:30rem)]:row-start-1"
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
                    <div className="max-h-[300px] overflow-y-auto py-4 pl-[3.375rem] pr-5 max-sm:px-4 [@container(max-width:30rem)]:px-4">
                        <div className="grid gap-4">
                            <div>
                                <div className="mb-2 flex items-center justify-between gap-2">
                                    <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                        Reverted messages
                                    </p>
                                    <span className="text-[10.5px] text-muted-foreground">{redo.messageCount}</span>
                                </div>
                                <ol className="grid gap-2">
                                    {redo.messages.map((message, index) => (
                                        <li
                                            className="grid grid-cols-[14px_minmax(0,1fr)] gap-2 text-xs leading-relaxed text-foreground/85"
                                            key={`${index}\u0000${message}`}
                                        >
                                            <span
                                                aria-hidden="true"
                                                className="-mt-1 text-xl font-bold text-orange-400"
                                            >
                                                “
                                            </span>
                                            <span className="min-w-0 whitespace-pre-wrap break-words">{message}</span>
                                        </li>
                                    ))}
                                </ol>
                            </div>
                            <div>
                                <div className="mb-1.5 flex items-center justify-between gap-2">
                                    <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                                        Files
                                    </p>
                                    <span className="text-[10.5px] text-muted-foreground">
                                        {redo.fileCount} changed
                                    </span>
                                </div>
                                <ul className="grid">
                                    {redo.files.map((file, index) => (
                                        <RedoFileSummary
                                            file={file}
                                            key={`${file.oldPath ?? ""}\u0000${file.path}\u0000${index}`}
                                        />
                                    ))}
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}
