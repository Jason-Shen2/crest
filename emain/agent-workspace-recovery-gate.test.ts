// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CanonicalWorkspaceIdentity } from "@crest/coding-agent/workspace-rewind/workspace-identity";
import { describe, expect, it, vi } from "vitest";
import { makeAgentWorkspaceRecoveryGate } from "./agent-workspace-recovery-gate";

const Workspace = {
    canonicalRoot: "/workspace",
    workspaceIdentity: "workspace-1",
    workspaceIncarnation: "incarnation-1",
    storeKey: "workspace-1",
    ancestorIdentityChain: [],
} as CanonicalWorkspaceIdentity;

describe("AgentWorkspaceRecoveryGate", () => {
    it("awaits startup scan and memoizes concurrent successful first access", async () => {
        const scanKnownJournals = vi.fn(async () => {});
        const ensureRecovered = vi.fn(async () => {});
        const assertWorkspaceWritable = vi.fn(async () => {});
        const gate = makeAgentWorkspaceRecoveryGate({ scanKnownJournals, ensureRecovered, assertWorkspaceWritable });
        await gate.scanBeforeIpcRegistration();
        await Promise.all([gate.ensureRecoveredOnce(Workspace), gate.ensureRecoveredOnce(Workspace)]);
        expect(scanKnownJournals).toHaveBeenCalledTimes(1);
        expect(ensureRecovered).toHaveBeenCalledTimes(1);
        await gate.assertWorkspaceWritable(Workspace);
        expect(assertWorkspaceWritable).toHaveBeenCalledWith(Workspace);
    });

    it("does not cache failed recovery as success", async () => {
        const ensureRecovered = vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(new Error("frozen"))
            .mockResolvedValueOnce();
        const gate = makeAgentWorkspaceRecoveryGate({
            scanKnownJournals: async () => {},
            ensureRecovered,
            assertWorkspaceWritable: async () => {},
        });
        await expect(gate.ensureRecoveredOnce(Workspace)).rejects.toThrow("frozen");
        await gate.ensureRecoveredOnce(Workspace);
        expect(ensureRecovered).toHaveBeenCalledTimes(2);
    });
});
