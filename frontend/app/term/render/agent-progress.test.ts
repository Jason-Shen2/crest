// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { PiRun } from "@/app/store/use-pi-chat";
import { deriveAgentProgress } from "./agent-progress";

function makeRun(responseMessages: PiRun["responseMessages"], status: PiRun["status"] = "done"): PiRun {
    return {
        runId: "run-1",
        userMessage: {
            role: "user",
            content: [{ type: "text", text: "improve agent progress UI" }],
            timestamp: 1,
        },
        responseMessages,
        status,
    };
}

describe("deriveAgentProgress", () => {
    it("groups read-only discovery tool calls into a product-facing exploration stage", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "find-1",
                            name: "find",
                            input: { pattern: "*.tsx", path: "frontend/app/term/render" },
                        },
                        {
                            type: "toolCall",
                            id: "read-1",
                            name: "read_text_file",
                            input: { path: "frontend/app/term/render/agent-block-element.tsx" },
                        },
                    ],
                },
                {
                    role: "toolResult",
                    toolCallId: "find-1",
                    toolName: "find",
                    content: [{ type: "text", text: "agent-block-element.tsx" }],
                    isError: false,
                },
                {
                    role: "toolResult",
                    toolCallId: "read-1",
                    toolName: "read_text_file",
                    content: [{ type: "text", text: "source" }],
                    isError: false,
                },
            ]),
        );

        expect(progress.stages).toHaveLength(1);
        expect(progress.stages[0]).toMatchObject({
            id: "explore-implementation",
            title: "Explore implementation",
            status: "done",
            risk: "read-only",
            summary: "Inspected project files and existing implementation.",
        });
        expect(progress.stages[0].summary).not.toContain("find");
        expect(progress.stages[0].summary).not.toContain("read_text_file");
        expect(progress.stages[0].actionGroups[0]).toMatchObject({
            title: "Inspected project files",
            status: "done",
            risk: "read-only",
        });
        expect(progress.stages[0].actionGroups[0].toolCalls.map((call) => call.name)).toEqual([
            "find",
            "read_text_file",
        ]);
    });

    it("derives edit and validation stages from Pi tool calls", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "edit-1",
                            name: "edit",
                            input: { path: "frontend/app/term/render/agent-progress.ts" },
                        },
                        {
                            type: "toolCall",
                            id: "test-1",
                            name: "functions.exec_command",
                            input: { cmd: "npm test -- --run frontend/app/term/render/agent-progress.test.ts" },
                        },
                    ],
                },
                {
                    role: "toolResult",
                    toolCallId: "edit-1",
                    toolName: "edit",
                    content: [{ type: "text", text: "patched" }],
                    isError: false,
                },
                {
                    role: "toolResult",
                    toolCallId: "test-1",
                    toolName: "functions.exec_command",
                    content: [{ type: "text", text: "1 passed" }],
                    isError: false,
                },
            ]),
        );

        expect(progress.stages.map((stage) => stage.title)).toEqual(["Modify files", "Verify result"]);
        expect(progress.stages[0]).toMatchObject({
            status: "done",
            risk: "file-edit",
            summary: "Updated files.",
        });
        expect(progress.stages[1]).toMatchObject({
            status: "done",
            risk: "command",
            summary: "Ran validation.",
        });
        expect(progress.stages[1].actionGroups[0].toolCalls[0]).toMatchObject({
            id: "test-1",
            name: "functions.exec_command",
            status: "done",
        });
    });

    it("marks a stage running when the current tool call has no result and exposes recent actions", () => {
        const progress = deriveAgentProgress(
            makeRun(
                [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "grep-1",
                                name: "grep",
                                input: { pattern: "ToolCallCard", path: "frontend/app" },
                            },
                        ],
                    },
                ],
                "streaming",
            ),
        );

        expect(progress.stages[0]).toMatchObject({
            title: "Explore implementation",
            status: "running",
            currentAction: "Inspecting project files.",
        });
        expect(progress.stages[0].recentActions).toEqual([
            {
                id: "grep-1",
                title: "Inspecting project files.",
                status: "running",
            },
        ]);
    });

    it("attaches failed tool results to the derived stage while preserving technical details", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "test-1",
                            name: "bash",
                            input: { command: "npm test -- --run frontend/app/term/render/agent-progress.test.ts" },
                        },
                    ],
                },
                {
                    role: "toolResult",
                    toolCallId: "test-1",
                    toolName: "bash",
                    content: [{ type: "text", text: "expected 1 to equal 2" }],
                    isError: true,
                },
            ]),
        );

        expect(progress.stages[0]).toMatchObject({
            title: "Verify result",
            status: "failed",
            summary: "Validation failed.",
        });
        expect(progress.stages[0].actionGroups[0]).toMatchObject({
            status: "failed",
            summary: "Validation failed.",
        });
        expect(progress.stages[0].actionGroups[0].toolCalls[0]).toMatchObject({
            id: "test-1",
            name: "bash",
            status: "failed",
            result: {
                isError: true,
            },
        });
    });
});
