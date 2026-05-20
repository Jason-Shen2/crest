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
//
// Visual reference: warp
// crates/warp_core/src/ui/theme/color.rs:138-152 — ui_green_color,
// ui_error_color, ui_warning_color define the canonical status hexes.
// Using the same values keeps the success/failure/warning signal looking
// like warp at a glance instead of leaning on Tailwind's emerald/rose
// stock palette (which is brighter and reads as a different visual
// language than warp).
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
                className={cn("text-[var(--color-term-success)]", className)}
                title="Succeeded"
            />
        );
    }
    if (state === "done-err") {
        return (
            <UIcon
                name="x-circle"
                size={size}
                className={cn("text-[var(--color-term-error)]", className)}
                title="Failed"
            />
        );
    }
    if (state === "background") {
        return (
            <UIcon
                name="clock"
                size={size}
                className={cn("text-[var(--color-term-accent)]", className)}
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

// ---------- agent watching ----------
//
// When the agent runs a command via shell_exec(background:true) it
// gets a block_id back and may keep polling that block via the
// long_running_read tool.  The user benefits from a visible signal
// that this block is being watched + an explicit hand-off control
// equivalent to the agent calling transfer_to_user.
//
// These components are exported standalone scaffolding — the parent
// renderer (block-element.tsx or wherever we land the wiring) decides
// when to mount them based on whether `block.agentSessionId` is set
// and the underlying command is still running.

interface AgentWatchingBadgeProps {
    // When true, show a pulsing dot — visually distinguishes "agent is
    // actively watching" from the (rarer) "block was started by agent
    // but agent has moved on" case.  Defaults to true; callers can set
    // false when the latest long_running_read result reported the
    // process has exited.
    active?: boolean;
    className?: string;
}

// AgentWatchingBadge — small chip placed next to the block status
// icon to signal "an agent has tools active on this block."  Click
// behavior is intentionally absent: the badge is informational, the
// take-over verb lives on TakeOverButton below.
//
// Visual reference: warp's "watching" pill on long-running blocks
// (`app/src/ai/blocklist/block/view_impl.rs` background section);
// crest uses the same icon-plus-pill silhouette in Tailwind tokens
// rather than warp's pathfinder_color literals.
export const AgentWatchingBadge = memo(({ active = true, className }: AgentWatchingBadgeProps) => {
    return (
        <span
            className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--color-term-accent)]/40 bg-[var(--color-term-accent)]/10 px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-wider text-[var(--color-term-accent)]",
                className
            )}
            title="An agent has tools active on this block"
        >
            <UIcon name="stars-01" size={10} className="shrink-0" />
            <span>Agent</span>
            {active && (
                <span className="ml-0.5 inline-block h-1 w-1 animate-pulse rounded-full bg-[var(--color-term-accent)]" />
            )}
        </span>
    );
});
AgentWatchingBadge.displayName = "AgentWatchingBadge";

interface TakeOverButtonProps {
    // Click handler — wire to "make this block visible if hidden + tell
    // the agent it should stop driving this block."  v1 doesn't include
    // the wshrpc plumbing for the agent-side "stop driving" signal; the
    // FE-side visibility flip is the user-facing half of the contract
    // and is the only thing we render here.
    onTakeOver: () => void;
    className?: string;
}

// TakeOverButton — explicit user-side verb to claim control of an
// agent-watched block.  Symmetric to the agent's `transfer_to_user`
// tool: agent can yield, user can grab.  Both verbs end up at the
// same UI state (block visible, badge gone).
export const TakeOverButton = memo(({ onTakeOver, className }: TakeOverButtonProps) => {
    return (
        <button
            type="button"
            onClick={onTakeOver}
            title="Take over this block — agent stops driving it"
            className={cn(
                "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded border border-fg-overlay-3 bg-fg-overlay-1/40 px-1.5 py-0.5 font-sans text-[11px] text-foreground/85 transition-colors hover:bg-fg-overlay-2/60 hover:text-foreground",
                className
            )}
        >
            <UIcon name="hand" size={11} className="shrink-0" />
            <span>Take over</span>
        </button>
    );
});
TakeOverButton.displayName = "TakeOverButton";
