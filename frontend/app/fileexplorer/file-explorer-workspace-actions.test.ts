// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

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

function makeHarness() {
    const contentStateAtom = atom({
        activeContent: { kind: "agent" as const },
        topTabs: [
            { id: "file-1", kind: "file" as const, path: "/repo/src/a.ts", title: "a.ts" },
            { id: "preview-1", kind: "preview" as const, path: "/repo/src/docs/readme.md", title: "readme.md" },
        ],
        lastActiveTopTabId: "",
    });
    const runtime = { path: "/repo/src/a.ts", value: "" };
    const editorRegistry = {
        runtimesByPath: new Map([[runtime.path, runtime]]),
        migratePaths: vi.fn(
            async (migrations: { oldPath: string; newPath: string }[], mutate?: () => Promise<void>) => {
                await mutate?.();
                for (const { oldPath, newPath } of migrations) {
                    const candidate = editorRegistry.runtimesByPath.get(oldPath);
                    if (!candidate) continue;
                    editorRegistry.runtimesByPath.delete(oldPath);
                    candidate.path = newPath;
                    editorRegistry.runtimesByPath.set(newPath, candidate);
                }
            }
        ),
        deletePaths: vi.fn(async (_paths: string[], mutate?: () => Promise<void>) => mutate?.()),
        migratePath: vi.fn(async (oldPath: string, newPath: string, mutate?: () => Promise<void>) => {
            await mutate?.();
            editorRegistry.runtimesByPath.delete(oldPath);
            runtime.path = newPath;
            editorRegistry.runtimesByPath.set(newPath, runtime);
        }),
        deletePath: vi.fn(async (_path: string, mutate?: () => Promise<void>) => mutate?.()),
        serializeMutation: vi.fn(async (mutate: () => Promise<void>) => mutate()),
        finalize: vi.fn(),
    };
    const model = {
        contentStateAtom,
        updateTopTab: vi.fn(),
        closeTopTab: vi.fn(),
    };
    const prepared = { commit: vi.fn(), rollback: vi.fn() };
    const closeCoordinator = { prepareFileMutationsSession: vi.fn().mockResolvedValue(prepared) };
    const rpc = { rename: vi.fn(), delete: vi.fn() };
    const controller = { openFile: vi.fn() };
    const terminalNavigation = { create: vi.fn() };
    const actions = makeFileExplorerWorkspaceActions({
        controller,
        closeCoordinator,
        editorRegistry: editorRegistry as any,
        model: model as any,
        terminalNavigation,
        rpc,
        homeDir: "/repo",
    });
    return { actions, closeCoordinator, controller, editorRegistry, model, prepared, rpc, terminalNavigation };
}

