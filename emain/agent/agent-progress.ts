// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMessage } from "./types";

export interface AgentProgressSummary {
    completed: number;
    total: number;
    current?: string;
}

const EmptyProgress: AgentProgressSummary = {
    completed: 0,
    total: 0,
    current: undefined,
};

const CheckboxLineRe = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*\S)\s*$/;
const FenceLineRe = /^\s*```/;

function getMessageText(message: AgentMessage): string {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((part) => {
            if ((part as { type?: string }).type !== "text") return "";
            return (part as { text?: string }).text ?? "";
        })
        .filter(Boolean)
        .join("\n");
}

export function getAgentProgressFromText(text: string): AgentProgressSummary {
    let completed = 0;
    let total = 0;
    let current: string | undefined;
    let inFence = false;

    for (const line of text.split(/\r?\n/)) {
        if (FenceLineRe.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        const match = line.match(CheckboxLineRe);
        if (!match) continue;
        total += 1;
        if (match[1].toLowerCase() === "x") {
            completed += 1;
            continue;
        }
        current ??= match[2].trim();
    }

    if (total === 0) return EmptyProgress;
    return { completed, total, current };
}

export function getAgentProgressFromMessages(messages: AgentMessage[]): AgentProgressSummary {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if ((message as { role?: string }).role !== "assistant") continue;
        const progress = getAgentProgressFromText(getMessageText(message));
        if (progress.total > 0) return progress;
    }
    return EmptyProgress;
}
