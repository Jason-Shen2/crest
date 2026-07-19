// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";

import { ObservationDetail } from "./observation-detail";
import type { ObservationPresentation, ObservationTone } from "./observation-presentation";

const ToneClasses: Record<ObservationTone, string> = {
    neutral: "border-border text-muted-foreground",
    info: "border-accent/40 text-accent",
    success: "border-success/40 text-success",
    warning: "border-warning/40 text-warning",
    error: "border-error/40 text-error",
};

interface ObservationRowProps {
    observation: AgentObservabilityObservation;
    presentation: ObservationPresentation;
    relativeTime: string;
    expanded: boolean;
    selected: boolean;
    renderInlineDetail?: boolean;
    onToggle: () => void;
}

export function ObservationRow({
    observation,
    presentation,
    relativeTime,
    expanded,
    selected,
    renderInlineDetail = true,
    onToggle,
}: ObservationRowProps) {
    return (
        <div className="w-full text-xs">
            <button
                aria-expanded={expanded}
                className={cn(
                    "flex w-full min-w-0 cursor-pointer items-start gap-2 rounded border px-2 py-2 text-left transition-colors",
                    selected
                        ? "border-accent bg-accent/10"
                        : "border-border/70 bg-fg-overlay-1/20 hover:bg-fg-overlay-1/40"
                )}
                type="button"
                onClick={onToggle}
            >
                <span className="w-12 shrink-0 font-mono text-[10px] text-muted-foreground">{relativeTime}</span>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className={cn("font-medium", ToneClasses[presentation.tone])}>{presentation.label}</span>
                        {presentation.badges.map((badge) => (
                            <span
                                key={`${badge.label}-${badge.tone}`}
                                className={cn("rounded border px-1 py-px text-[10px]", ToneClasses[badge.tone])}
                            >
                                {badge.label}
                            </span>
                        ))}
                    </div>
                    {presentation.summary ? (
                        <div className="mt-0.5 truncate text-muted-foreground">{presentation.summary}</div>
                    ) : null}
                </div>
            </button>
            {renderInlineDetail && expanded ? (
                <div className="mt-2 border-t border-border/70 pt-3">
                    <ObservationDetail observation={observation} />
                </div>
            ) : null}
        </div>
    );
}
