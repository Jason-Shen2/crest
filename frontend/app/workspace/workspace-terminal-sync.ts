// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import type { Atom } from "jotai";
import type { WorkspaceModel } from "./workspace-model";

function checkpointFromWorkspace(workspace: Workspace): WorkspaceCheckpoint {
    return {
        workspaceid: workspace.oid,
        navigationrevision: workspace.navigationrevision ?? 0,
        terminaltabids: Array.from(workspace.terminaltabids ?? []),
        contentstate: workspace.contentstate,
        activeterminaltabid: workspace.activeterminaltabid,
    };
}

export class WorkspaceTerminalSync {
    model: WorkspaceModel;
    workspaceAtom: Atom<Workspace>;
    unsubscribe: () => void;
    unregisterModelTeardown: () => void;

    constructor(model: WorkspaceModel, workspaceAtom: Atom<Workspace>) {
        this.model = model;
        this.workspaceAtom = workspaceAtom;
    }

    start(): void {
        this.dispose();
        this.unregisterModelTeardown = this.model.registerPreReplacementTeardown(() => this.dispose());
        const reconcile = () => {
            const workspace = globalStore.get(this.workspaceAtom);
            if (workspace != null) {
                this.model.reconcileCheckpoint(checkpointFromWorkspace(workspace));
            }
        };
        this.unsubscribe = globalStore.sub(this.workspaceAtom, reconcile);
        reconcile();
    }

    dispose(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        const unregister = this.unregisterModelTeardown;
        this.unregisterModelTeardown = undefined;
        unregister?.();
    }
}
