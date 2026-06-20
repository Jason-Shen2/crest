import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { LanguageServerManager } from "./language-server-manager";

function makeChild() {
    const handlers = new Map<string, () => void>();
    return {
        child: {
            stdin: {},
            stdout: {},
            stderr: {},
            kill: vi.fn(),
            on: vi.fn((event: string, handler: () => void) => {
                handlers.set(event, handler);
            }),
        },
        emit: (event: string) => handlers.get(event)?.(),
    };
}

describe("LanguageServerManager", () => {
    it("resolves typescript language server command", () => {
        const manager = new LanguageServerManager({ commandExists: () => false, spawn: vi.fn() as any });
        expect(manager.resolveCommand("typescript")).toEqual({
            command: "typescript-language-server",
            args: ["--stdio"],
        });
    });

    it("resolves typescript language server from app node_modules when available", () => {
        const appRoot = "/app";
        const manager = new LanguageServerManager({
            appRoot,
            commandExists: (candidate) => candidate === path.join(appRoot, "node_modules", ".bin", "typescript-language-server"),
            spawn: vi.fn() as any,
        });

        expect(manager.resolveCommand("typescript")).toEqual({
            command: path.join(appRoot, "node_modules", ".bin", "typescript-language-server"),
            args: ["--stdio"],
        });
    });

    it("resolves packaged typescript language server from unpacked app resources", () => {
        const resourcesPath = "/Applications/Crest.app/Contents/Resources";
        const nodeCommand = "/Applications/Crest.app/Contents/MacOS/Crest";
        const packagedCommand = path.join(
            resourcesPath,
            "app.asar.unpacked",
            "node_modules",
            "typescript-language-server",
            "lib",
            "cli.mjs"
        );
        const manager = new LanguageServerManager({
            resourcesPath,
            nodeCommand,
            commandExists: (candidate) => candidate === packagedCommand,
            spawn: vi.fn() as any,
        });

        expect(manager.resolveCommand("typescript")).toEqual({
            command: nodeCommand,
            args: [packagedCommand, "--stdio"],
            env: { ELECTRON_RUN_AS_NODE: "1" },
        });
    });

    it("reuses one process per workspace root and language", () => {
        const spawn = vi.fn(() => makeChild().child);
        const manager = new LanguageServerManager({ spawn: spawn as any });

        manager.getOrStart({ workspaceRoot: "/repo", language: "typescript" });
        manager.getOrStart({ workspaceRoot: "/repo", language: "typescript" });

        expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("starts independent sessions without reusing cached processes", () => {
        const first = makeChild();
        const second = makeChild();
        const spawn = vi.fn().mockReturnValueOnce(first.child).mockReturnValueOnce(second.child);
        const manager = new LanguageServerManager({ spawn: spawn as any });

        const firstSession = manager.startSession({ workspaceRoot: "/repo", language: "typescript" });
        const secondSession = manager.startSession({ workspaceRoot: "/repo", language: "typescript" });

        expect(spawn).toHaveBeenCalledTimes(2);
        expect(firstSession).toBe(first.child);
        expect(secondSession).toBe(second.child);
    });

    it("does not stop independent sessions through the cached process stop path", () => {
        const session = makeChild();
        const cached = makeChild();
        const spawn = vi.fn().mockReturnValueOnce(session.child).mockReturnValueOnce(cached.child);
        const manager = new LanguageServerManager({ spawn: spawn as any });

        manager.startSession({ workspaceRoot: "/repo", language: "typescript" });
        manager.getOrStart({ workspaceRoot: "/repo", language: "typescript" });
        manager.stopAll();

        expect(session.child.kill).not.toHaveBeenCalled();
        expect(cached.child.kill).toHaveBeenCalledTimes(1);
    });

    it("clears the cached process when a child process emits error", () => {
        const first = makeChild();
        const second = makeChild();
        const spawn = vi.fn().mockReturnValueOnce(first.child).mockReturnValueOnce(second.child);
        const manager = new LanguageServerManager({ spawn: spawn as any });

        manager.getOrStart({ workspaceRoot: "/repo", language: "typescript" });
        first.emit("error");
        const restarted = manager.getOrStart({ workspaceRoot: "/repo", language: "typescript" });

        expect(spawn).toHaveBeenCalledTimes(2);
        expect(restarted).toBe(second.child);
    });

    it("stops and clears one cached process", () => {
        const spawned = makeChild();
        const spawn = vi.fn(() => spawned.child);
        const manager = new LanguageServerManager({ spawn: spawn as any });

        manager.getOrStart({ workspaceRoot: "/repo", language: "typescript" });
        manager.stop({ workspaceRoot: "/repo", language: "typescript" });
        manager.getOrStart({ workspaceRoot: "/repo", language: "typescript" });

        expect(spawned.child.kill).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledTimes(2);
    });

    it("stops and clears all cached processes", () => {
        const first = makeChild();
        const second = makeChild();
        const spawn = vi.fn().mockReturnValueOnce(first.child).mockReturnValueOnce(second.child).mockReturnValue(makeChild().child);
        const manager = new LanguageServerManager({ spawn: spawn as any });

        manager.getOrStart({ workspaceRoot: "/repo", language: "typescript" });
        manager.getOrStart({ workspaceRoot: "/repo", language: "javascript" });
        manager.stopAll();
        manager.getOrStart({ workspaceRoot: "/repo", language: "typescript" });

        expect(first.child.kill).toHaveBeenCalledTimes(1);
        expect(second.child.kill).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledTimes(3);
    });
});
