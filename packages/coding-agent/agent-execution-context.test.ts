// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { parseAgentExecutionContext, resolveAuthenticatedWorkspaceSender } from "./agent-execution-context";

describe("parseAgentExecutionContext", () => {
    const valid = {
        workspaceId: "workspace-1",
        workspaceDir: "/tmp/project",
        sessionPath: "/tmp/sessions/session.jsonl",
        connection: "",
        environment: { TERM: "xterm-256color" },
        preferredTerminalTabId: "terminal-1",
        gitBranch: "main",
    };

    it("strictly parses context and normalizes missing recent commands", async () => {
        const validatePreferredTerminal = vi.fn(async () => true);

        await expect(parseAgentExecutionContext(valid, { validatePreferredTerminal })).resolves.toEqual({
            ...valid,
            recentCmds: [],
        });
        expect(validatePreferredTerminal).toHaveBeenCalledWith("terminal-1");
    });

    it.each([
        [{ ...valid, extra: true }, /unexpected key/],
        [{ ...valid, workspaceId: "" }, /workspaceId/],
        [{ ...valid, workspaceDir: "relative" }, /workspaceDir/],
        [{ ...valid, environment: { TERM: 3 } }, /environment/],
        [{ ...valid, recentCmds: ["ok", 3] }, /recentCmds/],
    ])("rejects invalid context %#", async (input, expected) => {
        await expect(
            parseAgentExecutionContext(input, { validatePreferredTerminal: async () => true })
        ).rejects.toThrow(expected);
    });

    it("rejects a preferred Terminal outside authoritative inventory", async () => {
        await expect(
            parseAgentExecutionContext(valid, { validatePreferredTerminal: async () => false })
        ).rejects.toThrow(/preferredTerminalTabId/);
    });
});

describe("resolveAuthenticatedWorkspaceSender", () => {
    it("rejects a sender switched while Workspace loading is pending", async () => {
        let resolveLoad!: (workspace: { meta: Record<string, string> }) => void;
        const load = new Promise<{ meta: Record<string, string> }>((resolve) => {
            resolveLoad = resolve;
        });
        const view = { waveWindowId: "window-1", initOpts: { workspaceId: "workspace-1", generation: 1 } };
        const window = {
            waveWindowId: "window-1",
            workspaceView: view,
            terminalMembership: { validate: vi.fn(async () => true) },
        };
        const resolving = resolveAuthenticatedWorkspaceSender(1, {
            getWorkspaceView: () => view,
            getWindow: () => window,
            loadWorkspace: () => load,
            canonicalizeDirectory: async (value) => value,
        });

        view.initOpts = { workspaceId: "workspace-2", generation: 2 };
        resolveLoad({ meta: { "workspace:dir": "/tmp/one" } });

        await expect(resolving).resolves.toBeUndefined();
    });

    it("rejects a sender switched while directory canonicalization is pending", async () => {
        let resolveDirectory!: (workspaceDir: string) => void;
        const canonical = new Promise<string>((resolve) => {
            resolveDirectory = resolve;
        });
        const view = { waveWindowId: "window-1", initOpts: { workspaceId: "workspace-1", generation: 1 } };
        const window = {
            waveWindowId: "window-1",
            workspaceView: view,
            terminalMembership: { validate: vi.fn(async () => true) },
        };
        const resolving = resolveAuthenticatedWorkspaceSender(1, {
            getWorkspaceView: () => view,
            getWindow: () => window,
            loadWorkspace: async () => ({ meta: { "workspace:dir": "/tmp/one" } }),
            canonicalizeDirectory: () => canonical,
        });

        window.workspaceView = {
            waveWindowId: "window-1",
            initOpts: { workspaceId: "workspace-2", generation: 2 },
        };
        resolveDirectory("/private/tmp/one");

        await expect(resolving).resolves.toBeUndefined();
    });
});
