// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { MonacoModelRegistry } from "@/app/righteditor/monaco-model-registry";
import { getRightEditorLanguage } from "@/app/righteditor/right-editor-language";
import type { RightEditorProductionRpc } from "@/app/righteditor/right-editor-rpc";
import type { RightEditorSaveStatus } from "@/app/righteditor/right-editor-types";
import type * as monaco from "monaco-editor";
import type { TopTabRuntime, TopTabRuntimeSnapshot } from "./top-tab-runtime-registry";
import { normalizeFileTabPath } from "./workspace-content-state";

type WorkspaceFileRpc = Pick<typeof RightEditorProductionRpc, "readFile" | "writeFile">;
type PathMutation = () => void | boolean | Promise<void | boolean>;

export interface WorkspacePathMigration {
    oldPath: string;
    newPath: string;
}

export type WorkspaceFileOperation = "idle" | "read" | "save" | "rename" | "delete";

export interface WorkspaceFileRuntimeSnapshot extends TopTabRuntimeSnapshot {
    saveStatus: RightEditorSaveStatus;
    operation: WorkspaceFileOperation;
    error: string;
}

export interface WorkspaceFileClosePreparationState {
    value: string;
    savedValue: string;
    dirty: boolean;
    saveStatus: RightEditorSaveStatus;
    operation: WorkspaceFileOperation;
    error: string;
    status: TopTabRuntimeSnapshot["status"];
    valueGeneration: number;
    modelValue: string;
    snapshot: WorkspaceFileRuntimeSnapshot;
}

