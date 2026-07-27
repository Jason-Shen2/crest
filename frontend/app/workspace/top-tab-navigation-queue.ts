// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    hydrateWorkspaceContentState,
    reduceWorkspaceContent,
    type WorkspaceContentAction,
    type WorkspaceContentState,
} from "./workspace-content-state";

export interface PendingTopTabIntent {
    sequence: number;
    action: WorkspaceContentAction;
}

interface LocalCheckpointBatch {
    payload: SaveWorkspaceCheckpointData;
    maxSequence: number;
}

export interface TopTabNavigationQueueOptions {
    confirmed: WorkspaceCheckpoint;
    save: (data: SaveWorkspaceCheckpointData) => Promise<SaveWorkspaceCheckpointResult>;
    onChange: (confirmed: WorkspaceCheckpoint, projected: WorkspaceContentState, error?: unknown) => void;
    getActiveTerminalTabId?: () => string;
}

function isUpdateBarrier(action: WorkspaceContentAction, topTabId: string): boolean {
    switch (action.type) {
        case "open-top-tab":
            return action.tab.id === topTabId;
        case "close-top-tab":
        case "reorder-top-tab":
            return action.topTabId === topTabId;
        default:
            return false;
    }
}

function checkpointsEquivalent(left: WorkspaceCheckpoint, right: WorkspaceCheckpoint): boolean {
    const snapshot = (checkpoint: WorkspaceCheckpoint) => ({
        workspaceid: checkpoint.workspaceid,
        navigationrevision: checkpoint.navigationrevision,
        terminaltabids: Array.from(checkpoint.terminaltabids ?? []),
        activeterminaltabid: checkpoint.activeterminaltabid ?? "",
        contentstate: serializeContentState(
            hydrateWorkspaceContentState(checkpoint.contentstate, checkpoint.activeterminaltabid ?? "")
        ),
    });
    return JSON.stringify(snapshot(left)) === JSON.stringify(snapshot(right));
}

function cloneCheckpoint(checkpoint: WorkspaceCheckpoint): WorkspaceCheckpoint {
    return {
        workspaceid: checkpoint.workspaceid,
        navigationrevision: checkpoint.navigationrevision,
        terminaltabids: Array.from(checkpoint.terminaltabids ?? []),
        activeterminaltabid: checkpoint.activeterminaltabid || undefined,
        contentstate: serializeContentState(
            hydrateWorkspaceContentState(checkpoint.contentstate, checkpoint.activeterminaltabid ?? "")
        ),
    };
}

export class TopTabNavigationQueue {
    confirmed: WorkspaceCheckpoint;
    pending: PendingTopTabIntent[] = [];
    projected: WorkspaceContentState;
    nextSequence = 1;
    tail = Promise.resolve();
    error: unknown;
    retryBatch: LocalCheckpointBatch;
    saving = false;
    save: TopTabNavigationQueueOptions["save"];
    onChange: TopTabNavigationQueueOptions["onChange"];
    getActiveTerminalTabId: () => string;

    constructor(options: TopTabNavigationQueueOptions) {
        this.confirmed = cloneCheckpoint(options.confirmed);
        this.projected = hydrateWorkspaceContentState(
            this.confirmed.contentstate,
            this.confirmed.activeterminaltabid ?? ""
        );
        this.save = options.save;
        this.onChange = options.onChange;
        this.getActiveTerminalTabId =
            options.getActiveTerminalTabId ?? (() => this.confirmed.activeterminaltabid ?? "");
    }

