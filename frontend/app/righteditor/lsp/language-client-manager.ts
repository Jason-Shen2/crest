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

export class LanguageClientManager {
    private readonly deps: LanguageClientManagerDeps;
    private readonly transports = new Map<ClientKey, DisposableTransport>();

    constructor(deps: LanguageClientManagerDeps) {
        this.deps = deps;
    }

    async ensureClient(input: EnsureClientInput): Promise<void> {
        const key = this.makeKey(input);
        if (this.transports.has(key)) return;
        this.transports.set(key, await this.deps.transportFactory(input));
    }

    stopClient(input: EnsureClientInput): void {
        const key = this.makeKey(input);
        const transport = this.transports.get(key);
        if (!transport) return;
        transport.dispose();
        this.transports.delete(key);
    }

    stopAll(): void {
        for (const transport of this.transports.values()) {
            transport.dispose();
        }
        this.transports.clear();
    }

    private makeKey(input: EnsureClientInput): ClientKey {
        return `${input.workspaceRoot}\u0000${input.language}`;
    }
}
