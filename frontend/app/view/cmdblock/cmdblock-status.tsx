// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import { memo } from "react";

// Block lifecycle states.  These map onto the `state` string field that
// pkg/cmdblock writes into CmdBlock.state.  We treat anything we don't
// recognize as "before" so a freshly inserted prompt row renders neutrally.
export type CmdBlockState = "before" | "running" | "done-ok" | "done-err" | "background" | "static";

export function blockStateFromRaw(state: string, exitCode?: number): CmdBlockState {
    if (state === "running") return "running";
    if (state === "background") return "background";
    if (state === "static") return "static";
    if (state === "prompt" || state === "before" || state === "") return "before";
    // "done", "complete", and anything else final → success or error by exit code
    if (exitCode == null || exitCode === 0) return "done-ok";
    return "done-err";
}

interface BlockStatusIconProps {
    state: CmdBlockState;
    size?: number;
    className?: string;
}

// BlockStatusIcon — renders the small lifecycle glyph that sits in the
// block header (top-right of the cwd/branch/cmd row).  Uses UIcon so the
// SVG is themed via currentColor.
export const BlockStatusIcon = memo(({ state, size = 14, className }: BlockStatusIconProps) => {
    if (state === "before") return null;
    if (state === "running") {
        return (
            <UIcon
                name="clock-loader"
                size={size}
                className={cn("animate-spin text-secondary", className)}
                title="Running"
            />
        );
    }
    if (state === "done-ok") {
        return (
            <UIcon
                name="check-circle-broken"
                size={size}
                className={cn("text-emerald-400", className)}
                title="Succeeded"
            />
        );
    }
    if (state === "done-err") {
        return (
            <UIcon
                name="x-circle"
                size={size}
                className={cn("text-rose-400", className)}
                title="Failed"
            />
        );
    }
    if (state === "background") {
        return (
            <UIcon
                name="clock"
                size={size}
                className={cn("text-sky-400", className)}
                title="Background"
            />
        );
    }
    return (
        <UIcon
            name="terminal-input"
            size={size}
            className={cn("text-secondary", className)}
            title="System message"
        />
    );
});
BlockStatusIcon.displayName = "BlockStatusIcon";

// formatDuration — humanized lifetime displayed next to the status icon.
// "1.2s" / "12s" / "1m 30s" cadence: short and tabular.
export function formatDuration(ms: number | undefined): string {
    if (ms == null || ms <= 0) return "";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds - minutes * 60);
    if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
    const hours = Math.floor(minutes / 60);
    const minRemainder = minutes - hours * 60;
    return minRemainder === 0 ? `${hours}h` : `${hours}h ${minRemainder}m`;
}

// formatExitCode — translate a numeric exit code into a human-friendly
// label.  Shell convention: codes in the 128 + SIGNAL range mean the
// process was killed by that signal, so 130 = SIGINT (Ctrl+C), 143 =
// SIGTERM, 137 = SIGKILL, 131 = SIGQUIT.  Anything else just shows
// the numeric code.
export function formatExitCode(code: number): string {
    switch (code) {
        case 130:
            return "interrupted";
        case 131:
            return "quit";
        case 137:
            return "killed";
        case 139:
            return "segfault";
        case 143:
            return "terminated";
        default:
            return `exit ${code}`;
    }
}

// formatPromptCwd — shorten an absolute cwd against the user's home so the
// prompt row reads "~/foo/bar" instead of the full /Users/... prefix.
export function formatPromptCwd(cwd: string | undefined, home: string): string {
    if (!cwd) return "";
    if (home && cwd === home) return "~";
    if (home && cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
    return cwd;
}
