// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { normalizeAgentNotificationEvent, normalizeCmdBlockNotification } from "./notifications-model";

describe("normalizeCmdBlockNotification", () => {
    it("parses Crest structured agent notifications", () => {
        const normalized = normalizeCmdBlockNotification(
            "crest://agent-notification",
            JSON.stringify({
                agent: "claude",
                event: "approval_required",
                message: "Approve command execution",
            })
        );

        expect(normalized).toEqual({
            source: "agent-cli",
            kind: "needs-action",
            agentName: "Claude Code",
            title: "Claude Code",
            body: "Approve command execution",
        });
    });

    it("classifies failed CLI agent notifications as failed", () => {
        const normalized = normalizeCmdBlockNotification(
            "crest://agent-notification",
            JSON.stringify({
                agent: "codex",
                event: "failed",
                error: "Command failed",
            })
        );

        expect(normalized).toMatchObject({
            source: "agent-cli",
            kind: "failed",
            agentName: "Codex",
            body: "Command failed",
        });
    });
});

describe("normalizeAgentNotificationEvent", () => {
    it("normalizes native Crest agent notifications without a terminal block", () => {
        const normalized = normalizeAgentNotificationEvent({
            source: "crest-agent",
            kind: "completed",
            agentname: "Crest Agent",
            body: "Plan finished",
        });

        expect(normalized).toEqual({
            source: "crest-agent",
            kind: "completed",
            agentName: "Crest Agent",
            title: "Crest Agent",
            body: "Plan finished",
        });
    });
});
