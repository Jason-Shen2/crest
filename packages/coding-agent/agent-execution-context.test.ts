// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseAgentExecutionContext, resolveAuthenticatedWorkspaceSender } from "./agent-execution-context";

describe("parseAgentExecutionContext", () => {
    const valid = {
        workspaceId: "workspace-1",
        workspaceDir: "/tmp/project",
        sessionPath: "/tmp/sessions/session.jsonl",
        environment: { TERM: "xterm-256color" },
        gitBranch: "main",
    };

    it("strictly parses Workspace-owned context", async () => {
        await expect(parseAgentExecutionContext(valid)).resolves.toEqual(valid);
    });

    it.each([
        [{ ...valid, extra: true }, /unexpected key/],
        [{ ...valid, workspaceId: "" }, /workspaceId/],
        [{ ...valid, workspaceDir: "relative" }, /workspaceDir/],
        [{ ...valid, environment: { TERM: 3 } }, /environment/],
    ])("rejects invalid context %#", async (input, expected) => {
        await expect(parseAgentExecutionContext(input)).rejects.toThrow(expected);
    });

    it.each(["preferredTerminalTabId", "connection", "recentCmds"])(
        "rejects removed Terminal-derived field %s",
        async (field) => {
            await expect(
                parseAgentExecutionContext({
                    ...valid,
                    [field]: field === "recentCmds" ? [] : "terminal-value",
                })
            ).rejects.toThrow(/unexpected key/);
        }
    );
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
