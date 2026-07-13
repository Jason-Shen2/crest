// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Based on assistant-ui (MIT): https://r.assistant-ui.com/base/context-display.json

"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shadcn/ui/tooltip";
import { cn } from "@/util/util";
import type { ComponentProps, FC, ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

export type CrestContextUsage = {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
};

type ContextDisplayContextValue = {
    usage: CrestContextUsage | undefined;
    totalTokens: number;
    percent: number;
    modelContextWindow: number;
};

type ContextDisplayRootProps = {
    modelContextWindow: number;
    usage?: CrestContextUsage | undefined;
    children: ReactNode;
};

type ContextDisplayPresetProps = {
    modelContextWindow: number;
    usage?: CrestContextUsage | undefined;
    className?: string;
    side?: "top" | "bottom" | "left" | "right";
};

const ContextDisplayContext = createContext<ContextDisplayContextValue | null>(null);

const RingSize = 22;
const RingStroke = 2.5;
const RingRadius = (RingSize - RingStroke) / 2;
const RingCircumference = 2 * Math.PI * RingRadius;

export function formatContextTokenCount(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
    return `${tokens}`;
}

export function getContextUsagePercent(totalTokens: number | undefined, modelContextWindow: number): number {
    if (!totalTokens || modelContextWindow <= 0) return 0;
    return Math.min((totalTokens / modelContextWindow) * 100, 100);
}

function getUsageTotalTokens(usage: CrestContextUsage | undefined): number {
    if (!usage) return 0;
    if (usage.totalTokens && usage.totalTokens > 0) return usage.totalTokens;
    return (
        (usage.inputTokens ?? 0) +
        (usage.cachedInputTokens ?? 0) +
        (usage.outputTokens ?? 0) +
        (usage.reasoningTokens ?? 0)
    );
}

function getStrokeColor(percent: number): string {
    if (percent > 85) return "stroke-red-500";
    if (percent >= 65) return "stroke-amber-500";
    return "stroke-emerald-500";
}

function useContextDisplay(): ContextDisplayContextValue {
    const ctx = useContext(ContextDisplayContext);
    if (!ctx) {
        throw new Error("ContextDisplay.* must be used within ContextDisplay.Root");
    }
    return ctx;
}

function ContextDisplayRoot({ modelContextWindow, usage, children }: ContextDisplayRootProps) {
    const totalTokens = getUsageTotalTokens(usage);
    const percent = getContextUsagePercent(totalTokens, modelContextWindow);
    const contextValue = useMemo(
        () => ({ usage, totalTokens, percent, modelContextWindow }),
        [usage, totalTokens, percent, modelContextWindow]
    );

    return (
        <ContextDisplayContext.Provider value={contextValue}>
            <TooltipProvider delayDuration={0}>
                <Tooltip>{children}</Tooltip>
            </TooltipProvider>
        </ContextDisplayContext.Provider>
    );
}

function ContextDisplayTrigger({ className, children, ...props }: ComponentProps<"button">) {
    return (
        <TooltipTrigger asChild>
            <button
                type="button"
                data-slot="context-display-trigger"
                className={cn(
                    "aui-context-display-trigger inline-flex cursor-pointer items-center rounded-full text-secondary transition-colors hover:bg-fg-overlay-1 hover:text-foreground",
                    className
                )}
                {...props}
            >
                {children}
            </button>
        </TooltipTrigger>
    );
}

function UsageRow({ label, value }: { label: string; value: number | undefined }) {
    if (value == null || value <= 0) return null;
    return (
        <div className="flex items-center justify-between gap-4">
            <span className="text-secondary/80">{label}</span>
            <span className="font-mono tabular-nums text-foreground">{formatContextTokenCount(value)}</span>
        </div>
    );
}

function ContextDisplayContent({ side = "top" }: { side?: "top" | "bottom" | "left" | "right" | undefined }) {
    const { usage, totalTokens, percent, modelContextWindow } = useContextDisplay();

    return (
        <TooltipContent
            side={side}
            sideOffset={8}
            data-slot="context-display-popover"
            className="rounded-xl border border-white/[0.10] bg-[rgba(34,34,36,0.82)] px-3 py-2 text-xs text-foreground shadow-[0_10px_32px_-24px_rgba(0,0,0,0.65)] backdrop-blur-xl [&_span>svg]:hidden!"
        >
            <div className="grid min-w-40 gap-1.5">
                <div className="flex items-center justify-between gap-4">
                    <span className="text-secondary/80">Usage</span>
                    <span className="font-mono tabular-nums">{Math.round(percent)}%</span>
                </div>
                <UsageRow label="Input" value={usage?.inputTokens} />
                <UsageRow label="Cached" value={usage?.cachedInputTokens} />
                <UsageRow label="Output" value={usage?.outputTokens} />
                <UsageRow label="Reasoning" value={usage?.reasoningTokens} />
                <div className="mt-0.5 border-t border-white/[0.08] pt-1.5">
                    <div className="flex items-center justify-between gap-4">
                        <span className="text-secondary/80">Total</span>
                        <span className="font-mono tabular-nums">
                            {formatContextTokenCount(totalTokens)} / {formatContextTokenCount(modelContextWindow)}
                        </span>
                    </div>
                </div>
            </div>
        </TooltipContent>
    );
}

function RingVisual() {
    const { percent } = useContextDisplay();
    const roundedPercent = Math.round(percent);

    return (
        <span className="relative inline-flex size-[22px] items-center justify-center">
            <svg
                aria-hidden="true"
                width={RingSize}
                height={RingSize}
                viewBox={`0 0 ${RingSize} ${RingSize}`}
                className="aui-context-display-ring -rotate-90 opacity-85"
            >
                <circle
                    cx={RingSize / 2}
                    cy={RingSize / 2}
                    r={RingRadius}
                    fill="none"
                    strokeWidth={RingStroke}
                    className="stroke-white/[0.12]"
                />
                <circle
                    cx={RingSize / 2}
                    cy={RingSize / 2}
                    r={RingRadius}
                    fill="none"
                    strokeWidth={RingStroke}
                    strokeLinecap="round"
                    strokeDasharray={RingCircumference}
                    strokeDashoffset={RingCircumference - (percent / 100) * RingCircumference}
                    className={cn("transition-[stroke-dashoffset,stroke] duration-300", getStrokeColor(percent))}
                />
            </svg>
            <span className="sr-only">Context usage {roundedPercent}%</span>
        </span>
    );
}

export const ContextDisplayRing: FC<ContextDisplayPresetProps> = ({ modelContextWindow, usage, className, side }) => (
    <ContextDisplayRoot modelContextWindow={modelContextWindow} usage={usage}>
        <ContextDisplayTrigger
            className={cn("aui-context-display-ring-trigger size-6 justify-center", className)}
            aria-label="Context usage"
        >
            <RingVisual />
        </ContextDisplayTrigger>
        <ContextDisplayContent side={side} />
    </ContextDisplayRoot>
);

export const ContextDisplay = {
    Ring: ContextDisplayRing,
    Root: ContextDisplayRoot,
    Trigger: ContextDisplayTrigger,
    Content: ContextDisplayContent,
};
