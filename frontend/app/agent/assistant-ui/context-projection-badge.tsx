// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

"use client";

import type { ReactNode } from "react";

function representationLabel(value: AgentContextRenderedRepresentation | AgentContextRepresentation | undefined) {
    if (!value) return "—";
    return value[0].toUpperCase() + value.slice(1);
}

function deliveryScopeLabel(value: AgentContextDeliveryScope) {
    return value === "conversation" ? "Conversation" : "This message";
}

export function projectionCounts(report: AgentContextProjectionReportView) {
    let included = 0;
    let attention = 0;
    for (const item of report.items) {
        if (item.renderedRepresentation === "attention") {
            attention += 1;
        } else {
            included += 1;
        }
    }
    return { included, attention };
}

function ProjectionItem({ item }: { item: AgentContextProjectionItemReportView }): ReactNode {
    const title = item.sourceSessionTitle || item.sourceSessionId || item.attachmentEntryId;
    return (
        <li className="rounded-md border border-border/50 bg-background/50 p-2">
            <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-medium text-foreground">{title}</span>
                <span className="shrink-0 text-muted-foreground">{item.advisoryTokens.toLocaleString()} tokens</span>
            </div>
            {item.sourcePreview && <p className="mt-1 line-clamp-2 text-muted-foreground">{item.sourcePreview}</p>}
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-muted-foreground">
                <dt>Requested</dt>
                <dd>{representationLabel(item.requestedRepresentation)}</dd>
                <dt>Rendered</dt>
                <dd>{representationLabel(item.renderedRepresentation)}</dd>
                <dt>Delivery</dt>
                <dd>{deliveryScopeLabel(item.deliveryScope)}</dd>
                <dt>Reason</dt>
                <dd>{item.reason.replace("_", " ")}</dd>
            </dl>
        </li>
    );
}

export function ContextProjectionBadge({ report }: { report: AgentContextProjectionReportView }): ReactNode {
    const counts = projectionCounts(report);
    return (
        <details className="mb-2 rounded-lg border border-border/60 bg-background/60 text-xs">
            <summary
                className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Show context projection details"
            >
                <span className="font-medium text-foreground">Context</span>
                <span>Included {counts.included}</span>
                {counts.attention > 0 && <span>Attention {counts.attention}</span>}
            </summary>
            <div className="border-t border-border/50 px-3 py-2">
                <ul className="space-y-2">
                    {report.items.map((item) => (
                        <ProjectionItem key={item.attachmentEntryId} item={item} />
                    ))}
                </ul>
                <label className="mt-2 block text-muted-foreground">
                    Overlay SHA-256
                    <input
                        className="mt-1 w-full cursor-text rounded border border-border/50 bg-background px-2 py-1 font-mono text-[11px] text-foreground"
                        aria-label="Overlay SHA-256"
                        readOnly
                        value={report.overlaySha256}
                        onFocus={(event) => event.currentTarget.select()}
                    />
                </label>
            </div>
        </details>
    );
}
