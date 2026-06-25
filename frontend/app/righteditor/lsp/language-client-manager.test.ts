import { describe, expect, it, vi } from "vitest";
import { LanguageClientManager } from "./language-client-manager";

describe("LanguageClientManager", () => {
    it("notifies status subscribers and advances the snapshot when status changes", async () => {
        let resolveTransport: (transport: { dispose: () => void }) => void;
        const transportPromise = new Promise<{ dispose: () => void }>((resolve) => {
            resolveTransport = resolve;
        });
        const transportFactory = vi.fn(async () => transportPromise);
        const manager = new LanguageClientManager({ transportFactory });
        const input = {
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        };
        const listener = vi.fn();
        const unsubscribe = manager.subscribeStatus(input, listener);
        const initialSnapshot = manager.getStatusSnapshot(input);

        const pending = manager.ensureClient(input);

        expect(listener).toHaveBeenCalledTimes(1);
        expect(manager.getStatusSnapshot(input)).toBeGreaterThan(initialSnapshot);
        expect(manager.getStatus(input).state).toBe("starting");

        resolveTransport!({ dispose: vi.fn() });
        await pending;

        expect(listener).toHaveBeenCalledTimes(2);
        expect(manager.getStatus(input).state).toBe("running");

        unsubscribe();
        manager.stopClient(input);

        expect(listener).toHaveBeenCalledTimes(2);
    });

    it("reuses one client per workspace root and server id across TS and TSX", async () => {
        const transportFactory = vi.fn(async () => ({ dispose: vi.fn() }));
        const manager = new LanguageClientManager({ transportFactory });

        await manager.ensureClient({
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        });
        await manager.ensureClient({
            workspaceRoot: "/repo",
            language: "typescriptreact",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        });

        expect(transportFactory).toHaveBeenCalledTimes(1);
    });

    it("starts shared TS transport with the concrete first language and all server languages", async () => {
        const transportFactory = vi.fn(async () => ({ dispose: vi.fn() }));
        const manager = new LanguageClientManager({ transportFactory });
        const languages = ["typescript", "typescriptreact", "javascript", "javascriptreact"];

        await manager.ensureClient({
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
            languages,
        });
        await manager.ensureClient({
            workspaceRoot: "/repo",
            language: "typescriptreact",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
            languages,
        });

        expect(transportFactory).toHaveBeenCalledWith({
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
            languages,
        });
        expect(
            manager.getStatus({
                workspaceRoot: "/repo",
                language: "typescriptreact",
                serverId: "typescript-language-server",
                displayName: "TypeScript/JavaScript",
                languages,
            })
        ).toEqual({
            workspaceRoot: "/repo",
            language: "typescriptreact",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
            state: "running",
            message: null,
        });
    });

    it("starts separate clients for different server ids in the same workspace", async () => {
        const transportFactory = vi.fn(async () => ({ dispose: vi.fn() }));
        const manager = new LanguageClientManager({ transportFactory });

        await manager.ensureClient({
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        });
        await manager.ensureClient({
            workspaceRoot: "/repo",
            language: "go",
            serverId: "gopls",
            displayName: "Go",
        });

        expect(transportFactory).toHaveBeenCalledTimes(2);
    });

    it("returns running shared server status with the requested language metadata", async () => {
        const transportFactory = vi.fn(async () => ({ dispose: vi.fn() }));
        const manager = new LanguageClientManager({ transportFactory });
        const tsInput = {
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        };
        const tsxInput = {
            workspaceRoot: "/repo",
            language: "typescriptreact",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        };

        await manager.ensureClient(tsInput);

        expect(manager.getStatus(tsxInput)).toEqual({
            workspaceRoot: "/repo",
            language: "typescriptreact",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
            state: "running",
            message: null,
        });
    });

    it("marks the client as running with status metadata after ensureClient", async () => {
        const transportFactory = vi.fn(async () => ({ dispose: vi.fn() }));
        const manager = new LanguageClientManager({ transportFactory });

        await manager.ensureClient({
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        });

        expect(
            manager.getStatus({
                workspaceRoot: "/repo",
                language: "typescript",
                serverId: "typescript-language-server",
                displayName: "TypeScript/JavaScript",
            })
        ).toEqual({
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
            state: "running",
            message: null,
        });
    });

    it("keeps a shared client running until the last release", async () => {
        const dispose = vi.fn();
        const transportFactory = vi.fn(async () => ({ dispose }));
        const manager = new LanguageClientManager({ transportFactory });
        const input = {
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        };

        const releaseFirst = manager.acquireClient(input);
        const releaseSecond = manager.acquireClient(input);
        await manager.ensureClient(input);

        releaseFirst();
        expect(dispose).not.toHaveBeenCalled();
        expect(manager.getStatus(input).state).toBe("running");

        releaseSecond();

        expect(dispose).toHaveBeenCalledTimes(1);
        expect(manager.getStatus(input).state).toBe("stopped");
    });

    it("keeps a shared TS client running until TS and TSX releases both complete", async () => {
        const dispose = vi.fn();
        const transportFactory = vi.fn(async () => ({ dispose }));
        const manager = new LanguageClientManager({ transportFactory });
        const tsInput = {
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        };
        const tsxInput = {
            workspaceRoot: "/repo",
            language: "typescriptreact",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        };

        const releaseTs = manager.acquireClient(tsInput);
        const releaseTsx = manager.acquireClient(tsxInput);
        await manager.ensureClient(tsInput);

        releaseTs();
        expect(dispose).not.toHaveBeenCalled();
        expect(manager.getStatus(tsxInput).state).toBe("running");

        releaseTsx();

        expect(dispose).toHaveBeenCalledTimes(1);
        expect(manager.getStatus(tsInput).state).toBe("stopped");
    });

    it("keeps Go and TS reference counts separate in the same workspace", async () => {
        const tsDispose = vi.fn();
        const goDispose = vi.fn();
        const transportFactory = vi
            .fn()
            .mockResolvedValueOnce({ dispose: tsDispose })
            .mockResolvedValueOnce({ dispose: goDispose });
        const manager = new LanguageClientManager({ transportFactory });
        const tsInput = {
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        };
        const goInput = {
            workspaceRoot: "/repo",
            language: "go",
            serverId: "gopls",
            displayName: "Go",
        };

        const releaseTs = manager.acquireClient(tsInput);
        const releaseGo = manager.acquireClient(goInput);
        await Promise.all([manager.ensureClient(tsInput), manager.ensureClient(goInput)]);

        releaseTs();
        expect(tsDispose).toHaveBeenCalledTimes(1);
        expect(goDispose).not.toHaveBeenCalled();
        expect(manager.getStatus(tsInput).state).toBe("stopped");
        expect(manager.getStatus(goInput).state).toBe("running");

        releaseGo();

        expect(goDispose).toHaveBeenCalledTimes(1);
    });

    it("marks clients without a server id as unavailable without starting transport", async () => {
        const transportFactory = vi.fn(async () => ({ dispose: vi.fn() }));
        const manager = new LanguageClientManager({ transportFactory });
        const input = {
            workspaceRoot: "/repo",
            language: "markdown",
            displayName: "Markdown",
        };

        await manager.ensureClient(input);

        expect(transportFactory).not.toHaveBeenCalled();
        expect(manager.getStatus(input)).toEqual({
            workspaceRoot: "/repo",
            language: "markdown",
            serverId: null,
            displayName: "Markdown",
            state: "unavailable",
            message: "Language server unavailable",
        });
    });

    it("maps LSP unavailable transport errors to unavailable status with the prefix stripped", async () => {
        const transportFactory = vi.fn(async () => {
            throw new Error("LSP unavailable: Install gopls");
        });
        const manager = new LanguageClientManager({ transportFactory });
        const input = {
            workspaceRoot: "/repo",
            language: "go",
            serverId: "gopls",
            displayName: "Go",
        };

        await expect(manager.ensureClient(input)).rejects.toThrow("LSP unavailable: Install gopls");

        expect(manager.getStatus(input)).toEqual({
            workspaceRoot: "/repo",
            language: "go",
            serverId: "gopls",
            displayName: "Go",
            state: "unavailable",
            message: "Install gopls",
        });
    });

    it("reuses one pending transport for concurrent requests", async () => {
        let resolveTransport: (transport: { dispose: () => void }) => void;
        const transportPromise = new Promise<{ dispose: () => void }>((resolve) => {
            resolveTransport = resolve;
        });
        const transportFactory = vi.fn(async () => transportPromise);
        const manager = new LanguageClientManager({ transportFactory });

        const input = {
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        };

        const first = manager.ensureClient(input);
        const second = manager.ensureClient(input);
        resolveTransport!({ dispose: vi.fn() });
        await Promise.all([first, second]);

        expect(transportFactory).toHaveBeenCalledTimes(1);
    });

    it("disposes a pending transport resolved after stopClient", async () => {
        let resolveTransport: (transport: { dispose: () => void }) => void;
        const transportPromise = new Promise<{ dispose: () => void }>((resolve) => {
            resolveTransport = resolve;
        });
        const transportFactory = vi.fn(async () => transportPromise);
        const manager = new LanguageClientManager({ transportFactory });

        const input = {
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        };

        const pending = manager.ensureClient(input);
        manager.stopClient(input);

        const dispose = vi.fn();
        resolveTransport!({ dispose });
        await pending;
        await manager.ensureClient(input);

        expect(dispose).toHaveBeenCalledTimes(1);
        expect(transportFactory).toHaveBeenCalledTimes(2);
    });

    it("does not let a stopped pending rejection overwrite stopped status", async () => {
        let rejectTransport: (error: Error) => void;
        const transportPromise = new Promise<{ dispose: () => void }>((_resolve, reject) => {
            rejectTransport = reject;
        });
        const transportFactory = vi.fn(async () => transportPromise);
        const manager = new LanguageClientManager({ transportFactory });
        const input = {
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        };

        const pending = manager.ensureClient(input);
        manager.stopClient(input);

        rejectTransport!(new Error("late failure"));
        await expect(pending).rejects.toThrow("late failure");

        expect(manager.getStatus(input)).toEqual({
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
            state: "stopped",
            message: null,
        });
    });

    it("does not let an older pending rejection overwrite a restarted running client", async () => {
        let rejectFirst: (error: Error) => void;
        const firstTransportPromise = new Promise<{ dispose: () => void }>((_resolve, reject) => {
            rejectFirst = reject;
        });
        const transportFactory = vi
            .fn()
            .mockImplementationOnce(async () => firstTransportPromise)
            .mockResolvedValueOnce({ dispose: vi.fn() });
        const manager = new LanguageClientManager({ transportFactory });
        const input = {
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        };

        const firstPending = manager.ensureClient(input);
        manager.stopClient(input);
        await manager.ensureClient(input);

        rejectFirst!(new Error("older failure"));
        await expect(firstPending).rejects.toThrow("older failure");

        expect(manager.getStatus(input)).toEqual({
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
            state: "running",
            message: null,
        });
    });

    it("disposes pending transports resolved after stopAll", async () => {
        let resolveTransport: (transport: { dispose: () => void }) => void;
        const transportPromise = new Promise<{ dispose: () => void }>((resolve) => {
            resolveTransport = resolve;
        });
        const transportFactory = vi.fn(async () => transportPromise);
        const manager = new LanguageClientManager({ transportFactory });

        const input = {
            workspaceRoot: "/repo",
            language: "typescript",
            serverId: "typescript-language-server",
            displayName: "TypeScript/JavaScript",
        };

        const pending = manager.ensureClient(input);
        manager.stopAll();

        const dispose = vi.fn();
        resolveTransport!({ dispose });
        await pending;
        await manager.ensureClient(input);

        expect(dispose).toHaveBeenCalledTimes(1);
        expect(transportFactory).toHaveBeenCalledTimes(2);
    });
});
