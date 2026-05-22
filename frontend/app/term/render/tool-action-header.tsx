// Copyright 2026, Crest contributors. SPDX-License-Identifier: Apache-2.0
//
// ToolActionHeader — single-line header strip for a tool-use card.
// Structure derived from warp:
//   app/src/ai/blocklist/inline_action/inline_action_header.rs
// Warp is © 2020-2026 Denver Technologies, Inc., MIT licensed.
//
// Layout (left → right):
//   [status icon]  toolname · tooldesc   [status badge]
//
// Status icon + accent track the tool-use status + approval state.

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import { memo } from "react";

import type { WaveUIDataToolUse } from "./tool-use-card";

export interface ToolActionHeaderProps {
    tool: WaveUIDataToolUse;
}

export const ToolActionHeader = memo(({ tool }: ToolActionHeaderProps) => {
    const { icon, accent, badge } = describe(tool);
    return (
        <div className="flex items-center gap-1.5">
            <UIcon name={icon} size={13} className={cn("shrink-0", accent)} />
            <span className="truncate font-mono text-[12px] text-foreground/95">
                {tool.toolname}
            </span>
            {tool.tooldesc && (
                <span className="truncate font-sans text-[12px] text-secondary/75">
                    · {tool.tooldesc}
                </span>
            )}
            {badge && (
                <span
                    className={cn(
                        "ml-auto shrink-0 rounded px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-wide",
                        badge.className
                    )}
                >
                    {badge.label}
                </span>
            )}
        </div>
    );
});
ToolActionHeader.displayName = "ToolActionHeader";

interface Descriptor {
    icon: string;
    accent: string;
    badge?: { label: string; className: string };
}

function describe(tool: WaveUIDataToolUse): Descriptor {
    if (tool.status === "error") {
        return {
            icon: "alert-circle",
            accent: "text-rose-400",
            badge: { label: "error", className: "bg-rose-500/15 text-rose-300" },
        };
    }
    if (tool.approval === "needs-approval") {
        return {
            icon: "shield-question",
            accent: "text-[var(--ansi-yellow)]",
            badge: { label: "needs approval", className: "bg-amber-500/15 text-amber-300" },
        };
    }
    if (tool.approval === "user-denied") {
        return {
            icon: "x-circle",
            accent: "text-rose-400",
            badge: { label: "denied", className: "bg-rose-500/15 text-rose-300" },
        };
    }
    if (tool.status === "pending") {
        return {
            icon: "clock-loader",
            accent: "text-secondary/85",
            badge: { label: "running", className: "bg-fg-overlay-2/60 text-foreground/75" },
        };
    }
    // status === "completed"
    return {
        icon: "check-circle-broken",
        accent: "text-[var(--ansi-green)]",
    };
}
