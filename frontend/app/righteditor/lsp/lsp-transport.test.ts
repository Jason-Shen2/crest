import { afterEach, describe, expect, it, vi } from "vitest";
import * as monaco from "monaco-editor";
import { applyLspDiagnosticsToMonacoMarkers, createLspWebSocketTransport } from "./lsp-transport";

const TransportMocks = vi.hoisted(() => {
    const startClient = vi.fn(async () => undefined);
    const disposeClient = vi.fn(async () => undefined);
    const setModelMarkers = vi.fn();
    const getModel = vi.fn((uri) => ({ uri }));
    const ensureMonacoVscodeServices = vi.fn(async () => undefined);
    return {
        startClient,
        disposeClient,
        setModelMarkers,
        getModel,
        ensureMonacoVscodeServices,
        clientConstructor: vi.fn(function (this: any) {
            this.start = startClient;
            this.dispose = disposeClient;
        }),
        readerConstructor: vi.fn(function (this: any) {
            this.dispose = vi.fn();
        }),
        writerConstructor: vi.fn(function (this: any) {
            this.end = vi.fn();
            this.write = vi.fn(async () => undefined);
        }),
    };
});

vi.mock("monaco-editor", () => ({
    Uri: {
        parse: (value: string) => ({ toString: () => value, value }),
    },
    MarkerSeverity: {
        Hint: 1,
        Info: 2,
        Warning: 4,
        Error: 8,
    },
    editor: {
        getModel: TransportMocks.getModel,
        setModelMarkers: TransportMocks.setModelMarkers,
    },
}));

vi.mock("monaco-languageclient", () => ({
    MonacoLanguageClient: TransportMocks.clientConstructor,
}));

vi.mock("@/app/monaco/monaco-env", () => ({
    ensureMonacoVscodeServices: TransportMocks.ensureMonacoVscodeServices,
}));

vi.mock("vscode-ws-jsonrpc", () => ({
    WebSocketMessageReader: TransportMocks.readerConstructor,
    WebSocketMessageWriter: TransportMocks.writerConstructor,
}));

type MockWebSocketEventHandler = (() => void) | null;

class MockWebSocket {
    static instances: MockWebSocket[] = [];
    onopen: MockWebSocketEventHandler = null;
    onerror: MockWebSocketEventHandler = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    close = vi.fn();
    send = vi.fn();

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
        vi.restoreAllMocks();
        TransportMocks.startClient.mockClear();
        TransportMocks.disposeClient.mockClear();
        TransportMocks.setModelMarkers.mockClear();
        TransportMocks.getModel.mockClear();
        TransportMocks.ensureMonacoVscodeServices.mockClear();
        TransportMocks.clientConstructor.mockClear();
        TransportMocks.readerConstructor.mockClear();
        TransportMocks.writerConstructor.mockClear();
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

    it("starts a named Monaco language client over the WebSocket transport", async () => {
        installRuntime("ws://127.0.0.1:9010");
        vi.stubGlobal("WebSocket", MockWebSocket);

        const transportPromise = createLspWebSocketTransport({
            workspaceRoot: "/repo",
            language: "typescript",
        });
        MockWebSocket.instances[0].open();
        const transport = await transportPromise;

        expect(TransportMocks.readerConstructor).toHaveBeenCalledTimes(1);
        expect(TransportMocks.writerConstructor).toHaveBeenCalledTimes(1);
        expect(TransportMocks.clientConstructor).toHaveBeenCalledWith(
            expect.objectContaining({
                name: "Crest typescript Language Client",
                clientOptions: expect.objectContaining({
                    documentSelector: [{ scheme: "file", language: "typescript" }],
                }),
            })
        );
        expect(TransportMocks.ensureMonacoVscodeServices).toHaveBeenCalledTimes(1);
        expect(TransportMocks.ensureMonacoVscodeServices.mock.invocationCallOrder[0]).toBeLessThan(
            TransportMocks.startClient.mock.invocationCallOrder[0]
        );
        expect(TransportMocks.startClient).toHaveBeenCalledTimes(1);

        transport.dispose();
        expect(TransportMocks.disposeClient).toHaveBeenCalledTimes(1);
        expect(MockWebSocket.instances[0].close).toHaveBeenCalledTimes(1);
    });

    it("uses server languages for Monaco selectors while keeping the backend language concrete", async () => {
        installRuntime("ws://127.0.0.1:9010");
        vi.stubGlobal("WebSocket", MockWebSocket);

        const transportPromise = createLspWebSocketTransport({
            workspaceRoot: "/repo",
            language: "typescript",
            languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
        });
        MockWebSocket.instances[0].open();
        const transport = await transportPromise;

        expect(MockWebSocket.instances[0].url).toBe(
            "ws://127.0.0.1:9010/lsp?workspaceRoot=%2Frepo&language=typescript"
        );
        expect(TransportMocks.clientConstructor).toHaveBeenCalledWith(
            expect.objectContaining({
                clientOptions: expect.objectContaining({
                    documentSelector: [
                        { scheme: "file", language: "typescript" },
                        { scheme: "file", language: "typescriptreact" },
                        { scheme: "file", language: "javascript" },
                        { scheme: "file", language: "javascriptreact" },
                    ],
                }),
            })
        );

        transport.dispose();
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

    it("maps 1-based LSP diagnostic severities to Monaco markers", () => {
        const uri = monaco.Uri.parse("file:///repo/src/app.ts");

        applyLspDiagnosticsToMonacoMarkers(uri, [
            {
                message: "Error diagnostic",
                range: {
                    start: { line: 2, character: 4 },
                    end: { line: 2, character: 9 },
                },
                severity: 1,
                source: "typescript",
            },
            {
                message: "Warning diagnostic",
                range: {
                    start: { line: 3, character: 1 },
                    end: { line: 3, character: 5 },
                },
                severity: 2,
                source: "typescript",
            },
            {
                message: "Info diagnostic",
                range: {
                    start: { line: 4, character: 1 },
                    end: { line: 4, character: 5 },
                },
                severity: 3,
                source: "typescript",
            },
            {
                message: "Hint diagnostic",
                range: {
                    start: { line: 5, character: 1 },
                    end: { line: 5, character: 5 },
                },
                severity: 4,
                source: "typescript",
            },
        ]);

        expect(TransportMocks.setModelMarkers).toHaveBeenCalledWith({ uri }, "right-editor-lsp", [
            expect.objectContaining({
                message: "Error diagnostic",
                severity: monaco.MarkerSeverity.Error,
                startLineNumber: 3,
                startColumn: 5,
                endLineNumber: 3,
                endColumn: 10,
                source: "typescript",
            }),
            expect.objectContaining({
                message: "Warning diagnostic",
                severity: monaco.MarkerSeverity.Warning,
            }),
            expect.objectContaining({
                message: "Info diagnostic",
                severity: monaco.MarkerSeverity.Info,
            }),
            expect.objectContaining({
                message: "Hint diagnostic",
                severity: monaco.MarkerSeverity.Hint,
            }),
        ]);
    });
});
