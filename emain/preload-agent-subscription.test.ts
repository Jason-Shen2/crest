// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
    const exposed = new Map<string, unknown>();
    return {
        exposed,
        invoke: vi.fn(),
        on: vi.fn(),
        send: vi.fn(),
    };
});

vi.mock("electron", () => ({
    contextBridge: {
        exposeInMainWorld: (name: string, value: unknown) => electron.exposed.set(name, value),
    },
    ipcRenderer: {
        invoke: electron.invoke,
        on: electron.on,
        send: electron.send,
        removeListener: vi.fn(),
    },
    Rectangle: class {},
    WebviewTag: class {},
    webUtils: { getPathForFile: vi.fn(() => "") },
}));

beforeAll(async () => {
    await import("./preload");
});

afterEach(() => {
    electron.invoke.mockReset();
    vi.restoreAllMocks();
});

describe("agent preload subscription", () => {
    it("reports an initial subscribe rejection to every current renderer subscriber", async () => {
        const failure = new Error("subscription rejected");
        let rejectSubscribe!: (error: unknown) => void;
        const subscribe = new Promise<unknown>((_resolve, reject) => {
            rejectSubscribe = reject;
        });
        electron.invoke.mockImplementation((channel: string) => {
            if (channel === "agent:subscribe") return subscribe;
            return Promise.resolve();
        });
        const api = electron.exposed.get("api") as ElectronApi;
        const onErrorA = vi.fn();
        const onErrorB = vi.fn();
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

        const unsubscribeA = api.agent.subscribe(
            { workspaceId: "workspace-1", generation: 1 },
            "/sessions/a.db",
            vi.fn(),
            onErrorA
        );
        const unsubscribeB = api.agent.subscribe(
            { workspaceId: "workspace-1", generation: 1 },
            "/sessions/a.db",
            vi.fn(),
            onErrorB
        );
        rejectSubscribe(failure);

        await vi.waitFor(() => expect(onErrorA).toHaveBeenCalledWith(failure));
        expect(onErrorB).toHaveBeenCalledWith(failure);
        expect(electron.invoke).toHaveBeenCalledTimes(1);

        unsubscribeA();
        unsubscribeB();
        consoleError.mockRestore();
    });
});
