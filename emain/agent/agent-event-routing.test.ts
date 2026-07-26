// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { makeAgentEventPayload, makeAgentSubscriptionKey } from "./agent-event-routing";

describe("agent event routing", () => {
    it("routes event payloads back on the renderer subscription path", () => {
        const event = { type: "session_state" };

        expect(
            makeAgentEventPayload(
                "/real/session.db",
                "/alias/../session.db",
                { workspaceId: "workspace-1", generation: 3 },
                event
            )
        ).toEqual({
            sessionPath: "/alias/../session.db",
            workspaceId: "workspace-1",
            generation: 3,
            event,
        });
    });

    it("keeps subscription keys distinct for different renderer paths to the same canonical session", () => {
        expect(
            makeAgentSubscriptionKey(7, "/real/session.db", "/raw-a/session.db", {
                workspaceId: "workspace-1",
                generation: 1,
            })
        ).not.toBe(
            makeAgentSubscriptionKey(7, "/real/session.db", "/raw-a/session.db", {
                workspaceId: "workspace-1",
                generation: 2,
            })
        );
    });
});
