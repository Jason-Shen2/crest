// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CanonicalWorkspaceIdentity } from "@crest/coding-agent/workspace-rewind/workspace-identity";
import type {
    WorkspaceRecovery,
    WorkspaceRecoveryDecision,
} from "@crest/coding-agent/workspace-rewind/workspace-recovery";
import { describe, expect, it, vi } from "vitest";
import { makeAgentWorkspaceRecoveryGate } from "./agent-workspace-recovery-gate";

const Workspace = {
    canonicalRoot: "/workspace",
    workspaceIdentity: "workspace-1",
    workspaceIncarnation: "incarnation-1",
    storeKey: "workspace-1",
    ancestorIdentityChain: [],
} as CanonicalWorkspaceIdentity;

function makeResolver(decision: WorkspaceRecoveryDecision = { state: "none" }) {
    return {
        resolvePending: vi.fn(async () => decision),
        assertWorkspaceWritable: vi.fn(async () => {}),
        keepCurrent: vi.fn(async () => {}),
        quarantine: vi.fn(async () => {}),
    } satisfies Pick<WorkspaceRecovery, "resolvePending" | "assertWorkspaceWritable" | "keepCurrent" | "quarantine">;
}

describe("AgentWorkspaceRecoveryGate", () => {
    it("exposes only the phase-free gate surface", () => {
        const gate = makeAgentWorkspaceRecoveryGate({
            scanPendingWorkspaces: async () => [],
            recoveryFor: async () => makeResolver(),
        });

        expect(Object.keys(gate).sort()).toEqual([
            "assertWorkspaceWritable",
            "getRecovery",
            "resolveRecovery",
            "scanBeforeIpcRegistration",
        ]);
        expect("getFrozenDiagnostic" in gate).toBe(false);
        expect("clearFrozenDiagnostic" in gate).toBe(false);
        expect("ignoreCompletedOperationId" in gate).toBe(false);
    });

    it("delegates startup, writes, queries, and actions to the same resolver", async () => {
        const resolver = makeResolver({
            state: "needs-user",
            view: {
                operationId: "operation-1",
                corrupt: false,
                message: "choose",
                paths: [],
                allowedActions: ["retry", "abandon-current"],
            },
        });
        const recoveryFor = vi.fn(async () => resolver);
        const gate = makeAgentWorkspaceRecoveryGate({
            scanPendingWorkspaces: async () => [Workspace],
            recoveryFor,
        });

        await gate.scanBeforeIpcRegistration();
        await gate.assertWorkspaceWritable(Workspace);
        await expect(gate.getRecovery(Workspace)).resolves.toMatchObject({ operationId: "operation-1" });
        await gate.resolveRecovery(Workspace, "operation-1", "retry", async () => {});
        await gate.resolveRecovery(Workspace, "operation-1", "abandon-current", async () => {});
        resolver.resolvePending.mockResolvedValue({
            state: "needs-user",
            view: {
                operationId: "operation-corrupt",
                corrupt: true,
                message: "corrupt",
                paths: [],
                allowedActions: ["quarantine-corrupt"],
            },
        });
        await gate.resolveRecovery(Workspace, "operation-corrupt", "quarantine-corrupt", async () => {});

        expect(recoveryFor).toHaveBeenCalledTimes(6);
        expect(resolver.resolvePending).toHaveBeenNthCalledWith(1);
        expect(resolver.assertWorkspaceWritable).toHaveBeenCalledOnce();
        expect(resolver.resolvePending).toHaveBeenNthCalledWith(2);
        expect(resolver.resolvePending).toHaveBeenNthCalledWith(3, "operation-1");
        expect(resolver.keepCurrent).toHaveBeenCalledWith("operation-1", expect.any(Function));
        expect(resolver.quarantine).toHaveBeenCalledWith("operation-corrupt", expect.any(Function));
    });

    it("waits for the resolver workspace lock and authoritatively rereads no pending", async () => {
        let releaseLock!: () => void;
        const lockReleased = new Promise<void>((resolve) => {
            releaseLock = resolve;
        });
        const resolvePending = vi.fn(async () => {
            await lockReleased;
            return { state: "none" } as const;
        });
        const gate = makeAgentWorkspaceRecoveryGate({
            scanPendingWorkspaces: async () => [],
            recoveryFor: async () => ({ ...makeResolver(), resolvePending }),
        });

        const query = gate.getRecovery(Workspace);
        await Promise.resolve();
        expect(resolvePending).toHaveBeenCalledOnce();
        let settled = false;
        void query.finally(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        releaseLock();

        await expect(query).resolves.toBeUndefined();
    });

    it("resolves auto-recoverable pending before returning a renderer view", async () => {
        const resolver = makeResolver({ state: "committed", operationId: "operation-1" });
        const gate = makeAgentWorkspaceRecoveryGate({
            scanPendingWorkspaces: async () => [],
            recoveryFor: async () => resolver,
        });

        await expect(gate.getRecovery(Workspace)).resolves.toBeUndefined();
        expect(resolver.resolvePending).toHaveBeenCalledOnce();
    });

    it("passes operationId into the locked resolver guard so stale actions cannot affect newer pending", async () => {
        const resolver = makeResolver();
        resolver.resolvePending.mockRejectedValue(new Error("Pending restore belongs to another operation"));
        const gate = makeAgentWorkspaceRecoveryGate({
            scanPendingWorkspaces: async () => [],
            recoveryFor: async () => resolver,
        });

        await expect(gate.resolveRecovery(Workspace, "stale-operation", "retry", async () => {})).rejects.toThrow(
            /another operation/i
        );
        expect(resolver.resolvePending).toHaveBeenCalledWith("stale-operation");
    });
});
