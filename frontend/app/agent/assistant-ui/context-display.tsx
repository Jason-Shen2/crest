// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Based on assistant-ui (MIT): https://r.assistant-ui.com/base/context-display.json

"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shadcn/ui/tooltip";
import { cn } from "@/util/util";
import type { ComponentProps, FC, ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

export type CrestContextDisplayValue = Pick<
    AgentContextSnapshotView,
    "effectiveInputTokens" | "inputCapacity" | "accuracy" | "lifecycle"
>;

type ContextDisplayContextValue = {
    value: CrestContextDisplayValue | undefined;
    usedTokens: number;
    percent: number;
    inputCapacity: number;
};

type ContextDisplayRootProps = {
    value?: CrestContextDisplayValue | undefined;
    children: ReactNode;
};

type ContextDisplayPresetProps = {
    value?: CrestContextDisplayValue | undefined;
    onOpen?: (() => void) | undefined;
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

export function getContextUsagePercent(usedTokens: number | undefined, inputCapacity: number): number {
    if (!usedTokens || inputCapacity <= 0) return 0;
    return Math.min((usedTokens / inputCapacity) * 100, 100);
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

function ContextDisplayRoot({ value, children }: ContextDisplayRootProps) {
    const usedTokens = value?.effectiveInputTokens ?? 0;
    const inputCapacity = value?.inputCapacity ?? 0;
    const percent = getContextUsagePercent(usedTokens, inputCapacity);
    const contextValue = useMemo(
        () => ({ value, usedTokens, percent, inputCapacity }),
        [value, usedTokens, percent, inputCapacity]
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

function ContextDisplayContent({ side = "top" }: { side?: "top" | "bottom" | "left" | "right" | undefined }) {
    const { value, usedTokens, percent, inputCapacity } = useContextDisplay();

    return (
        <TooltipContent
            side={side}
            sideOffset={8}
            data-slot="context-display-popover"
            className="rounded-xl border border-white/[0.10] bg-[rgba(34,34,36,0.82)] px-3 py-2 text-xs text-foreground shadow-[0_10px_32px_-24px_rgba(0,0,0,0.65)] backdrop-blur-xl [&_span>svg]:hidden!"
        >
            <div className="grid min-w-40 gap-1.5">
                <div className="flex items-center justify-between gap-4">
                    <span className="text-secondary/80">Next call input</span>
                    <span className="font-mono tabular-nums">{Math.round(percent)}%</span>
                </div>
                <div className="mt-0.5 border-t border-white/[0.08] pt-1.5">
                    <div className="flex items-center justify-between gap-4">
                        <span className="text-secondary/80">Used / capacity</span>
                        <span className="font-mono tabular-nums">
                            {formatContextTokenCount(usedTokens)} / {formatContextTokenCount(inputCapacity)}
                        </span>
                    </div>
                </div>
                <div className="text-[11px] text-secondary/70">
                    {value?.accuracy === "exact" ? "Exact provider count" : "Estimated before provider request"}
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

export const ContextDisplayRing: FC<ContextDisplayPresetProps> = ({ value, onOpen, className, side }) => (
    <ContextDisplayRoot value={value}>
        <ContextDisplayTrigger
            className={cn("aui-context-display-ring-trigger size-6 justify-center", className)}
            aria-label={`Open Context Inspector, ${Math.round(
                getContextUsagePercent(value?.effectiveInputTokens, value?.inputCapacity ?? 0)
            )} percent used`}
            onClick={onOpen}
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
