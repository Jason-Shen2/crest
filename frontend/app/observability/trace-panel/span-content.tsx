/**
 * SpanContent - Pure span/observation content renderer.
 *
 * Responsibilities:
 * - Render span-specific data (name, metrics, badges, scores)
 * - Apply view preferences (show/hide features)
 * - Format and display metrics with color coding
 */

import { cn } from "@/util/util";
import type { TraceNode } from "./types";

const LevelClassNames: Partial<Record<NonNullable<Observation["level"]>, string>> = {
    ERROR: "bg-error/15 text-error",
    WARNING: "bg-warning/15 text-warning",
    DEFAULT: "bg-fg-overlay-1 text-muted-foreground",
};

function formatIntervalSeconds(seconds: number): string {
    if (!Number.isFinite(seconds)) {
        return "0s";
    }
    if (seconds < 1) {
        return `${Math.round(seconds * 1000)}ms`;
    }
    return `${seconds.toFixed(2)}s`;
}

function formatTokenCounts(
    inputUsage?: number | null,
    outputUsage?: number | null,
    totalUsage?: number | null
): string {
    const total = totalUsage ?? (inputUsage ?? 0) + (outputUsage ?? 0);
    if (inputUsage != null || outputUsage != null) {
        return `${inputUsage ?? 0} in / ${outputUsage ?? 0} out`;
    }
    return `${total} tok`;
}

function formatUsd(value: number): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: value < 0.01 ? 6 : 4,
    }).format(value);
}

function heatMapTextColor({ max, value }: { max: number; value: number }) {
    if (max <= 0) {
        return "";
    }
    const ratio = value / max;
    if (ratio >= 0.66) {
        return "text-error";
    }
    if (ratio >= 0.33) {
        return "text-warning";
    }
    return "";
}

function getSubtreeDurationOverflowMs(
    duration: number | undefined,
    subtreeDuration: number | undefined
): number | null {
    if (duration == null || subtreeDuration == null) {
        return null;
    }
    const overflow = subtreeDuration - duration;
    return overflow > 1 ? subtreeDuration : null;
}

interface SpanContentProps {
    node: TraceNode;
    parentTotalCost?: number;
    parentTotalDuration?: number;
    commentCount?: number;
    onSelect?: () => void;
    onHover?: () => void;
    className?: string;
}

export function SpanContent({
    node,
    parentTotalCost,
    parentTotalDuration,
    commentCount,
    onSelect,
    onHover,
    className,
}: SpanContentProps) {
    const totalCost = node.totalCost;
    const duration =
        node.endTime && node.startTime
            ? node.endTime.getTime() - node.startTime.getTime()
            : node.latency
              ? node.latency * 1000
              : undefined;
    const shouldRenderDuration = Boolean(duration || node.latency);
    const subtreeWallClockOverflowMs = getSubtreeDurationOverflowMs(duration, node.subtreeWallClockDurationMs);
    const shouldRenderSubtreeDuration = shouldRenderDuration && subtreeWallClockOverflowMs != null;
    const shouldRenderCostTokens = Boolean(node.inputUsage || node.outputUsage || node.totalUsage || totalCost);
    const shouldRenderAnyMetrics = shouldRenderDuration || shouldRenderCostTokens;
    const nodeDisplayName = node.name || `Unnamed ${node.type.toLowerCase()}`;

    return (
        <button
            type="button"
            onClick={(event) => {
                event.stopPropagation();
                onSelect?.();
            }}
            onMouseEnter={onHover}
            title={node.name}
            className={cn(
                "peer relative flex min-w-0 flex-1 cursor-pointer items-center rounded-md py-0.5 pr-2 pl-1 text-left",
                className
            )}
        >
            <div className="flex min-w-0 flex-col">
                <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                    <span className="shrink truncate text-xs" title={nodeDisplayName}>
                        {nodeDisplayName}
                    </span>

                    <div className="flex items-center gap-x-2">
                        {commentCount != null && commentCount > 0 && (
                            <span className="rounded-sm bg-fg-overlay-1 px-1 text-xs text-muted-foreground">
                                {commentCount}
                            </span>
                        )}

                        {node.type !== "TRACE" && node.level && node.level !== "DEFAULT" && (
                            <div className="flex">
                                <span className={cn("rounded-sm p-0.5 text-xs", LevelClassNames[node.level])}>
                                    {node.level}
                                </span>
                            </div>
                        )}
                    </div>
                </div>

                {shouldRenderAnyMetrics && (
                    <div className="flex flex-wrap gap-x-2">
                        {shouldRenderDuration && (duration || node.latency) ? (
                            <span
                                title={node.type === "TRACE" ? "Total trace duration" : "Own span duration"}
                                className={cn(
                                    "text-xs text-muted-foreground",
                                    parentTotalDuration &&
                                        heatMapTextColor({
                                            max: parentTotalDuration,
                                            value: duration || (node.latency ? node.latency * 1000 : 0),
                                        })
                                )}
                            >
                                {formatIntervalSeconds((duration || (node.latency ? node.latency * 1000 : 0)) / 1000)}
                            </span>
                        ) : null}

                        {shouldRenderSubtreeDuration ? (
                            <span title="Subtree wall-clock duration" className="text-xs text-muted-foreground">
                                {"Σ "}
                                {formatIntervalSeconds(subtreeWallClockOverflowMs / 1000)}
                            </span>
                        ) : null}

                        {shouldRenderCostTokens && (node.inputUsage || node.outputUsage || node.totalUsage) ? (
                            <span className="text-xs text-muted-foreground">
                                {formatTokenCounts(node.inputUsage, node.outputUsage, node.totalUsage)}
                            </span>
                        ) : null}

                        {shouldRenderCostTokens && totalCost ? (
                            <span
                                title={
                                    node.children.length > 0 || node.type === "TRACE" ? "Aggregated cost" : undefined
                                }
                                className={cn(
                                    "text-xs text-muted-foreground",
                                    parentTotalCost &&
                                        heatMapTextColor({
                                            max: parentTotalCost,
                                            value: totalCost,
                                        })
                                )}
                            >
                                {node.children.length > 0 || node.type === "TRACE" ? "Σ " : ""}
                                {formatUsd(totalCost)}
                            </span>
                        ) : null}
                    </div>
                )}
            </div>
        </button>
    );
}
