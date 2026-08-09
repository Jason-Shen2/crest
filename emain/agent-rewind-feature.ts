// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WorkspaceGitRunner } from "@crest/coding-agent/workspace-rewind/git-runner";
import {
    makeProcessOwnerIdentity,
    type ProcessOwnerIdentity,
} from "@crest/coding-agent/workspace-rewind/process-owner";
import type { WorkspaceCheckpointSnapshotSource } from "@crest/coding-agent/workspace-rewind/snapshot-source";
import { WorkspaceSnapshotStore } from "@crest/coding-agent/workspace-rewind/snapshot-store";
import type { WorkspaceCandidates } from "@crest/coding-agent/workspace-rewind/workspace-candidates";
import {
    resolveCanonicalWorkspaceIdentity,
    type CanonicalWorkspaceIdentity,
} from "@crest/coding-agent/workspace-rewind/workspace-identity";
import type { WorkspaceMutationLog } from "@crest/coding-agent/workspace-rewind/workspace-mutation-log";
import type { WorkspaceSnapshotTracker } from "@crest/coding-agent/workspace-rewind/workspace-snapshot-tracker";
import {
    acquireWorkspaceTracker,
    type WorkspaceTrackerLease,
} from "@crest/coding-agent/workspace-rewind/workspace-tracker-registry";
import type { WorkspaceWriterLeaseRegistry } from "@crest/coding-agent/workspace-rewind/workspace-writer-lease";

interface AgentRewindFeatureDependencies {
    resolveIdentity?: (workspaceRoot: string) => Promise<CanonicalWorkspaceIdentity>;
    openStore?: typeof WorkspaceSnapshotStore.open;
    acquireTracker?: typeof acquireWorkspaceTracker;
    git?: WorkspaceGitRunner;
}

export type AgentRewindFeature =
    | { state: "unavailable"; message: string }
    | {
          state: "enabled";
          processOwner: ProcessOwnerIdentity;
          store: WorkspaceSnapshotStore;
      };

export type LiveAgentRewindFeature =
    | { state: "unavailable"; message: string }
    | {
          state: "enabled";
          processOwner: ProcessOwnerIdentity;
          store: WorkspaceSnapshotStore;
          tracker: WorkspaceSnapshotTracker;
          mutationLog: WorkspaceMutationLog;
          candidates: WorkspaceCandidates;
          writerLeases: WorkspaceWriterLeaseRegistry;
          snapshotSource: WorkspaceCheckpointSnapshotSource;
          release: WorkspaceTrackerLease["release"];
      };

let ProcessOwnerPromise: Promise<ProcessOwnerIdentity> | undefined;

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
    dependencies?: AgentRewindFeatureDependencies;
}): Promise<AgentRewindFeature> {
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

export async function acquireAgentRewindFeature(input: {
    workspaceRoot: string;
    dataRoot: string;
    dependencies?: AgentRewindFeatureDependencies;
}): Promise<LiveAgentRewindFeature> {
    try {
        const processOwner = await getAgentRewindProcessOwner();
        const identity = await (input.dependencies?.resolveIdentity ?? resolveCanonicalWorkspaceIdentity)(
            input.workspaceRoot
        );
        const lease = await (input.dependencies?.acquireTracker ?? acquireWorkspaceTracker)({
            dataRoot: input.dataRoot,
            identity,
            git: input.dependencies?.git ?? new WorkspaceGitRunner(),
            processOwner,
        });
        return {
            state: "enabled",
            processOwner,
            store: lease.store,
            tracker: lease.tracker,
            mutationLog: lease.mutationLog,
            candidates: lease.candidates,
            writerLeases: lease.writerLeases,
            snapshotSource: lease.snapshotSource,
            release: lease.release,
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
