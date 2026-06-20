// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { MonacoLanguageClient } from "monaco-languageclient";
import * as monaco from "monaco-editor";
import { type IWebSocket, WebSocketMessageReader, WebSocketMessageWriter } from "vscode-ws-jsonrpc";

export type LspTransportInput = {
    workspaceRoot: string;
    language: string;
};

export type LspTransport = {
    dispose: () => void;
};

type WaveRuntime = {
    lspWebSocketUrl?: string;
};

const LanguageClientErrorActionContinue = 1;
const LanguageClientCloseActionDoNotRestart = 1;

type LspDiagnostic = {
    message: string;
    range: {
        start: {
            line: number;
            character: number;
        };
        end: {
            line: number;
            character: number;
        };
    };
    severity?: number;
    source?: string;
    code?: string | number | { value?: string | number };
};

function getRuntimeLspWebSocketUrl(): string {
    const runtime = globalThis.window?.waveRuntime as WaveRuntime;
    const baseUrl = runtime?.lspWebSocketUrl;
    if (!baseUrl) {
        throw new Error("LSP WebSocket URL is not available");
    }
    return baseUrl.replace(/\/$/, "");
}

function makeJsonRpcWebSocket(socket: WebSocket): IWebSocket {
    return {
        send: (content) => socket.send(content),
        onMessage: (cb) => {
            socket.onmessage = (event) => cb(event.data);
        },
        onError: (cb) => {
            socket.onerror = cb;
        },
        onClose: (cb) => {
            socket.onclose = (event) => cb(event.code, event.reason);
        },
        dispose: () => socket.close(),
    };
}

function diagnosticSeverityToMarkerSeverity(severity?: number): monaco.MarkerSeverity {
    if (severity === 0) return monaco.MarkerSeverity.Error;
    if (severity === 1) return monaco.MarkerSeverity.Warning;
    if (severity === 2) return monaco.MarkerSeverity.Info;
    if (severity === 3) return monaco.MarkerSeverity.Hint;
    return monaco.MarkerSeverity.Info;
}

function diagnosticCodeToString(code: LspDiagnostic["code"]): string {
    if (code == null) return undefined;
    if (typeof code === "object") {
        return code.value == null ? undefined : String(code.value);
    }
    return String(code);
}

export function applyLspDiagnosticsToMonacoMarkers(uri: monaco.Uri, diagnostics: LspDiagnostic[]): void {
    const model = monaco.editor.getModel(uri);
    if (!model) return;
    monaco.editor.setModelMarkers(
        model,
        "right-editor-lsp",
        diagnostics.map((diagnostic) => ({
            message: diagnostic.message,
            severity: diagnosticSeverityToMarkerSeverity(diagnostic.severity),
            startLineNumber: diagnostic.range.start.line + 1,
            startColumn: diagnostic.range.start.character + 1,
            endLineNumber: diagnostic.range.end.line + 1,
            endColumn: diagnostic.range.end.character + 1,
            source: diagnostic.source,
            code: diagnosticCodeToString(diagnostic.code),
        }))
    );
}

export async function createLspWebSocketTransport(input: LspTransportInput): Promise<LspTransport> {
    const params = new URLSearchParams({
        workspaceRoot: input.workspaceRoot,
        language: input.language,
    });
    const socket = new WebSocket(`${getRuntimeLspWebSocketUrl()}/lsp?${params.toString()}`);
    return new Promise<LspTransport>((resolve, reject) => {
        socket.onopen = async () => {
            socket.onerror = null;
            const rpcSocket = makeJsonRpcWebSocket(socket);
            const reader = new WebSocketMessageReader(rpcSocket);
            const writer = new WebSocketMessageWriter(rpcSocket);
            const client = new MonacoLanguageClient({
                name: `Crest ${input.language} Language Client`,
                clientOptions: {
                    documentSelector: [{ scheme: "file", language: input.language }],
                    errorHandler: {
                        error: () => ({ action: LanguageClientErrorActionContinue }),
                        closed: () => ({ action: LanguageClientCloseActionDoNotRestart }),
                    },
                    middleware: {
                        handleDiagnostics: (uri, diagnostics, next) => {
                            applyLspDiagnosticsToMonacoMarkers(uri as monaco.Uri, diagnostics as LspDiagnostic[]);
                            next(uri, diagnostics);
                        },
                    },
                },
                messageTransports: {
                    reader,
                    writer,
                },
            });
            try {
                await client.start();
                resolve({
                    dispose: () => {
                        void client.dispose();
                        reader.dispose();
                        writer.end();
                        socket.close();
                    },
                });
            } catch (e) {
                reader.dispose();
                writer.end();
                socket.close();
                reject(e);
            }
        };
        socket.onerror = () => {
            socket.onopen = null;
            reject(new Error("Failed to connect to LSP WebSocket"));
        };
    });
}
