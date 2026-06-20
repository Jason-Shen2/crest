import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { LspWebSocketBridge, parseLspRequest } from "./lsp-websocket-server";

describe("parseLspRequest", () => {
    it("extracts language and workspace root", () => {
        expect(parseLspRequest("/lsp?language=typescript&workspaceRoot=%2Frepo")).toEqual({
            language: "typescript",
            workspaceRoot: "/repo",
        });
    });

    it("rejects missing language", () => {
        expect(() => parseLspRequest("/lsp?workspaceRoot=%2Frepo")).toThrow("Missing language");
    });
});

describe("LspWebSocketBridge", () => {
    it("forwards websocket messages to language server stdio and cleans up stdout listeners", async () => {
        const stdout = new EventEmitter();
        const child = {
            stdin: { write: vi.fn() },
            stdout,
        };
        const languageServerManager = {
            getOrStart: vi.fn(() => child),
            stopAll: vi.fn(),
        };
        const bridge = new LspWebSocketBridge({ languageServerManager: languageServerManager as any });
        const url = await bridge.start();
        const client = new WebSocket(`${url}/lsp?language=typescript&workspaceRoot=%2Frepo`);
        await new Promise<void>((resolve) => client.once("open", resolve));

        client.send("client-message");
        await vi.waitFor(() => {
            expect(child.stdin.write).toHaveBeenCalledTimes(1);
        });
        expect(child.stdin.write.mock.calls[0][0].toString()).toBe("client-message");

        const responsePromise = new Promise<string>((resolve) => {
            client.once("message", (data) => resolve(data.toString()));
        });
        stdout.emit("data", Buffer.from("server-message"));
        await expect(responsePromise).resolves.toBe("server-message");

        client.close();
        await vi.waitFor(() => {
            expect(stdout.listenerCount("data")).toBe(0);
        });
        await bridge.stop();
    });

    it("closes active websocket clients when the bridge stops", async () => {
        const child = {
            stdin: { write: vi.fn() },
            stdout: new EventEmitter(),
        };
        const languageServerManager = {
            getOrStart: vi.fn(() => child),
            stopAll: vi.fn(),
        };
        const bridge = new LspWebSocketBridge({ languageServerManager: languageServerManager as any });
        const url = await bridge.start();
        const client = new WebSocket(`${url}/lsp?language=typescript&workspaceRoot=%2Frepo`);
        await new Promise<void>((resolve) => client.once("open", resolve));

        let stopped = false;
        const stopPromise = bridge.stop().then(() => {
            stopped = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(stopped).toBe(true);
        expect(languageServerManager.stopAll).toHaveBeenCalledTimes(1);
        await stopPromise;
    });
});
