// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentWorkspaceRecoveryView } from "@crest/coding-agent/workspace-rewind/api-types";
import type { CanonicalWorkspaceIdentity } from "@crest/coding-agent/workspace-rewind/workspace-identity";
import type { WorkspaceRecovery } from "@crest/coding-agent/workspace-rewind/workspace-recovery";

export type AgentWorkspaceRecoveryAction = "retry";

type AgentWorkspaceRecoveryResolver = Pick<
    WorkspaceRecovery,
    "inspectPending" | "resolvePending" | "assertWorkspaceWritable"
>;

export interface AgentWorkspaceRecoveryGate {
    scanBeforeIpcRegistration(): Promise<void>;
    assertWorkspaceWritable(workspace: CanonicalWorkspaceIdentity): Promise<void>;
    getRecovery(workspace: CanonicalWorkspaceIdentity): Promise<AgentWorkspaceRecoveryView | undefined>;
    resolveRecovery(
        workspace: CanonicalWorkspaceIdentity,
        operationId: string,
        action: AgentWorkspaceRecoveryAction,
        assertCurrent: () => Promise<void>
    ): Promise<void>;
}

export interface AgentWorkspaceRecoveryGateDependencies {
    scanPendingWorkspaces(): Promise<CanonicalWorkspaceIdentity[]>;
    recoveryFor(
        workspace: CanonicalWorkspaceIdentity,
        assertCurrent?: () => Promise<void>
    ): Promise<AgentWorkspaceRecoveryResolver>;
}

export function makeAgentWorkspaceRecoveryGate(
    dependencies: AgentWorkspaceRecoveryGateDependencies
): AgentWorkspaceRecoveryGate {
    let scanPromise: Promise<void> | undefined;

    const getRecovery = async (workspace: CanonicalWorkspaceIdentity) => {
        const recovery = await dependencies.recoveryFor(workspace);
        const decision = await recovery.inspectPending();
        return decision.state === "needs-user" ? decision.view : undefined;
    };

    return {
        scanBeforeIpcRegistration() {
            scanPromise ??= dependencies.scanPendingWorkspaces().then(async (workspaces) => {
                for (const workspace of workspaces) {
                    try {
                        const recovery = await dependencies.recoveryFor(workspace);
                        await recovery.resolvePending();
                    } catch {
                        // One damaged workspace must not block IPC registration or recovery for other workspaces.
                    }
                }
            });
            return scanPromise;
        },
        async assertWorkspaceWritable(workspace) {
            const recovery = await dependencies.recoveryFor(workspace);
            await recovery.assertWorkspaceWritable();
        },
        getRecovery,
        async resolveRecovery(workspace, operationId, action, assertCurrent) {
            const recovery = await dependencies.recoveryFor(workspace, assertCurrent);
            if (action !== "retry") throw new Error("Unsupported workspace recovery action");
            await recovery.resolvePending(operationId);
        },
    };
}

const NoopRecoveryGate: AgentWorkspaceRecoveryGate = {
    async scanBeforeIpcRegistration() {},
    async assertWorkspaceWritable() {},
    async getRecovery() {
        return undefined;
    },
    async resolveRecovery() {},
};

let ProcessRecoveryGate: AgentWorkspaceRecoveryGate = NoopRecoveryGate;
let ProcessRecoveryGateInstalled = false;

export function installAgentWorkspaceRecoveryGate(gate: AgentWorkspaceRecoveryGate): void {
    ProcessRecoveryGate = gate;
    ProcessRecoveryGateInstalled = true;
}

export function hasInstalledAgentWorkspaceRecoveryGate(): boolean {
    return ProcessRecoveryGateInstalled;
}

export function getAgentWorkspaceRecoveryGate(): AgentWorkspaceRecoveryGate {
    return ProcessRecoveryGate;
}

export function _resetAgentWorkspaceRecoveryGateForTests(): void {
    ProcessRecoveryGate = NoopRecoveryGate;
    ProcessRecoveryGateInstalled = false;
}