    run<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.tail.then(operation, operation);
        this.tail = next.then(
            () => undefined,
            () => undefined
        );
        return next;
    }

    enqueue(action: WorkspaceContentAction): boolean {
        const ownedAction = structuredClone(action);
        const next = reduceWorkspaceContent(this.projected, ownedAction);
        if (JSON.stringify(next) === JSON.stringify(this.projected)) {
            return false;
        }
        if (ownedAction.type === "update-top-tab") {
            for (let index = this.pending.length - 1; index >= 0; index--) {
                const pendingIntent = this.pending[index];
                const candidate = pendingIntent.action;
                if (candidate.type === "update-top-tab") {
                    if (candidate.topTabId === ownedAction.topTabId) {
                        if (pendingIntent.sequence <= (this.retryBatch?.maxSequence ?? 0)) {
                            break;
                        }
                        candidate.updates = {
                            ...candidate.updates,
                            ...ownedAction.updates,
                        } as typeof candidate.updates;
                        this.recomputeProjected();
                        this.emit();
                        return true;
                    }
                    continue;
                }
                if (isUpdateBarrier(candidate, ownedAction.topTabId)) {
                    break;
                }
            }
        }
        this.pending.push({ sequence: this.nextSequence++, action: ownedAction });
        this.projected = next;
        this.emit();
        return true;
    }

    flush(): Promise<void> {
        if (this.pending.length === 0) {
            return this.tail;
        }
        return this.run(() => this.drainLocal());
    }

    invalidate(preserveError = false): Promise<void> {
        return this.run(async () => {
            this.pending = [];
            this.retryBatch = undefined;
            if (!preserveError) {
                this.error = undefined;
            }
            this.recomputeProjected();
            this.emit();
        });
    }

    runTerminalMutation(
        mutate: (expectedRevision: number) => Promise<WorkspaceCheckpoint>
    ): Promise<WorkspaceCheckpoint> {
        return this.run(async () => {
            await this.drainLocal();
            const checkpoint = await mutate(this.confirmed.navigationrevision);
            this.reconcile(checkpoint);
            return this.confirmed;
        });
    }

    reconcile(checkpoint: WorkspaceCheckpoint, force = false): boolean {
        const ownedCheckpoint = cloneCheckpoint(checkpoint);
        const terminalTabIds = ownedCheckpoint.terminaltabids ?? [];
        if (
            ownedCheckpoint.workspaceid !== this.confirmed.workspaceid ||
            new Set(terminalTabIds).size !== terminalTabIds.length ||
            (ownedCheckpoint.activeterminaltabid && !terminalTabIds.includes(ownedCheckpoint.activeterminaltabid))
        ) {
            return false;
        }
        if (ownedCheckpoint.navigationrevision < this.confirmed.navigationrevision) {
            return false;
        }
        if (checkpointsEquivalent(ownedCheckpoint, this.confirmed)) {
            return true;
        }
        if (
            !force &&
            ownedCheckpoint.navigationrevision === this.confirmed.navigationrevision &&
            !checkpointsEquivalent(ownedCheckpoint, this.confirmed)
        ) {
            return false;
        }
        this.confirmed = ownedCheckpoint;
        this.error = undefined;
        this.retryBatch = undefined;
        this.recomputeProjected();
        this.emit();
        return true;
    }

    async drainLocal(): Promise<void> {
        while (this.pending.length > 0) {
            const projected = this.projected;
            const confirmedAtStart = this.confirmed;
            let result: SaveWorkspaceCheckpointResult;
            try {
                const batch = this.retryBatch ?? {
                    maxSequence: this.pending[this.pending.length - 1].sequence,
                    payload: {
                        workspaceid: this.confirmed.workspaceid,
                        expectedrevision: this.confirmed.navigationrevision,
                        contentstate: serializeContentState(projected),
                        activeterminaltabid: this.getActiveTerminalTabId() || undefined,
                    },
                };
                this.retryBatch = structuredClone(batch);
                this.saving = true;
                this.emit();
                result = await this.save(structuredClone(this.retryBatch.payload));
                if (result.status !== "committed" && result.status !== "conflict") {
                    throw new Error(`unknown workspace checkpoint save status: ${String(result.status)}`);
                }
            } catch (error) {
                this.saving = false;
                if (!checkpointsEquivalent(this.confirmed, confirmedAtStart)) {
                    this.retryBatch = undefined;
                    continue;
                }
                this.error = error;
                this.emit();
                throw error;
            }
            this.saving = false;
            if (!checkpointsEquivalent(this.confirmed, confirmedAtStart)) {
                this.retryBatch = undefined;
                continue;
            }
            const acknowledgedMaxSequence = this.retryBatch.maxSequence;
            this.retryBatch = undefined;
            this.confirmed = cloneCheckpoint(result.checkpoint);
            this.error = undefined;
            if (result.status === "committed") {
                this.pending = this.pending.filter((intent) => intent.sequence > acknowledgedMaxSequence);
            }
            this.recomputeProjected();
            this.emit();
        }
    }

    recomputeProjected(): void {
        let state = hydrateWorkspaceContentState(this.confirmed.contentstate, this.confirmed.activeterminaltabid ?? "");
        for (const intent of this.pending) {
            state = reduceWorkspaceContent(state, intent.action);
        }
        this.projected = state;
    }

    emit(): void {
        this.onChange(this.confirmed, this.projected, this.error);
    }
}

function serializeContentState(state: WorkspaceContentState): SaveWorkspaceCheckpointData["contentstate"] {
    return {
        activecontent: serializeActiveContent(state.activeContent),
        toptabs: state.topTabs.map(serializeTopTab),
        lastactivetoptabid: state.lastActiveTopTabId,
    };
}

function serializeActiveContent(activeContent: WorkspaceContentState["activeContent"]): ActiveContent {
    switch (activeContent.kind) {
        case "agent":
            return { kind: "agent" };
        case "terminal":
            return { kind: "terminal", terminaltabid: activeContent.terminalTabId };
        case "top-tab":
            return { kind: "top-tab", toptabid: activeContent.topTabId };
    }
}

function serializeTopTab(tab: WorkspaceContentState["topTabs"][number]): TopTabDescriptor {
    switch (tab.kind) {
        case "file":
        case "preview":
            return { id: tab.id, kind: tab.kind, path: tab.path, title: tab.title };
        case "git-diff":
            return {
                id: tab.id,
                kind: tab.kind,
                reporoot: tab.repoRoot,
                path: tab.path,
                mode: tab.mode,
                originalpath: tab.originalPath,
                title: tab.title,
            };
    }
}
