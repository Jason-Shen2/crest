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
});
