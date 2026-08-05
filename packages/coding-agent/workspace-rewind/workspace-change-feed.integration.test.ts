// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import ParcelWatcher from "@parcel/watcher";

import { ParcelWorkspaceChangeFeed, type WorkspaceChangeRead } from "./workspace-change-feed";

describe("ParcelWorkspaceChangeFeed native integration", () => {
    let root: string;
    let workspaceRoot: string;
    let storeRoot: string;
    let feeds: ParcelWorkspaceChangeFeed[];
    let nativeBackendAvailable: boolean;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "crest-workspace-feed-native-"));
        const requestedWorkspaceRoot = join(root, "workspace");
        storeRoot = join(root, "store");
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
        if (!(await reconcileOrUnsupported(feed))) return;

        await writeFile(join(workspaceRoot, "create.txt"), "create");
        await writeFile(join(workspaceRoot, "update.txt"), "after");
        await unlink(join(workspaceRoot, "delete.txt"));
        await rename(join(workspaceRoot, "old.txt"), join(workspaceRoot, "new.txt"));

        const result = await feed.readChanges();
        assertComplete(result, ["create.txt", "delete.txt", "new.txt", "old.txt", "update.txt"]);
    });

    test("detects an offline change after dispose and reopen with the persisted cursor", async () => {
        const first = makeFeed();
        if (!(await reconcileOrUnsupported(first))) return;
        await first.dispose();
        await writeFile(join(workspaceRoot, "offline.txt"), "offline");

        const reopened = makeFeed();
        const result = await reopened.readChanges();

        assertComplete(result, ["offline.txt"]);
    });

    test("reports cursor deletion as a gap", async () => {
        const feed = makeFeed();
        if (!(await reconcileOrUnsupported(feed))) return;
        await unlink(join(storeRoot, "tracker", "committed.cursor"));

        await expect(feed.readChanges()).resolves.toEqual({ status: "gap", reason: "cursor-missing" });
    });

    test("coalesces one thousand writes to one changed path", async () => {
        const path = join(workspaceRoot, "hot.txt");
        await writeFile(path, "initial");
        const feed = makeFeed();
        if (!(await reconcileOrUnsupported(feed))) return;

        for (let index = 0; index < 1_000; index++) {
            await writeFile(path, String(index));
        }

        const result = await feed.readChanges();
        assertComplete(result, ["hot.txt"]);
    });

    function makeFeed(): ParcelWorkspaceChangeFeed {
        const feed = new ParcelWorkspaceChangeFeed({ workspaceRoot, storeRoot });
        feeds.push(feed);
        return feed;
    }

    async function reconcileOrUnsupported(feed: ParcelWorkspaceChangeFeed): Promise<boolean> {
        try {
            await reconcile(feed);
            return true;
        } catch (error) {
            if (nativeBackendAvailable) {
                await reconcile(feed);
                return true;
            }
            expect(error).toBeInstanceOf(Error);
            return false;
        }
    }
});

function assertComplete(result: WorkspaceChangeRead, expectedPaths: string[]): void {
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.changedPaths).toEqual(expectedPaths);
}

async function reconcile(feed: ParcelWorkspaceChangeFeed): Promise<void> {
    await feed.prepareForReconcile();
    await feed.initializeAfterReconcile();
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
