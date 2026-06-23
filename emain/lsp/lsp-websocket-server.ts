// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AddressInfo } from "node:net";
import { StreamMessageReader, StreamMessageWriter, type Disposable } from "vscode-jsonrpc/node";
import { type IWebSocket, WebSocketMessageReader, WebSocketMessageWriter } from "vscode-ws-jsonrpc";
import { WebSocket, WebSocketServer } from "ws";
import { LanguageServerManager } from "./language-server-manager";

export type ParsedLspRequest = {
    language: string;
    workspaceRoot: string;
    serverId: string;
};

type LanguageServerManagerLike = {
    acquire: (input: ParsedLspRequest) => ChildProcessWithoutNullStreams;
    release: (input: ParsedLspRequest) => void;
};

type SessionCleanup = (opts?: { releaseServer: boolean; closeWebSocket: boolean }) => void;

export function parseLspRequest(urlText: string): ParsedLspRequest {
    const url = new URL(urlText, "ws://127.0.0.1");
    if (url.pathname !== "/lsp") throw new Error("Invalid LSP endpoint");
    const language = url.searchParams.get("language");
    const workspaceRoot = url.searchParams.get("workspaceRoot");
    const serverId = url.searchParams.get("serverId");
    if (!language) throw new Error("Missing language");
    if (!workspaceRoot) throw new Error("Missing workspaceRoot");
    if (!serverId) throw new Error("Missing serverId");
    return { language, workspaceRoot, serverId };
}

function makeJsonRpcWebSocket(ws: WebSocket): IWebSocket {
    return {
        send: (content) => ws.send(content),
        onMessage: (cb) => ws.on("message", (data) => cb(data.toString())),
        onError: (cb) => ws.on("error", cb),
        onClose: (cb) => ws.on("close", (code, reason) => cb(code, reason.toString())),
        dispose: () => {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
        },
    };
}

export class LspWebSocketBridge {
    private readonly languageServerManager: LanguageServerManagerLike;
    private server: WebSocketServer = null;
    private url: string = null;
    private readonly clients = new Set<WebSocket>();
    private readonly sessionCleanups = new Set<SessionCleanup>();
    private readonly activeSessions = new Set<string>();

    constructor(deps: { languageServerManager?: LanguageServerManagerLike } = {}) {
        this.languageServerManager = deps.languageServerManager ?? new LanguageServerManager();
    }

    async start(): Promise<string> {
        if (this.server != null && this.url) {
            return this.url;
        }
        const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
        this.server = server;
        server.on("connection", (ws, request) => this.handleConnection(ws, request.url ?? ""));
        await new Promise<void>((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        const address = server.address() as AddressInfo;
        this.url = `ws://127.0.0.1:${address.port}`;
        return this.url;
    }

    async stop(): Promise<void> {
        const server = this.server;
        this.server = null;
        this.url = null;
        for (const cleanup of Array.from(this.sessionCleanups)) {
            cleanup();
        }
        for (const client of this.clients) {
            client.terminate();
        }
        this.clients.clear();
        if (!server) return;
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    }

    private handleConnection(ws: WebSocket, urlText: string): void {
        this.clients.add(ws);
        ws.on("close", () => this.clients.delete(ws));
        let child: ChildProcessWithoutNullStreams;
        let input: ParsedLspRequest | null = null;
        let sessionKey: string | null = null;
        try {
            input = parseLspRequest(urlText);
            sessionKey = makeSessionKey(input);
            if (this.activeSessions.has(sessionKey)) {
                throw new Error("LSP session already active for workspaceRoot and serverId");
            }
            this.activeSessions.add(sessionKey);
            child = this.languageServerManager.acquire(input);
        } catch (e: any) {
            if (sessionKey) {
                this.activeSessions.delete(sessionKey);
            }
            ws.close(1008, e?.message ?? String(e));
            return;
        }
        if (!input || !sessionKey) return;
        const acquiredInput = input;
        const acquiredSessionKey = sessionKey;
        const jsonRpcWebSocket = makeJsonRpcWebSocket(ws);
        const wsReader = new WebSocketMessageReader(jsonRpcWebSocket);
        const wsWriter = new WebSocketMessageWriter(jsonRpcWebSocket);
        const lspReader = new StreamMessageReader(child.stdout);
        const lspWriter = new StreamMessageWriter(child.stdin);
        const disposables: Disposable[] = [
            wsReader.listen((message) => void lspWriter.write(message)),
            lspReader.listen((message) => void wsWriter.write(message)),
        ];
        let cleanedUp = false;
        const closeWebSocket = () => {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
        };
        const cleanup: SessionCleanup = (opts = { releaseServer: true, closeWebSocket: false }) => {
            if (cleanedUp) return;
            cleanedUp = true;
            this.sessionCleanups.delete(cleanup);
            this.activeSessions.delete(acquiredSessionKey);
            child.off("exit", onChildExit);
            child.off("error", onChildError);
            for (const disposable of disposables) {
                disposable.dispose();
            }
            wsReader.dispose();
            wsWriter.dispose();
            lspReader.dispose();
            lspWriter.dispose();
            if (opts.releaseServer) {
                this.languageServerManager.release(acquiredInput);
            }
            if (opts.closeWebSocket) {
                closeWebSocket();
            }
        };
        const onChildExit = () => cleanup({ releaseServer: true, closeWebSocket: true });
        const onChildError = () => cleanup({ releaseServer: true, closeWebSocket: true });
        this.sessionCleanups.add(cleanup);
        child.once("exit", onChildExit);
        child.once("error", onChildError);
        ws.on("close", () => cleanup({ releaseServer: true, closeWebSocket: false }));
    }
}

function makeSessionKey(input: Pick<ParsedLspRequest, "workspaceRoot" | "serverId">): string {
    return `${input.workspaceRoot}\u0000${input.serverId}`;
}
