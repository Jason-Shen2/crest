// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { EMainQuitCoordinator } from "./emain-quit-coordinator";

describe("EMainQuitCoordinator", () => {
    it("coalesces before-quit while asking all windows and permits only approved re-entry", async () => {
        let resolveSecond: (allow: boolean) => void;
        let coordinator: EMainQuitCoordinator;
        const approved = { preventDefault: vi.fn() };
        let approvedResult = false;
        const app = {
            quit: vi.fn(() => {
                approvedResult = coordinator.beforeQuit(approved);
            }),
        };
        const windows = [
            { requestWorkspaceClose: vi.fn().mockResolvedValue(true) },
            { requestWorkspaceClose: vi.fn(() => new Promise<boolean>((resolve) => (resolveSecond = resolve))) },
        ];
        coordinator = new EMainQuitCoordinator(app, () => windows);
        const first = { preventDefault: vi.fn() };
        const second = { preventDefault: vi.fn() };
        coordinator.beforeQuit(first);
        coordinator.beforeQuit(second);
        expect(first.preventDefault).toHaveBeenCalled();
        expect(second.preventDefault).toHaveBeenCalled();
        resolveSecond!(true);
        await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
        expect(approvedResult).toBe(true);
        expect(approved.preventDefault).not.toHaveBeenCalled();
    });

    it("clears inflight after cancel so a later attempt can ask again", async () => {
        const app = { quit: vi.fn() };
        const window = { requestWorkspaceClose: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) };
        const coordinator = new EMainQuitCoordinator(app, () => [window]);
        coordinator.beforeQuit({ preventDefault: vi.fn() });
        await vi.waitFor(() => expect(window.requestWorkspaceClose).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(coordinator.inflight).toBeUndefined());
        coordinator.beforeQuit({ preventDefault: vi.fn() });
        await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    });

    it("runs relaunch only after every dirty workspace allows it", async () => {
        const action = vi.fn();
        const vetoed = new EMainQuitCoordinator({ quit: vi.fn() }, () => [
            { requestWorkspaceClose: vi.fn().mockResolvedValue(false) },
        ]);
        await expect(vetoed.guardAction("quit", action)).resolves.toBe(false);
        expect(action).not.toHaveBeenCalled();

        const allowed = new EMainQuitCoordinator({ quit: vi.fn() }, () => [
            { requestWorkspaceClose: vi.fn().mockResolvedValue(true) },
        ]);
        await expect(allowed.guardAction("quit", action)).resolves.toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });

    it("allows exactly one approved quit re-entry without a second request", async () => {
        const requestWorkspaceClose = vi.fn().mockResolvedValue(true);
        let coordinator: EMainQuitCoordinator;
        let approvedResult = false;
        const app = {
            quit: vi.fn(() => {
                approvedResult = coordinator.beforeQuit({ preventDefault: vi.fn() });
            }),
        };
        coordinator = new EMainQuitCoordinator(app, () => [{ requestWorkspaceClose }]);
        coordinator.beforeQuit({ preventDefault: vi.fn() });
        await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());

        expect(approvedResult).toBe(true);
        expect(requestWorkspaceClose).toHaveBeenCalledOnce();
        expect(coordinator.beforeQuit({ preventDefault: vi.fn() })).toBe(false);
        await vi.waitFor(() => expect(requestWorkspaceClose).toHaveBeenCalledTimes(2));
    });

    it("rolls back every prepared window when another window vetoes", async () => {
        const first = {
            requestWorkspaceClose: vi.fn().mockResolvedValue(true),
            finalizeWorkspaceClose: vi.fn(),
        };
        const second = {
            requestWorkspaceClose: vi.fn().mockResolvedValue(false),
            finalizeWorkspaceClose: vi.fn(),
        };
        const coordinator = new EMainQuitCoordinator({ quit: vi.fn() }, () => [first, second]);
        await expect(coordinator.guardAction("quit", vi.fn())).resolves.toBe(false);
        expect(first.finalizeWorkspaceClose).toHaveBeenCalledWith(false);
        expect(second.finalizeWorkspaceClose).toHaveBeenCalledWith(false);
    });

    it("rolls back prepared windows when the outer action fails and commits when it succeeds", async () => {
        const window = {
            requestWorkspaceClose: vi.fn().mockResolvedValue(true),
            finalizeWorkspaceClose: vi.fn(),
        };
        const coordinator = new EMainQuitCoordinator({ quit: vi.fn() }, () => [window]);
        await expect(
            coordinator.guardAction("quit", vi.fn().mockRejectedValue(new Error("outer confirmation cancelled")))
        ).resolves.toBe(false);
        expect(window.finalizeWorkspaceClose).toHaveBeenLastCalledWith(false);

        await expect(coordinator.guardAction("quit", vi.fn())).resolves.toBe(true);
        expect(window.finalizeWorkspaceClose).toHaveBeenLastCalledWith(true);
    });

    it("rejects a concurrent guarded action without running or bypassing it", async () => {
        let finishPrepare: (allow: boolean) => void;
        const window = {
            requestWorkspaceClose: vi.fn(() => new Promise<boolean>((resolve) => (finishPrepare = resolve))),
            finalizeWorkspaceClose: vi.fn(),
        };
        const coordinator = new EMainQuitCoordinator({ quit: vi.fn() }, () => [window]);
        const firstAction = vi.fn();
        const secondAction = vi.fn();
        const first = coordinator.guardAction("quit", firstAction);
        await vi.waitFor(() => expect(window.requestWorkspaceClose).toHaveBeenCalledOnce());
        await expect(coordinator.guardAction("quit", secondAction)).resolves.toBe(false);
        expect(secondAction).not.toHaveBeenCalled();
        finishPrepare!(true);
        await expect(first).resolves.toBe(true);
        expect(firstAction).toHaveBeenCalledOnce();
    });

    it("does not expose the approved re-entry token while an async action is waiting", async () => {
        let finishAction: () => void;
        const requestWorkspaceClose = vi.fn().mockResolvedValue(true);
        const coordinator = new EMainQuitCoordinator({ quit: vi.fn() }, () => [{ requestWorkspaceClose }]);
        const guarded = coordinator.guardAction(
            "quit",
            () => new Promise<void>((resolve) => (finishAction = resolve)),
            true
        );
        await vi.waitFor(() => expect(requestWorkspaceClose).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(finishAction).toBeTypeOf("function"));
        const unrelated = { preventDefault: vi.fn() };
        expect(coordinator.beforeQuit(unrelated)).toBe(false);
        expect(unrelated.preventDefault).toHaveBeenCalledOnce();
        finishAction!();
        await expect(guarded).resolves.toBe(true);
    });
});
