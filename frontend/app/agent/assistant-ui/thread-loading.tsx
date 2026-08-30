// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

"use client";

import { cn } from "@/util/util";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

export const SkeletonDelayMs = 180;
export const LongWaitDelayMs = 3000;

function ThreadLoadingTurn({ userWidth, assistantWidths }: { userWidth: string; assistantWidths: [string, string] }) {
    return (
        <div data-slot="aui_thread-loading-turn" className="flex flex-col gap-3">
            <div
                data-slot="aui_thread-loading-user"
                className={cn(
                    "bg-muted-foreground/15 h-4 self-end rounded-full animate-pulse motion-reduce:animate-none"
                )}
                style={{ width: userWidth }}
            />
            <div data-slot="aui_thread-loading-assistant" className="flex flex-col gap-2">
                {assistantWidths.map((width) => (
                    <div
                        key={width}
                        className="bg-muted-foreground/10 h-3 rounded-full animate-pulse motion-reduce:animate-none"
                        style={{ width }}
                    />
                ))}
            </div>
        </div>
    );
}

export function ThreadLoading() {
    const [visible, setVisible] = useState(false);
    const [longWait, setLongWait] = useState(false);

    useEffect(() => {
        const visibilityTimer = window.setTimeout(() => setVisible(true), SkeletonDelayMs);
        const longWaitTimer = window.setTimeout(() => {
            setVisible(true);
            setLongWait(true);
        }, LongWaitDelayMs);

        return () => {
            window.clearTimeout(visibilityTimer);
            window.clearTimeout(longWaitTimer);
        };
    }, []);

    if (!visible) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            data-slot="aui_thread-loading"
            className="aui-thread-loading animate-in fade-in-0 motion-reduce:animate-none flex flex-col gap-4 py-6 duration-300"
        >
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <RefreshCwIcon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                <span>{longWait ? "Loading a long conversation…" : "Loading conversation…"}</span>
            </div>
            <div aria-hidden="true" data-slot="aui_thread-loading-skeletons" className="flex flex-col gap-6">
                <ThreadLoadingTurn userWidth="38%" assistantWidths={["76%", "52%"]} />
                <ThreadLoadingTurn userWidth="44%" assistantWidths={["68%", "46%"]} />
            </div>
        </div>
    );
}
