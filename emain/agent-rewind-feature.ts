// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WorkspaceGitRunner } from "@crest/coding-agent/workspace-rewind/git-runner";
import {
    makeProcessOwnerIdentity,
    type ProcessOwnerIdentity,
} from "@crest/coding-agent/workspace-rewind/process-owner";
import { WorkspaceSnapshotStore } from "@crest/coding-agent/workspace-rewind/snapshot-store";
import {
    resolveCanonicalWorkspaceIdentity,
    type CanonicalWorkspaceIdentity,
} from "@crest/coding-agent/workspace-rewind/workspace-identity";

interface AgentRewindFeatureDependencies {
    resolveIdentity?: (workspaceRoot: string) => Promise<CanonicalWorkspaceIdentity>;
    openStore?: typeof WorkspaceSnapshotStore.open;
    git?: WorkspaceGitRunner;
}

export type AgentRewindFeature =
    | { state: "disabled" }
    | { state: "unavailable"; message: string }
    | {
          state: "enabled";
          processOwner: ProcessOwnerIdentity;
          store: WorkspaceSnapshotStore;
      };

let ProcessOwnerPromise: Promise<ProcessOwnerIdentity> | undefined;

export function isAgentRewindFeatureEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
    return env.CREST_AGENT_WORKSPACE_REWIND === "1";
}

export function getAgentRewindProcessOwner(
    factory: () => Promise<ProcessOwnerIdentity> = makeProcessOwnerIdentity
): Promise<ProcessOwnerIdentity> {
    if (!ProcessOwnerPromise) {
        ProcessOwnerPromise = factory();
    }
    return ProcessOwnerPromise;
}

export async function openAgentRewindFeature(input: {
    workspaceRoot: string;
    dataRoot: string;
    env?: Readonly<Record<string, string | undefined>>;
    dependencies?: AgentRewindFeatureDependencies;
}): Promise<AgentRewindFeature> {
    if (!isAgentRewindFeatureEnabled(input.env)) {
        return { state: "disabled" };
    }
    try {
        const processOwner = await getAgentRewindProcessOwner();
        const identity = await (input.dependencies?.resolveIdentity ?? resolveCanonicalWorkspaceIdentity)(
            input.workspaceRoot
        );
        const store = await (input.dependencies?.openStore ?? WorkspaceSnapshotStore.open)({
            dataRoot: input.dataRoot,
            identity,
            git: input.dependencies?.git ?? new WorkspaceGitRunner(),
            processOwner,
        });
        return {
            state: "enabled",
            processOwner,
            store,
        };
    } catch (error) {
        return {
            state: "unavailable",
            message: error instanceof Error ? error.message : String(error),
        };
    }
}

export function _resetAgentRewindProcessOwnerForTests(): void {
    ProcessOwnerPromise = undefined;
}
