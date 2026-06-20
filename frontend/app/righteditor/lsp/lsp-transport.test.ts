import { afterEach, describe, expect, it, vi } from "vitest";
import { createLspWebSocketTransport } from "./lsp-transport";

type MockWebSocketEventHandler = (() => void) | null;

class MockWebSocket {
    static instances: MockWebSocket[] = [];
    onopen: MockWebSocketEventHandler = null;
    onerror: MockWebSocketEventHandler = null;
    close = vi.fn();

    constructor(readonly url: string) {
        MockWebSocket.instances.push(this);
    }

    open(): void {
        this.onopen?.();
    }

    error(): void {
        this.onerror?.();
    }
}

function installRuntime(endpoint?: string): void {
    vi.stubGlobal("window", {
        waveRuntime: {
            lspWebSocketUrl: endpoint,
        },
    });
}

describe("createLspWebSocketTransport", () => {
    afterEach(() => {
        MockWebSocket.instances = [];
        vi.unstubAllGlobals();
    });

    it("requires a runtime LSP WebSocket endpoint", async () => {
        installRuntime();
        vi.stubGlobal("WebSocket", MockWebSocket);

        await expect(
            createLspWebSocketTransport({ workspaceRoot: "/repo", language: "typescript" })
        ).rejects.toThrow("LSP WebSocket URL is not available");
        expect(MockWebSocket.instances).toHaveLength(0);
    });

    it("resolves only after the WebSocket opens", async () => {
        installRuntime("ws://127.0.0.1:9010");
        vi.stubGlobal("WebSocket", MockWebSocket);

        let settled = false;
        const transportPromise = createLspWebSocketTransport({
            workspaceRoot: "/repo",
            language: "typescript",
        }).then((transport) => {
            settled = true;
            return transport;
        });
        await Promise.resolve();

        expect(settled).toBe(false);
        expect(MockWebSocket.instances[0].url).toBe(
            "ws://127.0.0.1:9010/lsp?workspaceRoot=%2Frepo&language=typescript"
        );

        MockWebSocket.instances[0].open();
        const transport = await transportPromise;
        transport.dispose();

        expect(MockWebSocket.instances[0].close).toHaveBeenCalledTimes(1);
    });

    it("rejects when the WebSocket errors before opening", async () => {
        installRuntime("ws://127.0.0.1:9010");
        vi.stubGlobal("WebSocket", MockWebSocket);

        const transportPromise = createLspWebSocketTransport({
            workspaceRoot: "/repo",
            language: "typescript",
        });
        MockWebSocket.instances[0].error();

        await expect(transportPromise).rejects.toThrow("Failed to connect to LSP WebSocket");
    });
});
