import { PassThrough } from "node:stream";
import { StreamMessageWriter } from "vscode-jsonrpc/node";
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
    it("translates websocket JSON messages to LSP stdio framing and cleans up stdout listeners", async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        let stdioPayload = "";
        stdin.on("data", (data) => {
            stdioPayload += data.toString();
        });
        const child = {
            stdin,
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

        client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
        await vi.waitFor(() => {
            expect(stdioPayload).toContain("Content-Length:");
        });
        expect(stdioPayload).toContain('"method":"initialize"');

        const responsePromise = new Promise<string>((resolve) => {
            client.once("message", (data) => resolve(data.toString()));
        });
        await new StreamMessageWriter(stdout).write({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
        await expect(responsePromise).resolves.toBe('{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}');

        client.close();
        await vi.waitFor(() => {
            expect(stdout.listenerCount("data")).toBe(0);
        });
        await bridge.stop();
    });

    it("closes active websocket clients when the bridge stops", async () => {
        const child = {
            stdin: new PassThrough(),
            stdout: new PassThrough(),
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
