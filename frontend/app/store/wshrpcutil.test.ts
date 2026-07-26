// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, test, vi } from "vitest";
import { TabClient } from "./tabrpcclient";
import { WshClient } from "./wshclient";

const mocks = vi.hoisted(() => ({
    registerRoute: vi.fn(),
    unregisterRoute: vi.fn(),
    setWpsRpcClient: vi.fn(),
    reconnectHandlers: [] as Array<() => void>,
    removedReconnectHandlers: [] as Array<() => void>,
    shutdown: vi.fn(),
    pushMessage: vi.fn(),
}));

vi.mock("./ws", () => ({
    addWSReconnectHandler: vi.fn((handler: () => void) => mocks.reconnectHandlers.push(handler)),
    removeWSReconnectHandler: vi.fn((handler: () => void) => {
        mocks.removedReconnectHandlers.push(handler);
        const index = mocks.reconnectHandlers.indexOf(handler);
        if (index >= 0) {
            mocks.reconnectHandlers.splice(index, 1);
        }
    }),
    globalWS: {
        connectNow: vi.fn(),
        pushMessage: mocks.pushMessage,
        shutdown: mocks.shutdown,
    },
    initGlobalWS: vi.fn(),
}));

vi.mock("./wps", () => ({
    setWpsRpcClient: mocks.setWpsRpcClient,
    wpsReconnectHandler: vi.fn(),
}));

vi.mock("./wshrpcutil-base", () => ({
    DefaultRouter: {
        reannounceRoutes: vi.fn(),
        recvRpcMessage: vi.fn(),
        registerRoute: mocks.registerRoute,
        unregisterRoute: mocks.unregisterRoute,
    },
    setDefaultRouter: vi.fn(),
}));

import { initWshrpc, RendererRpcClient, shutdownRendererWshrpc, TabRpcClient } from "./wshrpcutil";

describe("renderer RPC client initialization", () => {
    beforeEach(() => {
        shutdownRendererWshrpc();
        vi.clearAllMocks();
        mocks.reconnectHandlers.length = 0;
        mocks.removedReconnectHandlers.length = 0;
    });

    test("default initialization registers a TabClient and keeps the alias live", () => {
        initWshrpc("tab:tab-1");

        expect(RendererRpcClient).toBeInstanceOf(TabClient);
        expect(TabRpcClient).toBe(RendererRpcClient);
        expect(mocks.registerRoute).toHaveBeenCalledWith("tab:tab-1", RendererRpcClient);
        expect(mocks.setWpsRpcClient).toHaveBeenCalledWith(RendererRpcClient);
    });

    test("workspace factory registers a base WshClient and updates both live bindings", () => {
        initWshrpc("workspace:workspace-1", (routeId) => new WshClient(routeId));

        expect(RendererRpcClient).toBeInstanceOf(WshClient);
        expect(RendererRpcClient).not.toBeInstanceOf(TabClient);
        expect(RendererRpcClient.routeId).toBe("workspace:workspace-1");
        expect(TabRpcClient).toBe(RendererRpcClient);
        expect(mocks.registerRoute).toHaveBeenCalledWith("workspace:workspace-1", RendererRpcClient);
    });

    test("tears down the prior route, connection, and reconnect handlers before rebinding", () => {
        initWshrpc("workspace:workspace-1", (routeId) => new WshClient(routeId));
        const firstHandlers = [...mocks.reconnectHandlers];

        initWshrpc("workspace:workspace-2", (routeId) => new WshClient(routeId));

        expect(mocks.pushMessage).toHaveBeenCalledWith({
            wscommand: "rpc",
            message: expect.objectContaining({
                command: "routeunannounce",
                data: "workspace:workspace-1",
            }),
        });
        expect(mocks.shutdown).toHaveBeenCalledOnce();
        expect(mocks.reconnectHandlers).toHaveLength(2);
        expect(mocks.reconnectHandlers).not.toContain(firstHandlers[0]);
        expect(mocks.removedReconnectHandlers).toEqual(expect.arrayContaining(firstHandlers));
        expect(RendererRpcClient.routeId).toBe("workspace:workspace-2");
    });
});
