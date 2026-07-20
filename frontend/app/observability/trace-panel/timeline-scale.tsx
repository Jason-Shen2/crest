// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse TraceTimeline/TimelineScale.tsx.

import { calculateStepSize, ScaleWidth } from "./timeline-calculations";

function formatTick(seconds: number): string {
    if (seconds < 1) {
        return `${Math.round(seconds * 1000)}ms`;
    }
    if (seconds < 60) {
        return `${seconds.toFixed(2)}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
}

export function TimelineScale({
    traceDuration,
    scaleWidth = ScaleWidth,
}: {
    traceDuration: number;
    scaleWidth?: number;
}) {
    const stepSize = calculateStepSize(traceDuration, scaleWidth);
    const markerCount =
        stepSize > 0 && Number.isFinite(traceDuration) ? Math.min(Math.floor(traceDuration / stepSize) + 1, 10_000) : 1;

    return (
        <div data-testid="timeline-scale" className="relative h-7" style={{ width: scaleWidth }}>
            {Array.from({ length: markerCount }, (_, index) => {
                const value = stepSize * index;
                const left = traceDuration > 0 ? (value / traceDuration) * scaleWidth : 0;
                return (
                    <div
                        key={value}
                        className="absolute h-full border-l border-border/60"
                        style={{ left }}
                        data-testid="timeline-scale-tick"
                    >
                        <span className="absolute left-1 font-mono text-[9px] whitespace-nowrap text-muted-foreground">
                            {formatTick(value)}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
