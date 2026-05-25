// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AgentActivityBar — the agent footer strip between the conversation and the
// input editor. Modeled on warp's bottom orchestration/message bar (see the
// running-state screenshot): a thin full-width row with the working status on
// the left and a compact Stop chip on the right, shown only while in progress.
//
// Warp's Stop is a separate, in-progress-only affordance in this footer (a
// red-square keycap, ^C) — NOT a flipped send button — because the composer
// keeps submitting (queuing a follow-up) while the agent runs. We mirror that:
// the bar carries Stop + the pending-queue chips; the input below stays a
// normal Enter-to-send/queue editor.
//
// Hidden entirely when idle with nothing queued.

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
    if (!streaming && queuedMessages.length === 0) return null;
    return (
        <div className="mb-1.5 flex items-center gap-2.5 border-t border-white/[0.06] pt-1.5">
            {streaming && (
                <div className="flex shrink-0 items-center gap-1.5">
                    <span
                        className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground/70"
                        aria-hidden
                    />
                    <span className="text-[12px] text-foreground/55">Working…</span>
                </div>
            )}
            {queuedMessages.length > 0 && (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-secondary/55">
                        Queued
                    </span>
                    {queuedMessages.map((m, i) => (
                        <span
                            key={i}
                            className="inline-block max-w-[200px] truncate rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-foreground/65"
                            title={messageText(m)}
                        >
                            {messageText(m)}
                        </span>
                    ))}
                </div>
            )}
            {streaming && (
                // Warp's bottom Stop keycap: red-square glyph + label, compact,
                // right-aligned. (The ^C accelerator warp shows isn't wired yet
                // — Ctrl+C is still terminal copy / SIGINT here.)
                <button
                    type="button"
                    onClick={onStop}
                    aria-label="Stop the agent"
                    title="Stop the agent (clears any queued messages)"
                    className={cn(
                        "ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md border border-white/15 bg-white/[0.05]",
                        "px-2 py-0.5 text-[12px] text-foreground/70 transition-colors cursor-pointer",
                        "hover:bg-white/[0.1] hover:text-foreground"
                    )}
                >
                    <span className="h-2.5 w-2.5 rounded-[2px] bg-rose-400" aria-hidden />
                    Stop
                </button>
            )}
        </div>
    );
});
AgentActivityBar.displayName = "AgentActivityBar";
