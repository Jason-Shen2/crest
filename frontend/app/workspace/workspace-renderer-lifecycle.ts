// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

type WorkspaceRendererTeardownOptions = {
    flush: () => Promise<void>;
    clearSubscriptions: () => void;
    shutdownWshrpc: () => void;
};

function teardownWorkspaceRenderer(options: WorkspaceRendererTeardownOptions): void {
    try {
        void options.flush().catch(() => {});
    } catch {
        // Unload must continue even when starting the best-effort save fails synchronously.
    }
    options.clearSubscriptions();
    options.shutdownWshrpc();
}

export { teardownWorkspaceRenderer };
export type { WorkspaceRendererTeardownOptions };
