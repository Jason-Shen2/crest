import { globalStore } from "@/app/store/jotaiStore";
import { WorkspaceService } from "@/app/store/services";
import * as jotai from "jotai";
import { TopTabNavigationQueue } from "./top-tab-navigation-queue";
import { recordTopTabPerformance, topTabPerformanceNow } from "./top-tab-performance";
import {
    hydrateWorkspaceContentState,
    type WorkspaceContentState as LocalWorkspaceContentState,
    type PersistedWorkspaceContentState,
    type TopTab,
    type TopTabUpdates,
    type WorkspaceContentAction,
} from "./workspace-content-state";

const CheckpointDelayMs = 300;

export type WorkspaceCheckpointStatus = "clean" | "dirty" | "saving" | "error";

export interface WorkspaceModelEventTarget {
    visibilityState?: string;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
}

export interface WorkspaceModelClock {
    setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface WorkspaceModelOptions {
    workspaceId: string;
    windowId?: string;
    initialContentState?: PersistedWorkspaceContentState;
    initialTerminalTabIds?: readonly string[];
    initialActiveTerminalTabId?: string;
    initialNavigationRevision?: number;
    surfaceGeneration?: number;
    saveCheckpoint?: (checkpoint: SaveWorkspaceCheckpointData) => Promise<SaveWorkspaceCheckpointResult | void>;
    clock?: WorkspaceModelClock;
    windowTarget?: WorkspaceModelEventTarget;
    documentTarget?: WorkspaceModelEventTarget;
    onCheckpointError?: (error: unknown) => void;
}

export type WorkspacePreReplacementTeardown = () => void | Promise<void>;

function defaultClock(): WorkspaceModelClock {
    return {
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (timer) => clearTimeout(timer),
    };
}

function serializeActiveContent(activeContent: LocalWorkspaceContentState["activeContent"]): ActiveContent {
    switch (activeContent.kind) {
        case "agent":
            return { kind: "agent" };
        case "terminal":
            return { kind: "terminal", terminaltabid: activeContent.terminalTabId };
        case "top-tab":
            return { kind: "top-tab", toptabid: activeContent.topTabId };
    }
}

function serializeTopTab(tab: TopTab): TopTabDescriptor {
    switch (tab.kind) {
        case "file":
            return { id: tab.id, kind: tab.kind, path: tab.path, title: tab.title };
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
        case "agent-turn-diff":
            return {
                id: tab.id,
                kind: tab.kind,
                sessionid: tab.sessionId,
                sessioncreatedat: tab.sessionCreatedAt,
                sessioncwd: tab.sessionCwd,
                sessionpath: tab.sessionPath,
                turnid: tab.turnId,
                path: tab.path,
                title: tab.title,
            };
    }
}

function serializeContentState(state: LocalWorkspaceContentState): WorkspaceContentState {
    return {
        activecontent: serializeActiveContent(state.activeContent),
        toptabs: state.topTabs.map(serializeTopTab),
        lastactivetoptabid: state.lastActiveTopTabId,
    };
}

function defaultWindowTarget(): WorkspaceModelEventTarget {
    return typeof window === "undefined" ? undefined : window;
}

function defaultDocumentTarget(): WorkspaceModelEventTarget {
    return typeof document === "undefined" ? undefined : document;
}

export class WorkspaceModel {
    static instances = new Map<string, WorkspaceModel>();
    static replacements = new Map<string, Promise<WorkspaceModel>>();
    static resetInProgress: Promise<void>;

    contentStateAtom: jotai.PrimitiveAtom<LocalWorkspaceContentState>;
    terminalTabIdsAtom: jotai.PrimitiveAtom<string[]>;
    activeTerminalTabIdAtom: jotai.PrimitiveAtom<string>;
    checkpointStatusAtom: jotai.PrimitiveAtom<WorkspaceCheckpointStatus>;
    terminalSurfaceStatusAtom: jotai.PrimitiveAtom<TerminalSurfaceStatus>;

    workspaceId: string;
    revision: number;
    saveCheckpoint: (checkpoint: SaveWorkspaceCheckpointData) => Promise<SaveWorkspaceCheckpointResult | void>;
    navigationQueue: TopTabNavigationQueue;
    clock: WorkspaceModelClock;
    windowTarget: WorkspaceModelEventTarget;
    documentTarget: WorkspaceModelEventTarget;
    debounceTimer: ReturnType<typeof setTimeout>;
    terminalInventoryAuthoritative: boolean;
    surfaceGeneration: number;
    preReplacementTeardowns = new Set<WorkspacePreReplacementTeardown>();
    checkpointGeneration = 0;
    preparationPromise: Promise<void>;
    preparationComplete = false;
    disposed = false;
    disposalPromise: Promise<void>;
    checkpointErrorReported = false;

