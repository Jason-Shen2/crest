// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { notifyAppNotificationSystem, routeAppNotification } from "./notification-router";
import type { AppNotification } from "./notifications-model";

const mockRpc = vi.hoisted(() => ({
    NotifyCommand: vi.fn(),
}));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: mockRpc,
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: { routeid: "tab" },
}));

function makeNotification(patch: Partial<AppNotification> = {}): AppNotification {
    return {
        id: "note-1",
        source: "agent-cli",
        kind: "completed",
        agentName: "Claude Code",
        blockId: "block-a",
        tabId: "tab-a",
        title: "Claude Code",
        body: "Claude Code task finished",
        ts: 1,
        read: false,
        ...patch,
    };
}

describe("routeAppNotification", () => {
    beforeEach(() => {
        mockRpc.NotifyCommand.mockReset();
        mockRpc.NotifyCommand.mockResolvedValue(undefined);
    });

    it("stays silent when the notification target is already visible in the focused window", () => {
        const pushToast = vi.fn();
        const notifySystem = vi.fn();

        const delivery = routeAppNotification(makeNotification(), {
            focused: true,
            visible: true,
            pushToast,
            notifySystem,
        });

        expect(delivery).toBe("silent");
        expect(pushToast).not.toHaveBeenCalled();
        expect(notifySystem).not.toHaveBeenCalled();
    });

    it("shows an in-app toast when the app is focused but the target is hidden", () => {
        const note = makeNotification();
        const pushToast = vi.fn();
        const notifySystem = vi.fn();

        const delivery = routeAppNotification(note, {
            focused: true,
            visible: false,
            pushToast,
            notifySystem,
        });

        expect(delivery).toBe("toast");
        expect(pushToast).toHaveBeenCalledWith(note);
        expect(notifySystem).not.toHaveBeenCalled();
    });

    it("uses an OS notification when the app is unfocused", () => {
        const note = makeNotification();
        const pushToast = vi.fn();
        const notifySystem = vi.fn();

        const delivery = routeAppNotification(note, {
            focused: false,
            visible: true,
            pushToast,
            notifySystem,
        });

        expect(delivery).toBe("system");
        expect(pushToast).not.toHaveBeenCalled();
        expect(notifySystem).toHaveBeenCalledWith(note);
    });

    it("maps notification content to the Electron notify RPC", async () => {
        const note = makeNotification({
            title: "Claude Code",
            body: "Review is ready",
        });

        await notifyAppNotificationSystem(note);

        expect(mockRpc.NotifyCommand).toHaveBeenCalledWith(
            { routeid: "tab" },
            {
                title: "Claude Code",
                body: "Review is ready",
                silent: false,
            },
            { timeout: 2000 }
        );
    });
});
