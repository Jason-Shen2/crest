// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AgentActivityBar — a thin strip directly above the input editor that lists
// messages queued behind the current run. Concurrent sends are queued via the
// harness steer/followUp queues (not run in parallel), so the user can see
// what will run after the current turn — mirrors Cursor's sequential message
// queue.
//
// The Stop affordance is NOT here: it lives at the bottom of the streaming
// agent block (warp's orchestration pill bar model, anchored to the
// conversation and shown only in-progress). This bar is purely the queue view.
//
// Hidden entirely when nothing is queued.

import { memo } from "react";

import type { PiAgentMessage } from "@/app/store/use-pi-chat";

interface AgentActivityBarProps {
    /** Messages queued behind the current run (ordered steer-first). */
    queuedMessages: PiAgentMessage[];
}

function messageText(m: PiAgentMessage): string {
    const part = m.content?.find((c) => c.type === "text") as { text?: string } | undefined;
    return (part?.text ?? "").trim();
}

export const AgentActivityBar = memo(({ queuedMessages }: AgentActivityBarProps) => {
    if (queuedMessages.length === 0) return null;
    return (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
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
    );
});
AgentActivityBar.displayName = "AgentActivityBar";