describe("FileExplorerWorkspaceActions", () => {
    it("expands FileInfo home-relative paths before opening a File Top Tab", async () => {
        const h = makeHarness();

        await h.actions.openFile("~/Documents/crest/frontend/app.ts");

        expect(h.controller.openFile).toHaveBeenCalledWith("/repo/Documents/crest/frontend/app.ts");
    });

    it("matches home-relative rename paths against absolute File and Preview descriptors", async () => {
        const h = makeHarness();

        await expect(h.actions.renamePath("~/src", "~/lib")).resolves.toBe(true);

        expect(h.closeCoordinator.prepareFileMutationsSession).toHaveBeenCalledWith(["file-1", "preview-1"]);
        expect(h.rpc.rename).toHaveBeenCalledWith("/repo/src", "/repo/lib");
    });

    it("expands the home root before creating a Terminal", async () => {
        const h = makeHarness();

        await h.actions.createTerminal("~");

        expect(h.terminalNavigation.create).toHaveBeenCalledWith({ cwd: "/repo" });
    });

    it("collects all affected Top Tabs before a directory rename and migrates descendants", async () => {
        const h = makeHarness();
        await expect(h.actions.renamePath("/repo/src", "/repo/lib")).resolves.toBe(true);
        expect(h.closeCoordinator.prepareFileMutationsSession).toHaveBeenCalledWith(["file-1", "preview-1"]);
        expect(h.rpc.rename).toHaveBeenCalledOnce();
        expect(h.editorRegistry.migratePaths).toHaveBeenCalledWith(
            [{ oldPath: "/repo/src/a.ts", newPath: "/repo/lib/a.ts" }],
            expect.any(Function)
        );
        expect(h.model.updateTopTab).toHaveBeenCalledTimes(2);
        expect(h.prepared.commit).toHaveBeenCalledOnce();
        expect(h.prepared.rollback).not.toHaveBeenCalled();
    });

    it("stops before filesystem mutation when the batch guard cancels", async () => {
        const h = makeHarness();
        h.closeCoordinator.prepareFileMutationsSession.mockResolvedValue(undefined);
        await expect(h.actions.deletePath("/repo/src")).resolves.toBe(false);
        expect(h.rpc.delete).not.toHaveBeenCalled();
    });

    it.each(["rename", "delete"] as const)(
        "rolls back a prepared discard when %s filesystem mutation fails",
        async (kind) => {
            const h = makeHarness();
            const runtime = h.editorRegistry.runtimesByPath.get("/repo/src/a.ts")!;
            Object.assign(runtime, { value: "dirty-before", dirty: true });
            h.closeCoordinator.prepareFileMutationsSession.mockImplementationOnce(async () => {
                runtime.value = "saved";
                runtime.dirty = false;
                return {
                    commit: h.prepared.commit,
                    rollback: () => {
                        h.prepared.rollback();
                        runtime.value = "dirty-before";
                        runtime.dirty = true;
                    },
                };
            });
            h.rpc[kind].mockRejectedValue(new Error(`${kind} failed`));

            const mutation =
                kind === "rename" ? h.actions.renamePath("/repo/src", "/repo/lib") : h.actions.deletePath("/repo/src");
            await expect(mutation).rejects.toThrow(`${kind} failed`);

            expect(h.prepared.rollback).toHaveBeenCalledOnce();
            expect(h.prepared.commit).not.toHaveBeenCalled();
            expect(runtime.path).toBe("/repo/src/a.ts");
            expect(runtime).toMatchObject({ value: "dirty-before", dirty: true });
        }
    );

    it("reverse-renames the filesystem when local migration fails", async () => {
        const h = makeHarness();
        h.editorRegistry.migratePaths.mockImplementationOnce(
            async (_migrations: { oldPath: string; newPath: string }[], mutate?: () => Promise<void>) => {
                await mutate?.();
                throw new Error("migration failed");
            }
        );
        await expect(h.actions.renamePath("/repo/src", "/repo/lib")).rejects.toThrow("migration failed");
        expect(h.rpc.rename.mock.calls).toEqual([
            ["/repo/src", "/repo/lib"],
            ["/repo/lib", "/repo/src"],
        ]);
    });

    it.each(["rename", "delete"] as const)("keeps a slow %s RPC inside the registry mutation fence", async (kind) => {
        const h = makeHarness();
        const slowRpc = deferred();
        const order: string[] = [];
        let registryTail = Promise.resolve();
        const fence = (operation: () => Promise<void>) => {
            const next = registryTail.then(operation, operation);
            registryTail = next.catch(() => {});
            return next;
        };
        h.editorRegistry.migratePaths.mockImplementation(
            async (migrations: { oldPath: string; newPath: string }[], mutate?: () => Promise<void>) =>
                fence(async () => {
                    order.push("mutation-start");
                    await mutate?.();
                    for (const { oldPath, newPath } of migrations) {
                        const runtime = h.editorRegistry.runtimesByPath.get(oldPath);
                        if (runtime) {
                            h.editorRegistry.runtimesByPath.delete(oldPath);
                            runtime.path = newPath;
                            h.editorRegistry.runtimesByPath.set(newPath, runtime);
                        }
                    }
                    order.push("mutation-end");
                })
        );
        h.editorRegistry.deletePaths.mockImplementation(async (_paths: string[], mutate?: () => Promise<void>) =>
            fence(async () => {
                order.push("mutation-start");
                await mutate?.();
                order.push("mutation-end");
            })
        );
        const rpc = kind === "rename" ? h.rpc.rename : h.rpc.delete;
        rpc.mockImplementationOnce(async () => {
            order.push("rpc-start");
            await slowRpc.promise;
            order.push("rpc-end");
        });

        const mutation =
            kind === "rename" ? h.actions.renamePath("/repo/src", "/repo/lib") : h.actions.deletePath("/repo/src");
        await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce());
        const save = fence(async () => {
            order.push("save");
        });
        const editedRuntime = h.editorRegistry.runtimesByPath.get("/repo/src/a.ts")!;
        editedRuntime.value = "edited-during-rpc";
        await Promise.resolve();
        expect(order).toEqual(["mutation-start", "rpc-start"]);

        slowRpc.resolve();
        await mutation;
        await save;
        expect(order).toEqual(["mutation-start", "rpc-start", "rpc-end", "mutation-end", "save"]);
        expect(editedRuntime.value).toBe("edited-during-rpc");
    });
});
