// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Icon } from "@/app/icon/Icon";
import { cn } from "@/util/util";
import { memo } from "react";

interface FixedAgentEntryProps {
    active: boolean;
    onActivate: () => void;
}

export const FixedAgentEntry = memo(({ active, onActivate }: FixedAgentEntryProps) => {
    return (
        <button
            aria-label="Agent"
            aria-pressed={active}
            className={cn(
                "mx-0.5 flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[13px] font-medium transition-colors",
                active ? "bg-fg-overlay-2 text-primary" : "text-secondary hover:bg-fg-overlay-1 hover:text-primary"
            )}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            title="Agent"
            type="button"
            onClick={onActivate}
        >
            <Icon name="sparkles" size={13} strokeWidth={1.75} />
            <span>Agent</span>
        </button>
    );
});
FixedAgentEntry.displayName = "FixedAgentEntry";
