// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getAgentProgressFromMessages, getAgentProgressFromText } from "./agent-progress";
import type { AgentMessage } from "./types";

function assistant(text: string): AgentMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
    } as unknown as AgentMessage;
}

function user(text: string): AgentMessage {
    return {
        role: "user",
        content: [{ type: "text", text }],
    } as unknown as AgentMessage;
}

describe("agent progress disclosure", () => {
    it("summarizes markdown checkbox progress from text", () => {
        expect(
            getAgentProgressFromText(`
Plan:
- [x] Inspect existing agent session flow
- [ ] Wire progress into snapshot
- [ ] Render progress chip
`),
        ).toEqual({
            completed: 1,
            total: 3,
            current: "Wire progress into snapshot",
        });
    });

    it("uses the latest checklist-bearing agent message", () => {
        const messages = [
            assistant("- [ ] Old task\n- [ ] Other old task"),
            user("please continue"),
            assistant("Working on it"),
            assistant("- [x] New done\n- [ ] New current"),
        ];

        expect(getAgentProgressFromMessages(messages)).toEqual({
            completed: 1,
            total: 2,
            current: "New current",
        });
    });

    it("ignores checkboxes inside fenced code blocks", () => {
        expect(
            getAgentProgressFromText(`
\`\`\`md
- [ ] not real plan
\`\`\`
- [x] Real done
`),
        ).toEqual({
            completed: 1,
            total: 1,
            current: undefined,
        });
    });

    it("returns zero progress when there is no checklist", () => {
        expect(getAgentProgressFromText("No plan has been disclosed yet.")).toEqual({
            completed: 0,
            total: 0,
            current: undefined,
        });
    });
});
