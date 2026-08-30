// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as jotai from "jotai";
import {
    cloneWorkspaceAgentState,
    hydrateWorkspaceAgentState,
    serializeWorkspaceAgentState,
    workspaceAgentStatesEqual,
    type LocalWorkspaceAgentState,
} from "./workspace-agent-state";

const AgentCheckpointDelayMs = 300;
const AgentStateFields = ["activeSession", "selection"] as const;

type AgentStateField = (typeof AgentStateFields)[number];

export type WorkspaceAgentStatus = "clean" | "dirty" | "saving" | "error";

export interface WorkspaceAgentContextIdentity {
    workspaceGeneration: number;
    sessionGeneration: number;
    sessionPath?: string;
    modelKey: string;
}

export interface WorkspaceAgentContextState {
    identity: WorkspaceAgentContextIdentity;
    status: "loading" | "ready" | "out_of_date" | "error";
    snapshot?: AgentContextSnapshotView;
    errorMessage?: string;
}

export interface WorkspaceAgentModelEventTarget {
    visibilityState?: string;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
}

export interface WorkspaceAgentModelClock {
    setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface WorkspaceAgentModelOptions {
    windowId: string;
    workspaceId: string;
    generation: number;
    initialState?: WorkspaceAgentState;
    initialRevision?: number;
    saveCheckpoint?: (data: WorkspaceSaveAgentStateData) => Promise<WorkspaceAgentCheckpoint>;
    reloadCheckpoint?: () => Promise<WorkspaceAgentCheckpoint>;
    clock?: WorkspaceAgentModelClock;
    windowTarget?: WorkspaceAgentModelEventTarget;
    documentTarget?: WorkspaceAgentModelEventTarget;
}

interface SaveAttempt {
    state: LocalWorkspaceAgentState;
    fieldVersions: Partial<Record<AgentStateField, number>>;
    requestGeneration: number;
}

function defaultClock(): WorkspaceAgentModelClock {
    return {
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (timer) => clearTimeout(timer),
    };
}

function defaultWindowTarget(): WorkspaceAgentModelEventTarget {
    return typeof window === "undefined" ? undefined : window;
}

function defaultDocumentTarget(): WorkspaceAgentModelEventTarget {
    return typeof document === "undefined" ? undefined : document;
}

function isStaleCheckpointError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("stale workspace checkpoint") || message.includes("expected Agent revision");
}

function fieldEqual(field: AgentStateField, left: LocalWorkspaceAgentState, right: LocalWorkspaceAgentState): boolean {
    return JSON.stringify(left[field]) === JSON.stringify(right[field]);
}

function contextIdentitiesEqual(
    left: WorkspaceAgentContextIdentity,
    right: WorkspaceAgentContextIdentity
): boolean {
    return (
        left.workspaceGeneration === right.workspaceGeneration &&
        left.sessionGeneration === right.sessionGeneration &&
        left.sessionPath === right.sessionPath &&
        left.modelKey === right.modelKey
    );
}

export class WorkspaceAgentModel {
    static instances = new Map<string, WorkspaceAgentModel>();
    static resetInProgress: Promise<void>;

    stateAtom: jotai.PrimitiveAtom<LocalWorkspaceAgentState>;
    statusAtom: jotai.PrimitiveAtom<WorkspaceAgentStatus>;
    errorAtom: jotai.PrimitiveAtom<string>;
    sessionGenerationAtom = jotai.atom(0);
    contextSnapshotAtom: jotai.PrimitiveAtom<WorkspaceAgentContextState | null> =
        jotai.atom(null as WorkspaceAgentContextState | null);

    windowId: string;
    workspaceId: string;
    generation: number;
    revision: number;
    saveCheckpoint: (data: WorkspaceSaveAgentStateData) => Promise<WorkspaceAgentCheckpoint>;
    reloadCheckpoint: () => Promise<WorkspaceAgentCheckpoint>;
    clock: WorkspaceAgentModelClock;
    windowTarget: WorkspaceAgentModelEventTarget;
    documentTarget: WorkspaceAgentModelEventTarget;
    debounceTimer: ReturnType<typeof setTimeout>;
    saveLoop: Promise<void>;
    disposalPromise: Promise<void>;
    dirtyFields = new Set<AgentStateField>();
    fieldVersions: Record<AgentStateField, number> = {
        activeSession: 0,
        selection: 0,
    };
    requestGeneration = 0;
    disposing = false;
    disposed = false;

