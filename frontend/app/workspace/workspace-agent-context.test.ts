// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildWorkspaceAgentExecutionContext, makeWorkspaceAgentContext } from "./workspace-agent-context";

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
