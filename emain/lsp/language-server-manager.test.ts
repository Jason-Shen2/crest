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
    const typescriptInput = { workspaceRoot: "/repo", language: "typescript", serverId: "typescript-language-server" };
    const goInput = { workspaceRoot: "/repo", language: "go", serverId: "gopls" };

    it("resolves typescript language server command by server id", () => {
        const manager = new LanguageServerManager({ commandExists: () => false, spawn: vi.fn() as any });
        expect(manager.resolveCommand(typescriptInput)).toEqual({
            command: "typescript-language-server",
            args: ["--stdio"],
        });
    });

    it("resolves gopls after checking command availability", () => {
        const commandAvailable = vi.fn(() => true);
        const manager = new LanguageServerManager({ commandAvailable, spawn: vi.fn() as any });

        expect(manager.resolveCommand(goInput)).toEqual({
            command: "gopls",
            args: [],
        });
        expect(commandAvailable).toHaveBeenCalledWith("gopls", ["version"]);
    });

    it("rejects resolving the TypeScript server for Go", () => {
        const manager = new LanguageServerManager({ spawn: vi.fn() as any });

        expect(() =>
            manager.resolveCommand({ workspaceRoot: "/repo", language: "go", serverId: "typescript-language-server" })
        ).toThrow("Language go is not supported by language server typescript-language-server");
    });

    it("rejects starting gopls for TypeScript", () => {
        const manager = new LanguageServerManager({ commandAvailable: () => true, spawn: vi.fn() as any });

        expect(() =>
            manager.startSession({ workspaceRoot: "/repo", language: "typescript", serverId: "gopls" })
        ).toThrow("Language typescript is not supported by language server gopls");
    });

    it("throws an LSP unavailable error when gopls is missing", () => {
        const manager = new LanguageServerManager({ commandAvailable: () => false, spawn: vi.fn() as any });

        expect(() => manager.startSession(goInput)).toThrow(
            "LSP unavailable: Install gopls: go install golang.org/x/tools/gopls@latest"
        );
    });

    it("resolves typescript language server from app node_modules when available", () => {
        const appRoot = "/app";
        const manager = new LanguageServerManager({
            appRoot,
            commandExists: (candidate) => candidate === path.join(appRoot, "node_modules", ".bin", "typescript-language-server"),
            spawn: vi.fn() as any,
        });

        expect(manager.resolveCommand(typescriptInput)).toEqual({
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

        expect(manager.resolveCommand(typescriptInput)).toEqual({
            command: nodeCommand,
            args: [packagedCommand, "--stdio"],
            env: { ELECTRON_RUN_AS_NODE: "1" },
        });
    });

    it("reuses one process per workspace root and server id", () => {
        const spawn = vi.fn(() => makeChild().child);
        const manager = new LanguageServerManager({ spawn: spawn as any });

        manager.getOrStart(typescriptInput);
        manager.getOrStart({ workspaceRoot: "/repo", language: "typescriptreact", serverId: "typescript-language-server" });

        expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("validates language before returning an existing cached process", () => {
        const spawn = vi.fn(() => makeChild().child);
        const manager = new LanguageServerManager({ spawn: spawn as any });

        manager.getOrStart(typescriptInput);

        expect(() =>
            manager.getOrStart({ workspaceRoot: "/repo", language: "go", serverId: "typescript-language-server" })
        ).toThrow("Language go is not supported by language server typescript-language-server");
        expect(spawn).toHaveBeenCalledTimes(1);
    });

    it("starts independent sessions without reusing cached processes", () => {
        const first = makeChild();
        const second = makeChild();
        const spawn = vi.fn().mockReturnValueOnce(first.child).mockReturnValueOnce(second.child);
        const manager = new LanguageServerManager({ spawn: spawn as any });

        const firstSession = manager.startSession(typescriptInput);
        const secondSession = manager.startSession(typescriptInput);

        expect(spawn).toHaveBeenCalledTimes(2);
        expect(firstSession).toBe(first.child);
        expect(secondSession).toBe(second.child);
    });

    it("does not stop independent sessions through the cached process stop path", () => {
        const session = makeChild();
        const cached = makeChild();
        const spawn = vi.fn().mockReturnValueOnce(session.child).mockReturnValueOnce(cached.child);
        const manager = new LanguageServerManager({ spawn: spawn as any });

        manager.startSession(typescriptInput);
        manager.getOrStart(typescriptInput);
        manager.stopAll();

        expect(session.child.kill).not.toHaveBeenCalled();
        expect(cached.child.kill).toHaveBeenCalledTimes(1);
    });

    it("clears the cached process when a child process emits error", () => {
        const first = makeChild();
        const second = makeChild();
        const spawn = vi.fn().mockReturnValueOnce(first.child).mockReturnValueOnce(second.child);
        const manager = new LanguageServerManager({ spawn: spawn as any });

        manager.getOrStart(typescriptInput);
        first.emit("error");
        const restarted = manager.getOrStart(typescriptInput);

        expect(spawn).toHaveBeenCalledTimes(2);
        expect(restarted).toBe(second.child);
    });

    it("stops and clears one cached process", () => {
        const spawned = makeChild();
        const spawn = vi.fn(() => spawned.child);
        const manager = new LanguageServerManager({ spawn: spawn as any });

        manager.getOrStart(typescriptInput);
        manager.stop(typescriptInput);
        manager.getOrStart(typescriptInput);

        expect(spawned.child.kill).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledTimes(2);
    });

    it("stops and clears all cached processes", () => {
        const first = makeChild();
        const second = makeChild();
        const spawn = vi.fn().mockReturnValueOnce(first.child).mockReturnValueOnce(second.child).mockReturnValue(makeChild().child);
        const manager = new LanguageServerManager({ commandAvailable: () => true, spawn: spawn as any });

        manager.getOrStart(typescriptInput);
        manager.getOrStart({ workspaceRoot: "/repo", language: "go", serverId: "gopls" });
        manager.stopAll();
        manager.getOrStart(typescriptInput);

        expect(first.child.kill).toHaveBeenCalledTimes(1);
        expect(second.child.kill).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledTimes(3);
    });
});
