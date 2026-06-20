// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

type ClientKey = string;

type EnsureClientInput = {
    workspaceRoot: string;
    language: string;
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

export class LanguageClientManager {
    private readonly deps: LanguageClientManagerDeps;
    private readonly transports = new Map<ClientKey, DisposableTransport>();
    private readonly pendingTransports = new Map<ClientKey, PendingTransport>();

    constructor(deps: LanguageClientManagerDeps) {
        this.deps = deps;
    }

    async ensureClient(input: EnsureClientInput): Promise<void> {
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
        try {
            await transportPromise;
        } finally {
            if (this.pendingTransports.get(key) === pendingTransportEntry) {
                this.pendingTransports.delete(key);
            }
        }
    }

    stopClient(input: EnsureClientInput): void {
        const key = this.makeKey(input);
        const pendingTransport = this.pendingTransports.get(key);
        if (pendingTransport) {
            pendingTransport.stopped = true;
            this.pendingTransports.delete(key);
        }
        const transport = this.transports.get(key);
        if (!transport) return;
        transport.dispose();
        this.transports.delete(key);
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
    }

    private makeKey(input: EnsureClientInput): ClientKey {
        return `${input.workspaceRoot}\u0000${input.language}`;
    }
}
