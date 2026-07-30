// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useAuiState } from "@assistant-ui/react";
import { ChevronDownIcon, FileTextIcon, LoaderIcon, SearchIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useShallow } from "zustand/shallow";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shadcn/ui/collapsible";
import { cn } from "@/util/util";
import { buildReadActivityModel, buildSearchActivityModel, type ToolActivityPart } from "./tool-activity-model";

const ChipClassName = "rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.92em] text-foreground/85";

function ActivityIcon({ active, kind }: { active: boolean; kind: "search" | "read" }) {
    if (active) {
        return (
            <LoaderIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-spin [animation-duration:0.6s]" />
        );
    }
    const Icon = kind === "search" ? SearchIcon : FileTextIcon;
    return <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />;
}

function ActivityErrors({ errors }: { errors: string[] }) {
    if (errors.length === 0) return null;
    return (
        <div className="ms-6 flex flex-col gap-0.5 text-xs text-destructive">
            {errors.map((error, index) => (
                <span key={`${index}-${error}`}>{error}</span>
            ))}
        </div>
    );
}

export function SearchToolActivity({ parts }: { parts: ToolActivityPart[] }): ReactNode {
    const model = buildSearchActivityModel(parts);
    return (
        <div
            data-slot="tool-activity-search"
            aria-busy={model.active}
            className="text-muted-foreground flex flex-col gap-1 py-1.5 text-sm"
        >
            <div className="flex min-w-0 items-start gap-2">
                <ActivityIcon active={model.active} kind="search" />
                <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                    <span className="font-medium">{model.label}</span>
                    {model.rules.map((rule, index) => (
                        <span className="contents" key={`${index}-${rule.query}`}>
                            {index > 0 && <span>and</span>}
                            <code className={ChipClassName}>{rule.query}</code>
                            {rule.scopes.length > 0 && <span>in</span>}
                            {rule.scopes.map((scope) => (
                                <code className={ChipClassName} key={scope}>
                                    {scope}
                                </code>
                            ))}
                        </span>
                    ))}
                </div>
            </div>
            <ActivityErrors errors={model.errors} />
        </div>
    );
}

export function ReadToolActivity({
    parts,
    workspaceDir,
    onOpenFile,
}: {
    parts: ToolActivityPart[];
    workspaceDir: string;
    onOpenFile?: (path: string) => void;
}): ReactNode {
    const [open, setOpen] = useState(false);
    const model = buildReadActivityModel(parts, workspaceDir);

    return (
        <Collapsible
            data-slot="tool-activity-read"
            aria-busy={model.active}
            open={open}
            onOpenChange={setOpen}
            className="text-muted-foreground flex flex-col text-sm"
        >
            <CollapsibleTrigger asChild>
                <button
                    type="button"
                    aria-expanded={open}
                    className="group/read-trigger flex w-fit cursor-pointer items-start gap-2 py-1.5 text-left transition-colors hover:text-foreground"
                >
                    <ActivityIcon active={model.active} kind="read" />
                    <span className="font-medium">
                        {model.label} <code className={ChipClassName}>{model.summary}</code>
                    </span>
                    <ChevronDownIcon
                        aria-hidden="true"
                        className={cn("mt-0.5 size-4 shrink-0 transition-transform", !open && "-rotate-90")}
                    />
                </button>
            </CollapsibleTrigger>
            <ActivityErrors errors={model.errors} />
            <CollapsibleContent>
                <div className="ms-2 mt-0.5 flex flex-col gap-1 border-s border-white/10 py-1 ps-6">
                    {model.entries.map((entry) =>
                        entry.failed || !onOpenFile ? (
                            <div
                                data-slot="tool-activity-read-file"
                                className={cn("flex items-center gap-1.5", entry.failed && "text-destructive/80")}
                                key={entry.absolutePath}
                            >
                                <span>Read</span>
                                <code className={ChipClassName}>{entry.displayPath}</code>
                            </div>
                        ) : (
                            <button
                                type="button"
                                aria-label={`Open ${entry.displayPath}`}
                                className="flex w-fit cursor-pointer items-center gap-1.5 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                key={entry.absolutePath}
                                onClick={() => onOpenFile(entry.absolutePath)}
                            >
                                <span>Read</span>
                                <code className="rounded bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[0.92em] text-cyan-300">
                                    {entry.displayPath}
                                </code>
                            </button>
                        )
                    )}
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
}

function useToolActivityParts(indices: readonly number[]): ToolActivityPart[] {
    return useAuiState(
        useShallow(
            (state) =>
                indices
                    .map((index) => state.message.parts[index])
                    .filter((part) => part?.type === "tool-call") as ToolActivityPart[]
        )
    );
}

export function SearchToolActivityGroup({ indices }: { indices: readonly number[] }) {
    const parts = useToolActivityParts(indices);
    return <SearchToolActivity parts={parts} />;
}

export function ReadToolActivityGroup({
    indices,
    workspaceDir,
    onOpenFile,
}: {
    indices: readonly number[];
    workspaceDir: string;
    onOpenFile?: (path: string) => void;
}) {
    const parts = useToolActivityParts(indices);
    return <ReadToolActivity parts={parts} workspaceDir={workspaceDir} onOpenFile={onOpenFile} />;
}
