import { describe, expect, it, vi } from "vitest";
import { LanguageServerManager } from "./language-server-manager";

describe("LanguageServerManager", () => {
    it("resolves typescript language server command", () => {
        const manager = new LanguageServerManager({ spawn: vi.fn() as any });
        expect(manager.resolveCommand("typescript")).toEqual({
            command: "typescript-language-server",
            args: ["--stdio"],
        });
    });

    it("reuses one process per workspace root and language", () => {
        const spawn = vi.fn(() => ({ stdin: {}, stdout: {}, stderr: {}, kill: vi.fn(), on: vi.fn() }));
        const manager = new LanguageServerManager({ spawn: spawn as any });

        manager.getOrStart({ workspaceRoot: "/repo", language: "typescript" });
        manager.getOrStart({ workspaceRoot: "/repo", language: "typescript" });

        expect(spawn).toHaveBeenCalledTimes(1);
    });
});
