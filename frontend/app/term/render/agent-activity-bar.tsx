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
        <div className="mb-1.5 flex flex-col gap-1">
            {streaming && (
                <div className="flex items-center gap-1.5 text-[11px]">
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ansi-yellow)]" />
                    <span className="font-semibold uppercase tracking-wider text-[var(--ansi-yellow)]">
                        Agent running…
                    </span>
                    <button
                        type="button"
                        onClick={onStop}
                        title="Stop the agent (clears any queued messages)"
                        className={cn(
                            "ml-auto inline-flex items-center gap-1.5 rounded border border-fg-overlay-2",
                            "px-2 py-0.5 text-secondary/80 transition-colors cursor-pointer",
                            "hover:bg-fg-overlay-1/60 hover:text-foreground"
                        )}
                    >
                        <span className="inline-block h-2 w-2 rounded-[1px] bg-rose-400" />
                        Stop
                    </button>
                </div>
            )}
            {queuedMessages.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-secondary/70">
                    <span className="uppercase tracking-wider">queued</span>
                    {queuedMessages.map((m, i) => (
                        <span
                            key={i}
                            className="inline-block max-w-[240px] truncate rounded border border-fg-overlay-2 bg-fg-overlay-1/40 px-2 py-0.5 text-foreground/70"
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
