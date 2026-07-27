// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { WorkspaceInitCoordinator } from "./workspace-init-coordinator";

function deferred() {
    let resolve: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe("WorkspaceInitCoordinator", () => {
    it("serializes initialization and lets only the latest generation commit", async () => {
        const coordinator = new WorkspaceInitCoordinator();
        const slow = deferred();
        const started = deferred();
        const commits: string[] = [];
        const first = coordinator.run({ workspaceId: "workspace-1", generation: 1 }, async (isCurrent) => {
            started.resolve();
            await slow.promise;
            if (isCurrent()) {
                commits.push("workspace-1");
            }
        });
        await started.promise;
        const second = coordinator.run({ workspaceId: "workspace-2", generation: 2 }, async (isCurrent) => {
            if (isCurrent()) {
                commits.push("workspace-2");
            }
        });

        await Promise.resolve();
        expect(commits).toEqual([]);
        slow.resolve();
        await Promise.all([first, second]);

        expect(commits).toEqual(["workspace-2"]);
    });

    it("rejects an older generation delivered after a newer one", async () => {
        const coordinator = new WorkspaceInitCoordinator();
        const commits: string[] = [];

        await coordinator.run({ workspaceId: "workspace-2", generation: 2 }, async (isCurrent) => {
            if (isCurrent()) {
                commits.push("workspace-2");
            }
        });
        await coordinator.run({ workspaceId: "workspace-1", generation: 1 }, async (isCurrent) => {
            if (isCurrent()) {
                commits.push("workspace-1");
            }
        });

        expect(commits).toEqual(["workspace-2"]);
    });

    it("allows the current generation to retry after a rejected initialization", async () => {
        const coordinator = new WorkspaceInitCoordinator();
        const identity = { workspaceId: "workspace-1", generation: 1 };
        const commits: string[] = [];

        await expect(
            coordinator.run(identity, async () => {
                throw new Error("transient load failure");
            })
        ).rejects.toThrow("transient load failure");
        await coordinator.run(identity, async (isCurrent) => {
            if (isCurrent()) {
                commits.push("workspace-1");
            }
        });

        expect(commits).toEqual(["workspace-1"]);
    });
});
