// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { makeTopTabCloseCoordinator, type TopTabCloseDecision } from "@/app/workspace/top-tab-close-coordinator";
import { atom } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { makeFileExplorerWorkspaceActions } from "./file-explorer-workspace-actions";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function makeRuntime(path: string, value: string, savedValue = "saved") {
    return {
        path,
        value,
        savedValue,
        dirty: value !== savedValue,
        save: vi.fn(async function (this: any) {
            this.savedValue = this.value;
            this.dirty = false;
        }),
        discard: vi.fn(function (this: any) {
            this.value = this.savedValue;
            this.dirty = false;
        }),
        getSnapshot() {
            return { dirty: this.dirty, title: this.path };
        },
        captureClosePreparationState() {
            return { value: this.value, savedValue: this.savedValue, dirty: this.dirty };
        },
        restoreClosePreparationState(state: any) {
            Object.assign(this, state);
        },
    };
}

function makeIntegrationHarness(decisions: TopTabCloseDecision[] = []) {
    const runtimeA = makeRuntime("/repo/src/a.ts", "dirty-a");
    const runtimeB = makeRuntime("/repo/src/nested/b.ts", "dirty-b");
    const contentStateAtom = atom({
        activeContent: { kind: "agent" as const },
        topTabs: [
            { id: "file-a", kind: "file" as const, path: runtimeA.path, title: "a.ts" },
            { id: "file-b", kind: "file" as const, path: runtimeB.path, title: "b.ts" },
            { id: "preview", kind: "preview" as const, path: "/repo/src/readme.md", title: "readme.md" },
            { id: "sibling", kind: "file" as const, path: "/repo/src-other/c.ts", title: "c.ts" },
        ],
        lastActiveTopTabId: "",
    });
    const model = {
        contentStateAtom,
        flush: vi.fn(),
        closeTopTab: vi.fn((id: string) => {
            const state = globalStore.get(contentStateAtom);
            globalStore.set(contentStateAtom, { ...state, topTabs: state.topTabs.filter((tab) => tab.id !== id) });
        }),
        updateTopTab: vi.fn((id: string, updates: any) => {
            const state = globalStore.get(contentStateAtom);
            globalStore.set(contentStateAtom, {
                ...state,
                topTabs: state.topTabs.map((tab) => (tab.id === id ? { ...tab, ...updates } : tab)) as any,
            });
        }),
    };
    const runtimesByPath = new Map([
        [runtimeA.path, runtimeA],
        [runtimeB.path, runtimeB],
    ]);
    let registryTail = Promise.resolve();
    const serializeMutation = (mutation: () => Promise<void>) => {
        const next = registryTail.then(mutation, mutation);
        registryTail = next.catch(() => {});
        return next;
    };
    const editorRegistry = {
        runtimesByPath,
        serializeMutation: vi.fn(serializeMutation),
        migratePaths: vi.fn(async (migrations: { oldPath: string; newPath: string }[], mutate?: () => Promise<void>) =>
            serializeMutation(async () => {
                await mutate?.();
                for (const { oldPath, newPath } of migrations) {
                    const runtime = runtimesByPath.get(oldPath);
                    if (!runtime) continue;
                    runtimesByPath.delete(oldPath);
                    runtime.path = newPath;
                    runtimesByPath.set(newPath, runtime);
                }
            })
        ),
        deletePaths: vi.fn(async (paths: string[], mutate?: () => Promise<void>) =>
            serializeMutation(async () => {
                await mutate?.();
                for (const path of paths) {
                    runtimesByPath.delete(path);
                }
            })
        ),
        migratePath: vi.fn(async (oldPath: string, newPath: string, mutate?: () => Promise<void>) =>
            serializeMutation(async () => {
                await mutate?.();
                const runtime = runtimesByPath.get(oldPath);
                if (!runtime) return;
                runtimesByPath.delete(oldPath);
                runtime.path = newPath;
                runtimesByPath.set(newPath, runtime);
            })
        ),
        deletePath: vi.fn(async (path: string, mutate?: () => Promise<void>) =>
            serializeMutation(async () => {
                await mutate?.();
                const runtime = runtimesByPath.get(path);
                if (runtime) {
                    runtimesByPath.delete(path);
                }
            })
        ),
        finalize: vi.fn((runtime: any) => runtimesByPath.delete(runtime.path)),
    };
    const requestDecision = vi.fn(async () => decisions.shift() ?? "save");
    const coordinator = makeTopTabCloseCoordinator({
        model,
        getTopTabs: () => globalStore.get(contentStateAtom).topTabs,
        getFileRuntime: (id) => (id === "file-a" ? runtimeA : id === "file-b" ? runtimeB : undefined),
        requestDecision,
    });
    const rpc = { rename: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    const actions = makeFileExplorerWorkspaceActions({
        controller: { openFile: vi.fn() },
        closeCoordinator: coordinator,
        editorRegistry: editorRegistry as any,
        homeDir: "/repo",
        model: model as any,
        terminalNavigation: { create: vi.fn() },
        rpc,
    });
    return { actions, contentStateAtom, editorRegistry, model, requestDecision, rpc, runtimeA, runtimeB };
}

describe("FileExplorerWorkspaceActions integration contract", () => {
    it("collects multiple dirty decisions before saving and discarding", async () => {
        const h = makeIntegrationHarness(["discard", "save"]);
        await expect(h.actions.renamePath("/repo/src", "/repo/lib")).resolves.toBe(true);
        expect(h.requestDecision).toHaveBeenCalledTimes(2);
        expect(h.runtimeA.discard).toHaveBeenCalledOnce();
        expect(h.runtimeB.save).toHaveBeenCalledOnce();
        expect(h.rpc.rename).toHaveBeenCalledOnce();
    });

    it("keeps every dirty buffer unchanged for Discard followed by Cancel", async () => {
        const h = makeIntegrationHarness(["discard", "cancel"]);
        await expect(h.actions.deletePath("/repo/src")).resolves.toBe(false);
        expect(h.runtimeA.value).toBe("dirty-a");
        expect(h.runtimeB.value).toBe("dirty-b");
        expect(h.runtimeA.discard).not.toHaveBeenCalled();
        expect(h.rpc.delete).not.toHaveBeenCalled();
    });

    it("stops before discard and filesystem mutation when any Save fails", async () => {
        const h = makeIntegrationHarness(["discard", "save"]);
        h.runtimeB.save.mockRejectedValueOnce(new Error("save failed"));
        await expect(h.actions.deletePath("/repo/src")).resolves.toBe(false);
        expect(h.runtimeA.discard).not.toHaveBeenCalled();
        expect(h.rpc.delete).not.toHaveBeenCalled();
    });

    it("keeps confirmed Save effects but rolls back Discard when the filesystem mutation fails", async () => {
        const h = makeIntegrationHarness(["discard", "save"]);
        h.rpc.delete.mockRejectedValueOnce(new Error("filesystem failed"));
        await expect(h.actions.deletePath("/repo/src")).rejects.toThrow("filesystem failed");
        expect(h.runtimeA.value).toBe("dirty-a");
        expect(h.runtimeA.dirty).toBe(true);
        expect(h.runtimeB.savedValue).toBe("dirty-b");
        expect(h.runtimeB.dirty).toBe(false);
        expect(globalStore.get(h.contentStateAtom).topTabs).toHaveLength(4);
    });

    it("migrates every runtime and File/Preview descriptor by exact prefix", async () => {
        const h = makeIntegrationHarness(["save", "save"]);
        await h.actions.renamePath("/repo/src", "/repo/lib");
        expect(h.editorRegistry.migratePaths).toHaveBeenCalledOnce();
        expect(h.editorRegistry.migratePath).not.toHaveBeenCalled();
        expect(h.editorRegistry.migratePaths).toHaveBeenCalledWith(
            [
                { oldPath: "/repo/src/a.ts", newPath: "/repo/lib/a.ts" },
                { oldPath: "/repo/src/nested/b.ts", newPath: "/repo/lib/nested/b.ts" },
            ],
            expect.any(Function)
        );
        expect([...h.editorRegistry.runtimesByPath.keys()].sort()).toEqual(["/repo/lib/a.ts", "/repo/lib/nested/b.ts"]);
        expect(globalStore.get(h.contentStateAtom).topTabs.map((tab) => tab.path)).toEqual([
            "/repo/lib/a.ts",
            "/repo/lib/nested/b.ts",
            "/repo/lib/readme.md",
            "/repo/src-other/c.ts",
        ]);
    });

    it("reverse-migrates completed descendants after a later local migration fails", async () => {
        const h = makeIntegrationHarness(["save", "save"]);
        h.editorRegistry.migratePaths.mockImplementationOnce(
            async (migrations: { oldPath: string; newPath: string }[], mutate?: () => Promise<void>) => {
                await mutate?.();
                const first = migrations[0];
                const runtime = h.editorRegistry.runtimesByPath.get(first.oldPath)!;
                h.editorRegistry.runtimesByPath.delete(first.oldPath);
                runtime.path = first.newPath;
                h.editorRegistry.runtimesByPath.set(first.newPath, runtime);
                h.editorRegistry.runtimesByPath.delete(first.newPath);
                runtime.path = first.oldPath;
                h.editorRegistry.runtimesByPath.set(first.oldPath, runtime);
                throw new Error("second migration failed");
            }
        );
        await expect(h.actions.renamePath("/repo/src", "/repo/lib")).rejects.toThrow("second migration failed");
        expect(h.rpc.rename.mock.calls).toEqual([
            ["/repo/src", "/repo/lib"],
            ["/repo/lib", "/repo/src"],
        ]);
        expect([...h.editorRegistry.runtimesByPath.keys()].sort()).toEqual(["/repo/src/a.ts", "/repo/src/nested/b.ts"]);
        expect(globalStore.get(h.contentStateAtom).topTabs.map((tab) => tab.path)).toEqual([
            "/repo/src/a.ts",
            "/repo/src/nested/b.ts",
            "/repo/src/readme.md",
            "/repo/src-other/c.ts",
        ]);
    });

    it("serializes overlapping parent and child mutations", async () => {
        const h = makeIntegrationHarness(["save", "save"]);
        const first = deferred();
        h.rpc.rename.mockImplementationOnce(() => first.promise);
        const parentRename = h.actions.renamePath("/repo/src", "/repo/lib");
        await vi.waitFor(() => expect(h.rpc.rename).toHaveBeenCalledOnce());
        const childDelete = h.actions.deletePath("/repo/src/nested");
        await Promise.resolve();
        expect(h.rpc.delete).not.toHaveBeenCalled();
        first.resolve();
        await parentRename;
        await childDelete;
        expect(h.rpc.delete).toHaveBeenCalledOnce();
    });
});
