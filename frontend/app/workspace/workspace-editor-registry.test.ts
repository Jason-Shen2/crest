// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { MonacoModelRegistry } from "@/app/righteditor/monaco-model-registry";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceEditorRegistry } from "./workspace-editor-registry";

const Models = vi.hoisted(() => new Map<string, any>());

vi.mock("@/app/monaco/monaco-env", () => ({ loadMonaco: vi.fn() }));
vi.mock("monaco-editor", () => ({
    Uri: { parse: (uri: string) => ({ toString: () => uri }) },
    editor: {
        createModel: (value: string, language: string, uri: { toString: () => string }) => {
            const listeners = new Set<() => void>();
            const model = {
                value,
                language,
                getValue: () => model.value,
                setValue: (next: string) => {
                    model.value = next;
                    listeners.forEach((listener) => listener());
                },
                onDidChangeContent: (listener: () => void) => {
                    listeners.add(listener);
                    return { dispose: () => listeners.delete(listener) };
                },
                dispose: () => Models.delete(uri.toString()),
            };
            Models.set(uri.toString(), model);
            return model;
        },
        getModel: (uri: { toString: () => string }) => Models.get(uri.toString()) ?? null,
        setModelLanguage: vi.fn(),
    },
}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe("WorkspaceEditorRegistry", () => {
    it("rolls back the runtime identity when descriptor relocation is rejected", async () => {
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile: vi.fn(),
            },
            new MonacoModelRegistry()
        );
        const runtime = registry.open("file-1", "/repo/old.ts");
        await runtime.ready;

        await expect(registry.migratePath("/repo/old.ts", "/repo/new.ts", () => false)).rejects.toThrow(
            "descriptor relocation was rejected"
        );

        expect(runtime.path).toBe("/repo/old.ts");
        expect(registry.runtimesByPath.get("/repo/old.ts")).toBe(runtime);
        expect(registry.runtimesByPath.has("/repo/new.ts")).toBe(false);
    });

    it("restores an exact dirty runtime snapshot after a speculative discard", async () => {
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile: vi.fn(),
            },
            new MonacoModelRegistry()
        );
        const runtime = registry.open("file-1", "/repo/a.ts");
        await runtime.ready;
        runtime.setValue("edited byte-for-byte");
        const originalSnapshot = runtime.getSnapshot();
        const state = runtime.captureClosePreparationState();
        const observed: unknown[] = [];
        runtime.subscribe(() => observed.push(runtime.getSnapshot()));

        runtime.discard();
        runtime.restoreClosePreparationState(state);

        expect(runtime.value).toBe("edited byte-for-byte");
        expect(runtime.model.getValue()).toBe("edited byte-for-byte");
        expect(runtime.savedValue).toBe("saved");
        expect(runtime.dirty).toBe(true);
        expect(runtime.getSnapshot()).toBe(originalSnapshot);
        expect(observed.at(-1)).toBe(originalSnapshot);
    });

    it("shares one runtime and buffer for normalized-path aliases until the final alias closes", async () => {
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile: vi.fn(),
            },
            new MonacoModelRegistry()
        );
        const first = registry.open("file-1", "/repo/a.ts");
        const second = registry.open("file-2", "/repo/./a.ts");
        await first.ready;

        expect(second).toBe(first);
        first.model.setValue("edited by model");
        expect(second.value).toBe("edited by model");
        expect(second.getSnapshot().dirty).toBe(true);
        second.setValue("edited by alias");
        expect(first.model.getValue()).toBe("edited by alias");
        expect(first.value).toBe("edited by alias");

        await first.disposeAlias("file-1");
        expect(first.disposed).toBe(false);
        expect(registry.models.getModelByPath(first.modelKey)).toBe(first.model);
        await second.disposeAlias("file-2");
        expect(first.disposed).toBe(true);
        expect(registry.models.getModelByPath(first.modelKey)).toBeNull();
        first.model.setValue("after disposal");
        expect(first.value).toBe("edited by alias");
    });

    it("deduplicates concurrent reads and rejects a stale result after path migration", async () => {
        const firstRead = deferred<{ text: string; readonly: boolean }>();
        const rpc = {
            readFile: vi
                .fn()
                .mockImplementationOnce(() => firstRead.promise)
                .mockResolvedValueOnce({ text: "new", readonly: false }),
            writeFile: vi.fn(),
        };
        const registry = new WorkspaceEditorRegistry("workspace-1", rpc, new MonacoModelRegistry());
        const first = registry.open("file-1", "/repo/a.ts");
        const second = registry.open("file-2", "/repo/./a.ts");
        const loadingSnapshot = first.getSnapshot();

        expect(rpc.readFile).toHaveBeenCalledTimes(1);
        expect(loadingSnapshot.operation).toBe("read");
        expect(first.getSnapshot()).toBe(loadingSnapshot);
        expect(second).toBe(first);
        expect(second.model).toBe(first.model);
        const migration = registry.migratePath("/repo/a.ts", "/repo/b.ts");
        firstRead.resolve({ text: "stale", readonly: false });
        await Promise.all([first.ready, migration]);

        expect(first.path).toBe("/repo/b.ts");
        expect(first.value).toBe("new");
        expect(first.getSnapshot().operation).toBe("idle");
        expect(first.getSnapshot()).not.toBe(loadingSnapshot);
    });

    it("preserves a destination reload failure after a successful rename", async () => {
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi
                    .fn()
                    .mockResolvedValueOnce({ text: "source", readonly: false })
                    .mockRejectedValueOnce(new Error("reload failed")),
                writeFile: vi.fn(),
            },
            new MonacoModelRegistry()
        );
        const runtime = registry.open("file-1", "/repo/a.ts");
        await runtime.ready;

        await registry.migratePath("/repo/a.ts", "/repo/b.ts", vi.fn());

        expect(runtime.path).toBe("/repo/b.ts");
        expect(runtime.value).toBe("source");
        expect(runtime.dirty).toBe(false);
        expect(runtime.getSnapshot()).toMatchObject({
            status: "error",
            operation: "idle",
            error: "reload failed",
        });
    });

    it("suppresses rename completion after disposal starts during destination reload", async () => {
        const destinationRead = deferred<{ text: string; readonly: boolean }>();
        const readFile = vi
            .fn()
            .mockResolvedValueOnce({ text: "source", readonly: false })
            .mockImplementationOnce(() => destinationRead.promise);
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile,
                writeFile: vi.fn(),
            },
            new MonacoModelRegistry()
        );
        const runtime = registry.open("file-1", "/repo/a.ts");
        await runtime.ready;
        const migration = registry.migratePath("/repo/a.ts", "/repo/b.ts", vi.fn());
        await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
        const listener = vi.fn();
        runtime.subscribe(listener);

        const disposal = registry.dispose();
        destinationRead.resolve({ text: "destination", readonly: false });
        await Promise.all([migration, disposal]);

        expect(listener).not.toHaveBeenCalled();
        expect(runtime.disposed).toBe(true);
    });

    it("keeps dirty buffers and view state across detach, saves, and disposes the final model owner", async () => {
        const rpc = {
            readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
            writeFile: vi.fn().mockResolvedValue(undefined),
        };
        const models = new MonacoModelRegistry();
        const registry = new WorkspaceEditorRegistry("workspace-1", rpc, models);
        const runtime = registry.open("file-1", "/repo/a.ts");
        await runtime.ready;
        runtime.setValue("edited");
        runtime.saveViewState({ cursorState: [] } as any);
        registry.detach("file-1");

        const sameRuntime = registry.open("file-1", "/repo/a.ts");
        expect(sameRuntime.value).toBe("edited");
        expect(sameRuntime.dirty).toBe(true);
        expect(sameRuntime.viewState).toEqual({ cursorState: [] });

        await sameRuntime.save();
        expect(rpc.writeFile).toHaveBeenCalledWith("/repo/a.ts", "edited");
        expect(sameRuntime.dirty).toBe(false);

        await registry.dispose();
        expect(models.getModelByPath(sameRuntime.modelKey)).toBeNull();
    });

    it("preserves dirty state and reports an error when save fails", async () => {
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile: vi.fn().mockRejectedValue(new Error("disk full")),
            },
            new MonacoModelRegistry()
        );
        const runtime = registry.open("file-1", "/repo/a.ts");
        await runtime.ready;
        runtime.setValue("edited");

        await expect(runtime.save()).rejects.toThrow("disk full");
        expect(runtime.dirty).toBe(true);
        expect(runtime.error).toBe("disk full");
        expect(runtime.getSnapshot().status).toBe("error");
    });

    it("emits observable read, edit, save, rename, and error transitions", async () => {
        const write = deferred<void>();
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile: vi.fn(() => write.promise),
            },
            new MonacoModelRegistry()
        );
        const runtime = registry.open("file-1", "/repo/a.ts");
        const transitions: string[] = [];
        runtime.subscribe(() => {
            const snapshot = runtime.getSnapshot();
            transitions.push(
                `${snapshot.title}:${snapshot.status}:${snapshot.dirty}:${snapshot.saveStatus}:${snapshot.operation}:${snapshot.error ?? ""}`
            );
        });
        await runtime.ready;
        runtime.model.setValue("edited");
        const save = runtime.save();
        write.resolve();
        await save;
        await expect(
            registry.migratePath("/repo/a.ts", "/repo/b.ts", () => Promise.reject(new Error("rename failed")))
        ).rejects.toThrow("rename failed");

        expect(transitions).toEqual([
            "a.ts:ready:false:idle:idle:",
            "a.ts:ready:true:idle:idle:",
            "a.ts:ready:true:saving:save:",
            "a.ts:ready:false:saved:idle:",
            "a.ts:loading:false:saved:rename:",
            "a.ts:error:false:saved:idle:rename failed",
        ]);
    });

    it("rejects rename collisions without changing either runtime", async () => {
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi
                    .fn()
                    .mockImplementation((path) =>
                        Promise.resolve({ text: path.endsWith("a.ts") ? "source" : "destination", readonly: false })
                    ),
                writeFile: vi.fn(),
            },
            new MonacoModelRegistry()
        );
        const source = registry.open("source", "/repo/a.ts");
        const destination = registry.open("destination", "/repo/b.ts");
        await Promise.all([source.ready, destination.ready]);
        source.setValue("dirty source");
        source.saveViewState({ cursorState: [{ position: { lineNumber: 3, column: 2 } }] } as any);
        const mutate = vi.fn();

        await expect(registry.migratePath("/repo/a.ts", "/repo/b.ts", mutate)).rejects.toThrow(/already open/i);

        expect(mutate).not.toHaveBeenCalled();
        expect(source.path).toBe("/repo/a.ts");
        expect(source.value).toBe("dirty source");
        expect(source.viewState.cursorState[0].position.lineNumber).toBe(3);
        expect(destination.path).toBe("/repo/b.ts");
        expect(destination.value).toBe("destination");
    });

    it("serializes rename and delete operations and rolls delete failure back", async () => {
        const firstMutation = deferred<void>();
        const order: string[] = [];
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile: vi.fn(),
            },
            new MonacoModelRegistry()
        );
        const runtime = registry.open("file-1", "/repo/a.ts");
        await runtime.ready;
        const operations: string[] = [];
        runtime.subscribe(() => operations.push(runtime.getSnapshot().operation));
        const rename = registry.migratePath("/repo/a.ts", "/repo/b.ts", async () => {
            order.push("rename-start");
            await firstMutation.promise;
            order.push("rename-end");
        });
        const deletion = registry.deletePath("/repo/b.ts", async () => {
            order.push("delete");
            throw new Error("delete failed");
        });

        await Promise.resolve();
        expect(order).toEqual(["rename-start"]);
        firstMutation.resolve();
        await rename;
        await expect(deletion).rejects.toThrow("delete failed");
        expect(order).toEqual(["rename-start", "rename-end", "delete"]);
        expect(runtime.path).toBe("/repo/b.ts");
        expect(runtime.disposed).toBe(false);
        expect(runtime.getSnapshot().status).toBe("error");
        expect(operations).toEqual(["rename", "idle", "delete", "idle"]);
    });

    it("serializes overlapping saves without letting the older completion clean newer content", async () => {
        const firstWrite = deferred<void>();
        const secondWrite = deferred<void>();
        const writeFile = vi
            .fn()
            .mockImplementationOnce(() => firstWrite.promise)
            .mockImplementationOnce(() => secondWrite.promise);
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile,
            },
            new MonacoModelRegistry()
        );
        const runtime = registry.open("file-1", "/repo/a.ts");
        await runtime.ready;
        runtime.setValue("first");
        const saveFirst = runtime.save();
        runtime.setValue("second");
        const saveSecond = runtime.save();

        await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
        expect(writeFile).toHaveBeenNthCalledWith(1, "/repo/a.ts", "first");
        firstWrite.resolve();
        await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(2));
        expect(runtime.dirty).toBe(true);
        expect(writeFile).toHaveBeenNthCalledWith(2, "/repo/a.ts", "second");
        secondWrite.resolve();
        await Promise.all([saveFirst, saveSecond]);

        expect(runtime.savedValue).toBe("second");
        expect(runtime.dirty).toBe(false);
        expect(runtime.getSnapshot().saveStatus).toBe("saved");
    });

    it.each([
        { label: "successful", rejects: false, expectedPath: "/repo/b.ts" },
        { label: "failed", rejects: true, expectedPath: "/repo/a.ts" },
    ])("saves against the committed identity after a $label rename", async ({ rejects, expectedPath }) => {
        const mutation = deferred<void>();
        const writeFile = vi.fn().mockResolvedValue(undefined);
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile,
            },
            new MonacoModelRegistry()
        );
        const runtime = registry.open("file-1", "/repo/a.ts");
        await runtime.ready;
        const rename = registry.migratePath("/repo/a.ts", "/repo/b.ts", () => mutation.promise);
        await vi.waitFor(() => expect(runtime.getSnapshot().operation).toBe("rename"));
        runtime.setValue("edited");
        const save = runtime.save();

        if (rejects) {
            mutation.reject(new Error("rename failed"));
            await expect(rename).rejects.toThrow("rename failed");
        } else {
            mutation.resolve();
            await rename;
        }
        await save;

        expect(writeFile).toHaveBeenCalledWith(expectedPath, "edited");
    });

    it("holds every descendant rename identity in one batch while edits queue saves to the new path", async () => {
        const filesystem = deferred<void>();
        const writeFile = vi.fn().mockResolvedValue(undefined);
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile,
            },
            new MonacoModelRegistry()
        );
        const first = registry.open("file-1", "/repo/src/a.ts");
        const second = registry.open("file-2", "/repo/src/nested/b.ts");
        await Promise.all([first.ready, second.ready]);

        const rename = registry.migratePaths(
            [
                { oldPath: first.path, newPath: "/repo/lib/a.ts" },
                { oldPath: second.path, newPath: "/repo/lib/nested/b.ts" },
            ],
            () => filesystem.promise
        );
        await vi.waitFor(() => expect(second.getSnapshot().operation).toBe("rename"));
        expect(first.getSnapshot().operation).toBe("rename");
        expect(registry.reservedPaths.has("/repo/src/nested/b.ts")).toBe(true);
        expect(() => registry.open("old-alias", "/repo/src/nested/b.ts")).toThrow(/reserved/i);

        second.setValue("edited during rename");
        const save = second.save();
        expect(writeFile).not.toHaveBeenCalled();
        filesystem.resolve();
        await rename;
        await save;

        expect(second.path).toBe("/repo/lib/nested/b.ts");
        expect(registry.runtimesByPath.has("/repo/src/nested/b.ts")).toBe(false);
        expect(writeFile).toHaveBeenCalledWith("/repo/lib/nested/b.ts", "edited during rename");
    });

    it("holds every descendant delete identity until one filesystem mutation disposes the batch", async () => {
        const filesystem = deferred<void>();
        const writeFile = vi.fn().mockResolvedValue(undefined);
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile,
            },
            new MonacoModelRegistry()
        );
        const first = registry.open("file-1", "/repo/src/a.ts");
        const second = registry.open("file-2", "/repo/src/nested/b.ts");
        await Promise.all([first.ready, second.ready]);

        const deletion = registry.deletePaths([first.path, second.path], () => filesystem.promise);
        await vi.waitFor(() => expect(second.getSnapshot().operation).toBe("delete"));
        expect(first.getSnapshot().operation).toBe("delete");
        second.setValue("edited during delete");
        const save = second.save();
        expect(writeFile).not.toHaveBeenCalled();
        filesystem.resolve();
        await deletion;
        await save;

        expect(first.disposed).toBe(true);
        expect(second.disposed).toBe(true);
        expect(registry.runtimesByPath.size).toBe(0);
        expect(writeFile).not.toHaveBeenCalled();
    });

    it("restores every descendant identity and operation when a batch filesystem mutation fails", async () => {
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile: vi.fn(),
            },
            new MonacoModelRegistry()
        );
        const first = registry.open("file-1", "/repo/src/a.ts");
        const second = registry.open("file-2", "/repo/src/nested/b.ts");
        await Promise.all([first.ready, second.ready]);

        await expect(
            registry.migratePaths(
                [
                    { oldPath: first.path, newPath: "/repo/lib/a.ts" },
                    { oldPath: second.path, newPath: "/repo/lib/nested/b.ts" },
                ],
                async () => {
                    second.setValue("edit survives failure");
                    throw new Error("filesystem failed");
                }
            )
        ).rejects.toThrow("filesystem failed");

        expect([...registry.runtimesByPath.keys()].sort()).toEqual(["/repo/src/a.ts", "/repo/src/nested/b.ts"]);
        expect(first.getSnapshot().operation).toBe("idle");
        expect(second.getSnapshot().operation).toBe("idle");
        expect(second.value).toBe("edit survives failure");
        expect(registry.reservedPaths.size).toBe(0);
    });

    it("rolls back every identity when applying one destination model fails", async () => {
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile: vi.fn(),
            },
            new MonacoModelRegistry()
        );
        const first = registry.open("file-1", "/repo/src/a.ts");
        const second = registry.open("file-2", "/repo/src/nested/b.ts");
        await Promise.all([first.ready, second.ready]);
        const getOrCreateModel = registry.models.getOrCreateModel.bind(registry.models);
        vi.spyOn(registry.models, "getOrCreateModel").mockImplementation((options) => {
            if (options.path.includes("/repo/lib/nested/b.ts")) {
                throw new Error("destination model failed");
            }
            return getOrCreateModel(options);
        });

        await expect(
            registry.migratePaths(
                [
                    { oldPath: first.path, newPath: "/repo/lib/a.ts" },
                    { oldPath: second.path, newPath: "/repo/lib/nested/b.ts" },
                ],
                vi.fn()
            )
        ).rejects.toThrow("destination model failed");

        expect(first.path).toBe("/repo/src/a.ts");
        expect(second.path).toBe("/repo/src/nested/b.ts");
        expect([...registry.runtimesByPath.keys()].sort()).toEqual(["/repo/src/a.ts", "/repo/src/nested/b.ts"]);
        expect(first.model.getValue()).toBe("saved");
        expect(second.model.getValue()).toBe("saved");
        expect(registry.reservedPaths.size).toBe(0);
    });

    it("does not run a queued save after a successful delete", async () => {
        const mutation = deferred<void>();
        const writeFile = vi.fn();
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile,
            },
            new MonacoModelRegistry()
        );
        const runtime = registry.open("file-1", "/repo/a.ts");
        await runtime.ready;
        runtime.setValue("edited");
        const deletion = registry.deletePath("/repo/a.ts", () => mutation.promise);
        await vi.waitFor(() => expect(runtime.getSnapshot().operation).toBe("delete"));
        const save = runtime.save();
        mutation.resolve();
        await Promise.all([deletion, save]);

        expect(writeFile).not.toHaveBeenCalled();
        expect(runtime.disposed).toBe(true);
    });

    it("keeps the old mapping authoritative and reserves the destination during pending migration", async () => {
        const mutation = deferred<void>();
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile: vi.fn(),
            },
            new MonacoModelRegistry()
        );
        const runtime = registry.open("file-1", "/repo/a.ts");
        await runtime.ready;
        const migration = registry.migratePath("/repo/a.ts", "/repo/b.ts", () => mutation.promise);
        await vi.waitFor(() => expect(runtime.getSnapshot().operation).toBe("rename"));

        expect(() => registry.open("old-alias", "/repo/a.ts")).toThrow(/reserved/i);
        expect(() => registry.open("new-alias", "/repo/b.ts")).toThrow(/reserved/i);
        expect(runtime.path).toBe("/repo/a.ts");
        expect(registry.runtimesByPath.get("/repo/a.ts")).toBe(runtime);

        mutation.reject(new Error("rename failed"));
        await expect(migration).rejects.toThrow("rename failed");
        expect(registry.runtimesById.has("new-alias")).toBe(false);
        expect(registry.open("after-rollback", "/repo/b.ts")).not.toBe(runtime);
        expect(registry.open("old-alias", "/repo/a.ts")).toBe(runtime);
        expect(runtime.aliases).toEqual(new Set(["file-1", "old-alias"]));
    });

    it("creates a separate old-path runtime when open retries after successful migration", async () => {
        const mutation = deferred<void>();
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile: vi.fn(),
            },
            new MonacoModelRegistry()
        );
        const runtime = registry.open("file-1", "/repo/a.ts");
        await runtime.ready;
        const migration = registry.migratePath("/repo/a.ts", "/repo/b.ts", () => mutation.promise);
        await vi.waitFor(() => expect(runtime.getSnapshot().operation).toBe("rename"));
        expect(() => registry.open("old-during", "/repo/a.ts")).toThrow(/reserved/i);
        expect(() => registry.open("new-during", "/repo/b.ts")).toThrow(/reserved/i);

        mutation.resolve();
        await migration;
        const oldRuntime = registry.open("old-after", "/repo/a.ts");

        expect(oldRuntime).not.toBe(runtime);
        expect(registry.runtimesByPath.get("/repo/a.ts")).toBe(oldRuntime);
        expect(registry.runtimesByPath.get("/repo/b.ts")).toBe(runtime);
    });

    it.each(["rename", "delete"] as const)(
        "preserves the $kind operation while edits update the buffer",
        async (kind) => {
            const mutation = deferred<void>();
            const registry = new WorkspaceEditorRegistry(
                "workspace-1",
                {
                    readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                    writeFile: vi.fn(),
                },
                new MonacoModelRegistry()
            );
            const runtime = registry.open("file-1", "/repo/a.ts");
            await runtime.ready;
            const operation =
                kind === "rename"
                    ? registry.migratePath("/repo/a.ts", "/repo/b.ts", () => mutation.promise)
                    : registry.deletePath("/repo/a.ts", () => mutation.promise);
            await vi.waitFor(() => expect(runtime.getSnapshot().operation).toBe(kind));

            runtime.model.setValue("edited during operation");
            expect(runtime.value).toBe("edited during operation");
            expect(runtime.getSnapshot()).toMatchObject({
                dirty: true,
                operation: kind,
                status: "loading",
            });

            mutation.reject(new Error(`${kind} failed`));
            await expect(operation).rejects.toThrow(`${kind} failed`);
        }
    );

    it("atomically closes mutation admission during and after disposal", async () => {
        const write = deferred<void>();
        const writeFile = vi.fn(() => write.promise);
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile,
            },
            new MonacoModelRegistry()
        );
        const runtime = registry.open("file-1", "/repo/a.ts");
        await runtime.ready;
        runtime.setValue("edited");
        const save = runtime.save();
        await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
        const disposal = registry.dispose();
        const renameMutation = vi.fn();
        const deleteMutation = vi.fn();
        const directMutation = vi.fn();

        await expect(registry.migratePath("/repo/a.ts", "/repo/b.ts", renameMutation)).rejects.toThrow(/disposed/i);
        await expect(registry.deletePath("/repo/a.ts", deleteMutation)).rejects.toThrow(/disposed/i);
        await expect(registry.serializeMutation(async () => directMutation())).rejects.toThrow(/disposed/i);
        expect(renameMutation).not.toHaveBeenCalled();
        expect(deleteMutation).not.toHaveBeenCalled();
        expect(directMutation).not.toHaveBeenCalled();

        write.resolve();
        await Promise.all([save, disposal]);
        await expect(registry.migratePath("/repo/a.ts", "/repo/b.ts", renameMutation)).rejects.toThrow(/disposed/i);
        expect(renameMutation).not.toHaveBeenCalled();
    });

    it("waits for deferred reads and writes before final disposal without stale emits", async () => {
        const read = deferred<{ text: string; readonly: boolean }>();
        const write = deferred<void>();
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn(() => read.promise),
                writeFile: vi.fn(() => write.promise),
            },
            new MonacoModelRegistry()
        );
        const runtime = registry.open("file-1", "/repo/a.ts");
        const listener = vi.fn();
        runtime.subscribe(listener);
        const readDisposal = registry.dispose();
        let disposed = false;
        void readDisposal.then(() => {
            disposed = true;
        });
        await Promise.resolve();
        expect(disposed).toBe(false);
        read.resolve({ text: "stale", readonly: false });
        await readDisposal;
        expect(listener).not.toHaveBeenCalled();
        expect(runtime.disposed).toBe(true);

        const secondRegistry = new WorkspaceEditorRegistry(
            "workspace-2",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile: vi.fn(() => write.promise),
            },
            new MonacoModelRegistry()
        );
        const savingRuntime = secondRegistry.open("file-2", "/repo/b.ts");
        await savingRuntime.ready;
        savingRuntime.setValue("edited");
        const save = savingRuntime.save();
        await vi.waitFor(() => expect(savingRuntime.getSnapshot().operation).toBe("save"));
        const emitCount = vi.fn();
        savingRuntime.subscribe(emitCount);
        const writeDisposal = secondRegistry.dispose();
        await Promise.resolve();
        expect(savingRuntime.disposed).toBe(false);
        write.resolve();
        await Promise.all([save, writeDisposal]);
        expect(emitCount).not.toHaveBeenCalled();
        expect(savingRuntime.disposed).toBe(true);
    });

    it("waits for pending migration before disposal and suppresses completion emits", async () => {
        const mutation = deferred<void>();
        const registry = new WorkspaceEditorRegistry(
            "workspace-1",
            {
                readFile: vi.fn().mockResolvedValue({ text: "saved", readonly: false }),
                writeFile: vi.fn(),
            },
            new MonacoModelRegistry()
        );
        const runtime = registry.open("file-1", "/repo/a.ts");
        await runtime.ready;
        const migration = registry.migratePath("/repo/a.ts", "/repo/b.ts", () => mutation.promise);
        await vi.waitFor(() => expect(runtime.getSnapshot().operation).toBe("rename"));
        const listener = vi.fn();
        runtime.subscribe(listener);
        const disposal = registry.dispose();
        let disposed = false;
        void disposal.then(() => {
            disposed = true;
        });
        await Promise.resolve();
        expect(disposed).toBe(false);
        mutation.resolve();
        await Promise.all([migration, disposal]);

        expect(listener).not.toHaveBeenCalled();
        expect(runtime.disposed).toBe(true);
    });
});
