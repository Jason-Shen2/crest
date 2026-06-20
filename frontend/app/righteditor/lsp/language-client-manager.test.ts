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

    it("marks the client as running after ensureClient", async () => {
        const transportFactory = vi.fn(async () => ({ dispose: vi.fn() }));
        const manager = new LanguageClientManager({ transportFactory });

        await manager.ensureClient({ workspaceRoot: "/repo", language: "typescript" });

        expect(manager.getStatus({ workspaceRoot: "/repo", language: "typescript" })).toEqual({
            workspaceRoot: "/repo",
            language: "typescript",
            state: "running",
            message: null,
        });
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
