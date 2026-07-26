import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedWorkspaceContentState, TopTab } from "./workspace-content-state";
import { WorkspaceModel, makeWorkspaceModel, type WorkspaceModelEventTarget } from "./workspace-model";

const FileOne: TopTab = { id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" };
const FileTwo: TopTab = { id: "file-2", kind: "file", path: "/tmp/b.ts", title: "b.ts" };

class FakeEventTarget implements WorkspaceModelEventTarget {
    visibilityState = "visible";
    listeners = new Map<string, Set<() => void>>();

    addEventListener(type: string, listener: () => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: () => void): void {
        this.listeners.get(type)?.delete(listener);
    }

    dispatch(type: string): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener();
        }
    }

    listenerCount(): number {
        return Array.from(this.listeners.values()).reduce((count, listeners) => count + listeners.size, 0);
    }
}

function persisted(overrides: Partial<PersistedWorkspaceContentState> = {}): PersistedWorkspaceContentState {
    return {
        activecontent: { kind: "agent" },
        toptabs: [],
        lastactivetoptabid: "",
        ...overrides,
    };
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

afterEach(async () => {
    await WorkspaceModel.resetInstances();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("WorkspaceModel", () => {
    it("replaces the model when the same workspace receives a newer surface generation", async () => {
        const first = WorkspaceModel.getInstance({
            windowId: "window-1",
            workspaceId: "ws-1",
            surfaceGeneration: 1,
        });

        const second = await WorkspaceModel.replaceInstance({
            windowId: "window-1",
            workspaceId: "ws-1",
            surfaceGeneration: 2,
        });

        expect(second).not.toBe(first);
        expect(second.surfaceGeneration).toBe(2);
        expect(first.disposed).toBe(true);
    });

    it("preserves a dirty Top Tab intent across a newer authoritative checkpoint", () => {
        const model = makeWorkspaceModel({
            workspaceId: "ws-1",
            initialNavigationRevision: 1,
            initialTerminalTabIds: [],
            saveCheckpoint: vi.fn(),
        });
        model.openTopTab(FileOne);

        expect(
            model.reconcileCheckpoint({
                workspaceid: "ws-1",
                navigationrevision: 3,
                terminaltabids: ["term-remote"],
                activeterminaltabid: "term-remote",
                contentstate: {
                    activecontent: { kind: "terminal", terminaltabid: "term-remote" },
                    toptabs: [],
                    lastactivetoptabid: "",
                },
            })
        ).toBe(true);
        expect(globalStore.get(model.contentStateAtom).topTabs).toEqual([FileOne]);
    });

    it.each(["agent", "top-tab"] as const)(
        "preserves authoritative last-active Terminal while projected content is %s",
        async (activeKind) => {
            const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
            const model = makeWorkspaceModel({
                workspaceId: "ws-1",
                initialNavigationRevision: 1,
                initialTerminalTabIds: ["term-old", "term-new"],
                initialActiveTerminalTabId: "term-old",
                saveCheckpoint,
            });
            const topTabs =
                activeKind === "top-tab"
                    ? [{ id: "file-remote", kind: "file", path: "/tmp/remote.ts", title: "remote.ts" } as const]
                    : [];
            expect(
                model.reconcileCheckpoint({
                    workspaceid: "ws-1",
                    navigationrevision: 2,
                    terminaltabids: ["term-old", "term-new"],
                    activeterminaltabid: "term-new",
                    contentstate: {
                        activecontent:
                            activeKind === "agent" ? { kind: "agent" } : { kind: "top-tab", toptabid: "file-remote" },
                        toptabs: topTabs,
                        lastactivetoptabid: activeKind === "top-tab" ? "file-remote" : "",
                    },
                })
            ).toBe(true);

            model.openTopTab(FileOne);
            await model.flush();

            expect(saveCheckpoint).toHaveBeenCalledWith(
                expect.objectContaining({
                    expectedrevision: 2,
                    activeterminaltabid: "term-new",
                })
            );
        }
    );

    it("adopts a forced same-revision last-active Terminal change", async () => {
        const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
        const model = makeWorkspaceModel({
            workspaceId: "ws-1",
            initialNavigationRevision: 2,
            initialTerminalTabIds: ["term-old", "term-new"],
            initialActiveTerminalTabId: "term-old",
            saveCheckpoint,
        });
        expect(
            model.adoptAuthoritativeCheckpoint({
                workspaceid: "ws-1",
                navigationrevision: 2,
                terminaltabids: ["term-old", "term-new"],
                activeterminaltabid: "term-new",
                contentstate: {
                    activecontent: { kind: "agent" },
                    toptabs: [],
                    lastactivetoptabid: "",
                },
            })
        ).toBe(true);

        model.openTopTab(FileOne);
        await model.flush();

        expect(saveCheckpoint).toHaveBeenCalledWith(
            expect.objectContaining({
                expectedrevision: 2,
                activeterminaltabid: "term-new",
            })
        );
    });

    it("hydrates persisted navigation and starts after its initial revision without retaining input references", async () => {
        const snapshot = persisted({
            activecontent: { kind: "top-tab", toptabid: "file-1" },
            toptabs: [{ id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" }],
            lastactivetoptabid: "file-1",
        });
        const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
        const model = makeWorkspaceModel({
            workspaceId: "ws-1",
            initialContentState: snapshot,
            initialActiveTerminalTabId: "term-1",
            initialNavigationRevision: 9,
            saveCheckpoint,
        });

        snapshot.toptabs[0].title = "mutated";
        expect(globalStore.get(model.contentStateAtom).topTabs[0].title).toBe("a.ts");

        model.activateAgent();
        await model.flush();
        expect(saveCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ expectedrevision: 9 }));
    });

    it("hydrates the complete terminal inventory and rejects activation outside it", () => {
        const model = makeWorkspaceModel({
            workspaceId: "ws-1",
            initialTerminalTabIds: ["term-1", "term-2"],
            initialActiveTerminalTabId: "term-1",
        });

        expect(globalStore.get(model.terminalTabIdsAtom)).toEqual(["term-1", "term-2"]);
        expect(model.activateTerminal("legacy-mixed")).toBe(false);
        expect(globalStore.get(model.activeTerminalTabIdAtom)).toBe("term-1");
        expect(model.activateTerminal("term-2")).toBe(true);
    });

    it("updates navigation synchronously before its debounced checkpoint resolves", () => {
        const saveCheckpoint = vi.fn(() => new Promise<void>(() => {}));
        const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint });

        model.activateTerminal("term-1");

        expect(globalStore.get(model.contentStateAtom).activeContent).toEqual({
            kind: "terminal",
            terminalTabId: "term-1",
        });
        expect(globalStore.get(model.activeTerminalTabIdAtom)).toBe("term-1");
        expect(globalStore.get(model.checkpointStatusAtom)).toBe("dirty");
        expect(saveCheckpoint).not.toHaveBeenCalled();
    });

    it("coalesces navigation during the debounce into one atomic latest checkpoint", async () => {
        vi.useFakeTimers();
        const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
        const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint });

        model.activateTerminal("term-1");
        await vi.advanceTimersByTimeAsync(200);
        model.activateAgent();
        await vi.advanceTimersByTimeAsync(299);
        expect(saveCheckpoint).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(saveCheckpoint).toHaveBeenCalledTimes(1);
        expect(saveCheckpoint).toHaveBeenCalledWith({
            workspaceid: "ws-1",
            expectedrevision: 0,
            contentstate: {
                activecontent: { kind: "agent" },
                toptabs: [],
                lastactivetoptabid: "",
            },
            activeterminaltabid: "term-1",
        });
    });

    it("checkpoints the complete git diff identity after 300ms", async () => {
        vi.useFakeTimers();
        const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
        const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint });
        model.openTopTab({
            id: "diff-1",
            kind: "git-diff",
            repoRoot: "/repo",
            path: "src/app.ts",
            mode: "+",
            originalPath: "",
            title: "app.ts",
        });

        expect(globalStore.get(model.contentStateAtom).topTabs[0]).toEqual({
            id: "diff-1",
            kind: "git-diff",
            repoRoot: "/repo",
            path: "src/app.ts",
            mode: "+",
            originalPath: "",
            title: "app.ts",
        });
        expect(globalStore.get(model.checkpointStatusAtom)).toBe("dirty");
        await vi.advanceTimersByTimeAsync(299);
        expect(saveCheckpoint).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(saveCheckpoint).toHaveBeenCalledWith(
            expect.objectContaining({
                expectedrevision: 0,
                contentstate: expect.objectContaining({
                    toptabs: [
                        {
                            id: "diff-1",
                            kind: "git-diff",
                            reporoot: "/repo",
                            path: "src/app.ts",
                            mode: "+",
                            originalpath: "",
                            title: "app.ts",
                        },
                    ],
                }),
            })
        );
    });

    it("restores File, Preview, and Git Diff order and selection without runtime-only File state", async () => {
        const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
        const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint });
        const preview: TopTab = {
            id: "preview-1",
            kind: "preview",
            path: "/repo/README.md",
            title: "README.md",
        };
        const diff: TopTab = {
            id: "diff-1",
            kind: "git-diff",
            repoRoot: "/repo",
            path: "src/app.ts",
            mode: "+",
            originalPath: "",
            title: "app.ts",
        };

        model.openTopTab(FileOne);
        model.openTopTab(preview);
        model.openTopTab(diff);
        model.reorderTopTabs("diff-1", "file-1");
        model.activateTopTab("preview-1");
        await model.flush();

        const persistedState = saveCheckpoint.mock.calls.at(-1)?.[0].contentstate;
        expect(persistedState).toEqual({
            activecontent: { kind: "top-tab", toptabid: "preview-1" },
            toptabs: [
                {
                    id: "diff-1",
                    kind: "git-diff",
                    reporoot: "/repo",
                    path: "src/app.ts",
                    mode: "+",
                    originalpath: "",
                    title: "app.ts",
                },
                { id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" },
                { id: "preview-1", kind: "preview", path: "/repo/README.md", title: "README.md" },
            ],
            lastactivetoptabid: "preview-1",
        });
        expect(JSON.stringify(persistedState)).not.toMatch(/dirty|buffer|viewstate/i);

        const restored = makeWorkspaceModel({
            workspaceId: "ws-restored",
            initialContentState: persistedState,
        });
        expect(globalStore.get(restored.contentStateAtom)).toEqual({
            activeContent: { kind: "top-tab", topTabId: "preview-1" },
            topTabs: [diff, FileOne, preview],
            lastActiveTopTabId: "preview-1",
        });
    });

    it("does not checkpoint invalid or structurally equal top tab updates", async () => {
        vi.useFakeTimers();
        const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
        const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint });
        model.openTopTab({
            id: "preview-1",
            kind: "preview",
            path: "/tmp/preview.md",
            title: "Preview",
        });
        await model.flush();
        saveCheckpoint.mockClear();

        model.updateTopTab("preview-1", {
            kind: "preview",
            path: "/tmp/preview.md",
            title: "Preview",
        });
        model.updateTopTab("preview-1", { kind: "preview", path: "relative" });
        model.updateTopTab("missing", { kind: "preview", title: "Missing" });
        await vi.advanceTimersByTimeAsync(300);

        expect(saveCheckpoint).not.toHaveBeenCalled();
        expect(globalStore.get(model.checkpointStatusAtom)).toBe("clean");
    });

    it("serializes an in-flight checkpoint before saving newer navigation and never marks it clean early", async () => {
        const first = deferred<void>();
        const second = deferred<void>();
        const saveCheckpoint = vi
            .fn()
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise);
        const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint });

        model.activateTerminal("term-1");
        const flushing = model.flush();
        expect(globalStore.get(model.checkpointStatusAtom)).toBe("saving");
        await vi.waitFor(() => expect(saveCheckpoint).toHaveBeenCalledTimes(1));

        model.activateTerminal("term-2");
        expect(globalStore.get(model.checkpointStatusAtom)).toBe("dirty");
        expect(saveCheckpoint).toHaveBeenCalledTimes(1);

        first.resolve();
        await vi.waitFor(() => expect(saveCheckpoint).toHaveBeenCalledTimes(2));
        expect(globalStore.get(model.checkpointStatusAtom)).toBe("saving");
        expect(saveCheckpoint.mock.calls[1][0]).toEqual(
            expect.objectContaining({
                expectedrevision: 1,
                contentstate: expect.objectContaining({
                    activecontent: { kind: "terminal", terminaltabid: "term-2" },
                }),
                activeterminaltabid: "term-2",
            })
        );

        second.resolve();
        await flushing;
        expect(globalStore.get(model.checkpointStatusAtom)).toBe("clean");
    });

    it("retains a failed immutable checkpoint for an exact retry", async () => {
        const saveCheckpoint = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
        const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint });

        model.openTopTab(FileOne);
        const originalState = globalStore.get(model.contentStateAtom);
        await expect(model.flush()).rejects.toThrow("offline");
        expect(globalStore.get(model.checkpointStatusAtom)).toBe("error");

        originalState.topTabs[0].title = "mutated outside";
        model.activateTerminal("term-1");
        await expect(model.flush()).resolves.toBeUndefined();

        expect(saveCheckpoint.mock.calls[1][0]).toEqual(saveCheckpoint.mock.calls[0][0]);
        expect(saveCheckpoint.mock.calls[1][0].contentstate.toptabs[0].title).toBe("a.ts");
    });

    it("reports one visible checkpoint error until a successful retry recovers", async () => {
        const onCheckpointError = vi.fn();
        const saveCheckpoint = vi.fn().mockRejectedValue(new Error("offline"));
        const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint, onCheckpointError });

        model.openTopTab(FileOne);
        await expect(model.flush()).rejects.toThrow("offline");
        await expect(model.flush()).rejects.toThrow("offline");
        expect(onCheckpointError).toHaveBeenCalledTimes(1);
        saveCheckpoint.mockResolvedValue(undefined);
        await model.flush();
        model.activateAgent();
        saveCheckpoint.mockRejectedValue(new Error("offline again"));
        await expect(model.flush()).rejects.toThrow("offline again");
        expect(onCheckpointError).toHaveBeenCalledTimes(2);
    });

    it("preserves the original checkpoint failure when tracing throws", async () => {
        const checkpointFailure = new Error("checkpoint failed");
        vi.stubGlobal("performance", {
            now: vi.fn(() => 1),
            mark: () => {
                throw new Error("trace failed");
            },
        });
        const model = makeWorkspaceModel({
            workspaceId: "ws-1",
            saveCheckpoint: vi.fn().mockRejectedValue(checkpointFailure),
        });

        model.openTopTab(FileOne);
        await expect(model.flush()).rejects.toBe(checkpointFailure);
        expect(globalStore.get(model.checkpointStatusAtom)).toBe("error");
    });

    it("surfaces stale revision failures and keeps the checkpoint retryable", async () => {
        const stale = new Error("stale workspace checkpoint");
        const saveCheckpoint = vi.fn().mockRejectedValue(stale);
        const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint });

        model.activateTerminal("term-1");
        await expect(model.flush()).rejects.toBe(stale);
        expect(globalStore.get(model.checkpointStatusAtom)).toBe("error");
        await expect(model.flush()).rejects.toBe(stale);
        expect(saveCheckpoint.mock.calls[1][0]).toEqual(saveCheckpoint.mock.calls[0][0]);
    });

    it("does not allocate revisions or save for structurally equal and invalid reducer results", async () => {
        vi.useFakeTimers();
        const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
        const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint });

        model.activateAgent();
        model.activateTerminal("");
        model.activateTopTab("missing");
        model.closeTopTab("missing");
        model.openTopTab({ ...FileOne, path: "relative" });
        model.reorderTopTabs("missing", "also-missing");
        await vi.advanceTimersByTimeAsync(300);

        expect(globalStore.get(model.checkpointStatusAtom)).toBe("clean");
        expect(saveCheckpoint).not.toHaveBeenCalled();
    });

    it("uses the current terminal fallback and stable source/target indices", () => {
        const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint: vi.fn() });
        model.activateTerminal("term-current");
        model.openTopTab(FileOne);
        model.openTopTab(FileTwo);

        model.reorderTopTabs("file-1", "file-2");
        expect(globalStore.get(model.contentStateAtom).topTabs.map((tab) => tab.id)).toEqual(["file-2", "file-1"]);

        model.closeTopTab("file-1");
        model.closeTopTab("file-2");
        expect(globalStore.get(model.contentStateAtom).activeContent).toEqual({
            kind: "terminal",
            terminalTabId: "term-current",
        });
    });

    it("best-effort flushes lifecycle events without unhandled rejections and disposes listeners and timers", async () => {
        vi.useFakeTimers();
        const windowTarget = new FakeEventTarget();
        const documentTarget = new FakeEventTarget();
        const saveCheckpoint = vi.fn().mockRejectedValue(new Error("offline"));
        const model = makeWorkspaceModel({
            workspaceId: "ws-1",
            saveCheckpoint,
            windowTarget,
            documentTarget,
        });

        model.activateTerminal("term-1");
        windowTarget.dispatch("blur");
        await vi.waitFor(() => expect(saveCheckpoint).toHaveBeenCalledTimes(1));

        documentTarget.visibilityState = "hidden";
        documentTarget.dispatch("visibilitychange");
        windowTarget.dispatch("beforeunload");
        await Promise.resolve();
        await model.dispose();
        await vi.advanceTimersByTimeAsync(300);

        expect(windowTarget.listenerCount()).toBe(0);
        expect(documentTarget.listenerCount()).toBe(0);
        expect(saveCheckpoint.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("flushes the exact dirty snapshot while disposing and ignores later actions", async () => {
        const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
        const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint });
        model.activateTerminal("term-1");

        await model.dispose();
        model.activateAgent();

        expect(saveCheckpoint).toHaveBeenCalledTimes(1);
        expect(saveCheckpoint).toHaveBeenCalledWith({
            workspaceid: "ws-1",
            expectedrevision: 0,
            contentstate: {
                activecontent: { kind: "terminal", terminaltabid: "term-1" },
                toptabs: [],
                lastactivetoptabid: "",
            },
            activeterminaltabid: "term-1",
        });
        expect(globalStore.get(model.contentStateAtom).activeContent).toEqual({
            kind: "terminal",
            terminalTabId: "term-1",
        });
    });

    it("contains dispose save failures without unhandled rejection and keeps error status", async () => {
        const saveCheckpoint = vi.fn().mockRejectedValue(new Error("offline"));
        const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint });
        model.activateTerminal("term-1");

        await expect(model.dispose()).resolves.toBeUndefined();

        expect(saveCheckpoint).toHaveBeenCalledTimes(1);
        expect(globalStore.get(model.checkpointStatusAtom)).toBe("error");
    });

    it("keeps one model per window and flushes it before replacing its workspace", async () => {
        const windowTarget = new FakeEventTarget();
        const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
        const first = WorkspaceModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            saveCheckpoint,
            windowTarget,
        });
        first.activateTerminal("term-1");

        const replacement = await WorkspaceModel.replaceInstance({
            windowId: "win-1",
            workspaceId: "ws-2",
            saveCheckpoint,
            windowTarget,
        });

        expect(replacement).not.toBe(first);
        expect(saveCheckpoint).toHaveBeenCalledTimes(1);
        expect(saveCheckpoint.mock.calls[0][0].workspaceid).toBe("ws-1");
        expect(windowTarget.listenerCount()).toBe(2);
        expect(WorkspaceModel.getInstance({ windowId: "win-1", workspaceId: "ws-2", saveCheckpoint })).toBe(
            replacement
        );
    });

    it("waits for async pre-replacement teardown before creating the replacement", async () => {
        const teardown = deferred<void>();
        const first = WorkspaceModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            saveCheckpoint: vi.fn().mockResolvedValue(undefined),
        });
        const teardownHook = vi.fn(() => teardown.promise);
        first.registerPreReplacementTeardown(teardownHook);

        let settled = false;
        const replacing = WorkspaceModel.replaceInstance({
            windowId: "win-1",
            workspaceId: "ws-2",
            saveCheckpoint: vi.fn().mockResolvedValue(undefined),
        }).then((model) => {
            settled = true;
            return model;
        });

        await vi.waitFor(() => expect(teardownHook).toHaveBeenCalledOnce());
        expect(settled).toBe(false);
        expect(WorkspaceModel.instances.get("win-1")).toBe(first);
        teardown.resolve();
        await expect(replacing).resolves.toEqual(expect.objectContaining({ workspaceId: "ws-2" }));
    });

    it("invalidates model and checkpoint generations before invoking replacement teardown", async () => {
        const first = WorkspaceModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            surfaceGeneration: 4,
            saveCheckpoint: vi.fn().mockResolvedValue(undefined),
        });
        const checkpointGeneration = first.checkpointGeneration;
        const surfaceGeneration = first.surfaceGeneration;
        let observedCheckpointGeneration = checkpointGeneration;
        let observedSurfaceGeneration = surfaceGeneration;
        first.registerPreReplacementTeardown(() => {
            observedCheckpointGeneration = first.checkpointGeneration;
            observedSurfaceGeneration = first.surfaceGeneration;
        });

        await WorkspaceModel.replaceInstance({
            windowId: "win-1",
            workspaceId: "ws-2",
            saveCheckpoint: vi.fn().mockResolvedValue(undefined),
        });

        expect(observedCheckpointGeneration).toBeGreaterThan(checkpointGeneration);
        expect(observedSurfaceGeneration).toBeGreaterThan(surfaceGeneration);
    });

    it("contains rejected replacement teardown and still installs the replacement", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const first = WorkspaceModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            saveCheckpoint: vi.fn().mockResolvedValue(undefined),
        });
        first.registerPreReplacementTeardown(async () => {
            throw new Error("teardown failed");
        });

        try {
            await expect(
                WorkspaceModel.replaceInstance({
                    windowId: "win-1",
                    workspaceId: "ws-2",
                    saveCheckpoint: vi.fn().mockResolvedValue(undefined),
                })
            ).resolves.toEqual(expect.objectContaining({ workspaceId: "ws-2" }));
            expect(consoleError).toHaveBeenCalledWith(
                expect.stringMatching(/workspace.*teardown/i),
                expect.any(AggregateError)
            );
        } finally {
            consoleError.mockRestore();
        }
    });

    it("reuses one in-flight preparation promise when disposal joins replacement teardown", async () => {
        const teardown = deferred<void>();
        const model = makeWorkspaceModel({ workspaceId: "ws-1" });
        model.registerPreReplacementTeardown(() => teardown.promise);

        const firstPreparation = model.prepareForReplacement();
        const secondPreparation = model.prepareForReplacement();
        expect(secondPreparation).toBe(firstPreparation);
        let disposed = false;
        const disposing = model.dispose().then(() => {
            disposed = true;
        });
        await Promise.resolve();
        expect(disposed).toBe(false);

        teardown.resolve();
        await firstPreparation;
        await disposing;
        expect(disposed).toBe(true);
    });

    it("waits for an in-flight captured checkpoint before invalidating for replacement", async () => {
        const saving = deferred<void>();
        const saveCheckpoint = vi.fn(() => saving.promise);
        const model = makeWorkspaceModel({ workspaceId: "ws-1", saveCheckpoint });
        model.openTopTab(FileOne);
        const flushing = model.flush();
        await vi.waitFor(() => expect(saveCheckpoint).toHaveBeenCalledOnce());

        let prepared = false;
        const preparing = model.prepareForReplacement().then(() => {
            prepared = true;
        });
        await Promise.resolve();
        expect(prepared).toBe(false);

        saving.resolve();
        await flushing;
        await preparing;
        expect(saveCheckpoint).toHaveBeenCalledOnce();
        expect(model.navigationQueue.pending).toEqual([]);
        expect(model.navigationQueue.confirmed.navigationrevision).toBe(1);
    });

    it("drains teardown registered reentrantly while replacement preparation is in progress", async () => {
        const firstTeardown = deferred<void>();
        const secondTeardown = deferred<void>();
        const first = WorkspaceModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            saveCheckpoint: vi.fn().mockResolvedValue(undefined),
        });
        const secondHook = vi.fn(() => secondTeardown.promise);
        const firstHook = vi.fn(() => {
            first.registerPreReplacementTeardown(secondHook);
            return firstTeardown.promise;
        });
        first.registerPreReplacementTeardown(firstHook);

        let settled = false;
        const replacing = WorkspaceModel.replaceInstance({
            windowId: "win-1",
            workspaceId: "ws-2",
            saveCheckpoint: vi.fn().mockResolvedValue(undefined),
        }).then((replacement) => {
            settled = true;
            return replacement;
        });

        try {
            await vi.waitFor(() => expect(firstHook).toHaveBeenCalledOnce());
            firstTeardown.resolve();
            await vi.waitFor(() => expect(secondHook).toHaveBeenCalledOnce());
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(settled).toBe(false);
            expect(WorkspaceModel.instances.get("win-1")).toBe(first);

            secondTeardown.resolve();
            await expect(replacing).resolves.toEqual(expect.objectContaining({ workspaceId: "ws-2" }));
        } finally {
            firstTeardown.resolve();
            secondTeardown.resolve();
            await replacing.catch(() => {});
        }
    });

    it("awaits async pre-replacement teardown during direct disposal and global reset", async () => {
        const directTeardown = deferred<void>();
        const direct = makeWorkspaceModel({ workspaceId: "ws-direct" });
        direct.registerPreReplacementTeardown(() => directTeardown.promise);
        let directSettled = false;
        const disposing = direct.dispose().then(() => {
            directSettled = true;
        });
        await Promise.resolve();
        expect(directSettled).toBe(false);
        directTeardown.resolve();
        await disposing;

        const resetTeardown = deferred<void>();
        const registered = WorkspaceModel.getInstance({
            windowId: "win-reset",
            workspaceId: "ws-reset",
            saveCheckpoint: vi.fn().mockResolvedValue(undefined),
        });
        registered.registerPreReplacementTeardown(() => resetTeardown.promise);
        let resetSettled = false;
        const resetting = WorkspaceModel.resetInstances().then(() => {
            resetSettled = true;
        });
        await Promise.resolve();
        expect(resetSettled).toBe(false);
        resetTeardown.resolve();
        await resetting;
    });

    it("aborts a failed replacement, keeps the old model active, and retries its exact checkpoint", async () => {
        const offline = new Error("offline");
        const saving = deferred<void>();
        const windowTarget = new FakeEventTarget();
        const saveCheckpoint = vi
            .fn()
            .mockImplementationOnce(() => saving.promise)
            .mockResolvedValueOnce(undefined);
        const first = WorkspaceModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            saveCheckpoint,
            windowTarget,
        });
        first.activateTerminal("term-1");

        const replacing = WorkspaceModel.replaceInstance({
            windowId: "win-1",
            workspaceId: "ws-2",
            saveCheckpoint: vi.fn(),
            windowTarget,
        });
        saving.reject(offline);
        await expect(replacing).rejects.toBe(offline);

        expect(windowTarget.listenerCount()).toBe(2);
        expect(first.disposed).toBe(false);
        expect(WorkspaceModel.getInstance({ windowId: "win-1", workspaceId: "ws-1", saveCheckpoint })).toBe(first);

        await first.flush();
        expect(saveCheckpoint).toHaveBeenCalledTimes(2);
        expect(saveCheckpoint.mock.calls[1][0]).toEqual(saveCheckpoint.mock.calls[0][0]);
        expect(saveCheckpoint.mock.calls[1][0]).toEqual(
            expect.objectContaining({
                workspaceid: "ws-1",
                expectedrevision: 0,
                contentstate: expect.objectContaining({
                    activecontent: { kind: "terminal", terminaltabid: "term-1" },
                }),
            })
        );

        const replacement = await WorkspaceModel.replaceInstance({
            windowId: "win-1",
            workspaceId: "ws-2",
            saveCheckpoint: vi.fn(),
            windowTarget,
        });
        expect(replacement.workspaceId).toBe("ws-2");
        expect(windowTarget.listenerCount()).toBe(2);
    });

    it("rejects concurrent workspace replacements before they can attach duplicate listeners", async () => {
        const saving = deferred<void>();
        const windowTarget = new FakeEventTarget();
        const first = WorkspaceModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            saveCheckpoint: () => saving.promise,
            windowTarget,
        });
        first.activateTerminal("term-1");

        const replacing = WorkspaceModel.replaceInstance({
            windowId: "win-1",
            workspaceId: "ws-2",
            saveCheckpoint: vi.fn(),
            windowTarget,
        });
        const concurrent = WorkspaceModel.replaceInstance({
            windowId: "win-1",
            workspaceId: "ws-3",
            saveCheckpoint: vi.fn(),
            windowTarget,
        });
        saving.resolve();
        await expect(concurrent).rejects.toThrow(/in progress/);
        await replacing;
        expect(windowTarget.listenerCount()).toBe(2);
    });

    it("does not return the disposed old model while its replacement is flushing", async () => {
        const saving = deferred<void>();
        const windowTarget = new FakeEventTarget();
        const first = WorkspaceModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            saveCheckpoint: () => saving.promise,
            windowTarget,
        });
        first.activateTerminal("term-1");

        const replacing = WorkspaceModel.replaceInstance({
            windowId: "win-1",
            workspaceId: "ws-2",
            saveCheckpoint: vi.fn(),
            windowTarget,
        });

        let getError: unknown;
        try {
            WorkspaceModel.getInstance({
                windowId: "win-1",
                workspaceId: "ws-1",
                saveCheckpoint: vi.fn(),
                windowTarget,
            });
        } catch (error) {
            getError = error;
        }

        saving.resolve();
        await replacing;
        expect(getError).toEqual(expect.objectContaining({ message: expect.stringMatching(/await.*replace/i) }));
    });

    it("waits for replacement during reset and blocks a second replacement until the registry is empty", async () => {
        const saving = deferred<void>();
        const windowTarget = new FakeEventTarget();
        const first = WorkspaceModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            saveCheckpoint: () => saving.promise,
            windowTarget,
        });
        first.activateTerminal("term-1");

        const replacing = WorkspaceModel.replaceInstance({
            windowId: "win-1",
            workspaceId: "ws-2",
            saveCheckpoint: vi.fn().mockResolvedValue(undefined),
            windowTarget,
        });
        const resetting = WorkspaceModel.resetInstances();
        const secondReplacement = WorkspaceModel.replaceInstance({
            windowId: "win-1",
            workspaceId: "ws-3",
            saveCheckpoint: vi.fn(),
            windowTarget,
        });
        saving.resolve();
        await expect(secondReplacement).rejects.toThrow(/reset.*progress/i);
        await replacing;
        await resetting;
        expect(windowTarget.listenerCount()).toBe(0);

        const afterReset = WorkspaceModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-4",
            saveCheckpoint: vi.fn(),
            windowTarget,
        });
        expect(afterReset.workspaceId).toBe("ws-4");
        expect(windowTarget.listenerCount()).toBe(2);
    });

    it("caches once per window, rejects implicit workspace replacement, and isolates other windows", async () => {
        const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
        const first = WorkspaceModel.getInstance({ windowId: "win-1", workspaceId: "ws-1", saveCheckpoint });
        const same = WorkspaceModel.getInstance({ windowId: "win-1", workspaceId: "ws-1", saveCheckpoint });
        const otherWindow = WorkspaceModel.getInstance({ windowId: "win-2", workspaceId: "ws-1", saveCheckpoint });

        expect(same).toBe(first);
        expect(otherWindow).not.toBe(first);
        expect(() => WorkspaceModel.getInstance({ windowId: "win-1", workspaceId: "ws-2", saveCheckpoint })).toThrow(
            /replaceInstance/
        );

        await WorkspaceModel.resetInstances();
        expect(WorkspaceModel.getInstance({ windowId: "win-1", workspaceId: "ws-1", saveCheckpoint })).not.toBe(first);
    });

    it("accepts only identity-matching non-stale Terminal surface statuses", () => {
        const model = makeWorkspaceModel({
            workspaceId: "ws-1",
            surfaceGeneration: 3,
            saveCheckpoint: vi.fn(),
        });
        const ready: TerminalSurfaceStatus = {
            state: "ready",
            workspaceid: "ws-1",
            generation: 3,
            revision: 4,
            terminaltabid: "term-1",
        };

        expect(model.applyTerminalSurfaceStatus(ready)).toBe(true);
        expect(globalStore.get(model.terminalSurfaceStatusAtom)).toEqual(ready);
        expect(model.applyTerminalSurfaceStatus({ ...ready, state: "loading" })).toBe(false);
        expect(model.applyTerminalSurfaceStatus({ ...ready, revision: 3, state: "loading" })).toBe(false);
        expect(model.applyTerminalSurfaceStatus({ ...ready, workspaceid: "ws-old", revision: 5 })).toBe(false);
        expect(model.applyTerminalSurfaceStatus({ ...ready, generation: 2, revision: 5 })).toBe(false);
        expect(globalStore.get(model.terminalSurfaceStatusAtom)).toEqual(ready);
    });
});
