// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renameSync } from "node:fs";
import {
    chmod,
    copyFile,
    link,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
    ParcelWorkspaceChangeFeed,
    type WorkspaceChangeEvent,
    type WorkspaceChangeWatcher,
} from "./workspace-change-feed";

class FakeWatcher implements WorkspaceChangeWatcher {
    callback?: (error: Error | null, events: WorkspaceChangeEvent[]) => unknown;
    eventLog: Array<{ sequence: number; event: WorkspaceChangeEvent }> = [];
    eventSequence = 0;
    queryError?: Error;
    querySnapshots: string[] = [];
    onQuery?: () => void;
    onSnapshot?: () => void;
    snapshotGate?: Promise<void>;
    snapshotStarted?: () => void;
    subscribeError?: Error;
    subscribeGate?: Promise<void>;
    subscribeStarted?: () => void;
    unsubscribeGate?: Promise<void>;
    unsubscribeCalls = 0;

    set events(events: WorkspaceChangeEvent[]) {
        for (const event of events) this.eventLog.push({ sequence: ++this.eventSequence, event });
    }

    get events(): WorkspaceChangeEvent[] {
        return this.eventLog.map((entry) => entry.event);
    }

    async getEventsSince(_directory: string, snapshot: string): Promise<WorkspaceChangeEvent[]> {
        if (this.queryError) throw this.queryError;
        this.onQuery?.();
        const snapshotSequence = Number.parseInt(await readFile(snapshot, "utf8"), 10);
        this.querySnapshots.push(String(snapshotSequence));
        return this.eventLog.filter((entry) => entry.sequence > snapshotSequence).map((entry) => entry.event);
    }

    async subscribe(_directory: string, callback: (error: Error | null, events: WorkspaceChangeEvent[]) => unknown) {
        if (this.subscribeError) throw this.subscribeError;
        this.subscribeStarted?.();
        await this.subscribeGate;
        this.callback = (error, events) => {
            if (!error) this.events = [...events];
            return callback(error, events);
        };
        return {
            unsubscribe: async () => {
                this.unsubscribeCalls++;
                await this.unsubscribeGate;
            },
        };
    }

    async writeSnapshot(_directory: string, snapshotPath: string): Promise<string> {
        const { writeFile } = await import("node:fs/promises");
        this.onSnapshot?.();
        this.snapshotStarted?.();
        await this.snapshotGate;
        await writeFile(snapshotPath, String(this.eventSequence), { mode: 0o600 });
        return snapshotPath;
    }
}

