import { describe, expect, it, vi } from "vitest";
import { LanguageClientManager } from "./language-client-manager";

describe("LanguageClientManager", () => {
    it("reuses one client per workspace root and language", async () => {
        const transportFactory = vi.fn(async () => ({ dispose: vi.fn() }));
        const manager = new LanguageClientManager({ transportFactory });

        await manager.ensureClient({ workspaceRoot: "/repo", language: "typescript" });
        await manager.ensureClient({ workspaceRoot: "/repo", language: "typescript" });

        expect(transportFactory).toHaveBeenCalledTimes(1);
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
        const input = { workspaceRoot: "/repo", language: "typescript" };

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

    it("reuses one pending transport for concurrent requests", async () => {
        let resolveTransport: (transport: { dispose: () => void }) => void;
        const transportPromise = new Promise<{ dispose: () => void }>((resolve) => {
            resolveTransport = resolve;
        });
        const transportFactory = vi.fn(async () => transportPromise);
        const manager = new LanguageClientManager({ transportFactory });

        const first = manager.ensureClient({ workspaceRoot: "/repo", language: "typescript" });
        const second = manager.ensureClient({ workspaceRoot: "/repo", language: "typescript" });
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

        const pending = manager.ensureClient({ workspaceRoot: "/repo", language: "typescript" });
        manager.stopClient({ workspaceRoot: "/repo", language: "typescript" });

        const dispose = vi.fn();
        resolveTransport!({ dispose });
        await pending;
        await manager.ensureClient({ workspaceRoot: "/repo", language: "typescript" });

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

        const pending = manager.ensureClient({ workspaceRoot: "/repo", language: "typescript" });
        manager.stopAll();

        const dispose = vi.fn();
        resolveTransport!({ dispose });
        await pending;
        await manager.ensureClient({ workspaceRoot: "/repo", language: "typescript" });

        expect(dispose).toHaveBeenCalledTimes(1);
        expect(transportFactory).toHaveBeenCalledTimes(2);
    });
});