    onWindowFlush = () => {
        void this.flush().catch(() => {});
    };

    onVisibilityChange = () => {
        if (this.documentTarget?.visibilityState === "hidden") {
            void this.flush().catch(() => {});
        }
    };

    private constructor(options: WorkspaceAgentModelOptions) {
        this.windowId = options.windowId;
        this.workspaceId = options.workspaceId;
        this.generation = Math.max(0, Math.trunc(options.generation));
        this.revision = Math.max(0, Math.trunc(options.initialRevision ?? 0));
        this.saveCheckpoint =
            options.saveCheckpoint ?? ((data) => RpcApi.WorkspaceSaveAgentStateCommand(TabRpcClient, data));
        this.reloadCheckpoint =
            options.reloadCheckpoint ??
            (async () => {
                const workspace = await WOS.reloadWaveObject<Workspace>(WOS.makeORef("workspace", this.workspaceId));
                return {
                    workspaceid: workspace.oid,
                    revision: workspace.agentrevision ?? 0,
                    state: workspace.agentstate ?? {},
                };
            });
        this.clock = options.clock ?? defaultClock();
        this.windowTarget = options.windowTarget ?? defaultWindowTarget();
        this.documentTarget = options.documentTarget ?? defaultDocumentTarget();
        this.stateAtom = jotai.atom(hydrateWorkspaceAgentState(options.initialState));
        this.statusAtom = jotai.atom<WorkspaceAgentStatus>("clean");
        this.errorAtom = jotai.atom("");

        this.windowTarget?.addEventListener("blur", this.onWindowFlush);
        this.windowTarget?.addEventListener("beforeunload", this.onWindowFlush);
        this.documentTarget?.addEventListener("visibilitychange", this.onVisibilityChange);
    }

    static getInstance(options: WorkspaceAgentModelOptions): WorkspaceAgentModel {
        if (WorkspaceAgentModel.resetInProgress) {
            throw new Error("workspace Agent model reset is in progress");
        }
        const existing = WorkspaceAgentModel.instances.get(options.windowId);
        if (existing) {
            if (
                existing.workspaceId !== options.workspaceId ||
                existing.generation !== Math.max(0, Math.trunc(options.generation))
            ) {
                throw new Error(
                    `window ${options.windowId} already owns Workspace Agent ${existing.workspaceId}/${existing.generation}`
                );
            }
            return existing;
        }
        const model = new WorkspaceAgentModel(options);
        WorkspaceAgentModel.instances.set(options.windowId, model);
        return model;
    }

    static resetInstances(): Promise<void> {
        if (WorkspaceAgentModel.resetInProgress) {
            return WorkspaceAgentModel.resetInProgress;
        }
        const instances = Array.from(WorkspaceAgentModel.instances.values());
        const reset = Promise.all(instances.map((model) => model.dispose())).then(() => {});
        WorkspaceAgentModel.resetInProgress = reset;
        const clearReset = () => {
            if (WorkspaceAgentModel.resetInProgress === reset) {
                WorkspaceAgentModel.resetInProgress = undefined;
            }
        };
        void reset.then(clearReset, clearReset);
        return reset;
    }

    selectSession(session?: AgentSessionMeta): void {
        this.updateField("activeSession", session == null ? undefined : { ...session });
    }

    selectModel(selection?: AgentSelectionMeta): void {
        this.updateField("selection", selection == null ? undefined : { ...selection });
    }

    beginContextInspection(identity: WorkspaceAgentContextIdentity): WorkspaceAgentContextIdentity {
        const captured = { ...identity };
        const current = globalStore.get(this.contextSnapshotAtom);
        globalStore.set(this.contextSnapshotAtom, {
            identity: captured,
            status: "loading",
            ...(current && contextIdentitiesEqual(current.identity, captured) && current.snapshot
                ? { snapshot: current.snapshot }
                : {}),
        });
        return captured;
    }

    publishContextSnapshot(identity: WorkspaceAgentContextIdentity, snapshot: AgentContextSnapshotView): boolean {
        const current = globalStore.get(this.contextSnapshotAtom);
        if (!current || !contextIdentitiesEqual(current.identity, identity)) return false;
        if (
            snapshot.identity.modelKey !== identity.modelKey ||
            (snapshot.identity.sessionPath ?? undefined) !== (identity.sessionPath ?? undefined)
        ) {
            return false;
        }
        if (
            current.snapshot &&
            (snapshot.identity.revision < current.snapshot.identity.revision ||
                (snapshot.identity.revision === current.snapshot.identity.revision &&
                    snapshot.identity.leafId !== current.snapshot.identity.leafId))
        ) {
            return false;
        }
        globalStore.set(this.contextSnapshotAtom, {
            identity: { ...identity },
            status: "ready",
            snapshot,
        });
        return true;
    }

