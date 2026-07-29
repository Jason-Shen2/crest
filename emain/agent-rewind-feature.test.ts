// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    _resetAgentRewindProcessOwnerForTests,
    getAgentRewindProcessOwner,
    isAgentRewindFeatureEnabled,
    openAgentRewindFeature,
} from "./agent-rewind-feature";

afterEach(() => {
    _resetAgentRewindProcessOwnerForTests();
});

describe("agent rewind feature gate", () => {
    it("enables only for the exact rollout value", () => {
        expect(isAgentRewindFeatureEnabled({ CREST_AGENT_WORKSPACE_REWIND: "1" })).toBe(true);
        expect(isAgentRewindFeatureEnabled({ CREST_AGENT_WORKSPACE_REWIND: "true" })).toBe(false);
        expect(isAgentRewindFeatureEnabled({})).toBe(false);
    });

    it("shares the exact process owner object across concurrent runtimes", async () => {
        const owner = { pid: 42, processStartToken: "start-a", nonce: "nonce-a" };
        const factory = vi.fn(async () => owner);

        const [first, second] = await Promise.all([
            getAgentRewindProcessOwner(factory),
            getAgentRewindProcessOwner(factory),
        ]);

        expect(first).toBe(owner);
        expect(second).toBe(owner);
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it("does no identity or storage work while disabled", async () => {
        const resolveIdentity = vi.fn();
        const result = await openAgentRewindFeature({
            workspaceRoot: "/workspace",
            dataRoot: "/data",
            env: {},
            dependencies: { resolveIdentity },
        });

        expect(result).toEqual({ state: "disabled" });
        expect(resolveIdentity).not.toHaveBeenCalled();
    });
});
