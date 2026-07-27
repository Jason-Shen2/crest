// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Agents section — stub.
//
// Crest's agent system is in-flight across packages/agent and
// packages/coding-agent; the full terax AgentsSection.tsx ships 567 lines
// covering persona editor, snippet CRUD, prompt templates, and a deletion
// confirm flow.
//
// This iteration ships a placeholder that explains the section's role and
// notes which sub-tabs land in the next pass.

import { SectionHeader } from "./SectionHeader";

const PLANNED = [
    {
        title: "Personas",
        desc: "Per-agent system prompt, default model, and tool whitelist.",
    },
    {
        title: "Snippets",
        desc: "Reusable prompt fragments the agent expands on demand.",
    },
    {
        title: "Slash commands",
        desc: "Custom /commands registered with the agent runtime.",
    },
];

export function AgentsSection() {
    return (
        <div className="flex flex-col gap-6">
            <SectionHeader
                title="Agents"
                description="Personas and snippets the AI uses. Switch agents from the input bar."
            />

            <div className="flex flex-col gap-2">
                {PLANNED.map((p) => (
                    <div
                        key={p.title}
                        className="flex items-center justify-between gap-4 rounded-lg border border-dashed border-modal-border bg-white/[0.02] px-3 py-2.5"
                    >
                        <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-[12px] font-medium text-white/85">{p.title}</span>
                            <span className="text-[11px] text-white/45">{p.desc}</span>
                        </div>
                        <span className="text-[11px] text-white/40 font-mono">soon</span>
                    </div>
                ))}
            </div>

            <div className="text-[11px] text-white/45">
                Agent editor lands once the persona + snippet schema stabilizes
                in packages/agent. The three cards above are the planned
                sub-sections.
            </div>
        </div>
    );
}