describe("ParcelWorkspaceChangeFeed", () => {
    let root: string;
    let workspaceRoot: string;
    let storeRoot: string;
    let watcher: FakeWatcher;
    let feed: ParcelWorkspaceChangeFeed;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "crest-workspace-feed-"));
        workspaceRoot = join(root, "workspace");
        storeRoot = join(root, "store");
        await mkdir(workspaceRoot);
        watcher = new FakeWatcher();
        feed = new ParcelWorkspaceChangeFeed({ workspaceRoot, storeRoot, watcher });
    });

    afterEach(async () => {
        await feed.dispose();
        await rm(root, { recursive: true, force: true });
    });

    test("returns cold-start before reconciliation initializes continuity", async () => {
        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "cold-start" });
    });

    test("requires a fresh reconcile after reopening a clean feed", async () => {
        await reconcile(feed);
        await feed.dispose();
        feed = new ParcelWorkspaceChangeFeed({ workspaceRoot, storeRoot, watcher });

        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "cold-start" });
        await expect(reconcile(feed)).resolves.toBeUndefined();
        await expect(feed.readChanges()).resolves.toMatchObject({ status: "complete" });
    });

    test("preserves a change delivered after reconcile and before post-reconcile initialization", async () => {
        await feed.prepareForReconcile();
        watcher.callback?.(null, [{ type: "update", path: join(workspaceRoot, "after-reconcile.txt") }]);

        await feed.initializeAfterReconcile();
        const result = await feed.readChanges();

        expect(result.status === "complete" && result.changedPaths).toEqual(["after-reconcile.txt"]);
    });

    test("fails closed when post-reconcile initialization was not prepared", async () => {
        await expect(feed.initializeAfterReconcile()).rejects.toThrow(/prepare/i);
        await expect(feed.readChanges()).resolves.toMatchObject({ status: "gap" });
    });

    test("preserves an existing gap reason before initialization", async () => {
        feed.markGap();

        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "query-failed" });
    });

    test("removes a reconcile cursor published after disposal begins", async () => {
        let releaseSnapshot!: () => void;
        let signalSnapshotStarted!: () => void;
        watcher.snapshotGate = new Promise<void>((resolve) => {
            releaseSnapshot = resolve;
        });
        const snapshotStarted = new Promise<void>((resolve) => {
            signalSnapshotStarted = resolve;
        });
        watcher.snapshotStarted = signalSnapshotStarted;
        const preparing = feed.prepareForReconcile();
        await snapshotStarted;

        const disposing = feed.dispose();
        releaseSnapshot();

        await expect(preparing).rejects.toThrow(/continuity|disposed/i);
        await disposing;
        expect((await readdir(join(storeRoot, "tracker"))).filter((name) => name === "reconcile.cursor")).toEqual([]);
    });

    test("fails closed when reconcile preparation is repeated", async () => {
        await feed.prepareForReconcile();

        await expect(feed.prepareForReconcile()).rejects.toThrow(/already prepared/i);
        await expect(feed.initializeAfterReconcile()).rejects.toThrow(/gap/i);
        await expect(feed.readChanges()).resolves.toMatchObject({ status: "gap" });
    });

    test("does not publish a baseline after a callback gap during reconciliation", async () => {
        await feed.prepareForReconcile();
        watcher.callback?.(new Error("overflow"), []);

        await expect(feed.initializeAfterReconcile()).rejects.toThrow(/gap/i);
        await expect(feed.readChanges()).resolves.toMatchObject({ status: "gap" });
    });

    test("can establish a fresh reconcile boundary after an initialization gap", async () => {
        await feed.prepareForReconcile();
        watcher.callback?.(new Error("overflow"), []);
        await expect(feed.initializeAfterReconcile()).rejects.toThrow(/gap/i);

        await expect(feed.prepareForReconcile()).resolves.toBeUndefined();
        await expect(feed.initializeAfterReconcile()).resolves.toBeUndefined();
        await expect(feed.readChanges()).resolves.toMatchObject({ status: "complete" });
    });

    test.each(["callback error", "hint overflow"] as const)(
        "fails closed when %s races post-reconcile cursor publication",
        async (gapKind) => {
            await feed.dispose();
            let armed = false;
            feed = new ParcelWorkspaceChangeFeed({
                workspaceRoot,
                storeRoot,
                watcher,
                callbackPathCapacity: 1,
                testHooks: {
                    beforeAnchoredMutation: (operation) => {
                        if (!armed || operation !== "commit-publish") return;
                        armed = false;
                        emitCallbackGap(watcher, workspaceRoot, gapKind);
                    },
                },
            });
            await feed.prepareForReconcile();
            armed = true;

            await expect(feed.initializeAfterReconcile()).rejects.toThrow(/continuity|gap/i);
            await expect(feed.readChanges()).resolves.toMatchObject({ status: "gap" });
            await feed.dispose();
            feed = new ParcelWorkspaceChangeFeed({ workspaceRoot, storeRoot, watcher, callbackPathCapacity: 1 });
            await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "cold-start" });
            await expect(reconcile(feed)).resolves.toBeUndefined();
            await expect(feed.readChanges()).resolves.toMatchObject({ status: "complete" });
        }
    );

    test("unions historical and callback paths with canonical byte sorting and de-duplication", async () => {
        await reconcile(feed);
        watcher.events = [
            { type: "update", path: join(workspaceRoot, "z.txt") },
            { type: "delete", path: join(workspaceRoot, "a.txt") },
            { type: "create", path: join(workspaceRoot, "é.txt") },
        ];
        watcher.callback?.(null, [
            { type: "update", path: join(workspaceRoot, "a.txt") },
            { type: "create", path: join(workspaceRoot, "callback.txt") },
        ]);

        const result = await feed.readChanges();

        expect(result.status).toBe("complete");
        if (result.status !== "complete") return;
        expect(result.changedPaths).toEqual(["a.txt", "callback.txt", "z.txt", "é.txt"]);
        expect(result.scopeInvalidated).toBe(false);
        expect(result.candidateCursor).toMatch(/^[0-9a-f]{32}$/);
    });

    test("retains callback changes that race baseline cursor publication", async () => {
        watcher.onSnapshot = () => {
            watcher.onSnapshot = undefined;
            watcher.callback?.(null, [{ type: "create", path: join(workspaceRoot, "during-init.txt") }]);
        };

        await reconcile(feed);
        const result = await feed.readChanges();

        expect(result.status === "complete" && result.changedPaths).toEqual(["during-init.txt"]);
    });

    test("does not advance the committed cursor until commit and repeats historical changes", async () => {
        await reconcile(feed);
        watcher.events = [{ type: "update", path: join(workspaceRoot, "repeat.txt") }];

        const first = await feed.readChanges();
        const second = await feed.readChanges();

        expect(first.status === "complete" && first.changedPaths).toEqual(["repeat.txt"]);
        expect(second.status === "complete" && second.changedPaths).toEqual(["repeat.txt"]);
        expect(first.status === "complete" && second.status === "complete" && first.candidateCursor).not.toBe(
            second.status === "complete" ? second.candidateCursor : ""
        );
        if (second.status !== "complete") return;
        await feed.commitCursor(second.candidateCursor);
        watcher.events = [];
        const afterCommit = await feed.readChanges();
        expect(afterCommit.status === "complete" && afterCommit.changedPaths).toEqual([]);
    });

    test("advances from the supplied candidate and replaces it with interval-only same-path evidence", async () => {
        await reconcile(feed);
        watcher.events = [{ type: "update", path: join(workspaceRoot, "a.txt") }];
        const first = await feed.readChanges();
        if (first.status !== "complete") throw new Error("expected complete read");
        const firstCandidateName = `candidate-${first.candidateCursor}.cursor`;

        watcher.events = [{ type: "update", path: join(workspaceRoot, "a.txt") }];
        const advanced = await feed.advanceCandidate(first.candidateCursor);

        expect(advanced).toMatchObject({
            status: "complete",
            changedPaths: ["a.txt"],
            scopeInvalidated: false,
        });
        if (advanced.status !== "complete") return;
        expect(advanced.candidateCursor).not.toBe(first.candidateCursor);
        expect(watcher.querySnapshots.at(-1)).toBe("1");
        expect((await readdir(join(storeRoot, "tracker"))).filter((name) => name.startsWith("candidate-"))).toEqual([
            `candidate-${advanced.candidateCursor}.cursor`,
        ]);
        expect(await stat(join(storeRoot, "tracker", firstCandidateName)).catch(() => undefined)).toBeUndefined();
    });

    test("fails closed and cleans candidates when candidate advancement receives a stale token", async () => {
        await reconcile(feed);
        const first = await feed.readChanges();
        if (first.status !== "complete") throw new Error("expected complete read");

        await expect(feed.advanceCandidate("0".repeat(32))).rejects.toThrow(/candidate cursor/i);
        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "query-failed" });
        expect((await readdir(join(storeRoot, "tracker"))).filter((name) => name.startsWith("candidate-"))).toEqual([]);
    });

    test("fails closed and cleans both candidates when interval query fails", async () => {
        await reconcile(feed);
        const first = await feed.readChanges();
        if (first.status !== "complete") throw new Error("expected complete read");
        watcher.queryError = new Error("query failed");

        await expect(feed.advanceCandidate(first.candidateCursor)).resolves.toEqual({
            status: "gap",
            reason: "query-failed",
        });
        expect((await readdir(join(storeRoot, "tracker"))).filter((name) => name.startsWith("candidate-"))).toEqual([]);
    });

    test("preserves callback continuity and scope invalidation across candidate advancement", async () => {
        await reconcile(feed);
        const first = await feed.readChanges();
        if (first.status !== "complete") throw new Error("expected complete read");
        watcher.events = [{ type: "update", path: join(workspaceRoot, ".gitignore") }];
        watcher.onSnapshot = () => {
            watcher.onSnapshot = undefined;
            watcher.callback?.(null, [{ type: "update", path: join(workspaceRoot, "callback.txt") }]);
        };

        await expect(feed.advanceCandidate(first.candidateCursor)).resolves.toMatchObject({
            status: "complete",
            changedPaths: [".gitignore", "callback.txt"],
            scopeInvalidated: true,
        });
    });

    test("rejects forged, stale, and foreign candidate cursor tokens", async () => {
        await reconcile(feed);
        const first = await feed.readChanges();
        const second = await feed.readChanges();
        if (first.status !== "complete" || second.status !== "complete") {
            throw new Error("expected complete reads");
        }
        const foreignFeed = new ParcelWorkspaceChangeFeed({
            workspaceRoot,
            storeRoot: join(root, "foreign-store"),
            watcher: new FakeWatcher(),
        });
        await reconcile(foreignFeed);
        const foreign = await foreignFeed.readChanges();
        if (foreign.status !== "complete") throw new Error("expected complete foreign read");

        await expect(feed.commitCursor(first.candidateCursor)).rejects.toThrow("candidate cursor");
        await expect(feed.commitCursor("../committed")).rejects.toThrow("candidate cursor");
        await expect(feed.commitCursor("0".repeat(32))).rejects.toThrow("candidate cursor");
        await expect(feed.commitCursor(foreign.candidateCursor)).rejects.toThrow("candidate cursor");
        await feed.commitCursor(second.candidateCursor);
        await expect(feed.commitCursor(second.candidateCursor)).rejects.toThrow("candidate cursor");
        await foreignFeed.dispose();
    }, 15_000);

    test("uses private tracker artifacts and cleans candidate files", async () => {
        await reconcile(feed);
        const result = await feed.readChanges();
        if (result.status !== "complete") throw new Error("expected complete read");
        const trackerRoot = join(storeRoot, "tracker");
        const candidateName = `candidate-${result.candidateCursor}.cursor`;

        expect((await stat(trackerRoot)).mode & 0o777).toBe(0o700);
        expect((await stat(join(trackerRoot, candidateName))).mode & 0o777).toBe(0o600);
        await feed.commitCursor(result.candidateCursor);
        expect((await readdir(trackerRoot)).filter((entry) => entry.startsWith("candidate-"))).toEqual([]);

        const next = await feed.readChanges();
        if (next.status !== "complete") throw new Error("expected complete read");
        await feed.dispose();
        expect((await readdir(trackerRoot)).filter((entry) => entry.startsWith("candidate-"))).toEqual([]);
    });

    test("fails closed when the committed cursor is missing", async () => {
        await reconcile(feed);
        await unlink(join(storeRoot, "tracker", "committed.cursor"));

        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "cursor-missing" });
    });

    test("reports a missing cursor before an existing callback gap", async () => {
        await reconcile(feed);
        watcher.callback?.(new Error("callback failed"), []);
        await unlink(join(storeRoot, "tracker", "committed.cursor"));

        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "cursor-missing" });
    });

    test("fails closed on historical query and callback errors", async () => {
        await reconcile(feed);
        watcher.queryError = new Error("query failed");
        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "query-failed" });
        expect((await readdir(join(storeRoot, "tracker"))).filter((name) => name.startsWith("candidate-"))).toEqual([]);

        watcher.queryError = undefined;
        await reconcile(feed);
        watcher.callback?.(new Error("callback failed"), []);
        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "query-failed" });
    });

    test("fails closed before reconcile when subscription startup fails", async () => {
        watcher.subscribeError = new Error("subscribe failed");

        await expect(feed.prepareForReconcile()).rejects.toThrow("subscribe failed");
        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "query-failed" });
    });

    test("fails closed when a callback error races an historical query", async () => {
        await reconcile(feed);
        watcher.onQuery = () => watcher.callback?.(new Error("callback failed"), []);

        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "query-failed" });
    });

    test("markGap remains fail-closed until reconciliation reinitializes the cursor", async () => {
        await reconcile(feed);
        const candidate = await feed.readChanges();
        if (candidate.status !== "complete") throw new Error("expected complete read");
        feed.markGap();
        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "query-failed" });
        await expect(feed.commitCursor(candidate.candidateCursor)).rejects.toThrow("candidate cursor");
        await reconcile(feed);
        expect((await feed.readChanges()).status).toBe("complete");
    }, 15_000);

    test.each([
        ["outside", (root: string) => join(root, "outside.txt")],
        ["noncanonical", (root: string) => `${join(root, "workspace")}/nested/../file.txt`],
        ["invalid UTF-8", (root: string) => join(root, "workspace", "\ud800.txt")],
    ])("fails closed on an %s event path", async (_name, makePath) => {
        await reconcile(feed);
        watcher.events = [{ type: "update", path: makePath(root) }];
        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "unsafe-path" });
    });

    test.each([".git/index", ".gitignore", "nested/.gitignore", ".git/info/exclude", "nested/.git/config"])(
        "invalidates scope for %s",
        async (path) => {
            await reconcile(feed);
            watcher.events = [{ type: "update", path: join(workspaceRoot, path) }];
            const result = await feed.readChanges();
            expect(result.status === "complete" && result.scopeInvalidated).toBe(true);
        }
    );

    test("contains callback exceptions and disposes idempotently", async () => {
        await reconcile(feed);
        expect(() => watcher.callback?.(null, [{ type: "update", path: join(root, "outside") }])).not.toThrow();
        await feed.dispose();
        await feed.dispose();
        expect(watcher.unsubscribeCalls).toBe(1);
    });

    test("rejects a replaced tracker directory without writing through it", async () => {
        await reconcile(feed);
        await feed.dispose();
        const trackerRoot = join(storeRoot, "tracker");
        const originalTracker = join(storeRoot, "original-tracker");
        const outside = join(root, "outside-tracker");
        await rename(trackerRoot, originalTracker);
        await mkdir(outside);
        await copyFile(join(originalTracker, "committed.cursor"), join(outside, "committed.cursor"));
        await symlink(outside, trackerRoot, "dir");
        feed = new ParcelWorkspaceChangeFeed({ workspaceRoot, storeRoot, watcher });

        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "cold-start" });
        expect(await readdir(outside)).toEqual(["committed.cursor"]);
    });

    test("concurrent dispose callers both await unsubscribe and cleanup", async () => {
        await reconcile(feed);
        let release!: () => void;
        watcher.unsubscribeGate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const first = feed.dispose();
        const second = feed.dispose();
        let secondFinished = false;
        void second.then(() => {
            secondFinished = true;
        });
        await Promise.resolve();
        expect(secondFinished).toBe(false);
        release();
        await Promise.all([first, second]);
        expect(watcher.unsubscribeCalls).toBe(1);
    });

    test("serializes concurrent reads to one live candidate owner", async () => {
        await reconcile(feed);
        watcher.events = [{ type: "update", path: join(workspaceRoot, "a.txt") }];
        let releaseSnapshot!: () => void;
        let signalSnapshotStarted!: () => void;
        watcher.snapshotGate = new Promise<void>((resolve) => {
            releaseSnapshot = resolve;
        });
        const snapshotStarted = new Promise<void>((resolve) => {
            signalSnapshotStarted = resolve;
        });
        watcher.snapshotStarted = signalSnapshotStarted;

        const first = feed.readChanges();
        await snapshotStarted;
        const second = feed.readChanges();
        releaseSnapshot();
        const reads = await Promise.all([first, second]);

        expect(reads.every((read) => read.status === "complete")).toBe(true);
        expect(
            (await readdir(join(storeRoot, "tracker"))).filter((name) => name.startsWith("candidate-"))
        ).toHaveLength(1);
    });

    test("serializes read then reconcile preparation and removes the read candidate", async () => {
        await reconcile(feed);
        let releaseSnapshot!: () => void;
        let signalSnapshotStarted!: () => void;
        watcher.snapshotGate = new Promise<void>((resolve) => {
            releaseSnapshot = resolve;
        });
        const snapshotStarted = new Promise<void>((resolve) => {
            signalSnapshotStarted = resolve;
        });
        watcher.snapshotStarted = signalSnapshotStarted;

        const reading = feed.readChanges();
        await snapshotStarted;
        const preparing = feed.prepareForReconcile();
        releaseSnapshot();

        await expect(reading).resolves.toMatchObject({ status: "complete" });
        await expect(preparing).resolves.toBeUndefined();
        const artifacts = await readdir(join(storeRoot, "tracker"));
        expect(artifacts.filter((name) => name.startsWith("candidate-"))).toEqual([]);
        expect(artifacts).toContain("reconcile.cursor");
    });

    test("serializes candidate advance before a concurrent stale commit without leaking ownership", async () => {
        await reconcile(feed);
        watcher.events = [{ type: "update", path: join(workspaceRoot, "a.txt") }];
        const first = await feed.readChanges();
        if (first.status !== "complete") throw new Error("expected complete read");
        watcher.events = [{ type: "update", path: join(workspaceRoot, "a.txt") }];
        let releaseSnapshot!: () => void;
        let signalSnapshotStarted!: () => void;
        watcher.snapshotGate = new Promise<void>((resolve) => {
            releaseSnapshot = resolve;
        });
        const snapshotStarted = new Promise<void>((resolve) => {
            signalSnapshotStarted = resolve;
        });
        watcher.snapshotStarted = signalSnapshotStarted;

        const advancing = feed.advanceCandidate(first.candidateCursor);
        await snapshotStarted;
        const committing = feed.commitCursor(first.candidateCursor).then(
            () => ({ status: "fulfilled" as const }),
            (error) => ({ status: "rejected" as const, error })
        );
        releaseSnapshot();
        const advanced = await advancing;
        const commit = await committing;

        expect(advanced).toMatchObject({ status: "complete", changedPaths: ["a.txt"] });
        expect(commit).toMatchObject({ status: "rejected", error: expect.any(Error) });
        if (advanced.status !== "complete") return;
        expect((await readdir(join(storeRoot, "tracker"))).filter((name) => name.startsWith("candidate-"))).toEqual([
            `candidate-${advanced.candidateCursor}.cursor`,
        ]);
        await feed.commitCursor(advanced.candidateCursor);
    });

    test("fences an in-flight read immediately on dispose and joins candidate cleanup", async () => {
        await reconcile(feed);
        let releaseSnapshot!: () => void;
        let signalSnapshotStarted!: () => void;
        watcher.snapshotGate = new Promise<void>((resolve) => {
            releaseSnapshot = resolve;
        });
        const snapshotStarted = new Promise<void>((resolve) => {
            signalSnapshotStarted = resolve;
        });
        watcher.snapshotStarted = signalSnapshotStarted;

        const reading = feed.readChanges();
        await snapshotStarted;
        const disposing = feed.dispose();
        releaseSnapshot();

        await expect(reading).resolves.toMatchObject({ status: "gap" });
        await expect(disposing).resolves.toBeUndefined();
        expect((await readdir(join(storeRoot, "tracker"))).filter((name) => name.startsWith("candidate-"))).toEqual([]);
        expect(watcher.unsubscribeCalls).toBe(1);
    });

    test("dispose does not follow a replaced tracker directory to delete a foreign candidate", async () => {
        await reconcile(feed);
        const result = await feed.readChanges();
        if (result.status !== "complete") throw new Error("expected complete read");
        const trackerRoot = join(storeRoot, "tracker");
        const originalTracker = join(storeRoot, "original-tracker");
        const outside = join(root, "outside-dispose");
        const candidateName = `candidate-${result.candidateCursor}.cursor`;
        await rename(trackerRoot, originalTracker);
        await mkdir(outside);
        await writeFile(join(outside, candidateName), "foreign");
        await symlink(outside, trackerRoot, "dir");

        await expect(feed.dispose()).resolves.toBeUndefined();
        await expect(readFile(join(outside, candidateName), "utf8")).resolves.toBe("foreign");
    });

    test("rejects a candidate whose inode was replaced before commit", async () => {
        await reconcile(feed);
        const result = await feed.readChanges();
        if (result.status !== "complete") throw new Error("expected complete read");
        const candidate = join(storeRoot, "tracker", `candidate-${result.candidateCursor}.cursor`);
        await rename(candidate, `${candidate}.held`);
        await writeFile(candidate, "forged", { mode: 0o600 });

        await expect(feed.commitCursor(result.candidateCursor)).rejects.toThrow(/candidate cursor/i);
        await expect(reconcile(feed)).resolves.toBeUndefined();
        await expect(feed.readChanges()).resolves.toMatchObject({ status: "complete" });
    }, 15_000);

    test("rejects a candidate whose content changed in place before commit", async () => {
        await reconcile(feed);
        const result = await feed.readChanges();
        if (result.status !== "complete") throw new Error("expected complete read");
        const candidate = join(storeRoot, "tracker", `candidate-${result.candidateCursor}.cursor`);
        const size = (await stat(candidate)).size;
        await writeFile(candidate, Buffer.alloc(size, 0x78));

        await expect(feed.commitCursor(result.candidateCursor)).rejects.toThrow(/candidate cursor/i);
        await expect(reconcile(feed)).resolves.toBeUndefined();
        await expect(feed.readChanges()).resolves.toMatchObject({ status: "complete" });
    }, 15_000);

    test("rejects a hardlinked candidate before commit and recovers with one reconcile", async () => {
        await reconcile(feed);
        const hardlinked = await feed.readChanges();
        if (hardlinked.status !== "complete") throw new Error("expected complete read");
        const candidate = join(storeRoot, "tracker", `candidate-${hardlinked.candidateCursor}.cursor`);
        const held = `${candidate}.held`;
        await rename(candidate, held);
        await link(held, candidate);
        await expect(feed.commitCursor(hardlinked.candidateCursor)).rejects.toThrow(/candidate cursor/i);
        await expect(reconcile(feed)).resolves.toBeUndefined();
        await expect(feed.readChanges()).resolves.toMatchObject({ status: "complete" });
    }, 15_000);

    test("rejects a non-private candidate before commit and recovers with one reconcile", async () => {
        await reconcile(feed);
        const nonPrivate = await feed.readChanges();
        if (nonPrivate.status !== "complete") throw new Error("expected complete read");
        const nonPrivateCandidate = join(storeRoot, "tracker", `candidate-${nonPrivate.candidateCursor}.cursor`);
        await chmod(nonPrivateCandidate, 0o644);
        await expect(feed.commitCursor(nonPrivate.candidateCursor)).rejects.toThrow(/candidate cursor/i);
        await expect(reconcile(feed)).resolves.toBeUndefined();
        await expect(feed.readChanges()).resolves.toMatchObject({ status: "complete" });
    }, 15_000);

    test("rejects a private tracker inode replacement before candidate commit", async () => {
        await reconcile(feed);
        const result = await feed.readChanges();
        if (result.status !== "complete") throw new Error("expected complete read");
        const trackerRoot = join(storeRoot, "tracker");
        const held = join(storeRoot, "held-tracker");
        const replacement = join(storeRoot, "replacement-tracker");
        await rename(trackerRoot, held);
        await mkdir(replacement, { mode: 0o700 });
        await copyFile(join(held, "committed.cursor"), join(replacement, "committed.cursor"));
        await copyFile(
            join(held, `candidate-${result.candidateCursor}.cursor`),
            join(replacement, `candidate-${result.candidateCursor}.cursor`)
        );
        await rename(replacement, trackerRoot);

        await expect(feed.commitCursor(result.candidateCursor)).rejects.toThrow(/candidate cursor|anchor|changed/i);
        expect(await readdir(trackerRoot)).toContain(`candidate-${result.candidateCursor}.cursor`);
    });

    test("rejects a tracker exchange between committed read and candidate publication", async () => {
        await reconcile(feed);
        const trackerRoot = join(storeRoot, "tracker");
        const held = join(storeRoot, "read-held");
        const replacement = join(storeRoot, "read-replacement");
        await mkdir(replacement, { mode: 0o700 });
        await copyFile(join(trackerRoot, "committed.cursor"), join(replacement, "committed.cursor"));
        watcher.onSnapshot = () => {
            watcher.onSnapshot = undefined;
            renameSync(trackerRoot, held);
            renameSync(replacement, trackerRoot);
        };

        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "query-failed" });
        expect((await readdir(trackerRoot)).filter((name) => name.startsWith("candidate-"))).toEqual([]);
    });

    test("does not establish tracker storage through an intermediate symlink", async () => {
        await feed.dispose();
        const outsideStore = join(root, "outside-store");
        const linkedStore = join(root, "linked-store");
        await mkdir(outsideStore, { mode: 0o700 });
        await symlink(outsideStore, linkedStore, "dir");
        feed = new ParcelWorkspaceChangeFeed({ workspaceRoot, storeRoot: linkedStore, watcher });

        await expect(feed.prepareForReconcile()).rejects.toThrow(/anchor|symlink|unsafe|not a directory/i);
        await expect(readdir(outsideStore)).resolves.toEqual([]);
    });

    test("removes only reserved abandoned journal temps during prepare", async () => {
        await reconcile(feed);
        const trackerRoot = join(storeRoot, "tracker");
        const reserved = ".0123456789abcdef0123456789abcdef.tmp";
        await writeFile(join(trackerRoot, reserved), "abandoned", { mode: 0o600 });
        await writeFile(join(trackerRoot, "keep.tmp"), "unrelated", { mode: 0o600 });

        await feed.prepareForReconcile();

        expect(await readdir(trackerRoot)).not.toContain(reserved);
        expect(await readdir(trackerRoot)).toContain("keep.tmp");
    });

    test("anchors commit against a tracker exchange after candidate validation", async () => {
        await feed.dispose();
        let armed = false;
        let exchange!: () => Promise<void>;
        feed = new ParcelWorkspaceChangeFeed({
            workspaceRoot,
            storeRoot,
            watcher,
            testHooks: {
                beforeAnchoredMutation: async (operation) => {
                    if (armed && operation === "commit") await exchange();
                },
            },
        });
        await reconcile(feed);
        const result = await feed.readChanges();
        if (result.status !== "complete") throw new Error("expected complete read");
        const trackerRoot = join(storeRoot, "tracker");
        const held = join(storeRoot, "exchange-held");
        const replacement = join(storeRoot, "exchange-replacement");
        await mkdir(replacement, { mode: 0o700 });
        await copyFile(join(trackerRoot, "committed.cursor"), join(replacement, "committed.cursor"));
        await copyFile(
            join(trackerRoot, `candidate-${result.candidateCursor}.cursor`),
            join(replacement, `candidate-${result.candidateCursor}.cursor`)
        );
        exchange = async () => {
            armed = false;
            await rename(trackerRoot, held);
            await rename(replacement, trackerRoot);
        };
        armed = true;

        await expect(feed.commitCursor(result.candidateCursor)).rejects.toThrow(/candidate cursor/i);
        expect(await readdir(trackerRoot)).toContain(`candidate-${result.candidateCursor}.cursor`);
    });

    test("anchors committed publication against an exchange after candidate removal", async () => {
        await feed.dispose();
        let armed = false;
        let exchange!: () => Promise<void>;
        feed = new ParcelWorkspaceChangeFeed({
            workspaceRoot,
            storeRoot,
            watcher,
            testHooks: {
                beforeAnchoredMutation: async (operation) => {
                    if (armed && operation === "commit-publish") await exchange();
                },
            },
        });
        await reconcile(feed);
        const result = await feed.readChanges();
        if (result.status !== "complete") throw new Error("expected complete read");
        const trackerRoot = join(storeRoot, "tracker");
        const held = join(storeRoot, "publish-held");
        const replacement = join(storeRoot, "publish-replacement");
        await mkdir(replacement, { mode: 0o700 });
        await copyFile(join(trackerRoot, "committed.cursor"), join(replacement, "committed.cursor"));
        const replacementBytes = await readFile(join(replacement, "committed.cursor"));
        exchange = async () => {
            armed = false;
            await rename(trackerRoot, held);
            await rename(replacement, trackerRoot);
        };
        armed = true;

        await expect(feed.commitCursor(result.candidateCursor)).rejects.toThrow(/candidate cursor/i);
        expect(await readFile(join(trackerRoot, "committed.cursor"))).toEqual(replacementBytes);
    });

    test.each(["callback error", "hint overflow"] as const)(
        "fails closed when %s races candidate cursor publication",
        async (gapKind) => {
            await feed.dispose();
            let armed = false;
            feed = new ParcelWorkspaceChangeFeed({
                workspaceRoot,
                storeRoot,
                watcher,
                callbackPathCapacity: 1,
                testHooks: {
                    beforeAnchoredMutation: (operation) => {
                        if (!armed || operation !== "commit-publish") return;
                        armed = false;
                        emitCallbackGap(watcher, workspaceRoot, gapKind);
                    },
                },
            });
            await reconcile(feed);
            const result = await feed.readChanges();
            if (result.status !== "complete") throw new Error("expected complete read");
            armed = true;

            await expect(feed.commitCursor(result.candidateCursor)).rejects.toThrow(/continuity|candidate/i);
            await expect(feed.readChanges()).resolves.toMatchObject({ status: "gap" });
            await feed.dispose();
            feed = new ParcelWorkspaceChangeFeed({ workspaceRoot, storeRoot, watcher, callbackPathCapacity: 1 });
            await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "cold-start" });
            await expect(reconcile(feed)).resolves.toBeUndefined();
            await expect(feed.readChanges()).resolves.toMatchObject({ status: "complete" });
        }
    );

    test("unsubscribes a subscription that resolves after disposal", async () => {
        let resolveSubscribe!: () => void;
        let signalSubscribeStarted!: () => void;
        const subscribeStarted = new Promise<void>((resolve) => {
            signalSubscribeStarted = resolve;
        });
        watcher.subscribeStarted = signalSubscribeStarted;
        watcher.subscribeGate = new Promise<void>((resolve) => {
            resolveSubscribe = resolve;
        });
        const preparing = feed.prepareForReconcile();
        await subscribeStarted;
        const disposing = feed.dispose();
        resolveSubscribe();

        await expect(preparing).rejects.toThrow(/disposed/i);
        await disposing;
        expect(watcher.unsubscribeCalls).toBe(1);
    });

    test("deduplicates callback hints before applying the capacity limit", async () => {
        await feed.dispose();
        feed = new ParcelWorkspaceChangeFeed({ workspaceRoot, storeRoot, watcher, callbackPathCapacity: 2 });
        await reconcile(feed);
        watcher.callback?.(
            null,
            Array.from({ length: 100 }, () => ({ type: "update" as const, path: join(workspaceRoot, "same.txt") }))
        );
        watcher.callback?.(null, [{ type: "update", path: join(workspaceRoot, "second.txt") }]);

        const result = await feed.readChanges();
        expect(result.status === "complete" && result.changedPaths).toEqual(["same.txt", "second.txt"]);
    });

    test("marks a gap when callback hint capacity is exceeded", async () => {
        await feed.dispose();
        feed = new ParcelWorkspaceChangeFeed({ workspaceRoot, storeRoot, watcher, callbackPathCapacity: 2 });
        await reconcile(feed);
        watcher.callback?.(null, [
            { type: "update", path: join(workspaceRoot, "one.txt") },
            { type: "update", path: join(workspaceRoot, "two.txt") },
            { type: "update", path: join(workspaceRoot, "three.txt") },
        ]);

        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "query-failed" });
    });

    test("fails closed on Windows until owner-only ACL storage is available", async () => {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");

        await expect(feed.prepareForReconcile()).rejects.toThrow(/Windows ACL/i);
    });
});

async function reconcile(feed: ParcelWorkspaceChangeFeed): Promise<void> {
    await feed.prepareForReconcile();
    await feed.initializeAfterReconcile();
}

function emitCallbackGap(watcher: FakeWatcher, workspaceRoot: string, kind: "callback error" | "hint overflow"): void {
    if (kind === "callback error") {
        watcher.callback?.(new Error("callback failed during publication"), []);
        return;
    }
    watcher.callback?.(null, [
        { type: "update", path: join(workspaceRoot, "overflow-a.txt") },
        { type: "update", path: join(workspaceRoot, "overflow-b.txt") },
    ]);
}
