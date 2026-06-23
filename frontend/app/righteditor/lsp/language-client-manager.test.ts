import { describe, expect, it, vi } from "vitest";
import { LanguageClientManager } from "./language-client-manager";

describe("LanguageClientManager", () => {
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
