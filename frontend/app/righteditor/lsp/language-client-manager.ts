// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RightEditorLspStatus } from "../right-editor-types";

type ClientKey = string;

type EnsureClientInput = {
    workspaceRoot: string;
    language: string;
    languages?: string[];
    serverId?: string | null;
    displayName?: string;
};

type DisposableTransport = {
    dispose: () => void;
};

type LanguageClientManagerDeps = {
    transportFactory: (input: EnsureClientInput) => Promise<DisposableTransport>;
};

type PendingTransport = {
    promise: Promise<DisposableTransport>;
    stopped: boolean;
};

const LspUnavailablePrefix = "LSP unavailable: ";

export class LanguageClientManager {
    private readonly deps: LanguageClientManagerDeps;
    private readonly transports = new Map<ClientKey, DisposableTransport>();
    private readonly pendingTransports = new Map<ClientKey, PendingTransport>();
    private readonly statusByKey = new Map<ClientKey, RightEditorLspStatus>();
    private readonly referenceCounts = new Map<ClientKey, number>();

    constructor(deps: LanguageClientManagerDeps) {
        this.deps = deps;
    }

    async ensureClient(input: EnsureClientInput): Promise<void> {
        if (!input.serverId) {
            this.setStatus(input, "unavailable", "Language server unavailable");
            return;
        }
        const key = this.makeKey(input);
        if (this.transports.has(key)) return;
        const pendingTransport = this.pendingTransports.get(key);
        if (pendingTransport) {
            await pendingTransport.promise;
            return;
        }
        let pendingTransportEntry: PendingTransport;
        const transportPromise = this.deps.transportFactory(input).then((transport) => {
            if (pendingTransportEntry.stopped) {
                transport.dispose();
                return transport;
            }
            this.transports.set(key, transport);
            return transport;
        });
        pendingTransportEntry = {
            promise: transportPromise,
            stopped: false,
        };
        this.pendingTransports.set(key, pendingTransportEntry);
        this.setStatus(input, "starting", null);
        try {
            await transportPromise;
            if (!pendingTransportEntry.stopped) {
                this.setStatus(input, "running", null);
            }
        } catch (e: any) {
            if (this.pendingTransports.get(key) === pendingTransportEntry && !pendingTransportEntry.stopped) {
                this.setErrorStatus(input, e);
            }
            throw e;
        } finally {
            if (this.pendingTransports.get(key) === pendingTransportEntry) {
                this.pendingTransports.delete(key);
            }
        }
    }

    getStatus(input: EnsureClientInput): RightEditorLspStatus {
        const status = this.statusByKey.get(this.makeKey(input));
        return {
            workspaceRoot: input.workspaceRoot,
            language: input.language,
            serverId: input.serverId ?? status?.serverId ?? null,
            displayName: input.displayName ?? status?.displayName ?? input.language,
            state: status?.state ?? "stopped",
            message: status?.message ?? null,
        };
    }

    acquireClient(input: EnsureClientInput): () => void {
        if (!input.serverId) {
            this.setStatus(input, "unavailable", "Language server unavailable");
            return () => undefined;
        }
        const key = this.makeKey(input);
        this.referenceCounts.set(key, (this.referenceCounts.get(key) ?? 0) + 1);
        void this.ensureClient(input).catch(() => undefined);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const nextCount = (this.referenceCounts.get(key) ?? 0) - 1;
            if (nextCount > 0) {
                this.referenceCounts.set(key, nextCount);
                return;
            }
            this.referenceCounts.delete(key);
            this.stopClient(input);
        };
    }

    stopClient(input: EnsureClientInput): void {
        const key = this.makeKey(input);
        const pendingTransport = this.pendingTransports.get(key);
        if (pendingTransport) {
            pendingTransport.stopped = true;
            this.pendingTransports.delete(key);
        }
        const transport = this.transports.get(key);
        if (transport) {
            transport.dispose();
            this.transports.delete(key);
        }
        this.setStatus(input, "stopped", null);
    }

    stopAll(): void {
        for (const pendingTransport of this.pendingTransports.values()) {
            pendingTransport.stopped = true;
        }
        for (const transport of this.transports.values()) {
            transport.dispose();
        }
        this.transports.clear();
        this.pendingTransports.clear();
        this.statusByKey.clear();
        this.referenceCounts.clear();
    }

    private setStatus(input: EnsureClientInput, state: RightEditorLspStatus["state"], message: string | null): void {
        this.statusByKey.set(this.makeKey(input), {
            workspaceRoot: input.workspaceRoot,
            language: input.language,
            serverId: input.serverId ?? null,
            displayName: input.displayName ?? input.language,
            state,
            message,
        });
    }

    private setErrorStatus(input: EnsureClientInput, e: any): void {
        const message = e?.message ?? String(e);
        if (message.startsWith(LspUnavailablePrefix)) {
            this.setStatus(input, "unavailable", message.slice(LspUnavailablePrefix.length));
            return;
        }
        this.setStatus(input, "error", message);
    }

    private makeKey(input: EnsureClientInput): ClientKey {
        return `${input.workspaceRoot}\u0000${input.serverId ?? ""}`;
    }
}

export const languageClientManager = new LanguageClientManager({
    transportFactory: async (input) => {
        const { createLspWebSocketTransport } = await import("./lsp-transport");
        return createLspWebSocketTransport(input);
    },
});
