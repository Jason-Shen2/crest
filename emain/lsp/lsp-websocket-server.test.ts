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
    it("extracts server id, language, and workspace root", () => {
        expect(
            parseLspRequest("/lsp?language=typescript&workspaceRoot=%2Frepo&serverId=typescript-language-server")
        ).toEqual({
            language: "typescript",
            workspaceRoot: "/repo",
            serverId: "typescript-language-server",
        });
    });

    it("rejects missing language", () => {
        expect(() => parseLspRequest("/lsp?workspaceRoot=%2Frepo&serverId=typescript-language-server")).toThrow(
            "Missing language"
        );
    });

    it("rejects missing server id", () => {
        expect(() => parseLspRequest("/lsp?language=typescript&workspaceRoot=%2Frepo")).toThrow("Missing serverId");
    });

    it("rejects requests outside the /lsp endpoint", () => {
        expect(() =>
            parseLspRequest("/bad?language=typescript&workspaceRoot=%2Frepo&serverId=typescript-language-server")
        ).toThrow("Invalid LSP endpoint");
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
            acquire: vi.fn(() => child),
            release: vi.fn(),
        };
        const bridge = new LspWebSocketBridge({ languageServerManager: languageServerManager as any });
        const url = await bridge.start();
        const client = new WebSocket(
            `${url}/lsp?language=typescript&workspaceRoot=%2Frepo&serverId=typescript-language-server`
        );
        await new Promise<void>((resolve) => client.once("open", resolve));

        expect(languageServerManager.acquire).toHaveBeenCalledWith({
            language: "typescript",
            workspaceRoot: "/repo",
            serverId: "typescript-language-server",
        });

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
        expect(languageServerManager.release).toHaveBeenCalledWith({
            language: "typescript",
            workspaceRoot: "/repo",
            serverId: "typescript-language-server",
        });
        await bridge.stop();
    });

    it("closes active websocket clients when the bridge stops", async () => {
        const child = makeStreamChild();
        const languageServerManager = {
            acquire: vi.fn(() => child),
            release: vi.fn(),
        };
        const bridge = new LspWebSocketBridge({ languageServerManager: languageServerManager as any });
        const url = await bridge.start();
        const client = new WebSocket(
            `${url}/lsp?language=typescript&workspaceRoot=%2Frepo&serverId=typescript-language-server`
        );
        await new Promise<void>((resolve) => client.once("open", resolve));

        let stopped = false;
        const stopPromise = bridge.stop().then(() => {
            stopped = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(stopped).toBe(true);
        expect(languageServerManager.release).toHaveBeenCalledTimes(1);
        expect(child.kill).not.toHaveBeenCalled();
        await stopPromise;
    });

    it("rejects a duplicate active websocket session for the same workspace root and server id", async () => {
        const child = makeStreamChild();
        const languageServerManager = {
            acquire: vi.fn(() => child),
            release: vi.fn(),
        };
        const bridge = new LspWebSocketBridge({ languageServerManager: languageServerManager as any });
        const url = await bridge.start();
        const firstClient = new WebSocket(
            `${url}/lsp?language=typescript&workspaceRoot=%2Frepo&serverId=typescript-language-server`
        );
        const secondClient = new WebSocket(
            `${url}/lsp?language=typescript&workspaceRoot=%2Frepo&serverId=typescript-language-server`
        );
        const duplicateClose = new Promise<{ code: number; reason: string }>((resolve) => {
            secondClient.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
        });
        await Promise.all([
            new Promise<void>((resolve) => firstClient.once("open", resolve)),
            new Promise<void>((resolve) => secondClient.once("open", resolve)),
        ]);

        await expect(duplicateClose).resolves.toEqual({
            code: 1008,
            reason: "LSP session already active for workspaceRoot and serverId",
        });
        expect(languageServerManager.acquire).toHaveBeenCalledTimes(1);
        expect(child.stdout.listenerCount("data")).toBe(1);

        firstClient.close();
        await vi.waitFor(() => {
            expect(languageServerManager.release).toHaveBeenCalledTimes(1);
        });
        await bridge.stop();
    });

    it("allows a new websocket session after the previous matching session closes", async () => {
        const child = makeStreamChild();
        const languageServerManager = {
            acquire: vi.fn(() => child),
            release: vi.fn(),
        };
        const bridge = new LspWebSocketBridge({ languageServerManager: languageServerManager as any });
        const url = await bridge.start();
        const firstClient = new WebSocket(
            `${url}/lsp?language=typescript&workspaceRoot=%2Frepo&serverId=typescript-language-server`
        );
        await new Promise<void>((resolve) => firstClient.once("open", resolve));

        firstClient.close();
        await vi.waitFor(() => {
            expect(languageServerManager.release).toHaveBeenCalledTimes(1);
        });

        const secondClient = new WebSocket(
            `${url}/lsp?language=typescript&workspaceRoot=%2Frepo&serverId=typescript-language-server`
        );
        await new Promise<void>((resolve) => secondClient.once("open", resolve));

        expect(languageServerManager.acquire).toHaveBeenCalledTimes(2);
        secondClient.close();
        await bridge.stop();
    });

    it("closes and cleans up the websocket when the language server exits", async () => {
        const child = makeStreamChild();
        const languageServerManager = {
            acquire: vi.fn(() => child),
            release: vi.fn(),
        };
        const bridge = new LspWebSocketBridge({ languageServerManager: languageServerManager as any });
        const url = await bridge.start();
        const client = new WebSocket(
            `${url}/lsp?language=typescript&workspaceRoot=%2Frepo&serverId=typescript-language-server`
        );
        await new Promise<void>((resolve) => client.once("open", resolve));

        child.emit("exit", 0, null);

        await vi.waitFor(() => {
            expect(client.readyState).toBe(WebSocket.CLOSED);
            expect(child.stdout.listenerCount("data")).toBe(0);
        });
        expect(child.kill).not.toHaveBeenCalled();
        expect(languageServerManager.release).toHaveBeenCalledTimes(1);
        await bridge.stop();
    });

    it("closes and cleans up the websocket when the language server errors", async () => {
        const child = makeStreamChild();
        const languageServerManager = {
            acquire: vi.fn(() => child),
            release: vi.fn(),
        };
        const bridge = new LspWebSocketBridge({ languageServerManager: languageServerManager as any });
        const url = await bridge.start();
        const client = new WebSocket(
            `${url}/lsp?language=typescript&workspaceRoot=%2Frepo&serverId=typescript-language-server`
        );
        await new Promise<void>((resolve) => client.once("open", resolve));

        child.emit("error", new Error("ls failed"));

        await vi.waitFor(() => {
            expect(client.readyState).toBe(WebSocket.CLOSED);
            expect(child.stdout.listenerCount("data")).toBe(0);
        });
        expect(child.kill).not.toHaveBeenCalled();
        expect(languageServerManager.release).toHaveBeenCalledTimes(1);
        await bridge.stop();
    });

    it("rejects invalid endpoint paths without starting a language server session", async () => {
        const languageServerManager = {
            acquire: vi.fn(),
            release: vi.fn(),
        };
        const bridge = new LspWebSocketBridge({ languageServerManager: languageServerManager as any });
        const url = await bridge.start();
        const client = new WebSocket(
            `${url}/bad?language=typescript&workspaceRoot=%2Frepo&serverId=typescript-language-server`
        );
        await new Promise<void>((resolve) => client.once("open", resolve));

        await vi.waitFor(() => {
            expect(client.readyState).toBe(WebSocket.CLOSED);
        });
        expect(languageServerManager.acquire).not.toHaveBeenCalled();
        expect(languageServerManager.release).not.toHaveBeenCalled();
        await bridge.stop();
    });
});
