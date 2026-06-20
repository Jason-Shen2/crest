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
});