    onWindowFlush = () => {
        void this.flush().catch(() => {});
    };

    onVisibilityChange = () => {
        if (this.documentTarget?.visibilityState === "hidden") {
            void this.flush().catch(() => {});
        }
    };

    private constructor(options: WorkspaceModelOptions) {
        this.workspaceId = options.workspaceId;
        this.revision = Math.max(0, Math.trunc(options.initialNavigationRevision ?? 0));
        this.surfaceGeneration = Math.max(0, Math.trunc(options.surfaceGeneration ?? 0));
        this.saveCheckpoint =
            options.saveCheckpoint ?? ((checkpoint) => WorkspaceService.SaveWorkspaceCheckpoint(checkpoint));
        this.clock = options.clock ?? defaultClock();
        this.windowTarget = options.windowTarget ?? defaultWindowTarget();
        this.documentTarget = options.documentTarget ?? defaultDocumentTarget();

        const initialTerminalTabId =
            typeof options.initialActiveTerminalTabId === "string" ? options.initialActiveTerminalTabId : "";
        const contentState = hydrateWorkspaceContentState(options.initialContentState, initialTerminalTabId);
        this.contentStateAtom = jotai.atom(contentState);
        this.terminalInventoryAuthoritative = options.initialTerminalTabIds != null;
        this.terminalTabIdsAtom = jotai.atom(Array.from(options.initialTerminalTabIds ?? []));
        this.activeTerminalTabIdAtom = jotai.atom(initialTerminalTabId);
        this.checkpointStatusAtom = jotai.atom<WorkspaceCheckpointStatus>("clean");
        this.terminalSurfaceStatusAtom = jotai.atom<TerminalSurfaceStatus>(undefined);
        const initialCheckpoint: WorkspaceCheckpoint = {
            workspaceid: this.workspaceId,
            navigationrevision: this.revision,
            terminaltabids: Array.from(options.initialTerminalTabIds ?? []),
            contentstate: serializeContentState(contentState),
            activeterminaltabid: initialTerminalTabId || undefined,
        };
        let observedConfirmed: WorkspaceCheckpoint;
        this.navigationQueue = new TopTabNavigationQueue({
            confirmed: initialCheckpoint,
            save: async (data) => {
                const startedAt = topTabPerformanceNow();
                let result: SaveWorkspaceCheckpointResult | void;
                try {
                    result = await this.saveCheckpoint(data);
                } catch (error) {
                    recordTopTabPerformance("workspace-checkpoint-error", {
                        kind: "workspace",
                        id: this.workspaceId,
                        duration: topTabPerformanceNow() - startedAt,
                    });
                    throw error;
                }
                if (result) {
                    return result;
                }
                return {
                    status: "committed",
                    checkpoint: {
                        workspaceid: this.workspaceId,
                        navigationrevision: data.expectedrevision + 1,
                        terminaltabids: globalStore.get(this.terminalTabIdsAtom),
                        contentstate: data.contentstate,
                        activeterminaltabid: data.activeterminaltabid,
                    },
                };
            },
            getActiveTerminalTabId: () => globalStore.get(this.activeTerminalTabIdAtom),
            onChange: (confirmed, projected, error) => {
                const authoritativeUpdate = confirmed !== observedConfirmed;
                observedConfirmed = confirmed;
                this.revision = confirmed.navigationrevision;
                if (authoritativeUpdate) {
                    this.terminalInventoryAuthoritative = true;
                    globalStore.set(this.terminalTabIdsAtom, Array.from(confirmed.terminaltabids ?? []));
                    globalStore.set(this.activeTerminalTabIdAtom, confirmed.activeterminaltabid ?? "");
                }
                globalStore.set(this.contentStateAtom, projected);
                if (projected.activeContent.kind === "terminal") {
                    globalStore.set(this.activeTerminalTabIdAtom, projected.activeContent.terminalTabId);
                }
                globalStore.set(
                    this.checkpointStatusAtom,
                    error
                        ? "error"
                        : this.navigationQueue?.saving
                          ? "saving"
                          : this.navigationQueue?.pending.length
                            ? "dirty"
                            : "clean"
                );
                if (error && !this.checkpointErrorReported) {
                    this.checkpointErrorReported = true;
                    options.onCheckpointError?.(error);
                } else if (!error) {
                    this.checkpointErrorReported = false;
                }
            },
        });
        observedConfirmed = this.navigationQueue.confirmed;

        this.windowTarget?.addEventListener("blur", this.onWindowFlush);
        this.windowTarget?.addEventListener("beforeunload", this.onWindowFlush);
        this.documentTarget?.addEventListener("visibilitychange", this.onVisibilityChange);
    }

