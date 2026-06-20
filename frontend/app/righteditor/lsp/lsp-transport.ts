// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type LspTransportInput = {
    workspaceRoot: string;
    language: string;
};

export type LspTransport = {
    dispose: () => void;
};

export async function createLspWebSocketTransport(input: LspTransportInput): Promise<LspTransport> {
    const params = new URLSearchParams({
        workspaceRoot: input.workspaceRoot,
        language: input.language,
    });
    const socket = new WebSocket(`ws://127.0.0.1:0/lsp?${params.toString()}`);
    return {
        dispose: () => socket.close(),
    };
}
