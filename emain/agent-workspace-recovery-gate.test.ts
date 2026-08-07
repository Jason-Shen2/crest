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
        inspectPending: vi.fn(async () => decision),
        assertWorkspaceWritable: vi.fn(async () => {}),
    } satisfies Pick<WorkspaceRecovery, "resolvePending" | "inspectPending" | "assertWorkspaceWritable">;
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

    it("resolves at startup but keeps renderer queries read-only", async () => {
        const resolver = makeResolver({
            state: "needs-user",
            view: {
                operationId: "operation-1",
                corrupt: false,
                message: "choose",
                paths: [],
                allowedActions: ["retry"],
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

        expect(recoveryFor).toHaveBeenCalledTimes(4);
        expect(resolver.resolvePending).toHaveBeenNthCalledWith(1);
        expect(resolver.assertWorkspaceWritable).toHaveBeenCalledOnce();
        expect(resolver.inspectPending).toHaveBeenCalledOnce();
        expect(resolver.resolvePending).toHaveBeenNthCalledWith(2, "operation-1");
    });

    it("waits for the resolver workspace lock and authoritatively rereads no pending", async () => {
        let releaseLock!: () => void;
        const lockReleased = new Promise<void>((resolve) => {
            releaseLock = resolve;
        });
        const inspectPending = vi.fn(async () => {
            await lockReleased;
            return { state: "none" } as const;
        });
        const gate = makeAgentWorkspaceRecoveryGate({
            scanPendingWorkspaces: async () => [],
            recoveryFor: async () => ({ ...makeResolver(), inspectPending }),
        });

        const query = gate.getRecovery(Workspace);
        await Promise.resolve();
        expect(inspectPending).toHaveBeenCalledOnce();
        let settled = false;
        void query.finally(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        releaseLock();

        await expect(query).resolves.toBeUndefined();
    });

    it("does not resolve auto-recoverable pending while answering a renderer query", async () => {
        const resolver = makeResolver({ state: "committed", operationId: "operation-1" });
        const gate = makeAgentWorkspaceRecoveryGate({
            scanPendingWorkspaces: async () => [],
            recoveryFor: async () => resolver,
        });

        await expect(gate.getRecovery(Workspace)).resolves.toBeUndefined();
        expect(resolver.inspectPending).toHaveBeenCalledOnce();
        expect(resolver.resolvePending).not.toHaveBeenCalled();
    });

    it("isolates startup recovery failures per workspace", async () => {
        const second = { ...Workspace, workspaceIdentity: "workspace-2", storeKey: "workspace-2" };
        const firstResolver = makeResolver();
        firstResolver.resolvePending.mockRejectedValue(new Error("broken workspace"));
        const secondResolver = makeResolver();
        const recoveryFor = vi.fn(async (workspace: CanonicalWorkspaceIdentity) =>
            workspace.workspaceIdentity === Workspace.workspaceIdentity ? firstResolver : secondResolver
        );
        const gate = makeAgentWorkspaceRecoveryGate({
            scanPendingWorkspaces: async () => [Workspace, second],
            recoveryFor,
        });

        await expect(gate.scanBeforeIpcRegistration()).resolves.toBeUndefined();

        expect(firstResolver.resolvePending).toHaveBeenCalledOnce();
        expect(secondResolver.resolvePending).toHaveBeenCalledOnce();
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
