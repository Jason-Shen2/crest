// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    copyFile,
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

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
    ParcelWorkspaceChangeFeed,
    type WorkspaceChangeEvent,
    type WorkspaceChangeWatcher,
} from "./workspace-change-feed";

class FakeWatcher implements WorkspaceChangeWatcher {
    callback?: (error: Error | null, events: WorkspaceChangeEvent[]) => unknown;
    events: WorkspaceChangeEvent[] = [];
    queryError?: Error;
    onQuery?: () => void;
    onSnapshot?: () => void;
    snapshot = 0;
    subscribeError?: Error;
    unsubscribeGate?: Promise<void>;
    unsubscribeCalls = 0;

    async getEventsSince(): Promise<WorkspaceChangeEvent[]> {
        if (this.queryError) throw this.queryError;
        this.onQuery?.();
        return [...this.events];
    }

    async subscribe(_directory: string, callback: (error: Error | null, events: WorkspaceChangeEvent[]) => unknown) {
        if (this.subscribeError) throw this.subscribeError;
        this.callback = callback;
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
        await writeFile(snapshotPath, String(++this.snapshot), { mode: 0o600 });
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

    test("unions historical and callback paths with canonical byte sorting and de-duplication", async () => {
        await feed.initializeAfterReconcile();
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

        await feed.initializeAfterReconcile();
        const result = await feed.readChanges();

        expect(result.status === "complete" && result.changedPaths).toEqual(["during-init.txt"]);
    });

    test("does not advance the committed cursor until commit and repeats historical changes", async () => {
        await feed.initializeAfterReconcile();
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

    test("rejects forged, stale, and foreign candidate cursor tokens", async () => {
        await feed.initializeAfterReconcile();
        const first = await feed.readChanges();
        const second = await feed.readChanges();
        if (first.status !== "complete" || second.status !== "complete") throw new Error("expected complete reads");
        const foreignFeed = new ParcelWorkspaceChangeFeed({
            workspaceRoot,
            storeRoot: join(root, "foreign-store"),
            watcher: new FakeWatcher(),
        });
        await foreignFeed.initializeAfterReconcile();
        const foreign = await foreignFeed.readChanges();
        if (foreign.status !== "complete") throw new Error("expected complete foreign read");

        await expect(feed.commitCursor(first.candidateCursor)).rejects.toThrow("candidate cursor");
        await expect(feed.commitCursor("../committed")).rejects.toThrow("candidate cursor");
        await expect(feed.commitCursor("0".repeat(32))).rejects.toThrow("candidate cursor");
        await expect(feed.commitCursor(foreign.candidateCursor)).rejects.toThrow("candidate cursor");
        await feed.commitCursor(second.candidateCursor);
        await expect(feed.commitCursor(second.candidateCursor)).rejects.toThrow("candidate cursor");
        await foreignFeed.dispose();
    });

    test("uses private tracker artifacts and cleans candidate files", async () => {
        await feed.initializeAfterReconcile();
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
        await feed.initializeAfterReconcile();
        await unlink(join(storeRoot, "tracker", "committed.cursor"));

        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "cursor-missing" });
    });

    test("reports a missing cursor before an existing callback gap", async () => {
        await feed.initializeAfterReconcile();
        watcher.callback?.(new Error("callback failed"), []);
        await unlink(join(storeRoot, "tracker", "committed.cursor"));

        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "cursor-missing" });
    });

    test("fails closed on historical query and callback errors", async () => {
        await feed.initializeAfterReconcile();
        watcher.queryError = new Error("query failed");
        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "query-failed" });

        await feed.initializeAfterReconcile();
        watcher.queryError = undefined;
        watcher.callback?.(new Error("callback failed"), []);
        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "query-failed" });
    });

    test("publishes reconciliation cursor but fails closed when subscription startup fails", async () => {
        watcher.subscribeError = new Error("subscribe failed");

        await expect(feed.initializeAfterReconcile()).resolves.toBeUndefined();
        expect((await stat(join(storeRoot, "tracker", "committed.cursor"))).isFile()).toBe(true);
        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "query-failed" });
    });

    test("fails closed when a callback error races an historical query", async () => {
        await feed.initializeAfterReconcile();
        watcher.onQuery = () => watcher.callback?.(new Error("callback failed"), []);

        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "query-failed" });
    });

    test("markGap remains fail-closed until reconciliation reinitializes the cursor", async () => {
        await feed.initializeAfterReconcile();
        const candidate = await feed.readChanges();
        if (candidate.status !== "complete") throw new Error("expected complete read");
        feed.markGap();
        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "query-failed" });
        await expect(feed.commitCursor(candidate.candidateCursor)).rejects.toThrow("candidate cursor");
        await feed.initializeAfterReconcile();
        expect((await feed.readChanges()).status).toBe("complete");
    });

    test.each([
        ["outside", (root: string) => join(root, "outside.txt")],
        ["noncanonical", (root: string) => `${join(root, "workspace")}/nested/../file.txt`],
        ["invalid UTF-8", (root: string) => join(root, "workspace", "\ud800.txt")],
    ])("fails closed on an %s event path", async (_name, makePath) => {
        await feed.initializeAfterReconcile();
        watcher.events = [{ type: "update", path: makePath(root) }];
        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "unsafe-path" });
    });

    test.each([".git/index", ".gitignore", "nested/.gitignore", ".git/info/exclude", "nested/.git/config"])(
        "invalidates scope for %s",
        async (path) => {
            await feed.initializeAfterReconcile();
            watcher.events = [{ type: "update", path: join(workspaceRoot, path) }];
            const result = await feed.readChanges();
            expect(result.status === "complete" && result.scopeInvalidated).toBe(true);
        }
    );

    test("contains callback exceptions and disposes idempotently", async () => {
        await feed.initializeAfterReconcile();
        expect(() => watcher.callback?.(null, [{ type: "update", path: join(root, "outside") }])).not.toThrow();
        await feed.dispose();
        await feed.dispose();
        expect(watcher.unsubscribeCalls).toBe(1);
    });

    test("rejects a replaced tracker directory without writing through it", async () => {
        await feed.initializeAfterReconcile();
        await feed.dispose();
        const trackerRoot = join(storeRoot, "tracker");
        const originalTracker = join(storeRoot, "original-tracker");
        const outside = join(root, "outside-tracker");
        await rename(trackerRoot, originalTracker);
        await mkdir(outside);
        await copyFile(join(originalTracker, "committed.cursor"), join(outside, "committed.cursor"));
        await symlink(outside, trackerRoot, "dir");
        feed = new ParcelWorkspaceChangeFeed({ workspaceRoot, storeRoot, watcher });

        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "query-failed" });
        expect(await readdir(outside)).toEqual(["committed.cursor"]);
    });

    test("concurrent dispose callers both await unsubscribe and cleanup", async () => {
        await feed.initializeAfterReconcile();
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

    test("dispose does not follow a replaced tracker directory to delete a foreign candidate", async () => {
        await feed.initializeAfterReconcile();
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
});
