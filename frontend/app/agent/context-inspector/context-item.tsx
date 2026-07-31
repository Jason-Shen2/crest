// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Icon } from "@/app/icon/Icon";
import { useState } from "react";
import { formatContextTokens } from "./context-format";

const ItemLabels: Record<string, string> = {
    base_prompt: "Base instructions",
    runtime_guidance: "Runtime guidance",
    project_instruction: "Project instructions",
    skill: "Skill",
    tool_definition: "Tool definition",
    turn: "Conversation turn",
    user_message: "User",
    assistant_message: "Assistant",
    tool_call: "Tool call",
    tool_result: "Tool result",
    compaction_summary: "Compacted history",
    branch_summary: "Branch summary",
    context_reference: "Added context",
};

function sourceLines(item: AgentContextSnapshotItemView): string[] {
    const source = item.source;
    const lines: string[] = [];
    if (source.path) lines.push(source.path);
    if (source.skillName) lines.push(`Skill: ${source.skillName}`);
    if (source.toolName) lines.push(`Tool: ${source.toolName}`);
    if (source.toolCallId) lines.push(`Call: ${source.toolCallId}`);
    if (source.pairedResultEntryId) lines.push(`Result: ${source.pairedResultEntryId}`);
    if (source.coveredEntryIds?.length) lines.push(`Covers ${source.coveredEntryIds.length} replaced entries`);
    if (source.attachmentEntryId) lines.push(`Attachment: ${source.attachmentEntryId}`);
    if (source.artifactEntryId) lines.push(`Artifact: ${source.artifactEntryId}`);
    if (source.entryIds?.length) lines.push(`Entries: ${source.entryIds.join(", ")}`);
    return lines;
}

export function ContextItem({ item }: { item: AgentContextSnapshotItemView }) {
    const [expanded, setExpanded] = useState(false);
    const sources = sourceLines(item);
    const hasDetail = (item.children?.length ?? 0) > 0 || sources.length > 0 || !!item.diagnostic;
    return (
        <article data-testid="context-inventory-item" className="border-b border-border/45 last:border-b-0">
            <button
                type="button"
                aria-expanded={expanded}
                aria-label={`${item.title}, ${ItemLabels[item.kind] ?? item.kind}`}
                className="flex w-full cursor-pointer items-start gap-2 px-3 py-2.5 text-left outline-none transition-colors hover:bg-fg-overlay-1 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                onClick={() => setExpanded((value) => !value)}
            >
                <Icon
                    name="chevron-right"
                    size={13}
                    className={`mt-0.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
                />
                <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-medium text-foreground">{item.title}</span>
                        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                            {formatContextTokens(item.tokens)}
                        </span>
                    </span>
                    <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-muted-foreground">
                        {ItemLabels[item.kind] ?? item.kind.replaceAll("_", " ")}
                    </span>
                    <span className="mt-1 line-clamp-2 block text-[11px] leading-4 text-muted-foreground">
                        {item.preview || "No preview available"}
                    </span>
                </span>
            </button>
            {expanded ? (
                <div className="space-y-2 border-t border-border/35 bg-fg-overlay-1/35 px-3 py-2.5 pl-8">
                    {item.diagnostic ? (
                        <p className="rounded bg-warning/10 px-2 py-1.5 text-[11px] text-foreground">
                            {item.diagnostic}
                        </p>
                    ) : null}
                    {sources.length > 0 ? (
                        <div className="space-y-0.5 font-mono text-[10px] leading-4 text-muted-foreground">
                            {sources.map((line) => (
                                <div key={line} className="break-all">
                                    {line}
                                </div>
                            ))}
                        </div>
                    ) : null}
                    {item.children?.map((child) => (
                        <div key={child.id} className="rounded-md border border-border/50 bg-panel">
                            <ContextItem item={child} />
                        </div>
                    ))}
                    {!hasDetail ? <div className="text-[11px] text-muted-foreground">No additional provenance.</div> : null}
                </div>
            ) : null}
        </article>
    );
}
