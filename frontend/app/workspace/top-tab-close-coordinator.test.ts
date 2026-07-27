// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { makeTopTabCloseCoordinator, type TopTabCloseDecision } from "./top-tab-close-coordinator";

function setup(
    decisions: TopTabCloseDecision[],
    options: {
        closeRuntime?: (topTabId: string) => Promise<void> | void;
    } = {}
) {
    const tabs = [
        { id: "file-1", kind: "file", title: "one.ts" },
        { id: "file-2", kind: "file", title: "two.ts" },
    ];
    const runtimes = new Map(
        tabs.map((tab) => [
            tab.id,
            {
                dirty: true,
                value: `${tab.id}-changed`,
                savedValue: `${tab.id}-saved`,
                snapshot: { dirty: true, title: tab.title },
                captureClosePreparationState() {
                    return {
                        value: this.value,
                        savedValue: this.savedValue,
                        dirty: this.dirty,
                        snapshot: this.snapshot,
                    };
                },
                restoreClosePreparationState(state: {
                    value: string;
                    savedValue: string;
                    dirty: boolean;
                    snapshot: { dirty: boolean; title: string };
                }) {
                    this.value = state.value;
                    this.savedValue = state.savedValue;
                    this.dirty = state.dirty;
                    this.snapshot = state.snapshot;
                },
                save: vi.fn(function () {
                    this.dirty = false;
                    this.snapshot = { ...this.snapshot, dirty: false };
                    return Promise.resolve();
                }),
                discard() {
                    this.value = this.savedValue;
                    this.dirty = false;
                    this.snapshot = { ...this.snapshot, dirty: false };
                },
                getSnapshot() {
                    return this.snapshot;
                },
            },
        ])
    );
    const model = {
        contentStateAtom: {} as any,
        closeTopTab: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
    };
    const coordinator = makeTopTabCloseCoordinator({
        model,
        getTopTabs: () => tabs as any,
        getFileRuntime: (id) => runtimes.get(id) as any,
        requestDecision: vi.fn(async () => decisions.shift() ?? "cancel"),
        closeRuntime: options.closeRuntime,
    });
    return { coordinator, model, runtimes };
}