    failContextInspection(identity: WorkspaceAgentContextIdentity, errorMessage: string): boolean {
        const current = globalStore.get(this.contextSnapshotAtom);
        if (!current || !contextIdentitiesEqual(current.identity, identity)) return false;
        globalStore.set(this.contextSnapshotAtom, {
            identity: { ...identity },
            status: current.snapshot ? "out_of_date" : "error",
            ...(current.snapshot ? { snapshot: current.snapshot } : {}),
            errorMessage,
        });
        return true;
    }

    clearContextInspection(): void {
        globalStore.set(this.contextSnapshotAtom, null);
    }

    reconcile(checkpoint: WorkspaceAgentCheckpoint, generation = this.generation): boolean {
        if (
            this.disposing ||
            this.disposed ||
            generation !== this.generation ||
            checkpoint.workspaceid !== this.workspaceId
        ) {
            return false;
        }
        const next = hydrateWorkspaceAgentState(checkpoint.state);
        const current = globalStore.get(this.stateAtom);
        if (checkpoint.revision < this.revision) {
            return false;
        }
        if (checkpoint.revision === this.revision && !workspaceAgentStatesEqual(current, next)) {
            return false;
        }
        if (checkpoint.revision === this.revision) {
            return true;
        }
        for (const field of Array.from(this.dirtyFields)) {
            if (fieldEqual(field, current, next)) {
                this.dirtyFields.delete(field);
                continue;
            }
            next[field] = current[field] as never;
        }
        this.requestGeneration++;
        this.revision = checkpoint.revision;
        this.replaceState(next);
        globalStore.set(this.statusAtom, this.dirtyFields.size > 0 ? "dirty" : "clean");
        globalStore.set(this.errorAtom, "");
        return true;
    }

    async flush(): Promise<void> {
        this.cancelDebounce();
        if (this.dirtyFields.size === 0 && !this.saveLoop) {
            return;
        }
        if (!this.saveLoop) {
            this.saveLoop = this.drainSaves().finally(() => {
                this.saveLoop = undefined;
            });
        }
        return this.saveLoop;
    }

    async dispose(): Promise<void> {
        if (this.disposalPromise) {
            return this.disposalPromise;
        }
        this.disposing = true;
        this.cancelDebounce();
        const flush = this.flush();
        const disposal = flush
            .catch(() => {})
            .finally(() => {
                this.disposed = true;
                this.requestGeneration++;
                this.windowTarget?.removeEventListener("blur", this.onWindowFlush);
                this.windowTarget?.removeEventListener("beforeunload", this.onWindowFlush);
                this.documentTarget?.removeEventListener("visibilitychange", this.onVisibilityChange);
                if (WorkspaceAgentModel.instances.get(this.windowId) === this) {
                    WorkspaceAgentModel.instances.delete(this.windowId);
                }
            });
        this.disposalPromise = disposal;
        return disposal;
    }

    updateField<Field extends AgentStateField>(field: Field, value: LocalWorkspaceAgentState[Field]): void {
        if (this.disposing || this.disposed) {
            return;
        }
        if (field === "activeSession") {
            this.advanceSessionGeneration();
        }
        const current = globalStore.get(this.stateAtom);
        const next = cloneWorkspaceAgentState(current);
        next[field] = value;
        if (fieldEqual(field, current, next)) {
            return;
        }
        this.fieldVersions[field]++;
        this.dirtyFields.add(field);
        globalStore.set(this.stateAtom, next);
        globalStore.set(this.statusAtom, "dirty");
        globalStore.set(this.errorAtom, "");
        this.scheduleSave();
    }

    advanceSessionGeneration(): void {
        globalStore.set(this.sessionGenerationAtom, globalStore.get(this.sessionGenerationAtom) + 1);
    }

    replaceState(next: LocalWorkspaceAgentState): void {
        const current = globalStore.get(this.stateAtom);
        if (!fieldEqual("activeSession", current, next)) {
            this.advanceSessionGeneration();
        }
        globalStore.set(this.stateAtom, next);
    }

