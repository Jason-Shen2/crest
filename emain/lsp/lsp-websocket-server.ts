// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { LanguageServerManager } from "./language-server-manager";

export type ParsedLspRequest = {
    language: string;
    workspaceRoot: string;
};

type LanguageServerManagerLike = {
    getOrStart: (input: ParsedLspRequest) => ChildProcessWithoutNullStreams;
    stopAll: () => void;
};

export function parseLspRequest(urlText: string): ParsedLspRequest {
    const url = new URL(urlText, "ws://127.0.0.1");
    const language = url.searchParams.get("language");
    const workspaceRoot = url.searchParams.get("workspaceRoot");
    if (!language) throw new Error("Missing language");
    if (!workspaceRoot) throw new Error("Missing workspaceRoot");
    return { language, workspaceRoot };
}

export class LspWebSocketBridge {
    private readonly languageServerManager: LanguageServerManagerLike;
    private server: WebSocketServer = null;
    private url: string = null;
    private readonly clients = new Set<WebSocket>();

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
        this.languageServerManager.stopAll();
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
        try {
            child = this.languageServerManager.getOrStart(parseLspRequest(urlText));
        } catch (e: any) {
            ws.close(1008, e?.message ?? String(e));
            return;
        }
        const stdoutHandler = (data: Buffer) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(data);
        };
        child.stdout.on("data", stdoutHandler);
        ws.on("message", (data) => child.stdin.write(data));
        ws.on("close", () => {
            child.stdout.off("data", stdoutHandler);
        });
    }
}
