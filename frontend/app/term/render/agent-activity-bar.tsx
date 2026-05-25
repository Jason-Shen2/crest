// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AgentActivityBar — a persistent strip directly above the input editor that
// surfaces the agent's live state where the user is already looking, instead
// of burying controls in the (possibly scrolled-off) agent block header.
//
// Mirrors warp's orchestration pill bar (a persistent status+action bar, not
// an in-content control; orchestration_pill_bar.rs): while a run streams it
// shows a "Stop" affordance (warp's "Stop agent", shown only in-progress), and
// it lists messages queued behind the current turn (concurrent sends are
// queued via the harness steer/followUp queues, not run in parallel).
//
// Visual language matches the input bar's ContextChip (cmdblock-input.tsx):
// subtle white/alpha surfaces, 6px radius, muted text — a cohesive card rather
// than loose bordered rows. Spinner + neutral "Working…" follows the
// understated treatment ChatGPT / Claude / Cursor use for an in-progress
// agent, with a single clear Stop pill.
//
// Hidden entirely when the agent is idle with nothing queued.

import { memo } from "react";

import type { PiAgentMessage, UsePiChatStatus } from "@/app/store/use-pi-chat";
import { cn } from "@/util/util";

interface AgentActivityBarProps {
    status: UsePiChatStatus;
    /** Messages queued behind the current run (ordered steer-first). */
    queuedMessages: PiAgentMessage[];
    /** Stop the in-progress run. abort() also clears the queue (harness-side). */
    onStop: () => void;
}

function messageText(m: PiAgentMessage): string {
    const part = m.content?.find((c) => c.type === "text") as { text?: string } | undefined;
    return (part?.text ?? "").trim();
}

export const AgentActivityBar = memo(({ status, queuedMessages, onStop }: AgentActivityBarProps) => {
    const streaming = status === "streaming";
    // Nothing to show when idle and no pending messages.
    if (!streaming && queuedMessages.length === 0) return null;
    return (
        <div className="mb-1.5 flex flex-col gap-1.5 rounded-lg border border-white/10 bg-white/[0.035] px-2.5 py-1.5">
            {streaming && (
                <div className="flex items-center gap-2">
                    <span
                        className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground/70"
                        aria-hidden
                    />
                    <span className="text-[12px] text-foreground/70">Working…</span>
                    <button
                        type="button"
                        onClick={onStop}
                        aria-label="Stop the agent"
                        title="Stop the agent (clears any queued messages)"
                        className={cn(
                            "ml-auto inline-flex items-center gap-1.5 rounded-[6px] border border-white/25 bg-white/[0.08]",
                            "px-2 py-0.5 text-[12px] text-foreground/85 transition-colors cursor-pointer",
                            "hover:bg-white/[0.14] hover:text-foreground"
                        )}
                    >
                        <span className="h-2 w-2 rounded-[2px] bg-current" aria-hidden />
                        Stop
                    </button>
                </div>
            )}
            {queuedMessages.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-secondary/55">
                        Queued
                    </span>
                    {queuedMessages.map((m, i) => (
                        <span
                            key={i}
                            className="inline-block max-w-[240px] truncate rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-foreground/65"
                            title={messageText(m)}
                        >
                            {messageText(m)}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
});
AgentActivityBar.displayName = "AgentActivityBar";