    static getInstance(options: WorkspaceModelOptions & { windowId: string }): WorkspaceModel {
        if (WorkspaceModel.resetInProgress) {
            throw new Error("workspace model reset is in progress");
        }
        if (WorkspaceModel.replacements.has(options.windowId)) {
            throw new Error(`await workspace replacement for window ${options.windowId}`);
        }
        const existing = WorkspaceModel.instances.get(options.windowId);
        if (existing) {
            if (existing.workspaceId !== options.workspaceId) {
                throw new Error(
                    `window ${options.windowId} already owns workspace ${existing.workspaceId}; use WorkspaceModel.replaceInstance()`
                );
            }
            return existing;
        }
        const model = new WorkspaceModel(options);
        WorkspaceModel.instances.set(options.windowId, model);
        return model;
    }

    static replaceInstance(options: WorkspaceModelOptions & { windowId: string }): Promise<WorkspaceModel> {
        if (WorkspaceModel.resetInProgress) {
            return Promise.reject(new Error("workspace model reset is in progress"));
        }
        if (WorkspaceModel.replacements.has(options.windowId)) {
            return Promise.reject(
                new Error(`workspace replacement is already in progress for window ${options.windowId}`)
            );
        }
        const replacement = (async () => {
            const existing = WorkspaceModel.instances.get(options.windowId);
            if (
                existing?.workspaceId === options.workspaceId &&
                (options.surfaceGeneration == null ||
                    existing.surfaceGeneration === Math.max(0, Math.trunc(options.surfaceGeneration)))
            ) {
                return existing;
            }
            if (existing) {
                await existing.flush();
                await existing.dispose();
            }
            const model = new WorkspaceModel(options);
            WorkspaceModel.instances.set(options.windowId, model);
            return model;
        })();
        WorkspaceModel.replacements.set(options.windowId, replacement);
        const clearReplacement = () => {
            if (WorkspaceModel.replacements.get(options.windowId) === replacement) {
                WorkspaceModel.replacements.delete(options.windowId);
            }
        };
        void replacement.then(clearReplacement, clearReplacement);
        return replacement;
    }

    static make(options: WorkspaceModelOptions): WorkspaceModel {
        return new WorkspaceModel(options);
    }

    static resetInstances(): Promise<void> {
        if (WorkspaceModel.resetInProgress) {
            return WorkspaceModel.resetInProgress;
        }
        const reset = (async () => {
            await Promise.allSettled(Array.from(WorkspaceModel.replacements.values()));
            const models = Array.from(WorkspaceModel.instances.values());
            WorkspaceModel.instances.clear();
            await Promise.all(models.map((model) => model.dispose()));
        })();
        WorkspaceModel.resetInProgress = reset;
        const clearReset = () => {
            if (WorkspaceModel.resetInProgress === reset) {
                WorkspaceModel.resetInProgress = undefined;
            }
        };
        void reset.then(clearReset, clearReset);
        return reset;
    }

    activateAgent(): void {
        this.apply({ type: "activate-agent" });
    }

    applyTerminalSurfaceStatus(status: TerminalSurfaceStatus): boolean {
        const current = globalStore.get(this.terminalSurfaceStatusAtom);
        if (
            status.workspaceid !== this.workspaceId ||
            status.generation !== this.surfaceGeneration ||
            status.revision < (current?.revision ?? 0)
        ) {
            return false;
        }
        if (current && status.revision === current.revision) {
            if (JSON.stringify(status) === JSON.stringify(current)) {
                return true;
            }
            if (current.state !== "loading" || (status.state !== "ready" && status.state !== "error")) {
                return false;
            }
        }
        globalStore.set(this.terminalSurfaceStatusAtom, status);
        return true;
    }

    activateTerminal(terminalTabId: string): boolean {
        if (this.terminalInventoryAuthoritative && !globalStore.get(this.terminalTabIdsAtom).includes(terminalTabId)) {
            return false;
        }
        this.apply({ type: "activate-terminal", terminalTabId }, terminalTabId);
        return true;
    }

    activateTopTab(topTabId: string): void {
        this.apply({ type: "activate-top-tab", topTabId });
    }

    openTopTab(tab: TopTab): void {
        this.apply({ type: "open-top-tab", tab });
    }

    updateTopTab(topTabId: string, updates: TopTabUpdates): void {
        this.apply({ type: "update-top-tab", topTabId, updates });
    }

    closeTopTab(topTabId: string): void {
        this.apply({
            type: "close-top-tab",
            topTabId,
            activeTerminalTabId: globalStore.get(this.activeTerminalTabIdAtom),
        });
    }

