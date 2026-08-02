// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CanonicalWorkspaceIdentity } from "@crest/coding-agent/workspace-rewind/workspace-identity";

export type AgentWorkspaceRecoveryAction = "retry" | "abandon-current" | "quarantine-corrupt";

export type AgentWorkspaceFrozenDiagnosticSource =
    | { kind: "process-scan" }
    | { kind: "internal-recovery" }
    | { kind: "startup-corrupt"; filename: string }
    | {
          kind: "startup-orphan";
          reason: "missing-owner" | "mismatched-workspace" | "unresolvable-workspace";
          sessionId: string;
          ownerPath?: string;
          ownerCwd?: string;
      };

export interface AgentWorkspaceFrozenDiagnostic {
    operationId: string;
    message: string;
    corrupt: boolean;
    allowedActions: AgentWorkspaceRecoveryAction[];
    source?: AgentWorkspaceFrozenDiagnosticSource;
}

export interface AgentWorkspaceRecoveryProbeOptions {
    ignoreCompletedOperationId?: string;
}

export interface AgentWorkspaceRecoveryGate {
    scanBeforeIpcRegistration(): Promise<void>;
    ensureRecoveredOnce(workspace: CanonicalWorkspaceIdentity): Promise<void>;
    assertWorkspaceWritable(workspace: CanonicalWorkspaceIdentity): Promise<void>;
    getFrozenDiagnostic?(workspace: CanonicalWorkspaceIdentity): AgentWorkspaceFrozenDiagnostic | undefined;
    probeFrozenDiagnostic?(
        workspace: CanonicalWorkspaceIdentity,
        options?: AgentWorkspaceRecoveryProbeOptions
    ): Promise<AgentWorkspaceFrozenDiagnostic | undefined>;
    resolveFrozenDiagnostic?(
        workspace: CanonicalWorkspaceIdentity,
        operationId: string,
        action: AgentWorkspaceRecoveryAction,
        assertCurrent: () => Promise<void>
    ): Promise<boolean>;
    clearFrozenDiagnostic?(workspace: CanonicalWorkspaceIdentity, operationId: string): void | Promise<void>;
}

export interface AgentWorkspaceRecoveryGateDependencies {
    scanKnownJournals(): Promise<void>;
    ensureRecovered(workspace: CanonicalWorkspaceIdentity): Promise<void>;
    assertWorkspaceWritable(workspace: CanonicalWorkspaceIdentity): Promise<void>;
}

export function makeAgentWorkspaceRecoveryGate(
    dependencies: AgentWorkspaceRecoveryGateDependencies
): AgentWorkspaceRecoveryGate {
    let scanPromise: Promise<void> | undefined;
    const recovered = new Set<string>();
    const recovering = new Map<string, Promise<void>>();
    const keyFor = (workspace: CanonicalWorkspaceIdentity) =>
        `${workspace.workspaceIdentity}\0${workspace.workspaceIncarnation}`;

    return {
        scanBeforeIpcRegistration() {
            scanPromise ??= dependencies.scanKnownJournals();
            return scanPromise;
        },
        ensureRecoveredOnce(workspace) {
            const key = keyFor(workspace);
            if (recovered.has(key)) {
                return Promise.resolve();
            }
            const pending = recovering.get(key);
            if (pending) {
                return pending;
            }
            const operation = dependencies
                .ensureRecovered(workspace)
                .then(() => {
                    recovered.add(key);
                })
                .finally(() => {
                    recovering.delete(key);
                });
            recovering.set(key, operation);
            return operation;
        },
        async assertWorkspaceWritable(workspace) {
            await this.ensureRecoveredOnce(workspace);
            await dependencies.assertWorkspaceWritable(workspace);
        },
    };
}

const NoopRecoveryGate: AgentWorkspaceRecoveryGate = {
    async scanBeforeIpcRegistration() {},
    async ensureRecoveredOnce() {},
    async assertWorkspaceWritable() {},
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