    scheduleSave(): void {
        this.cancelDebounce();
        this.debounceTimer = this.clock.setTimeout(() => {
            this.debounceTimer = undefined;
            void this.flush().catch(() => {});
        }, AgentCheckpointDelayMs);
    }

    cancelDebounce(): void {
        if (this.debounceTimer == null) {
            return;
        }
        this.clock.clearTimeout(this.debounceTimer);
        this.debounceTimer = undefined;
    }

    makeSaveAttempt(): SaveAttempt {
        const fieldVersions: Partial<Record<AgentStateField, number>> = {};
        for (const field of this.dirtyFields) {
            fieldVersions[field] = this.fieldVersions[field];
        }
        return {
            state: cloneWorkspaceAgentState(globalStore.get(this.stateAtom)),
            fieldVersions,
            requestGeneration: this.requestGeneration,
        };
    }

    async drainSaves(): Promise<void> {
        let staleRetryUsed = false;
        while (this.dirtyFields.size > 0) {
            const attempt = this.makeSaveAttempt();
            const data: WorkspaceSaveAgentStateData = {
                workspaceid: this.workspaceId,
                expectedrevision: this.revision,
                state: serializeWorkspaceAgentState(attempt.state),
            };
            globalStore.set(this.statusAtom, "saving");
            try {
                const checkpoint = await this.saveCheckpoint(data);
                if (this.disposed) {
                    return;
                }
                if (attempt.requestGeneration !== this.requestGeneration) {
                    staleRetryUsed = false;
                    continue;
                }
                if (!this.applySaveCheckpoint(checkpoint, attempt)) {
                    throw new Error("Workspace Agent save returned an invalid checkpoint");
                }
                staleRetryUsed = false;
            } catch (error) {
                if (this.disposed) {
                    return;
                }
                if (attempt.requestGeneration !== this.requestGeneration) {
                    staleRetryUsed = false;
                    continue;
                }
                if (isStaleCheckpointError(error) && !staleRetryUsed) {
                    staleRetryUsed = true;
                    try {
                        if (!(await this.reloadAfterStale(attempt.requestGeneration))) {
                            if (this.disposed) {
                                return;
                            }
                            staleRetryUsed = false;
                            continue;
                        }
                    } catch (reloadError) {
                        globalStore.set(this.statusAtom, "error");
                        globalStore.set(
                            this.errorAtom,
                            reloadError instanceof Error ? reloadError.message : String(reloadError)
                        );
                        throw reloadError;
                    }
                    continue;
                }
                globalStore.set(this.statusAtom, "error");
                globalStore.set(this.errorAtom, error instanceof Error ? error.message : String(error));
                throw error;
            }
        }
        globalStore.set(this.statusAtom, "clean");
        globalStore.set(this.errorAtom, "");
    }

    applySaveCheckpoint(checkpoint: WorkspaceAgentCheckpoint, attempt: SaveAttempt): boolean {
        if (checkpoint.workspaceid !== this.workspaceId || checkpoint.revision <= this.revision) {
            return false;
        }
        const local = cloneWorkspaceAgentState(globalStore.get(this.stateAtom));
        const next = hydrateWorkspaceAgentState(checkpoint.state);
        for (const field of AgentStateFields) {
            const attemptedVersion = attempt.fieldVersions[field];
            if (attemptedVersion != null && this.fieldVersions[field] === attemptedVersion) {
                this.dirtyFields.delete(field);
                continue;
            }
            if (this.dirtyFields.has(field)) {
                next[field] = local[field] as never;
            }
        }
        this.revision = checkpoint.revision;
        this.replaceState(next);
        globalStore.set(this.statusAtom, this.dirtyFields.size > 0 ? "dirty" : "clean");
        return true;
    }

    async reloadAfterStale(requestGeneration: number): Promise<boolean> {
        const checkpoint = await this.reloadCheckpoint();
        if (requestGeneration !== this.requestGeneration || this.disposed) {
            return false;
        }
        if (checkpoint.workspaceid !== this.workspaceId || checkpoint.revision < this.revision) {
            throw new Error("Workspace Agent reload returned an invalid checkpoint");
        }
        const local = cloneWorkspaceAgentState(globalStore.get(this.stateAtom));
        const dirtyFields = new Set(this.dirtyFields);
        const next = hydrateWorkspaceAgentState(checkpoint.state);
        for (const field of dirtyFields) {
            next[field] = local[field] as never;
        }
        this.revision = checkpoint.revision;
        this.replaceState(next);
        globalStore.set(this.statusAtom, "dirty");
        return true;
    }
}
