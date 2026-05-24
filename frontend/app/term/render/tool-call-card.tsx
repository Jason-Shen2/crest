// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// ToolCallCard — renders one pi tool call + its paired toolResult.
// Replaces the old ToolUseCard (which carried the Wave-era
// approval / askquestion / citation / diff UX). Pi's tool model is
// lean: a toolCall content block on an assistant message + a separate
// toolResult message bound by toolUseId. This card just shows what
// happened: name + abbreviated input + result content (or error).
//
// Status:
//   - "running"   — no paired toolResult yet (stream in progress)
//   - "done"      — paired toolResult exists with isError = false
//   - "error"     — paired toolResult exists with isError = true
//
// No approval flow, no diff view, no askquestion takeover, no
// citations — those were Wave-era UX bound to tools we've now
// deprecated. If a future tool needs richer presentation, it should
// own a custom card variant rather than retrofit this one.

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import { memo, useMemo, useState } from "react";

export interface PiToolCall {
    id: string;
    name: string;
    input: unknown;
}

export interface PiToolResultContent {
    /** Result body content. Pi shape: array of TextContent | ImageContent. */
    content?: Array<{ type: string; text?: string; [field: string]: unknown }>;
    isError?: boolean;
}

export interface ToolCallCardProps {
    call: PiToolCall;
    /** Paired tool result, when available (undefined while running). */
    result?: PiToolResultContent;
}

type Status = "running" | "done" | "error";

const PREVIEW_MAX_LEN = 120;

function deriveStatus(result: PiToolResultContent | undefined): Status {
    if (!result) return "running";
    return result.isError ? "error" : "done";
}

function describeStatus(status: Status): { icon: string; accent: string; badge?: string } {
    switch (status) {
        case "error":
            return { icon: "alert-circle", accent: "text-rose-400", badge: "error" };
        case "running":
            return { icon: "clock-loader", accent: "text-secondary/85", badge: "running" };
        case "done":
            return { icon: "check-circle-broken", accent: "text-[var(--ansi-green)]" };
    }
}

/**
 * One-line preview of the tool input. JSON-stringified, collapsed to
 * a single line, truncated. The full input is visible in the expanded
 * body when the user clicks to expand.
 */
function previewInput(input: unknown): string {
    try {
        const json = JSON.stringify(input);
        const oneLine = json.replace(/\s+/g, " ").trim();
        if (oneLine.length <= PREVIEW_MAX_LEN) return oneLine;
        return `${oneLine.slice(0, PREVIEW_MAX_LEN)}…`;
    } catch {
        return String(input);
    }
}

/**
 * Render the result content as plain text. Pi puts everything in a
 * content array; for text-only results (the common case in v1) we
 * concat the text parts. Image / structured parts aren't rendered
 * yet — they'd render as "[image]" / "[structured]" stubs.
 */
function renderResultText(result: PiToolResultContent | undefined): string {
    if (!result || !result.content) return "";
    const parts: string[] = [];
    for (const c of result.content) {
        if (c.type === "text" && typeof c.text === "string") {
            parts.push(c.text);
        } else if (c.type === "image") {
            parts.push("[image]");
        } else {
            parts.push(`[${c.type}]`);
        }
    }
    return parts.join("\n");
}

export const ToolCallCard = memo(({ call, result }: ToolCallCardProps) => {
    const status = deriveStatus(result);
    const { icon, accent, badge } = describeStatus(status);
    const [expanded, setExpanded] = useState(false);
    const inputPreview = useMemo(() => previewInput(call.input), [call.input]);
    const fullInputJson = useMemo(() => {
        try {
            return JSON.stringify(call.input, null, 2);
        } catch {
            return String(call.input);
        }
    }, [call.input]);
    const resultText = useMemo(() => renderResultText(result), [result]);

    return (
        <div
            className={cn(
                "my-2 overflow-hidden rounded border border-fg-overlay-2 bg-fg-overlay-1/30",
                status === "error" && "border-rose-500/40",
            )}
            data-tool-callid={call.id}
            data-tool-status={status}
        >
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="flex w-full items-center gap-1.5 border-b border-transparent px-2 py-1.5 text-left hover:bg-fg-overlay-1/60"
            >
                <UIcon name={icon} size={13} className={cn("shrink-0", accent)} />
                <span className="shrink-0 font-mono text-[12px] text-foreground/95">{call.name}</span>
                <span className="truncate font-mono text-[11px] text-secondary/70">
                    {inputPreview}
                </span>
                {badge && (
                    <span
                        className={cn(
                            "ml-auto shrink-0 rounded px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-wide",
                            status === "error"
                                ? "bg-rose-500/15 text-rose-300"
                                : "bg-fg-overlay-2/60 text-foreground/75",
                        )}
                    >
                        {badge}
                    </span>
                )}
                <UIcon
                    name={expanded ? "chevron-down" : "chevron-right"}
                    size={11}
                    className="shrink-0 text-secondary/60"
                />
            </button>
            {expanded && (
                <div className="border-t border-fg-overlay-2/60 px-2 py-1.5 text-[11px] font-mono">
                    <div className="mb-1 text-secondary/60 uppercase tracking-wide text-[10px]">
                        input
                    </div>
                    <pre className="mb-2 whitespace-pre-wrap break-words text-foreground/90">
                        {fullInputJson}
                    </pre>
                    {result && (
                        <>
                            <div className="mb-1 text-secondary/60 uppercase tracking-wide text-[10px]">
                                {status === "error" ? "error" : "result"}
                            </div>
                            <pre
                                className={cn(
                                    "whitespace-pre-wrap break-words",
                                    status === "error" ? "text-rose-300" : "text-foreground/90",
                                )}
                            >
                                {resultText || "(empty)"}
                            </pre>
                        </>
                    )}
                </div>
            )}
        </div>
    );
});
ToolCallCard.displayName = "ToolCallCard";
