// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
    ParcelWorkspaceChangeFeed,
    type WorkspaceChangeEvent,
    type WorkspaceChangeSubscription,
    type WorkspaceChangeWatcher,
} from "./workspace-change-feed";

class FakeWatcher implements WorkspaceChangeWatcher {
    callbacks = new Set<(error: Error | null, events: WorkspaceChangeEvent[]) => unknown>();
    subscribeCalls = 0;
    unsubscribeCalls = 0;

    async subscribe(
        _directory: string,
        callback: (error: Error | null, events: WorkspaceChangeEvent[]) => unknown
    ): Promise<WorkspaceChangeSubscription> {
        this.subscribeCalls++;
        this.callbacks.add(callback);
        let subscribed = true;
        return {
            unsubscribe: async () => {
                if (!subscribed) return;
                subscribed = false;
                this.unsubscribeCalls++;
                this.callbacks.delete(callback);
            },
        };
    }

    emit(...events: WorkspaceChangeEvent[]): void {
        for (const callback of this.callbacks) callback(null, events);
    }

    fail(error = new Error("watcher failed")): void {
        for (const callback of this.callbacks) callback(error, []);
    }
}

describe("ParcelWorkspaceChangeFeed", () => {
    let root: string;
    let workspaceRoot: string;
    let watcher: FakeWatcher;
    let feed: ParcelWorkspaceChangeFeed;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "crest-workspace-change-feed-"));
        workspaceRoot = join(root, "workspace");
        await mkdir(workspaceRoot);
        watcher = new FakeWatcher();
        feed = new ParcelWorkspaceChangeFeed({ workspaceRoot, watcher });
    });

    afterEach(async () => {
        await feed.dispose();
        await rm(root, { recursive: true, force: true });
    });

    test("starts cold and drains canonical unique byte-sorted in-memory hints", async () => {
        await expect(feed.drain()).resolves.toEqual({ status: "unavailable", reason: "not-started" });
        expect(feed.isTrusted()).toBe(false);

        await feed.start();
        watcher.emit(
            { path: join(workspaceRoot, "z.txt"), type: "create" },
            { path: "a.txt", type: "update" },
            { path: "z.txt", type: "delete" }
        );

        await expect(feed.drain()).resolves.toEqual({ status: "complete", changedPaths: ["a.txt", "z.txt"] });
        await expect(feed.drain()).resolves.toEqual({ status: "complete", changedPaths: [] });
        expect(feed.isTrusted()).toBe(true);
    });

    test("never loses a callback racing a drain", async () => {
        await feed.start();
        watcher.emit({ path: "before.txt", type: "update" });

        const draining = feed.drain();
        watcher.emit({ path: "racing.txt", type: "update" });
        const first = await draining;
        const second = await feed.drain();

        if (first.status !== "complete" || second.status !== "complete") throw new Error("expected complete drain");
        expect([...first.changedPaths, ...second.changedPaths].sort()).toEqual(["before.txt", "racing.txt"]);
    });

    test("ignores Git metadata events that cannot change eligible Workspace content", async () => {
        await feed.start();
        watcher.emit(
            { path: ".git/index", type: "update" },
            { path: join(workspaceRoot, ".git", "fsmonitor--daemon", "cookies", "token"), type: "create" },
            { path: "source.ts", type: "update" }
        );

        await expect(feed.drain()).resolves.toEqual({ status: "complete", changedPaths: ["source.ts"] });
        expect(feed.isTrusted()).toBe(true);
    });

    test("ignores callbacks from a subscription replaced by restart", async () => {
        await feed.start();
        const staleCallback = [...watcher.callbacks][0]!;
        await feed.start();

        staleCallback(null, [{ path: "stale.txt", type: "update" }]);
        watcher.emit({ path: "current.txt", type: "update" });

        await expect(feed.drain()).resolves.toEqual({ status: "complete", changedPaths: ["current.txt"] });
    });

    test.each([
        ["outside absolute path", (workspace: string) => join(workspace, "..", "outside.txt")],
        ["parent traversal", () => "../outside.txt"],
        ["noncanonical path", () => "folder/../file.txt"],
        ["invalid UTF-8 path", () => "\ud800.txt"],
        ["empty path", () => ""],
    ])("loses trust for an unsafe %s", async (_label, makePath) => {
        await feed.start();

        watcher.emit({ path: makePath(workspaceRoot), type: "update" });

        expect(feed.isTrusted()).toBe(false);
        await expect(feed.drain()).resolves.toEqual({ status: "unavailable", reason: "unsafe-path" });
    });

    test("loses trust on capacity overflow and can be restarted before a reconcile", async () => {
        await feed.dispose();
        feed = new ParcelWorkspaceChangeFeed({ workspaceRoot, watcher, callbackPathCapacity: 2 });
        await feed.start();

        watcher.emit(
            { path: "one.txt", type: "update" },
            { path: "two.txt", type: "update" },
            { path: "three.txt", type: "update" }
        );

        expect(feed.isTrusted()).toBe(false);
        await expect(feed.drain()).resolves.toEqual({ status: "unavailable", reason: "overflow" });
        await feed.start();
        watcher.emit({ path: "after-reconcile.txt", type: "update" });
        await expect(feed.drain()).resolves.toEqual({
            status: "complete",
            changedPaths: ["after-reconcile.txt"],
        });
        expect(watcher.subscribeCalls).toBe(2);
        expect(watcher.unsubscribeCalls).toBe(1);
    });

    test("loses trust when the watcher reports a continuity error", async () => {
        await feed.start();

        watcher.fail();

        expect(feed.isTrusted()).toBe(false);
        await expect(feed.drain()).resolves.toEqual({ status: "unavailable", reason: "watcher-error" });
    });

    test("dispose is idempotent and makes later reads unavailable", async () => {
        await feed.start();

        await Promise.all([feed.dispose(), feed.dispose()]);

        expect(watcher.unsubscribeCalls).toBe(1);
        expect(feed.isTrusted()).toBe(false);
        await expect(feed.drain()).resolves.toEqual({ status: "unavailable", reason: "disposed" });
        await expect(feed.start()).rejects.toThrow(/disposed/i);
    });

    test("does not create or consult durable cursor storage", async () => {
        const storeRoot = join(root, "store");
        const legacyTracker = join(storeRoot, "tracker");
        await mkdir(legacyTracker, { recursive: true });
        const options = { workspaceRoot, storeRoot, watcher };
        await feed.dispose();
        feed = new ParcelWorkspaceChangeFeed(options);

        await feed.start();
        watcher.emit({ path: "new-runtime.txt", type: "update" });

        await expect(feed.drain()).resolves.toEqual({ status: "complete", changedPaths: ["new-runtime.txt"] });
    });
});
