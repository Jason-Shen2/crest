// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { runWorkspaceSwitchTransaction } from "./emain-workspace-switch-transaction";

function makeHarness() {
    const calls: string[] = [];
    let backendWorkspaceId = "old";
    return {
        calls,
        get backendWorkspaceId() {
            return backendWorkspaceId;
        },
        options: {
            oldWorkspaceId: "old",
            newWorkspaceId: "new",
            switchBackend: vi.fn(async (workspaceId: string) => {
                calls.push(`backend:${workspaceId}`);
                backendWorkspaceId = workspaceId;
                return true;
            }),
            getBackendWorkspaceId: vi.fn(async () => {
                calls.push(`authority:${backendWorkspaceId}`);
                return backendWorkspaceId;
            }),
            initialize: vi.fn(async (workspaceId: string) => {
                calls.push(`init:${workspaceId}`);
                return true;
            }),
            commitOldView: vi.fn(() => calls.push("destroy-old")),
            finalizePreparedClose: vi.fn((commit: boolean) => {
                calls.push(`finalize:${commit}`);
                return true;
            }),
            enterFatal: vi.fn((_: unknown, workspaceId?: string) => calls.push(`fatal:${workspaceId ?? "unknown"}`)),
        },
    };
}

describe("workspace switch transaction", () => {
    it("restores backend, old renderer, and dirty close preparation after post-switch init failure", async () => {
        const harness = makeHarness();
        harness.options.initialize
            .mockImplementationOnce(async (workspaceId) => {
                harness.calls.push(`init:${workspaceId}`);
                return false;
            })
            .mockImplementationOnce(async (workspaceId) => {
                harness.calls.push(`init:${workspaceId}`);
                return true;
            });

        await expect(runWorkspaceSwitchTransaction(harness.options)).resolves.toEqual({
            status: "rolled-back",
            workspaceId: "old",
        });

        expect(harness.calls).toEqual([
            "backend:new",
            "init:new",
            "authority:new",
            "backend:old",
            "authority:old",
            "init:old",
            "finalize:false",
        ]);
        expect(harness.options.commitOldView).not.toHaveBeenCalled();
    });

    it("destroys old views and commits prepared close only after new initialization succeeds", async () => {
        const harness = makeHarness();

        await expect(runWorkspaceSwitchTransaction(harness.options)).resolves.toEqual({
            status: "committed",
            workspaceId: "new",
        });

        expect(harness.calls).toEqual(["backend:new", "init:new", "finalize:true", "destroy-old"]);
    });

    it.each(["reject", "throw"] as const)(
        "keeps authoritative new identity when backend rollback %s and new renderer recovery succeeds",
        async (failure) => {
            const harness = makeHarness();
            harness.options.initialize.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
            harness.options.switchBackend.mockImplementationOnce(async (workspaceId) => {
                harness.calls.push(`backend:${workspaceId}`);
                return true;
            });
            harness.options.switchBackend.mockImplementationOnce(async (workspaceId) => {
                harness.calls.push(`backend:${workspaceId}`);
                if (failure === "throw") throw new Error("rollback failed");
                return false;
            });
            harness.options.getBackendWorkspaceId.mockResolvedValue("new");

            await expect(runWorkspaceSwitchTransaction(harness.options)).resolves.toEqual({
                status: "recovered-new",
                workspaceId: "new",
            });

            expect(harness.options.initialize).toHaveBeenLastCalledWith("new");
            expect(harness.options.finalizePreparedClose).toHaveBeenCalledWith(true);
            expect(harness.options.enterFatal).not.toHaveBeenCalled();
        }
    );

    it("enters fatal state without claiming old identity when rollback and authoritative new init both fail", async () => {
        const harness = makeHarness();
        harness.options.initialize.mockResolvedValue(false);
        harness.options.switchBackend
            .mockImplementationOnce(async () => true)
            .mockRejectedValueOnce(new Error("rollback failed"));
        harness.options.getBackendWorkspaceId.mockResolvedValue("new");

        const result = await runWorkspaceSwitchTransaction(harness.options);

        expect(result).toMatchObject({ status: "fatal", workspaceId: "new" });
        expect(harness.options.initialize).toHaveBeenLastCalledWith("new");
        expect(harness.options.finalizePreparedClose).toHaveBeenCalledWith(false);
        expect(harness.options.enterFatal).toHaveBeenCalledWith(expect.any(AggregateError), "new");
        expect(harness.options.commitOldView).not.toHaveBeenCalled();
    });

    it("enters fatal state instead of claiming rollback when dirty-state rollback cannot be delivered", async () => {
        const harness = makeHarness();
        harness.options.initialize.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        harness.options.finalizePreparedClose.mockReturnValue(false);

        const result = await runWorkspaceSwitchTransaction(harness.options);

        expect(result).toMatchObject({ status: "fatal", workspaceId: "old" });
        expect(harness.options.enterFatal).toHaveBeenCalledWith(expect.any(AggregateError), "old");
        expect(harness.options.commitOldView).not.toHaveBeenCalled();
    });

    it("does not retain fatal transaction state and permits a later switch to succeed", async () => {
        const failed = makeHarness();
        failed.options.initialize.mockResolvedValue(false);
        failed.options.switchBackend.mockImplementationOnce(async () => true).mockResolvedValueOnce(false);
        failed.options.getBackendWorkspaceId.mockResolvedValue("new");
        await runWorkspaceSwitchTransaction(failed.options);

        const retry = makeHarness();
        await expect(runWorkspaceSwitchTransaction(retry.options)).resolves.toMatchObject({ status: "committed" });
        expect(retry.options.finalizePreparedClose).toHaveBeenCalledWith(true);
    });
});
