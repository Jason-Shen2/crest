import { describe, expect, it, vi } from "vitest";
import { TopTabNavigationQueue } from "./top-tab-navigation-queue";
import type { TopTab } from "./workspace-content-state";

const FileTab: TopTab = { id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" };

function checkpoint(revision: number, topTabs: TopTabDescriptor[] = []): WorkspaceCheckpoint {
    return {
        workspaceid: "ws-1",
        navigationrevision: revision,
        terminaltabids: [],
        contentstate: {
            activecontent: { kind: "agent" },
            toptabs: topTabs,
            lastactivetoptabid: "",
        },
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function makeQueue(
    save: (data: SaveWorkspaceCheckpointData) => Promise<SaveWorkspaceCheckpointResult>,
    initial = checkpoint(0)
) {
    const changes: TopTab[][] = [];
    const queue = new TopTabNavigationQueue({
        confirmed: initial,
        save,
        onChange: (_confirmed, projected) => changes.push(projected.topTabs),
    });
    return { queue, changes };
}

describe("TopTabNavigationQueue", () => {
    it("replays intents enqueued while a Terminal mutation is pending exactly once", async () => {
        const terminal = deferred<WorkspaceCheckpoint>();
        const save = vi
            .fn()
            .mockResolvedValueOnce({
                status: "committed",
                checkpoint: checkpoint(1, [{ id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" }]),
            })
            .mockResolvedValueOnce({
                status: "committed",
                checkpoint: checkpoint(3, [{ id: "file-1", kind: "file", path: "/tmp/a.ts", title: "dirty.ts" }]),
            });
        const { queue } = makeQueue(save);
        queue.enqueue({ type: "open-top-tab", tab: FileTab });
        const mutation = queue.runTerminalMutation(() => terminal.promise);
        await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
        queue.enqueue({ type: "update-top-tab", topTabId: FileTab.id, updates: { kind: "file", title: "dirty.ts" } });
        terminal.resolve(checkpoint(2, [{ id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" }]));
        await mutation;
        await queue.flush();

        expect(queue.projected.topTabs).toEqual([{ ...FileTab, title: "dirty.ts" }]);
        expect(queue.pending).toEqual([]);
        expect(save).toHaveBeenCalledTimes(2);
        expect(save.mock.calls[1][0].contentstate.toptabs[0].title).toBe("dirty.ts");
    });

    it("does not let an older Terminal response replace a newer WOS checkpoint", async () => {
        const terminal = deferred<WorkspaceCheckpoint>();
        const initial = {
            ...checkpoint(1),
            terminaltabids: ["term-old"],
            activeterminaltabid: "term-old",
        };
        const { queue } = makeQueue(vi.fn(), initial);
        const mutation = queue.runTerminalMutation(() => terminal.promise);
        await Promise.resolve();
        queue.enqueue({ type: "open-top-tab", tab: FileTab });
        const newer = {
            ...checkpoint(3),
            terminaltabids: ["term-new"],
            activeterminaltabid: "term-new",
        };
        expect(queue.reconcile(newer)).toBe(true);
        terminal.resolve({
            ...checkpoint(2),
            terminaltabids: ["term-old", "term-rpc"],
            activeterminaltabid: "term-rpc",
        });
        await mutation;

        expect(queue.confirmed).toEqual(newer);
        expect(queue.projected.topTabs).toEqual([FileTab]);
        expect(queue.pending).toHaveLength(1);
    });

    it("adopts a conflict, replays pending intents, and retries them once", async () => {
        const save = vi
            .fn()
            .mockResolvedValueOnce({ status: "conflict", checkpoint: checkpoint(2) })
            .mockResolvedValueOnce({
                status: "committed",
                checkpoint: checkpoint(3, [{ id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" }]),
            });
        const { queue } = makeQueue(save);
        queue.enqueue({ type: "open-top-tab", tab: FileTab });
        await queue.flush();

        expect(save).toHaveBeenCalledTimes(2);
        expect(save.mock.calls[1][0].expectedrevision).toBe(2);
        expect(queue.projected.topTabs).toEqual([FileTab]);
        expect(queue.pending).toEqual([]);
    });

    it("retains a failed batch and retries the same intent", async () => {
        const failure = new Error("offline");
        const save = vi
            .fn()
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce({
                status: "committed",
                checkpoint: checkpoint(1, [{ id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" }]),
            });
        const { queue } = makeQueue(save);
        queue.enqueue({ type: "open-top-tab", tab: FileTab });

        await expect(queue.flush()).rejects.toBe(failure);
        expect(queue.pending).toHaveLength(1);
        await queue.flush();
        expect(save.mock.calls[1][0]).toEqual(save.mock.calls[0][0]);
        expect(queue.pending).toEqual([]);
    });

    it("owns an immutable action snapshot across conflict replay", async () => {
        const mutableTab = { ...FileTab };
        const save = vi
            .fn()
            .mockResolvedValueOnce({ status: "conflict", checkpoint: checkpoint(1) })
            .mockResolvedValueOnce({
                status: "committed",
                checkpoint: checkpoint(2, [{ id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" }]),
            });
        const { queue } = makeQueue(save);
        queue.enqueue({ type: "open-top-tab", tab: mutableTab });
        mutableTab.title = "caller-mutated.ts";
        await queue.flush();

        expect(save.mock.calls[0][0].contentstate.toptabs[0].title).toBe("a.ts");
        expect(save.mock.calls[1][0].contentstate.toptabs[0].title).toBe("a.ts");
        expect(queue.projected.topTabs).toEqual([FileTab]);
    });

    it("keeps a failed batch boundary when a newer intent arrives before retry", async () => {
        const failure = new Error("offline");
        const save = vi
            .fn()
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce({
                status: "committed",
                checkpoint: checkpoint(1, [{ id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" }]),
            })
            .mockResolvedValueOnce({
                status: "committed",
                checkpoint: checkpoint(2, [{ id: "file-1", kind: "file", path: "/tmp/a.ts", title: "dirty.ts" }]),
            });
        const { queue } = makeQueue(save);
        queue.enqueue({ type: "open-top-tab", tab: FileTab });
        await expect(queue.flush()).rejects.toBe(failure);
        queue.enqueue({
            type: "update-top-tab",
            topTabId: FileTab.id,
            updates: { kind: "file", title: "dirty.ts" },
        });

        await queue.flush();

        expect(save).toHaveBeenCalledTimes(3);
        expect(save.mock.calls[1][0]).toEqual(save.mock.calls[0][0]);
        expect(save.mock.calls[2][0].contentstate.toptabs[0].title).toBe("dirty.ts");
        expect(queue.pending).toEqual([]);
    });

    it("acknowledges only the captured batch when an intent arrives during save", async () => {
        const first = deferred<SaveWorkspaceCheckpointResult>();
        const save = vi
            .fn()
            .mockImplementationOnce(() => first.promise)
            .mockResolvedValueOnce({
                status: "committed",
                checkpoint: checkpoint(2, [{ id: "file-1", kind: "file", path: "/tmp/a.ts", title: "dirty.ts" }]),
            });
        const { queue } = makeQueue(save);
        queue.enqueue({ type: "open-top-tab", tab: FileTab });
        const flushing = queue.flush();
        await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
        queue.enqueue({ type: "update-top-tab", topTabId: FileTab.id, updates: { kind: "file", title: "dirty.ts" } });
        first.resolve({
            status: "committed",
            checkpoint: checkpoint(1, [{ id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" }]),
        });
        await flushing;

        expect(save).toHaveBeenCalledTimes(2);
        expect(queue.projected.topTabs[0].title).toBe("dirty.ts");
    });

    it("coalesces adjacent updates but not across a close referencing the same ID", () => {
        const { queue } = makeQueue(vi.fn());
        queue.enqueue({ type: "open-top-tab", tab: FileTab });
        queue.enqueue({ type: "update-top-tab", topTabId: FileTab.id, updates: { kind: "file", title: "one.ts" } });
        queue.enqueue({ type: "update-top-tab", topTabId: FileTab.id, updates: { kind: "file", path: "/tmp/two.ts" } });
        expect(queue.pending).toHaveLength(2);
        queue.enqueue({ type: "close-top-tab", topTabId: FileTab.id });
        expect(queue.pending).toHaveLength(3);
    });

    it("coalesces updates across activation of the same Top Tab", () => {
        const persistedFile = { id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" } as const;
        const { queue } = makeQueue(vi.fn(), checkpoint(1, [persistedFile]));
        queue.enqueue({
            type: "update-top-tab",
            topTabId: FileTab.id,
            updates: { kind: "file", title: "one.ts" },
        });
        queue.enqueue({ type: "activate-top-tab", topTabId: FileTab.id });
        queue.enqueue({
            type: "update-top-tab",
            topTabId: FileTab.id,
            updates: { kind: "file", path: "/tmp/two.ts" },
        });

        expect(queue.pending).toHaveLength(2);
        expect(queue.projected.topTabs).toEqual([{ ...FileTab, title: "one.ts", path: "/tmp/two.ts" }]);
    });

    it("replays pending intents once across repeated authoritative delivery", () => {
        const { queue } = makeQueue(vi.fn(), checkpoint(1));
        queue.enqueue({ type: "open-top-tab", tab: FileTab });
        const authoritative = checkpoint(2);
        expect(queue.reconcile(authoritative)).toBe(true);
        expect(queue.reconcile(authoritative)).toBe(true);
        expect(queue.projected.topTabs).toEqual([FileTab]);
        expect(queue.pending).toHaveLength(1);
    });

    it("owns an adopted checkpoint snapshot across conflict replay", async () => {
        const adopted = checkpoint(2, [{ id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" }]);
        const save = vi
            .fn()
            .mockResolvedValueOnce({ status: "conflict", checkpoint: structuredClone(adopted) })
            .mockResolvedValueOnce({
                status: "committed",
                checkpoint: checkpoint(3, [{ id: "file-1", kind: "file", path: "/tmp/a.ts", title: "dirty.ts" }]),
            });
        const { queue } = makeQueue(save);
        expect(queue.reconcile(adopted)).toBe(true);
        adopted.navigationrevision = 9;
        adopted.contentstate.toptabs[0].title = "caller-mutated.ts";
        queue.enqueue({
            type: "update-top-tab",
            topTabId: FileTab.id,
            updates: { kind: "file", title: "dirty.ts" },
        });
        await queue.flush();

        expect(save.mock.calls[0][0].expectedrevision).toBe(2);
        expect(save.mock.calls[0][0].contentstate.toptabs[0].title).toBe("dirty.ts");
        expect(queue.confirmed.navigationrevision).toBe(3);
    });

    it("rejects a forced lower-revision checkpoint", () => {
        const { queue } = makeQueue(vi.fn(), checkpoint(3));

        expect(queue.reconcile(checkpoint(2), true)).toBe(false);
        expect(queue.confirmed.navigationrevision).toBe(3);
    });

    it("rejects an unknown save status without consuming the retryable batch", async () => {
        const save = vi
            .fn()
            .mockResolvedValueOnce({
                status: "mystery",
                checkpoint: checkpoint(1, [{ id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" }]),
            } as unknown as SaveWorkspaceCheckpointResult)
            .mockRejectedValueOnce(new Error("unexpected second save"));
        const { queue } = makeQueue(save);
        queue.enqueue({ type: "open-top-tab", tab: FileTab });

        await expect(queue.flush()).rejects.toThrow("unknown workspace checkpoint save status");
        expect(save).toHaveBeenCalledOnce();
        expect(queue.pending).toHaveLength(1);
        expect(queue.error).toBeInstanceOf(Error);
    });

    it("does not restart an in-flight save for repeated equivalent authoritative delivery", async () => {
        const saving = deferred<SaveWorkspaceCheckpointResult>();
        const save = vi.fn(() => saving.promise);
        const initial = checkpoint(0);
        const { queue } = makeQueue(save, initial);
        queue.enqueue({ type: "open-top-tab", tab: FileTab });
        const flushing = queue.flush();
        await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());

        expect(queue.reconcile(structuredClone(initial))).toBe(true);
        saving.resolve({
            status: "committed",
            checkpoint: checkpoint(1, [{ id: "file-1", kind: "file", path: "/tmp/a.ts", title: "a.ts" }]),
        });
        await flushing;

        expect(save).toHaveBeenCalledOnce();
        expect(queue.pending).toEqual([]);
    });
});
