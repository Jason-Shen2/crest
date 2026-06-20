// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

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

function getRuntimeLspWebSocketUrl(): string {
    const runtime = (globalThis as any).window?.waveRuntime as WaveRuntime | undefined;
    const baseUrl = runtime?.lspWebSocketUrl;
    if (!baseUrl) {
        throw new Error("LSP WebSocket URL is not available");
    }
    return baseUrl.replace(/\/$/, "");
}

export async function createLspWebSocketTransport(input: LspTransportInput): Promise<LspTransport> {
    const params = new URLSearchParams({
        workspaceRoot: input.workspaceRoot,
        language: input.language,
    });
    const socket = new WebSocket(`${getRuntimeLspWebSocketUrl()}/lsp?${params.toString()}`);
    return new Promise<LspTransport>((resolve, reject) => {
        socket.onopen = () => {
            socket.onerror = null;
            resolve({
                dispose: () => socket.close(),
            });
        };
        socket.onerror = () => {
            socket.onopen = null;
            reject(new Error("Failed to connect to LSP WebSocket"));
        };
    });
}