function titleForPath(path: string): string {
    return path.split("/").filter(Boolean).at(-1) ?? path;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class WorkspaceFileRuntime implements TopTabRuntime {
    id: string;
    path: string;
    savedValue = "";
    value = "";
    dirty = false;
    readonly = false;
    modelUri: string;
    modelKey: string;
    model: monaco.editor.ITextModel;
    viewState: monaco.editor.ICodeEditorViewState;
    status: TopTabRuntimeSnapshot["status"] = "loading";
    saveStatus: RightEditorSaveStatus = "idle";
    error: string;
    operation: WorkspaceFileOperation = "read";
    ready: Promise<void>;
    registry: WorkspaceEditorRegistry;
    listeners = new Set<() => void>();
    disposed = false;
    snapshot: WorkspaceFileRuntimeSnapshot;
    aliases = new Set<string>();
    modelSubscription: monaco.IDisposable;
    applyingRegistryValue = false;
    saveGeneration = 0;
    valueGeneration = 0;

    constructor(registry: WorkspaceEditorRegistry, id: string, path: string) {
        this.registry = registry;
        this.id = id;
        this.aliases.add(id);
        this.path = path;
        this.modelKey = registry.modelKey(path);
        this.modelUri = registry.modelUri(path);
        this.model = registry.models.getOrCreateModel({
            path: this.modelKey,
            uri: this.modelUri,
            text: "",
            language: getRightEditorLanguage(path),
        });
        this.bindModel(this.model);
        this.snapshot = this.makeSnapshot();
        this.ready = registry.load(this, path);
    }

    get language(): string {
        return getRightEditorLanguage(this.path);
    }

    getSnapshot(): WorkspaceFileRuntimeSnapshot {
        return this.snapshot;
    }

    makeSnapshot(): WorkspaceFileRuntimeSnapshot {
        return {
            dirty: this.dirty,
            title: titleForPath(this.path),
            status: this.status,
            saveStatus: this.saveStatus,
            operation: this.operation,
            error: this.error ?? null,
        };
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(): void {
        this.snapshot = this.makeSnapshot();
        [...this.listeners].forEach((listener) => listener());
    }

    setValue(value: string): void {
        if (this.disposed) {
            return;
        }
        if (this.model.getValue() !== value) {
            this.model.setValue(value);
            return;
        }
        this.applyModelValue(value);
    }

    bindModel(model: monaco.editor.ITextModel): void {
        this.modelSubscription?.dispose();
        this.model = model;
        this.modelSubscription = model.onDidChangeContent(() => {
            if (!this.applyingRegistryValue) {
                this.applyModelValue(model.getValue());
            }
        });
    }

    applyModelValue(value: string): void {
        if (value === this.value) {
            return;
        }
        this.value = value;
        this.valueGeneration++;
        this.dirty = value !== this.savedValue;
        this.saveStatus = "idle";
        const destructiveOperation = this.operation === "rename" || this.operation === "delete";
        if (!destructiveOperation) {
            this.operation = "idle";
            this.status = "ready";
            this.error = undefined;
        }
        this.emit();
    }

    applyReadValue(value: string): void {
        this.applyingRegistryValue = true;
        this.savedValue = value;
        this.value = value;
        this.dirty = false;
        if (this.model.getValue() !== value) {
            this.model.setValue(value);
        }
        this.applyingRegistryValue = false;
    }

    saveViewState(viewState: monaco.editor.ICodeEditorViewState): void {
        this.viewState = viewState;
    }

    attach(editor: monaco.editor.IStandaloneCodeEditor): void {
        void editor;
    }

    detach(editor: monaco.editor.IStandaloneCodeEditor): void {
        this.viewState = editor.saveViewState();
    }

    async save(): Promise<void> {
        if (this.disposed || this.registry.closing || !this.dirty) {
            return;
        }
        const value = this.value;
        const valueGeneration = this.valueGeneration;
        const saveGeneration = ++this.saveGeneration;
        return this.registry.save(this, value, valueGeneration, saveGeneration);
    }

    discard(): void {
        this.setValue(this.savedValue);
    }

    async reload(): Promise<void> {
        if (this.disposed || this.registry.closing) {
            return;
        }
        this.status = "loading";
        this.operation = "read";
        this.error = undefined;
        this.emit();
        this.ready = this.registry.load(this, this.path);
        await this.ready;
    }

    captureClosePreparationState(): WorkspaceFileClosePreparationState {
        return {
            value: this.value,
            savedValue: this.savedValue,
            dirty: this.dirty,
            saveStatus: this.saveStatus,
            operation: this.operation,
            error: this.error,
            status: this.status,
            valueGeneration: this.valueGeneration,
            modelValue: this.model.getValue(),
            snapshot: this.snapshot,
        };
    }

    restoreClosePreparationState(state: WorkspaceFileClosePreparationState): void {
        this.applyingRegistryValue = true;
        try {
            if (this.model.getValue() !== state.modelValue) {
                this.model.setValue(state.modelValue);
            }
        } finally {
            this.applyingRegistryValue = false;
        }
        this.value = state.value;
        this.savedValue = state.savedValue;
        this.dirty = state.dirty;
        this.saveStatus = state.saveStatus;
        this.operation = state.operation;
        this.error = state.error;
        this.status = state.status;
        this.valueGeneration = state.valueGeneration;
        this.snapshot = state.snapshot;
        [...this.listeners].forEach((listener) => listener());
    }

    dispose(): Promise<void> {
        return this.registry.release(this);
    }

    disposeAlias(topTabId: string): Promise<void> {
        return this.registry.releaseAlias(topTabId, this);
    }
}

export class WorkspaceEditorRegistry {
    workspaceId: string;
    rpc: WorkspaceFileRpc;
    models: MonacoModelRegistry;
    runtimesById = new Map<string, WorkspaceFileRuntime>();
    runtimesByPath = new Map<string, WorkspaceFileRuntime>();
    readsByPath = new Map<string, Promise<{ text: string; readonly: boolean }>>();
    inFlightReads = new Set<Promise<unknown>>();
    reservedPaths = new Map<string, WorkspaceFileRuntime>();
    mutationQueue: Promise<void> = Promise.resolve();
    disposalPromise: Promise<void>;
    closing = false;
    disposed = false;

    constructor(workspaceId: string, rpc: WorkspaceFileRpc, models = new MonacoModelRegistry()) {
        this.workspaceId = workspaceId;
        this.rpc = rpc;
        this.models = models;
    }

    normalizePath(path: string): string {
        return normalizeFileTabPath(path);
    }

    modelKey(path: string): string {
        return `${this.workspaceId}:${this.normalizePath(path)}`;
    }

    modelUri(path: string): string {
        return `wave://workspace/${encodeURIComponent(this.workspaceId)}/${encodeURIComponent(this.normalizePath(path))}`;
    }

    open(id: string, path: string): WorkspaceFileRuntime {
        if (this.closing || this.disposed) {
            throw new Error("Workspace editor registry is disposed");
        }
        const existingById = this.runtimesById.get(id);
        if (existingById) {
            return existingById;
        }
        const normalizedPath = this.normalizePath(path);
        if (this.reservedPaths.has(normalizedPath)) {
            throw new Error(`Workspace file path is reserved: ${normalizedPath}`);
        }
        const existingByPath = this.runtimesByPath.get(normalizedPath);
        if (existingByPath) {
            existingByPath.aliases.add(id);
            this.runtimesById.set(id, existingByPath);
            return existingByPath;
        }
        const runtime = new WorkspaceFileRuntime(this, id, normalizedPath);
        this.runtimesById.set(id, runtime);
        this.runtimesByPath.set(normalizedPath, runtime);
        return runtime;
    }

    removePathRuntime(path: string, runtime: WorkspaceFileRuntime): void {
        if (this.runtimesByPath.get(path) === runtime) {
            this.runtimesByPath.delete(path);
        }
    }

    async load(runtime: WorkspaceFileRuntime, path: string): Promise<void> {
        let read = this.readsByPath.get(path);
        if (!read) {
            read = this.rpc.readFile(path);
            this.readsByPath.set(path, read);
            this.inFlightReads.add(read);
            void read.then(
                () => {
                    this.inFlightReads.delete(read);
                    if (this.readsByPath.get(path) === read) {
                        this.readsByPath.delete(path);
                    }
                },
                () => {
                    this.inFlightReads.delete(read);
                    if (this.readsByPath.get(path) === read) {
                        this.readsByPath.delete(path);
                    }
                }
            );
        }
        try {
            const result = await read;
            if (this.closing || runtime.disposed || runtime.path !== path || runtime.dirty) {
                return;
            }
            runtime.readonly = result.readonly;
            runtime.applyReadValue(result.text);
            const destructiveOperation = runtime.operation === "rename" || runtime.operation === "delete";
            if (!destructiveOperation) {
                runtime.status = "ready";
                runtime.operation = "idle";
                runtime.error = undefined;
                runtime.emit();
            }
        } catch (error) {
            if (this.closing || runtime.path !== path || runtime.disposed) {
                return;
            }
            runtime.status = "error";
            runtime.operation = "idle";
            runtime.error = errorMessage(error);
            runtime.emit();
        }
    }

    detach(_id: string): void {}

    save(runtime: WorkspaceFileRuntime, value: string, valueGeneration: number, saveGeneration: number): Promise<void> {
        return this.serializeMutation(async () => {
            if (runtime.disposed) {
                return;
            }
            const path = runtime.path;
            const isLatestSave = () => saveGeneration === runtime.saveGeneration;
            if (!this.closing && isLatestSave()) {
                runtime.saveStatus = "saving";
                runtime.operation = "save";
                runtime.status = "ready";
                runtime.error = undefined;
                runtime.emit();
            }
            try {
                await this.rpc.writeFile(path, value);
                if (this.closing || runtime.disposed || !isLatestSave()) {
                    return;
                }
                runtime.savedValue = value;
                runtime.dirty = runtime.value !== value;
                runtime.saveStatus = runtime.valueGeneration === valueGeneration ? "saved" : "idle";
                runtime.operation = "idle";
                runtime.status = "ready";
                runtime.emit();
            } catch (error) {
                if (!this.closing && !runtime.disposed && isLatestSave()) {
                    runtime.saveStatus = "error";
                    runtime.operation = "idle";
                    runtime.status = "error";
                    runtime.error = errorMessage(error);
                    runtime.emit();
                }
                throw error;
            }
        });
    }

    migratePaths(migrations: WorkspacePathMigration[], mutate?: PathMutation): Promise<void> {
        return this.serializeMutation(async () => {
            const records = migrations
                .map(({ oldPath, newPath }) => {
                    const oldNormalized = this.normalizePath(oldPath);
                    const newNormalized = this.normalizePath(newPath);
                    const runtime = this.runtimesByPath.get(oldNormalized);
                    return runtime && oldNormalized !== newNormalized
                        ? {
                              runtime,
                              oldPath: oldNormalized,
                              newPath: newNormalized,
                              oldModelKey: runtime.modelKey,
                              oldModelUri: runtime.modelUri,
                              status: runtime.status,
                              operation: runtime.operation,
                              error: runtime.error,
                          }
                        : undefined;
                })
                .filter(Boolean);
            if (records.length === 0) {
                await mutate?.();
                return;
            }
            const runtimes = new Set(records.map((record) => record.runtime));
            const destinations = new Set<string>();
            for (const record of records) {
                if (destinations.has(record.newPath)) {
                    throw new Error(`Workspace file destination is duplicated: ${record.newPath}`);
                }
                destinations.add(record.newPath);
                const destination = this.runtimesByPath.get(record.newPath);
                if (destination && !runtimes.has(destination)) {
                    throw new Error(`Workspace file destination is already open: ${record.newPath}`);
                }
                if (this.reservedPaths.has(record.oldPath) || this.reservedPaths.has(record.newPath)) {
                    throw new Error(`Workspace file path is reserved: ${record.newPath}`);
                }
            }
            for (const record of records) {
                this.reservedPaths.set(record.oldPath, record.runtime);
                this.reservedPaths.set(record.newPath, record.runtime);
                record.runtime.status = "loading";
                record.runtime.operation = "rename";
                record.runtime.error = undefined;
                record.runtime.emit();
            }
            let identitiesApplied = false;
            try {
                await mutate?.();
                if (this.closing) {
                    return;
                }
                for (const record of records) {
                    this.removePathRuntime(record.oldPath, record.runtime);
                }
                identitiesApplied = true;
                for (const record of records) {
                    const runtime = record.runtime;
                    runtime.path = record.newPath;
                    runtime.modelKey = this.modelKey(record.newPath);
                    runtime.modelUri = this.modelUri(record.newPath);
                    runtime.bindModel(
                        this.models.getOrCreateModel({
                            path: runtime.modelKey,
                            uri: runtime.modelUri,
                            text: runtime.value,
                            language: getRightEditorLanguage(record.newPath),
                        })
                    );
                    this.runtimesByPath.set(record.newPath, runtime);
                    this.models.disposePath(record.oldModelKey);
                }
                await Promise.all(
                    records.map(async ({ runtime, newPath }) => {
                        if (runtime.dirty) {
                            runtime.status = "ready";
                            runtime.operation = "idle";
                            runtime.emit();
                            return;
                        }
                        runtime.ready = this.load(runtime, newPath);
                        await runtime.ready;
                        if (!this.closing && !runtime.disposed && runtime.status !== "error") {
                            runtime.status = "ready";
                            runtime.operation = "idle";
                            runtime.error = undefined;
                            runtime.emit();
                        }
                    })
                );
            } catch (error) {
                if (identitiesApplied) {
                    for (const record of records) {
                        this.removePathRuntime(record.newPath, record.runtime);
                    }
                    for (const record of records) {
                        const runtime = record.runtime;
                        const currentModelKey = runtime.modelKey;
                        const identityChanged =
                            runtime.path !== record.oldPath ||
                            runtime.modelKey !== record.oldModelKey ||
                            runtime.modelUri !== record.oldModelUri;
                        runtime.path = record.oldPath;
                        runtime.modelKey = record.oldModelKey;
                        runtime.modelUri = record.oldModelUri;
                        if (identityChanged) {
                            runtime.bindModel(
                                this.models.getOrCreateModel({
                                    path: runtime.modelKey,
                                    uri: runtime.modelUri,
                                    text: runtime.value,
                                    language: getRightEditorLanguage(record.oldPath),
                                })
                            );
                        }
                        this.runtimesByPath.set(record.oldPath, runtime);
                        if (identityChanged && currentModelKey !== record.oldModelKey) {
                            this.models.disposePath(currentModelKey);
                        }
                    }
                }
                for (const record of records) {
                    const runtime = record.runtime;
                    if (!runtime.disposed) {
                        runtime.status = record.status;
                        runtime.operation = record.operation;
                        runtime.error = record.error;
                        runtime.emit();
                    }
                }
                throw error;
            } finally {
                for (const record of records) {
                    if (this.reservedPaths.get(record.oldPath) === record.runtime) {
                        this.reservedPaths.delete(record.oldPath);
                    }
                    if (this.reservedPaths.get(record.newPath) === record.runtime) {
                        this.reservedPaths.delete(record.newPath);
                    }
                }
            }
        });
    }

    deletePaths(paths: string[], mutate?: PathMutation): Promise<void> {
        return this.serializeMutation(async () => {
            const records = [
                ...new Set(paths.map((path) => this.runtimesByPath.get(this.normalizePath(path))).filter(Boolean)),
            ].map((runtime) => ({
                runtime,
                path: runtime.path,
                status: runtime.status,
                operation: runtime.operation,
                error: runtime.error,
            }));
            if (records.length === 0) {
                await mutate?.();
                return;
            }
            for (const record of records) {
                if (this.reservedPaths.has(record.path)) {
                    throw new Error(`Workspace file path is reserved: ${record.path}`);
                }
                this.reservedPaths.set(record.path, record.runtime);
                record.runtime.status = "loading";
                record.runtime.operation = "delete";
                record.runtime.error = undefined;
                record.runtime.emit();
            }
            try {
                await mutate?.();
                for (const record of records) {
                    this.finalize(record.runtime);
                }
            } catch (error) {
                for (const record of records) {
                    const runtime = record.runtime;
                    if (!runtime.disposed) {
                        runtime.status = record.status;
                        runtime.operation = record.operation;
                        runtime.error = record.error;
                        runtime.emit();
                    }
                }
                throw error;
            } finally {
                for (const record of records) {
                    if (this.reservedPaths.get(record.path) === record.runtime) {
                        this.reservedPaths.delete(record.path);
                    }
                }
            }
        });
    }

    migratePath(oldPath: string, newPath: string, mutate?: PathMutation): Promise<void> {
        return this.serializeMutation(async () => {
            const oldNormalized = this.normalizePath(oldPath);
            const newNormalized = this.normalizePath(newPath);
            const runtime = this.runtimesByPath.get(oldNormalized);
            if (!runtime || oldNormalized === newNormalized) {
                await mutate?.();
                return;
            }
            const destination = this.runtimesByPath.get(newNormalized);
            if (destination && destination !== runtime) {
                const error = new Error(`Workspace file destination is already open: ${newNormalized}`);
                runtime.status = "error";
                runtime.operation = "idle";
                runtime.error = error.message;
                runtime.emit();
                throw error;
            }
            if (this.reservedPaths.has(oldNormalized) || this.reservedPaths.has(newNormalized)) {
                throw new Error(`Workspace file path is reserved: ${newNormalized}`);
            }
            this.reservedPaths.set(oldNormalized, runtime);
            this.reservedPaths.set(newNormalized, runtime);
            runtime.status = "loading";
            runtime.operation = "rename";
            runtime.error = undefined;
            runtime.emit();
            try {
                const accepted = await mutate?.();
                if (accepted === false) {
                    throw new Error("Workspace file descriptor relocation was rejected");
                }
                if (this.closing || runtime.disposed) {
                    return;
                }
                const oldModelKey = runtime.modelKey;
                this.runtimesByPath.delete(oldNormalized);
                runtime.path = newNormalized;
                runtime.modelKey = this.modelKey(newNormalized);
                runtime.modelUri = this.modelUri(newNormalized);
                runtime.bindModel(
                    this.models.getOrCreateModel({
                        path: runtime.modelKey,
                        uri: runtime.modelUri,
                        text: runtime.value,
                        language: getRightEditorLanguage(newNormalized),
                    })
                );
                this.runtimesByPath.set(newNormalized, runtime);
                this.models.disposePath(oldModelKey);
                if (runtime.dirty) {
                    runtime.status = "ready";
                    runtime.operation = "idle";
                    runtime.emit();
                } else {
                    runtime.ready = this.load(runtime, newNormalized);
                    await runtime.ready;
                    if (!this.closing && !runtime.disposed && runtime.getSnapshot().status !== "error") {
                        runtime.status = "ready";
                        runtime.operation = "idle";
                        runtime.error = undefined;
                        runtime.emit();
                    }
                }
            } catch (error) {
                if (!this.closing && !runtime.disposed) {
                    runtime.status = "error";
                    runtime.operation = "idle";
                    runtime.error = errorMessage(error);
                    runtime.emit();
                }
                throw error;
            } finally {
                if (this.reservedPaths.get(newNormalized) === runtime) {
                    this.reservedPaths.delete(newNormalized);
                }
                if (this.reservedPaths.get(oldNormalized) === runtime) {
                    this.reservedPaths.delete(oldNormalized);
                }
            }
        });
    }

    deletePath(path: string, mutate?: PathMutation): Promise<void> {
        return this.serializeMutation(async () => {
            const runtime = this.runtimesByPath.get(this.normalizePath(path));
            if (!runtime) {
                await mutate?.();
                return;
            }
            runtime.status = "loading";
            runtime.operation = "delete";
            runtime.error = undefined;
            runtime.emit();
            try {
                await mutate?.();
                if (this.closing) {
                    this.finalize(runtime);
                    return;
                }
                runtime.status = "ready";
                runtime.operation = "idle";
                runtime.emit();
                this.finalize(runtime);
            } catch (error) {
                if (!this.closing && !runtime.disposed) {
                    runtime.status = "error";
                    runtime.operation = "idle";
                    runtime.error = errorMessage(error);
                    runtime.emit();
                }
                throw error;
            }
        });
    }

    serializeMutation(mutation: () => Promise<void>): Promise<void> {
        if (this.closing || this.disposed) {
            return Promise.reject(new Error("Workspace editor registry is disposed"));
        }
        const next = this.mutationQueue.then(mutation, mutation);
        this.mutationQueue = next.catch(() => {});
        return next;
    }

    finalize(runtime: WorkspaceFileRuntime): void {
        if (runtime.disposed) {
            return;
        }
        runtime.disposed = true;
        runtime.modelSubscription?.dispose();
        for (const [id, candidate] of this.runtimesById) {
            if (candidate === runtime) {
                this.runtimesById.delete(id);
            }
        }
        this.removePathRuntime(runtime.path, runtime);
        this.models.disposePath(runtime.modelKey);
        runtime.listeners.clear();
        runtime.aliases.clear();
    }

    async release(runtime: WorkspaceFileRuntime): Promise<void> {
        await this.mutationQueue.catch(() => {});
        if (runtime.aliases.size === 0 || [...runtime.aliases].every((id) => !this.runtimesById.has(id))) {
            this.finalize(runtime);
            return;
        }
        for (const id of [...runtime.aliases]) {
            this.runtimesById.delete(id);
            runtime.aliases.delete(id);
        }
        this.finalize(runtime);
    }

    async releaseAlias(id: string, runtime: WorkspaceFileRuntime): Promise<void> {
        if (this.runtimesById.get(id) !== runtime) {
            return;
        }
        this.runtimesById.delete(id);
        runtime.aliases.delete(id);
        if (runtime.aliases.size === 0) {
            await this.mutationQueue.catch(() => {});
            if (runtime.aliases.size === 0) {
                this.finalize(runtime);
            }
        }
    }

    async dispose(): Promise<void> {
        if (this.disposalPromise) {
            return this.disposalPromise;
        }
        this.disposalPromise = this.finishDisposal();
        return this.disposalPromise;
    }

    async finishDisposal(): Promise<void> {
        this.closing = true;
        await Promise.allSettled([this.mutationQueue, ...this.inFlightReads]);
        [...new Set(this.runtimesById.values())].forEach((runtime) => this.finalize(runtime));
        this.readsByPath.clear();
        this.reservedPaths.clear();
        this.models.disposeAll();
        this.disposed = true;
    }
}
