import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { StreamMessageWriter } from "vscode-jsonrpc/node";
import type { RequestMessage, ResponseMessage } from "vscode-jsonrpc";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { LspWebSocketBridge, parseLspRequest } from "./lsp-websocket-server";

function makeStreamChild() {
    return Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        kill: vi.fn(),
    });
}

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
        const child = makeStreamChild();
        const stdin = child.stdin;
        const stdout = child.stdout;
        let stdioPayload = "";
        stdin.on("data", (data) => {
            stdioPayload += data.toString();
        });
        const languageServerManager = {
            startSession: vi.fn(() => child),
            stopAll: vi.fn(),
        };
        const bridge = new LspWebSocketBridge({ languageServerManager: languageServerManager as any });
        const url = await bridge.start();
        const client = new WebSocket(`${url}/lsp?language=typescript&workspaceRoot=%2Frepo`);
        await new Promise<void>((resolve) => client.once("open", resolve));

        const initializeMessage: RequestMessage = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
        client.send(JSON.stringify(initializeMessage));
        await vi.waitFor(() => {
            expect(stdioPayload).toContain("Content-Length:");
        });
        expect(stdioPayload).toContain('"method":"initialize"');

        const responsePromise = new Promise<string>((resolve) => {
            client.once("message", (data) => resolve(data.toString()));
        });
        const initializeResponse: ResponseMessage = { jsonrpc: "2.0", id: 1, result: { capabilities: {} } };
        await new StreamMessageWriter(stdout).write(initializeResponse);
        await expect(responsePromise).resolves.toBe('{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}');

        client.close();
        await vi.waitFor(() => {
            expect(stdout.listenerCount("data")).toBe(0);
        });
        await bridge.stop();
    });

    it("closes active websocket clients when the bridge stops", async () => {
        const child = makeStreamChild();
        const languageServerManager = {
            startSession: vi.fn(() => child),
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
        expect(child.kill).toHaveBeenCalledTimes(1);
        await stopPromise;
    });

    it("starts a separate language server session for each websocket client", async () => {
        const firstChild = makeStreamChild();
        const secondChild = makeStreamChild();
        const reusedChild = makeStreamChild();
        const languageServerManager = {
            getOrStart: vi.fn(() => reusedChild),
            startSession: vi.fn().mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild),
            stopAll: vi.fn(),
        };
        const bridge = new LspWebSocketBridge({ languageServerManager: languageServerManager as any });
        const url = await bridge.start();
        const firstClient = new WebSocket(`${url}/lsp?language=typescript&workspaceRoot=%2Frepo`);
        const secondClient = new WebSocket(`${url}/lsp?language=typescript&workspaceRoot=%2Frepo`);
        await Promise.all([
            new Promise<void>((resolve) => firstClient.once("open", resolve)),
            new Promise<void>((resolve) => secondClient.once("open", resolve)),
        ]);

        expect(languageServerManager.startSession).toHaveBeenCalledTimes(2);
        expect(languageServerManager.getOrStart).not.toHaveBeenCalled();
        expect(firstChild.stdout.listenerCount("data")).toBe(1);
        expect(secondChild.stdout.listenerCount("data")).toBe(1);
        expect(reusedChild.stdout.listenerCount("data")).toBe(0);

        firstClient.close();
        secondClient.close();
        await bridge.stop();
    });

    it("closes and cleans up the websocket when the language server exits", async () => {
        const child = makeStreamChild();
        const languageServerManager = {
            startSession: vi.fn(() => child),
        };
        const bridge = new LspWebSocketBridge({ languageServerManager: languageServerManager as any });
        const url = await bridge.start();
        const client = new WebSocket(`${url}/lsp?language=typescript&workspaceRoot=%2Frepo`);
        await new Promise<void>((resolve) => client.once("open", resolve));

        child.emit("exit", 0, null);

        await vi.waitFor(() => {
            expect(client.readyState).toBe(WebSocket.CLOSED);
            expect(child.stdout.listenerCount("data")).toBe(0);
        });
        expect(child.kill).not.toHaveBeenCalled();
        await bridge.stop();
    });

    it("closes and cleans up the websocket when the language server errors", async () => {
        const child = makeStreamChild();
        const languageServerManager = {
            startSession: vi.fn(() => child),
        };
        const bridge = new LspWebSocketBridge({ languageServerManager: languageServerManager as any });
        const url = await bridge.start();
        const client = new WebSocket(`${url}/lsp?language=typescript&workspaceRoot=%2Frepo`);
        await new Promise<void>((resolve) => client.once("open", resolve));

        child.emit("error", new Error("ls failed"));

        await vi.waitFor(() => {
            expect(client.readyState).toBe(WebSocket.CLOSED);
            expect(child.stdout.listenerCount("data")).toBe(0);
        });
        expect(child.kill).not.toHaveBeenCalled();
        await bridge.stop();
    });
});