    reorderTopTabs(sourceId: string, targetId: string): void {
        const state = globalStore.get(this.contentStateAtom);
        const targetIndex = state.topTabs.findIndex((tab) => tab.id === targetId);
        if (targetIndex === -1 || !state.topTabs.some((tab) => tab.id === sourceId)) {
            return;
        }
        this.apply({ type: "reorder-top-tab", topTabId: sourceId, targetIndex });
    }

    reconcileCheckpoint(checkpoint: WorkspaceCheckpoint): boolean {
        if (this.disposed) {
            return false;
        }
        return this.navigationQueue.reconcile(checkpoint);
    }

    adoptAuthoritativeCheckpoint(checkpoint: WorkspaceCheckpoint): boolean {
        if (this.disposed) {
            return false;
        }
        return this.navigationQueue.reconcile(checkpoint, true);
    }

    registerPreReplacementTeardown(teardown: WorkspacePreReplacementTeardown): () => void {
        if (this.preparationPromise && !this.preparationComplete) {
            this.preReplacementTeardowns.add(teardown);
            return () => this.preReplacementTeardowns.delete(teardown);
        }
        if (this.disposed || this.preparationComplete) {
            this.runDetachedPreReplacementTeardown(teardown);
            return () => {};
        }
        this.preReplacementTeardowns.add(teardown);
        return () => this.preReplacementTeardowns.delete(teardown);
    }

    runDetachedPreReplacementTeardown(teardown: WorkspacePreReplacementTeardown): void {
        void Promise.resolve()
            .then(teardown)
            .catch((error) => {
                console.error(
                    "[workspace-model] teardown registered after preparation failed",
                    new AggregateError([error])
                );
            });
    }

    prepareForReplacement(): Promise<void> {
        if (this.preparationPromise) {
            return this.preparationPromise;
        }
        this.surfaceGeneration++;
        const checkpointStatus = globalStore.get(this.checkpointStatusAtom);
        const invalidation = this.invalidateLocalCheckpoints(checkpointStatus === "error");
        const preparation = (async () => {
            await invalidation;
            const errors: unknown[] = [];
            while (this.preReplacementTeardowns.size > 0) {
                const teardowns = Array.from(this.preReplacementTeardowns);
                this.preReplacementTeardowns.clear();
                const results = await Promise.allSettled(teardowns.map((teardown) => Promise.resolve().then(teardown)));
                errors.push(
                    ...results
                        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
                        .map((result) => result.reason)
                );
            }
            this.preparationComplete = true;
            if (errors.length > 0) {
                console.error("[workspace-model] workspace teardown failed", new AggregateError(errors));
            }
        })();
        this.preparationPromise = preparation;
        return preparation;
    }

    invalidateLocalCheckpoints(preserveError = false): Promise<void> {
        this.checkpointGeneration++;
        this.cancelDebounce();
        return this.navigationQueue.invalidate(preserveError);
    }

    async flush(): Promise<void> {
        this.cancelDebounce();
        globalStore.set(this.checkpointStatusAtom, this.navigationQueue.pending.length ? "saving" : "clean");
        return this.navigationQueue.flush();
    }

    async dispose(): Promise<void> {
        if (this.disposalPromise) {
            return this.disposalPromise;
        }
        const disposal = (async () => {
            await this.flush().catch(() => {});
            if (this.disposed) {
                return;
            }
            this.disposed = true;
            this.cancelDebounce();
            this.windowTarget?.removeEventListener("blur", this.onWindowFlush);
            this.windowTarget?.removeEventListener("beforeunload", this.onWindowFlush);
            this.documentTarget?.removeEventListener("visibilitychange", this.onVisibilityChange);
            await this.prepareForReplacement();
        })();
        this.disposalPromise = disposal;
        return disposal;
    }

    apply(action: WorkspaceContentAction, nextActiveTerminalTabId?: string): void {
        if (this.disposed) {
            return;
        }
        if (!this.navigationQueue.enqueue(action)) {
            return;
        }
        globalStore.set(this.checkpointStatusAtom, "dirty");
        if (nextActiveTerminalTabId != null) {
            globalStore.set(this.activeTerminalTabIdAtom, nextActiveTerminalTabId);
        }
        this.scheduleCheckpoint();
    }

    scheduleCheckpoint(): void {
        this.cancelDebounce();
        this.debounceTimer = this.clock.setTimeout(() => {
            this.debounceTimer = undefined;
            void this.flush().catch(() => {});
        }, CheckpointDelayMs);
    }

    cancelDebounce(): void {
        if (this.debounceTimer == null) {
            return;
        }
        this.clock.clearTimeout(this.debounceTimer);
        this.debounceTimer = undefined;
    }
}

export function makeWorkspaceModel(options: WorkspaceModelOptions): WorkspaceModel {
    return WorkspaceModel.make(options);
}
