// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceTimeline/TimelineBar.tsx.

import { cn } from "@/util/util";
import type { TimelineTraceNode } from "./timeline-types";

const MinimumBarWidth = 4;

function formatSeconds(seconds: number): string {
    if (seconds < 1) {
        return `${Math.round(seconds * 1000)}ms`;
    }
    return `${Number(seconds.toFixed(2))}s`;
}

function totalTokens(observation: Observation | undefined, row: TimelineTraceNode): number | null {
    const observed = observation?.usageDetails.totalTokens;
    if (Number.isFinite(observed)) {
        return observed;
    }
    return row.node.totalTokens ?? null;
}

function totalCost(observation: Observation | undefined, row: TimelineTraceNode): number | null {
    const observed = observation?.costDetails.total;
    if (Number.isFinite(observed)) {
        return observed;
    }
    return row.node.totalCost ?? null;
}

export function TimelineBar({
    row,
    observation,
    isSelected,
    isHovered,
}: {
    row: TimelineTraceNode;
    observation?: Observation;
    isSelected: boolean;
    isHovered: boolean;
}) {
    const { node } = row;
    const ttft = observation?.timeToFirstToken;
    const ttftWidth =
        ttft != null && Number.isFinite(ttft) && ttft > 0 && row.duration > 0
            ? Math.min(row.width, (ttft / row.duration) * row.width)
            : 0;
    const tokens = totalTokens(observation, row);
    const cost = totalCost(observation, row);
    const toneClass =
        node.level === "ERROR"
            ? "bg-error/70"
            : node.type === "TOOL"
              ? "bg-success/60"
              : node.type === "GENERATION"
                ? "bg-accent/70"
                : "bg-muted-foreground/50";

    return (
        <div className="absolute top-1/2 flex -translate-y-1/2 items-center gap-2" style={{ left: row.startOffset }}>
            <div
                data-testid="timeline-bar"
                className={cn(
                    "relative h-3 overflow-hidden rounded-sm",
                    toneClass,
                    isSelected && "ring-2 ring-accent",
                    isHovered && !isSelected && "ring-1 ring-muted-foreground"
                )}
                style={{ width: Math.max(MinimumBarWidth, row.width) }}
            >
                {ttftWidth > 0 ? (
                    <span className="absolute inset-y-0 left-0 bg-accent/35" style={{ width: ttftWidth }} />
                ) : null}
            </div>
            <div className="flex items-center gap-2 text-[10px] whitespace-nowrap text-muted-foreground">
                <span>{formatSeconds(row.duration)}</span>
                {ttftWidth > 0 ? <span>TTFT {formatSeconds(ttft!)}</span> : null}
                {observation?.model ? <span>{observation.model}</span> : null}
                {tokens != null && tokens > 0 ? <span>{tokens.toLocaleString("en-US")} tokens</span> : null}
                {cost != null && cost > 0 ? <span>${cost.toLocaleString("en-US")}</span> : null}
                {node.level === "ERROR" ? (
                    <span className="text-error">{observation?.statusMessage || "ERROR"}</span>
                ) : null}
            </div>
        </div>
    );
}
