// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import ParcelWatcher from "@parcel/watcher";

import { ParcelWorkspaceChangeFeed } from "./workspace-change-feed";

describe("ParcelWorkspaceChangeFeed native integration", () => {
    let root: string;
    let workspaceRoot: string;
    let feeds: ParcelWorkspaceChangeFeed[];
    let nativeBackendAvailable: boolean;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "crest-workspace-feed-native-"));
        const requestedWorkspaceRoot = join(root, "workspace");
        await mkdir(requestedWorkspaceRoot);
        workspaceRoot = await realpath(requestedWorkspaceRoot);
        nativeBackendAvailable = await supportsNativeWatcher(workspaceRoot);
        feeds = [];
    });

    afterEach(async () => {
        await Promise.all(feeds.map((feed) => feed.dispose()));
        await rm(root, { recursive: true, force: true });
    });

    test("reports create, update, delete, and both sides of rename", async () => {
        await writeFile(join(workspaceRoot, "update.txt"), "before");
        await writeFile(join(workspaceRoot, "delete.txt"), "delete");
        await writeFile(join(workspaceRoot, "old.txt"), "rename");
        const feed = makeFeed();
        if (!(await startOrUnsupported(feed))) return;

        await writeFile(join(workspaceRoot, "create.txt"), "create");
        await writeFile(join(workspaceRoot, "update.txt"), "after");
        await unlink(join(workspaceRoot, "delete.txt"));
        await rename(join(workspaceRoot, "old.txt"), join(workspaceRoot, "new.txt"));

        await expectPaths(feed, ["create.txt", "delete.txt", "new.txt", "old.txt", "update.txt"]);
    });

    test("a reopened runtime starts cold and never consults a persisted cursor", async () => {
        const first = makeFeed();
        if (!(await startOrUnsupported(first))) return;
        await first.dispose();
        await writeFile(join(workspaceRoot, "offline.txt"), "offline");

        const reopened = makeFeed();
        await expect(reopened.drain()).resolves.toEqual({ status: "unavailable", reason: "not-started" });
        if (!(await startOrUnsupported(reopened))) return;

        await expect(reopened.drain()).resolves.toEqual({ status: "complete", changedPaths: [] });
    });

    test("coalesces one thousand writes to one changed path", async () => {
        const path = join(workspaceRoot, "hot.txt");
        await writeFile(path, "initial");
        const feed = makeFeed();
        if (!(await startOrUnsupported(feed))) return;

        for (let index = 0; index < 1_000; index++) {
            await writeFile(path, String(index));
        }

        await expectPaths(feed, ["hot.txt"]);
    });

    function makeFeed(): ParcelWorkspaceChangeFeed {
        const feed = new ParcelWorkspaceChangeFeed({ workspaceRoot });
        feeds.push(feed);
        return feed;
    }

    async function startOrUnsupported(feed: ParcelWorkspaceChangeFeed): Promise<boolean> {
        try {
            await feed.start();
            return true;
        } catch (error) {
            if (nativeBackendAvailable) {
                await feed.start();
                return true;
            }
            expect(error).toBeInstanceOf(Error);
            return false;
        }
    }
});

async function expectPaths(feed: ParcelWorkspaceChangeFeed, expectedPaths: string[]): Promise<void> {
    const observed = new Set<string>();
    await vi.waitFor(
        async () => {
            const result = await feed.drain();
            expect(result.status).toBe("complete");
            if (result.status !== "complete") return;
            for (const path of result.changedPaths) observed.add(path);
            expect([...observed].sort()).toEqual(expectedPaths);
        },
        { timeout: 5_000, interval: 20 }
    );
}

async function supportsNativeWatcher(workspaceRoot: string): Promise<boolean> {
    try {
        const subscription = await ParcelWatcher.subscribe(workspaceRoot, () => undefined);
        await subscription.unsubscribe();
        return true;
    } catch {
        return false;
    }
}
