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
                environment: { FOO: "bar" },
                gitBranch: "main",
            })
        ).toEqual({
            workspaceId: "workspace-1",
            workspaceDir: "/tmp/project",
            sessionPath: "/tmp/session.jsonl",
            environment: { FOO: "bar" },
            gitBranch: "main",
        });
    });

    it("copies the provider-owned environment", () => {
        const environment = { FOO: "bar" };
        const context = buildWorkspaceAgentExecutionContext({
            workspaceId: "workspace-1",
            generation: 2,
            workspaceDir: "/tmp/project",
            environment,
        });

        environment.FOO = "changed";
        expect(context.environment).toEqual({ FOO: "bar" });
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
