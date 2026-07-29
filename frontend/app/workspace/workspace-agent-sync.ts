// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import type { Atom } from "jotai";
import type { WorkspaceAgentModel } from "./workspace-agent-model";
import type { WorkspaceModel } from "./workspace-model";

function checkpointFromWorkspace(workspace: Workspace): WorkspaceAgentCheckpoint {
    return {
        workspaceid: workspace.oid,
        revision: workspace.agentrevision ?? 0,
        state: workspace.agentstate ?? {},
    };
}

export class WorkspaceAgentSync {
    model: WorkspaceAgentModel;
    workspaceModel: WorkspaceModel;
    workspaceAtom: Atom<Workspace>;
    unsubscribe: () => void;
    unregisterModelTeardown: () => void;
    disposalPromise: Promise<void>;

    constructor(model: WorkspaceAgentModel, workspaceModel: WorkspaceModel, workspaceAtom: Atom<Workspace>) {
        this.model = model;
        this.workspaceModel = workspaceModel;
        this.workspaceAtom = workspaceAtom;
    }

    start(): void {
        this.disposeSubscription();
        this.unregisterModelTeardown = this.workspaceModel.registerPreReplacementTeardown(() => this.dispose());
        const reconcile = () => {
            const workspace = globalStore.get(this.workspaceAtom);
            if (workspace?.oid !== this.model.workspaceId) {
                return;
            }
            this.model.reconcile(checkpointFromWorkspace(workspace), this.model.generation);
        };
        this.unsubscribe = globalStore.sub(this.workspaceAtom, reconcile);
        reconcile();
    }

    disposeSubscription(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        const unregister = this.unregisterModelTeardown;
        this.unregisterModelTeardown = undefined;
        unregister?.();
    }

    dispose(): Promise<void> {
        if (this.disposalPromise) {
            return this.disposalPromise;
        }
        this.disposeSubscription();
        const disposal = this.model.dispose();
        this.disposalPromise = disposal;
        return disposal;
    }
}
