// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import { memo } from "react";
import {
    BlockStatusIcon,
    CmdBlockState,
    formatDuration,
    formatExitCode,
    formatPromptCwd,
} from "./cmdblock-status";

export interface CmdBlockHeaderProps {
    state: CmdBlockState;
    cwd?: string;
    home?: string;
    branch?: string;
    cmd?: string;
    durationMs?: number;
    exitCode?: number;
    selected?: boolean;
    // Environment badges — populated by OSC 133;P k=v from the shell
    // integration script (virtual_env / conda_env / node_version).
    venv?: string;
    nodeVersion?: string;
    // Optional right-side slot (toolbelt or extra metadata).  We keep the
    // toolbelt rendering as a slot so the header doesn't have to know which
    // affordances are wired for a given block (different types of blocks —
    // e.g. background vs static — surface different actions).
    rightSlot?: React.ReactNode;
}

// CmdBlockHeader — the prompt-row strip at the top of every command block.
// Layout (left → right):
//   [path indicator] cwd  ⌥ branch    cmd…    [status icon] duration     [right slot]
// The cmd text wraps if long; the status + duration cluster pins to the
// right edge and the optional slot floats further out for the toolbelt.
export const CmdBlockHeader = memo(
    ({ state, cwd, home, branch, cmd, durationMs, exitCode, selected, venv, nodeVersion, rightSlot }: CmdBlockHeaderProps) => {
        const prettyCwd = formatPromptCwd(cwd, home ?? "");
        const duration = formatDuration(durationMs);
        const showExit = state === "done-err" && exitCode != null && exitCode !== 0;
        return (
            <div
                className={cn(
                    "flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5",
                    "text-[12px] leading-tight",
                    selected && "bg-fg-overlay-1"
                )}
            >
                {/* Left: cwd + branch */}
                <div className="flex min-w-0 items-center gap-1.5 text-secondary">
                    <UIcon name="terminal" size={12} className="shrink-0 text-secondary/70" />
                    {prettyCwd && (
                        <span className="truncate text-foreground/85" title={cwd}>
                            {prettyCwd}
                        </span>
                    )}
                    {branch && (
                        <span className="inline-flex shrink-0 items-center gap-0.5 text-[#b8f2c0]">
                            <UIcon name="git-branch-02" size={11} className="opacity-85" />
                            <span className="max-w-[120px] truncate" title={branch}>
                                {branch}
                            </span>
                        </span>
                    )}
                    {venv && (
                        <span
                            className="inline-flex shrink-0 items-center gap-0.5 text-[#c7b8f2]"
                            title={`virtual env: ${venv}`}
                        >
                            <UIcon name="box" size={11} className="opacity-85" />
                            <span className="max-w-[100px] truncate">{shortenVenv(venv)}</span>
                        </span>
                    )}
                    {nodeVersion && (
                        <span
                            className="inline-flex shrink-0 items-center gap-0.5 text-[#f2d5b8]"
                            title={`node ${nodeVersion}`}
                        >
                            <UIcon name="hexagon" size={11} className="opacity-85" />
                            <span className="max-w-[60px] truncate">{nodeVersion}</span>
                        </span>
                    )}
                </div>

                {/* Middle: command text */}
                {cmd && (
                    <div
                        className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground"
                        title={cmd}
                    >
                        {cmd}
                    </div>
                )}

                {/* Right: status + duration */}
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    {showExit && (
                        <span className="font-mono text-[10px] tabular-nums text-rose-400/85">
                            {formatExitCode(exitCode!)}
                        </span>
                    )}
                    {duration && (
                        <span className="font-mono text-[10px] tabular-nums text-secondary/70">
                            {duration}
                        </span>
                    )}
                    <BlockStatusIcon state={state} />
                </div>

                {rightSlot}
            </div>
        );
    }
);
CmdBlockHeader.displayName = "CmdBlockHeader";

// shortenVenv — extract a friendly env name from a full path.  A common
// shell-integration value is the absolute path of the active venv
// directory; the user only cares about the basename, and even that's
// often a generic ".venv" — so we walk one level up when the basename
// is a dotfile-like marker.
function shortenVenv(value: string): string {
    if (!value) return value;
    const parts = value.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) return value;
    const last = parts[parts.length - 1];
    if ((last === ".venv" || last === "venv" || last === "env") && parts.length >= 2) {
        return parts[parts.length - 2];
    }
    return last;
}
