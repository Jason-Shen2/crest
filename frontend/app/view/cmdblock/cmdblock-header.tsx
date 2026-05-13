// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// CmdBlockHeader — the prompt strip at the top of every command block.
//
// Visual reference (target layout): warp terminal block header.  Per the
// reference screenshots, warp uses a two-row prompt block above each
// command's output:
//
//   Row 1 (muted text, no background tint):
//     <env>  <cwd>  (<duration>)              <persistent toolbelt icons>
//   Row 2 (ANSI yellow, only when there is a command):
//     <command>
//
// Notes:
//   * No `>_` sigil / no chip-style git-branch box — warp just inlines
//     env / cwd / branch as plain muted text.
//   * No success ✓ icon — the duration in parentheses is the only "done"
//     signal.  A spinner appears for `running` and an error glyph for
//     `done-err`; everything else is text-only.
//   * No background tint on the header band — the muted text color
//     against the pane background is enough demarcation in warp.  A 1px
//     bottom divider gives the next-row visual cut.

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import { memo } from "react";
import {
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
    venv?: string;
    nodeVersion?: string;
    // Right-side slot — used by the snackbar to inject the dismiss
    // button next to the toolbelt.
    rightSlot?: React.ReactNode;
}

export const CmdBlockHeader = memo(
    ({ state, cwd, home, branch, cmd, durationMs, exitCode, selected, venv, nodeVersion, rightSlot }: CmdBlockHeaderProps) => {
        const prettyCwd = formatPromptCwd(cwd, home ?? "");
        const duration = formatDuration(durationMs);
        const showExit = state === "done-err" && exitCode != null && exitCode !== 0;
        const envLabel = pickEnvLabel(venv, nodeVersion);
        return (
            <div
                className={cn(
                    "flex flex-col gap-0.5 px-3 py-2",
                    "text-[12px] leading-tight",
                    "border-b border-fg-overlay-1",
                    selected && "bg-fg-overlay-1"
                )}
            >
                {/* Row 1: env / cwd / branch / (duration) — all muted.
                    Persistent right slot floats to the far right. */}
                <div className="flex min-w-0 items-center gap-x-2 text-secondary/80">
                    {envLabel && (
                        <span className="shrink-0" title={envLabel}>
                            {envLabel}
                        </span>
                    )}
                    {prettyCwd && (
                        <span className="truncate" title={cwd}>
                            {prettyCwd}
                        </span>
                    )}
                    {branch && (
                        <span className="inline-flex shrink-0 items-center gap-0.5" title={branch}>
                            <UIcon name="git-branch-02" size={11} className="opacity-70" />
                            <span className="max-w-[120px] truncate">{branch}</span>
                        </span>
                    )}
                    {duration && state !== "running" && (
                        <span className="font-mono tabular-nums">
                            ({duration})
                        </span>
                    )}
                    {state === "running" && (
                        <UIcon
                            name="clock-loader"
                            size={11}
                            className="animate-spin"
                            title="Running"
                        />
                    )}
                    {showExit && (
                        <span
                            className="inline-flex shrink-0 items-center gap-1 text-[var(--color-term-error)]"
                            title={`Exit ${exitCode}`}
                        >
                            <UIcon name="x-circle" size={11} />
                            <span className="font-mono text-[10px] tabular-nums">
                                {formatExitCode(exitCode!)}
                            </span>
                        </span>
                    )}
                    <div className="ml-auto flex shrink-0 items-center">{rightSlot}</div>
                </div>

                {/* Row 2: command in ANSI yellow.  Visual reference:
                    warp default_themes.rs:15 — DARK_MODE yellow = #FEFDC2.
                    Skipped entirely when there is no command (e.g. for
                    background or static blocks). */}
                {cmd && (
                    <div
                        className="min-w-0 truncate font-mono text-[var(--ansi-yellow)]"
                        title={cmd}
                    >
                        {cmd}
                    </div>
                )}
            </div>
        );
    }
);
CmdBlockHeader.displayName = "CmdBlockHeader";

// pickEnvLabel — prefer a python virtual env name (the more common
// "active environment" signal in warp's screenshots, e.g. `base` for
// conda), fall back to node version.  Both shorten down to the leaf
// segment when the shell-integration script sent a full path.
function pickEnvLabel(venv?: string, nodeVersion?: string): string | undefined {
    if (venv) return shortenVenv(venv);
    if (nodeVersion) return nodeVersion;
    return undefined;
}

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
