// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
    buildWorkspaceAgentExecutionContext,
    makeWorkspaceAgentContext,
    resolveWorkspaceAgentTerminalBlockId,
    resolveWorkspaceAgentTerminalValues,
} from "./workspace-agent-context";

describe("buildWorkspaceAgentExecutionContext", () => {
    it("builds block-free Workspace context with safe provider defaults", () => {
        expect(
            buildWorkspaceAgentExecutionContext({
                workspaceId: "workspace-1",
                generation: 2,
                workspaceDir: "/tmp/project",
                sessionPath: "/tmp/session.jsonl",
                preferredTerminalTabId: "terminal-1",
                gitBranch: "main",
            })
        ).toEqual({
            workspaceId: "workspace-1",
            workspaceDir: "/tmp/project",
            sessionPath: "/tmp/session.jsonl",
            connection: "",
            environment: {},
            preferredTerminalTabId: "terminal-1",
            gitBranch: "main",
            recentCmds: [],
        });
    });

    it("copies provider-owned environment and recent commands", () => {
        const environment = { FOO: "bar" };
        const recentCmds = ["git status"];
        const context = buildWorkspaceAgentExecutionContext({
            workspaceId: "workspace-1",
            generation: 2,
            workspaceDir: "/tmp/project",
            connection: "ssh://host",
            environment,
            recentCmds,
        });

        environment.FOO = "changed";
        recentCmds.push("pwd");
        expect(context.environment).toEqual({ FOO: "bar" });
        expect(context.recentCmds).toEqual(["git status"]);
    });

    it("constructs one immutable runtime identity beside the derived context", () => {
        const value = makeWorkspaceAgentContext(
            {
                workspaceId: "workspace-1",
                generation: 3,
                workspaceDir: "/tmp/project",
            },
            {} as never
        );

        expect(value.runtimeClient.identity).toEqual({ workspaceId: "workspace-1", generation: 3 });
        expect(value.executionContext.workspaceDir).toBe("/tmp/project");
    });
});

describe("Workspace Agent terminal context", () => {
    const tab = {
        oid: "terminal-1",
        otype: "tab",
        name: "Terminal",
        layoutstate: "layout-1",
        blockids: ["block-1", "block-2"],
    } as Tab;

    it("maps the preferred Terminal tab to its persisted focused block", () => {
        const layout = {
            oid: "layout-1",
            otype: "layout",
            focusednodeid: "node-2",
            leaforder: [
                { nodeid: "node-1", blockid: "block-1" },
                { nodeid: "node-2", blockid: "block-2" },
            ],
        } as LayoutState;

        expect(resolveWorkspaceAgentTerminalBlockId(tab, layout)).toBe("block-2");
    });

    it("uses the first persisted leaf when the layout has no focused node", () => {
        const layout = {
            oid: "layout-1",
            otype: "layout",
            leaforder: [
                { nodeid: "node-1", blockid: "block-1" },
                { nodeid: "node-2", blockid: "block-2" },
            ],
        } as LayoutState;

        expect(resolveWorkspaceAgentTerminalBlockId(tab, layout)).toBe("block-1");
    });

    it("does not invent a block mapping from stale layout membership", () => {
        const layout = {
            oid: "layout-1",
            otype: "layout",
            focusednodeid: "stale-node",
            leaforder: [{ nodeid: "stale-node", blockid: "deleted-block" }],
        } as LayoutState;

        expect(resolveWorkspaceAgentTerminalBlockId(tab, layout)).toBeUndefined();
    });

    it("derives the selected block connection and chronological recent command feed", () => {
        const block = {
            oid: "block-2",
            otype: "block",
            meta: { connection: "ssh://dev" },
        } as Block;
        const newestFirst = Array.from({ length: 12 }, (_, index) => `cmd-${12 - index}`);

        expect(resolveWorkspaceAgentTerminalValues("block-2", block, newestFirst)).toEqual({
            connection: "ssh://dev",
            recentCmds: ["cmd-3", "cmd-4", "cmd-5", "cmd-6", "cmd-7", "cmd-8", "cmd-9", "cmd-10", "cmd-11", "cmd-12"],
        });
    });
});