describe("TopTabCloseCoordinator", () => {
    it("vetoes a save when a newer edit arrives before the write completes", async () => {
        let finishSave: () => void;
        const { coordinator, model, runtimes } = setup(["save"]);
        const runtime = runtimes.get("file-1")!;
        runtime.save.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finishSave = resolve;
                })
        );
        const closing = coordinator.close("file-1");
        await vi.waitFor(() => expect(runtime.save).toHaveBeenCalledOnce());
        runtime.value = "newer edit";
        runtime.dirty = true;
        runtime.snapshot = { ...runtime.snapshot, dirty: true };
        finishSave!();

        await expect(closing).resolves.toBe(false);
        expect(runtime.value).toBe("newer edit");
        expect(model.closeTopTab).not.toHaveBeenCalled();
    });

    it("saves before destructively closing one tab and coalesces repeated closes", async () => {
        const { coordinator, model, runtimes } = setup(["save"]);
        const first = coordinator.close("file-1");
        const second = coordinator.close("file-1");
        await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
        expect(runtimes.get("file-1")?.save).toHaveBeenCalledOnce();
        expect(model.closeTopTab).toHaveBeenCalledOnce();
    });

    it("closes retained runtime once only after descriptor close succeeds", async () => {
        const closeRuntime = vi.fn().mockResolvedValue(undefined);
        const success = setup(["save"], { closeRuntime });
        const first = success.coordinator.close("file-1");
        const second = success.coordinator.close("file-1");

        await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
        expect(closeRuntime).toHaveBeenCalledTimes(1);
        expect(closeRuntime).toHaveBeenCalledWith("file-1");

        closeRuntime.mockClear();
        const vetoed = setup(["cancel"], { closeRuntime });
        await expect(vetoed.coordinator.close("file-1")).resolves.toBe(false);
        expect(vetoed.model.closeTopTab).not.toHaveBeenCalled();
        expect(closeRuntime).not.toHaveBeenCalled();

        const failedClose = setup(["save"], { closeRuntime });
        failedClose.model.closeTopTab.mockImplementationOnce(() => {
            throw new Error("checkpoint failed");
        });
        await expect(failedClose.coordinator.close("file-1")).resolves.toBe(false);
        expect(closeRuntime).not.toHaveBeenCalled();
    });

    it("collects every decision before mutation and cancel preserves both files and descriptors", async () => {
        const { coordinator, model, runtimes } = setup(["discard", "cancel"]);
        await expect(coordinator.prepareWorkspaceClose()).resolves.toBe(false);
        expect([...runtimes.values()].map((runtime) => runtime.value)).toEqual(["file-1-changed", "file-2-changed"]);
        expect(model.closeTopTab).not.toHaveBeenCalled();
        expect(model.flush).not.toHaveBeenCalled();
    });

    it("runs every save before discard and a failed save prevents discard", async () => {
        const { coordinator, runtimes } = setup(["discard", "save"]);
        runtimes.get("file-2")?.save.mockRejectedValueOnce(new Error("offline"));
        await expect(coordinator.prepareFileMutations(["file-1", "file-2"])).resolves.toBe(false);
        expect(runtimes.get("file-1")?.value).toBe("file-1-changed");
    });

    it("prepares workspace close without deleting descriptors and flushes after discard", async () => {
        const { coordinator, model, runtimes } = setup(["discard", "discard"]);
        await expect(coordinator.prepareWorkspaceClose()).resolves.toBe(true);
        expect([...runtimes.values()].every((runtime) => !runtime.dirty)).toBe(true);
        expect(model.flush).toHaveBeenCalledOnce();
        expect(model.closeTopTab).not.toHaveBeenCalled();
    });

    it.each([
        [
            "prompt",
            () => setup(["discard"]),
            (context: ReturnType<typeof setup>) => {
                (context.coordinator as any).requestDecision;
            },
        ],
        [
            "flush",
            () => setup(["discard", "discard"]),
            (context: ReturnType<typeof setup>) => {
                context.model.flush.mockRejectedValueOnce(new Error("offline"));
            },
        ],
    ])("returns false when %s fails", async (_name, makeContext, fail) => {
        const context = makeContext();
        fail(context);
        if (_name === "prompt") {
            const coordinator = makeTopTabCloseCoordinator({
                model: context.model,
                getTopTabs: () => [{ id: "file-1", kind: "file", title: "one.ts" }] as any,
                getFileRuntime: (id) => context.runtimes.get(id) as any,
                requestDecision: vi.fn().mockRejectedValue(new Error("dialog lost")),
            });
            await expect(coordinator.prepareWorkspaceClose()).resolves.toBe(false);
            return;
        }
        await expect(context.coordinator.prepareWorkspaceClose()).resolves.toBe(false);
    });

    it("returns false when discard or destructive close throws", async () => {
        const discardContext = setup(["discard"]);
        discardContext.runtimes.get("file-1")!.discard = vi.fn(() => {
            throw new Error("disposed");
        });
        await expect(discardContext.coordinator.prepareFileMutation("file-1")).resolves.toBe(false);

        const closeContext = setup(["save"]);
        closeContext.model.closeTopTab.mockImplementationOnce(() => {
            throw new Error("checkpoint failed");
        });
        await expect(closeContext.coordinator.close("file-1")).resolves.toBe(false);
    });

    it("rolls back a dirty discard when destructive descriptor close throws", async () => {
        const { coordinator, model, runtimes } = setup(["discard"]);
        const runtime = runtimes.get("file-1")!;
        const originalSnapshot = runtime.getSnapshot();
        const original = {
            value: runtime.value,
            savedValue: runtime.savedValue,
            dirty: runtime.dirty,
        };
        model.closeTopTab.mockImplementationOnce(() => {
            throw new Error("checkpoint failed");
        });

        await expect(coordinator.close("file-1")).resolves.toBe(false);
        expect({
            value: runtime.value,
            savedValue: runtime.savedValue,
            dirty: runtime.dirty,
        }).toEqual(original);
        expect(runtime.getSnapshot()).toBe(originalSnapshot);
        expect(model.closeTopTab).toHaveBeenCalledOnce();
    });

    it("rolls back every earlier discard when a later discard throws", async () => {
        const { coordinator, model, runtimes } = setup(["discard", "discard"]);
        const original = [...runtimes.values()].map((runtime) => ({
            value: runtime.value,
            savedValue: runtime.savedValue,
            dirty: runtime.dirty,
        }));
        runtimes.get("file-2")!.discard = vi.fn(() => {
            throw new Error("disposed");
        });

        await expect(coordinator.prepareWorkspaceClose()).resolves.toBe(false);
        expect(
            [...runtimes.values()].map((runtime) => ({
                value: runtime.value,
                savedValue: runtime.savedValue,
                dirty: runtime.dirty,
            }))
        ).toEqual(original);
        expect(model.closeTopTab).not.toHaveBeenCalled();
    });

    it("rolls back all discarded buffers when flush rejects", async () => {
        const { coordinator, model, runtimes } = setup(["discard", "discard"]);
        const original = [...runtimes.values()].map((runtime) => ({
            value: runtime.value,
            savedValue: runtime.savedValue,
            dirty: runtime.dirty,
        }));
        model.flush.mockRejectedValueOnce(new Error("offline"));

        await expect(coordinator.prepareWorkspaceClose()).resolves.toBe(false);
        expect(
            [...runtimes.values()].map((runtime) => ({
                value: runtime.value,
                savedValue: runtime.savedValue,
                dirty: runtime.dirty,
            }))
        ).toEqual(original);
        expect(model.closeTopTab).not.toHaveBeenCalled();
    });

    it("serializes overlapping close and workspace preparation without duplicate prompts", async () => {
        let decide: (decision: TopTabCloseDecision) => void;
        const context = setup([]);
        const requestDecision = vi.fn(
            () =>
                new Promise<TopTabCloseDecision>((resolve) => {
                    decide = resolve;
                })
        );
        const coordinator = makeTopTabCloseCoordinator({
            model: context.model,
            getTopTabs: () => [{ id: "file-1", kind: "file", title: "one.ts" }] as any,
            getFileRuntime: (id) => context.runtimes.get(id) as any,
            requestDecision,
        });
        const closing = coordinator.close("file-1");
        const preparing = coordinator.prepareWorkspaceClose();
        await vi.waitFor(() => expect(requestDecision).toHaveBeenCalledOnce());
        decide!("discard");
        await expect(closing).resolves.toBe(true);
        await expect(preparing).resolves.toBe(true);
        expect(requestDecision).toHaveBeenCalledOnce();
    });

    it("retains workspace discard rollback until explicit commit", async () => {
        const rollbackContext = setup(["discard", "discard"]);
        const original = [...rollbackContext.runtimes.values()].map((runtime) => runtime.value);
        const session = await rollbackContext.coordinator.prepareWorkspaceCloseSession();
        expect([...rollbackContext.runtimes.values()].map((runtime) => runtime.dirty)).toEqual([false, false]);
        session.rollback();
        expect([...rollbackContext.runtimes.values()].map((runtime) => runtime.value)).toEqual(original);

        const commitContext = setup(["discard", "discard"]);
        const committed = await commitContext.coordinator.prepareWorkspaceCloseSession();
        committed.commit();
        expect([...commitContext.runtimes.values()].map((runtime) => runtime.dirty)).toEqual([false, false]);
    });
});
