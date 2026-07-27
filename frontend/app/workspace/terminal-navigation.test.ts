import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTerminalNavigationAdapter } from "./terminal-navigation";
import { WorkspaceModel } from "./workspace-model";

function checkpoint(revision: number, terminalTabIds: string[], activeTerminalTabId = terminalTabIds[0] ?? "") {
    return {
        workspaceid: "ws-1",
        navigationrevision: revision,
        terminaltabids: terminalTabIds,
        activeterminaltabid: activeTerminalTabId,
        contentstate: {
            activecontent: activeTerminalTabId
                ? { kind: "terminal", terminaltabid: activeTerminalTabId }
                : { kind: "agent" },
            toptabs: [],
            lastactivetoptabid: "",
        },
    } as WorkspaceCheckpoint;
}

function deferred<T>() {
    let resolve!: (value?: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

afterEach(async () => {
    await WorkspaceModel.resetInstances();
});

describe("terminal navigation", () => {
    it("flushes pending selection before create and applies the authoritative checkpoint", async () => {
        let resolveSave: () => void;
        const saveCheckpoint = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveSave = resolve;
                })
        );
        const create = vi.fn().mockResolvedValue(checkpoint(2, ["term-1", "term-2"], "term-2"));
        const model = WorkspaceModel.make({
            workspaceId: "ws-1",
            initialTerminalTabIds: ["term-1"],
            initialActiveTerminalTabId: "term-1",
            saveCheckpoint,
        });
        const navigation = makeTerminalNavigationAdapter(model, {
            create,
            rename: vi.fn(),
            close: vi.fn(),
            reorder: vi.fn(),
            reload: vi.fn(),
        });

        model.activateAgent();
        const creating = navigation.create({});
        await Promise.resolve();
        expect(saveCheckpoint).toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        resolveSave!();
        await creating;

        expect(create).toHaveBeenCalledWith(expect.objectContaining({ expectedrevision: 1 }));
        expect(globalStore.get(model.terminalTabIdsAtom)).toEqual(["term-1", "term-2"]);
        expect(model.revision).toBe(2);
    });

    it("serializes structural mutations and rejects equal-revision different checkpoints", async () => {
        let resolveCreate: (value: WorkspaceCheckpoint) => void;
        const create = vi.fn(
            () =>
                new Promise<WorkspaceCheckpoint>((resolve) => {
                    resolveCreate = resolve;
                })
        );
        const close = vi.fn().mockResolvedValue(checkpoint(2, []));
        const model = WorkspaceModel.make({
            workspaceId: "ws-1",
            initialTerminalTabIds: ["term-1"],
            initialActiveTerminalTabId: "term-1",
        });
        const navigation = makeTerminalNavigationAdapter(model, {
            create,
            rename: vi.fn(),
            close,
            reorder: vi.fn(),
            reload: vi.fn(),
        });

        const creating = navigation.create({});
        const closing = navigation.close("term-1");
        await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
        expect(close).not.toHaveBeenCalled();
        resolveCreate!(checkpoint(1, ["term-1", "term-2"], "term-2"));
        await creating;
        await closing;
        expect(close).toHaveBeenCalledWith(expect.objectContaining({ expectedrevision: 1 }));

        expect(model.reconcileCheckpoint(checkpoint(2, ["different"], "different"))).toBe(false);
        expect(globalStore.get(model.terminalTabIdsAtom)).toEqual([]);
    });

    it("accepts an idempotent RPC response after the matching WOS update arrives first", async () => {
        let resolveCreate: (value: WorkspaceCheckpoint) => void;
        const create = vi.fn(
            () =>
                new Promise<WorkspaceCheckpoint>((resolve) => {
                    resolveCreate = resolve;
                })
        );
        const model = WorkspaceModel.make({
            workspaceId: "ws-1",
            initialTerminalTabIds: [],
        });
        const navigation = makeTerminalNavigationAdapter(model, {
            create,
            rename: vi.fn(),
            close: vi.fn(),
            reorder: vi.fn(),
            reload: vi.fn(),
        });
        const creating = navigation.create({});
        await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
        const authoritative = checkpoint(1, ["term-1"]);
        expect(model.reconcileCheckpoint(authoritative)).toBe(true);
        resolveCreate!(authoritative);

        await creating;
        expect(globalStore.get(model.terminalTabIdsAtom)).toEqual(["term-1"]);
        expect(model.revision).toBe(1);
    });

    it("reloads the workspace after a stale structural mutation", async () => {
        const stale = new Error("stale workspace checkpoint: expected revision 1");
        const reload = vi.fn().mockResolvedValue({
            oid: "ws-1",
            otype: "workspace",
            version: 3,
            navigationrevision: 2,
            terminaltabids: ["term-remote"],
            activeterminaltabid: "term-remote",
            contentstate: {
                activecontent: { kind: "terminal", terminaltabid: "term-remote" },
                toptabs: [],
                lastactivetoptabid: "",
            },
        } as Workspace);
        const model = WorkspaceModel.make({ workspaceId: "ws-1", initialTerminalTabIds: [] });
        const navigation = makeTerminalNavigationAdapter(model, {
            create: vi.fn().mockRejectedValue(stale),
            rename: vi.fn(),
            close: vi.fn(),
            reorder: vi.fn(),
            reload,
        });

        await expect(navigation.create({})).rejects.toBe(stale);
        expect(reload).toHaveBeenCalledOnce();
        expect(globalStore.get(model.terminalTabIdsAtom)).toEqual(["term-remote"]);
        expect(model.revision).toBe(2);
    });

    it("adopts an equal-revision authoritative reload after conflict and allows the next mutation", async () => {
        const stale = new Error("stale workspace checkpoint: expected revision 1");
        const remote = {
            oid: "ws-1",
            otype: "workspace",
            version: 3,
            navigationrevision: 1,
            terminaltabids: ["term-remote"],
            activeterminaltabid: "term-remote",
            contentstate: {
                activecontent: { kind: "terminal", terminaltabid: "term-remote" },
                toptabs: [],
                lastactivetoptabid: "",
            },
        } as Workspace;
        const create = vi.fn().mockResolvedValue(checkpoint(3, ["term-remote", "term-new"], "term-new"));
        const model = WorkspaceModel.make({
            workspaceId: "ws-1",
            initialTerminalTabIds: ["term-local"],
            initialActiveTerminalTabId: "term-local",
            initialContentState: {
                activecontent: { kind: "terminal", terminaltabid: "term-local" },
                toptabs: [],
                lastactivetoptabid: "",
            },
            saveCheckpoint: vi.fn().mockRejectedValueOnce(stale).mockResolvedValue(undefined),
        });
        const navigation = makeTerminalNavigationAdapter(model, {
            create,
            rename: vi.fn(),
            close: vi.fn(),
            reorder: vi.fn(),
            reload: vi.fn().mockResolvedValue(remote),
        });

        model.activateAgent();
        await expect(navigation.create({})).rejects.toBe(stale);
        expect(globalStore.get(model.terminalTabIdsAtom)).toEqual(["term-remote"]);
        expect(globalStore.get(model.checkpointStatusAtom)).toBe("dirty");

        await navigation.create({});
        expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ expectedrevision: 2 }));
        expect(globalStore.get(model.terminalTabIdsAtom)).toEqual(["term-remote", "term-new"]);
    });

    it("replays a dirty selection when a newer WOS checkpoint arrives before structural mutation", async () => {
        const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
        const create = vi.fn().mockResolvedValue(checkpoint(3, ["term-remote", "term-new"], "term-new"));
        const model = WorkspaceModel.make({
            workspaceId: "ws-1",
            initialTerminalTabIds: ["term-local"],
            initialActiveTerminalTabId: "term-local",
            initialContentState: {
                activecontent: { kind: "terminal", terminaltabid: "term-local" },
                toptabs: [],
                lastactivetoptabid: "",
            },
            saveCheckpoint,
        });
        const navigation = makeTerminalNavigationAdapter(model, {
            create,
            rename: vi.fn(),
            close: vi.fn(),
            reorder: vi.fn(),
            reload: vi.fn(),
        });

        model.activateAgent();
        expect(globalStore.get(model.checkpointStatusAtom)).toBe("dirty");
        expect(model.reconcileCheckpoint(checkpoint(2, ["term-remote"], "term-remote"))).toBe(true);
        await navigation.create({});

        expect(saveCheckpoint).toHaveBeenCalledOnce();
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ expectedrevision: 3 }));
    });

    it.each(["success", "failure"] as const)(
        "ignores a stale in-flight selection %s after newer WOS and allows structural mutation",
        async (outcome) => {
            const saving = deferred<void>();
            const staleFailure = new Error("late selection failure");
            const create = vi.fn().mockResolvedValue(checkpoint(4, ["term-remote", "term-new"], "term-new"));
            const model = WorkspaceModel.make({
                workspaceId: "ws-1",
                initialTerminalTabIds: ["term-local"],
                initialActiveTerminalTabId: "term-local",
                initialContentState: {
                    activecontent: { kind: "terminal", terminaltabid: "term-local" },
                    toptabs: [],
                    lastactivetoptabid: "",
                },
                saveCheckpoint: vi.fn(() => saving.promise),
            });
            const navigation = makeTerminalNavigationAdapter(model, {
                create,
                rename: vi.fn(),
                close: vi.fn(),
                reorder: vi.fn(),
                reload: vi.fn(),
            });

            model.activateAgent();
            const flushing = model.flush();
            expect(model.reconcileCheckpoint(checkpoint(2, ["term-remote"], "term-remote"))).toBe(true);
            if (outcome === "success") {
                saving.resolve();
            } else {
                saving.reject(staleFailure);
            }
            if (outcome === "failure") {
                await expect(flushing).rejects.toBe(staleFailure);
                expect(globalStore.get(model.checkpointStatusAtom)).toBe("error");
                return;
            }
            await expect(flushing).resolves.toBeUndefined();
            expect(globalStore.get(model.checkpointStatusAtom)).toBe("clean");

            await navigation.create({});
            expect(create).toHaveBeenCalledWith(expect.objectContaining({ expectedrevision: 3 }));
            expect(globalStore.get(model.terminalTabIdsAtom)).toEqual(["term-remote", "term-new"]);
        }
    );
});
