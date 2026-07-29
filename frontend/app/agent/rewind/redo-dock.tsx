// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

"use client";

import { Button } from "@/shadcn/ui/button";
import { ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";

export interface RedoDockProps {
    redo: AgentRedoView;
    busy: boolean;
    onRedo: () => void;
}

function countLabel(count: number, singular: string): string {
    return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function RedoFileSummary({ file }: { file: AgentRewindFileRowView }) {
    return (
        <li className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-white/[0.035] px-2.5 py-1.5 text-xs">
            <span className="rounded bg-white/[0.07] px-1.5 py-0.5 uppercase text-secondary">{file.operation}</span>
            {file.oldPath ? <code className="break-all text-secondary line-through">{file.oldPath}</code> : null}
            <code className="min-w-0 flex-1 break-all text-foreground">{file.path}</code>
            {file.additions != null ? <span className="text-green-400">+{file.additions}</span> : null}
            {file.deletions != null ? <span className="text-red-400">-{file.deletions}</span> : null}
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
            className="overflow-hidden rounded-2xl border border-white/[0.10] bg-[rgba(34,34,36,0.62)]"
        >
            <div className="flex items-center gap-2 px-3 py-2">
                <button
                    aria-expanded={expanded}
                    aria-controls={detailsId}
                    aria-label={expanded ? "Hide reverted details" : "Show reverted details"}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-sm"
                    onClick={() => setExpanded((current) => !current)}
                    type="button"
                >
                    <ChevronDownIcon
                        aria-hidden="true"
                        className={`size-4 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
                    />
                    <span className="truncate">
                        Reverted {countLabel(redo.messageCount, "message")} · {countLabel(redo.fileCount, "file")}
                    </span>
                </button>
                <Button className="cursor-pointer" disabled={busy} onClick={onRedo} size="sm">
                    Redo
                </Button>
            </div>
            {expanded ? (
                <div
                    aria-label="Reverted operation details"
                    className="grid max-h-64 gap-2 overflow-y-auto border-t border-white/[0.065] px-3 py-2.5"
                    id={detailsId}
                    role="region"
                >
                    <p className="text-xs text-secondary">Operation {redo.operationId}</p>
                    <blockquote className="rounded-lg border-l-2 border-accent bg-white/[0.035] px-3 py-2 text-sm">
                        {redo.targetPrompt}
                    </blockquote>
                    {redo.files.length > 0 ? (
                        <ul className="grid gap-1.5">
                            {redo.files.map((file, index) => (
                                <RedoFileSummary
                                    file={file}
                                    key={`${file.oldPath ?? ""}\u0000${file.path}\u0000${index}`}
                                />
                            ))}
                        </ul>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}
