// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";

import type { ObservationPresentation, ObservationTone } from "./observation-presentation";

const ToneClasses: Record<ObservationTone, string> = {
    neutral: "border-border text-muted-foreground",
    info: "border-blue-500/40 text-blue-400",
    success: "border-green-500/40 text-green-400",
    warning: "border-yellow-500/40 text-yellow-400",
    error: "border-red-500/40 text-red-400",
};

interface ObservationRowProps {
    observation: AgentObservabilityObservation;
    presentation: ObservationPresentation;
    relativeTime: string;
    expanded: boolean;
    selected: boolean;
    onToggle: () => void;
}

export function ObservationRow({
    observation,
    presentation,
    relativeTime,
    expanded,
    selected,
    onToggle,
}: ObservationRowProps) {
    return (
        <button
            aria-expanded={expanded}
            className={cn(
                "w-full cursor-pointer rounded border px-2 py-2 text-left text-xs transition-colors",
                selected ? "border-accent bg-accent/10" : "border-border/70 bg-fg-overlay-1/20 hover:bg-fg-overlay-1/40"
            )}
            type="button"
            onClick={onToggle}
        >
            <div className="flex min-w-0 items-start gap-2">
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
                    {expanded ? (
                        <div className="mt-2 whitespace-pre-wrap border-t border-border/70 pt-2 text-muted-foreground">
                            {presentation.summary || observation.statusMessage || "No additional details."}
                        </div>
                    ) : null}
                </div>
            </div>
        </button>
    );
}
