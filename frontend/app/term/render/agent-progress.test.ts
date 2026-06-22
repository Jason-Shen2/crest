// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PiRun } from "@/app/store/use-pi-chat";
import { deriveAgentProgress } from "./agent-progress";
import { AgentProgressView } from "./agent-progress-view";

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
    it("does not expose change review for read-only and command-only tool runs", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "read-1",
                            name: "read_text_file",
                            input: { path: "src/app.ts" },
                        },
                        {
                            type: "toolCall",
                            id: "test-1",
                            name: "bash",
                            input: { command: "npm test -- --run src/app.test.ts" },
                        },
                    ],
                },
                {
                    role: "toolResult",
                    toolCallId: "read-1",
                    toolName: "read_text_file",
                    content: [{ type: "text", text: "source" }],
                    isError: false,
                },
                {
                    role: "toolResult",
                    toolCallId: "test-1",
                    toolName: "bash",
                    content: [{ type: "text", text: "1 passed" }],
                    isError: false,
                },
            ])
        );

        expect(progress.changeReview).toBeUndefined();
    });

    it("does not expose change review for edit tool results without diff hunks or stats", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "edit-noop",
                            name: "edit_text_file",
                            input: { path: "a.ts" },
                        },
                    ],
                },
                {
                    role: "toolResult",
                    toolCallId: "edit-noop",
                    toolName: "edit_text_file",
                    content: [{ type: "text", text: "patched" }],
                    details: {
                        changeOperation: {
                            id: "op-noop",
                            toolCallId: "edit-noop",
                            kind: "patch",
                            path: "a.ts",
                            patch: "--- a/a.ts\n+++ b/a.ts\n",
                            patchStatus: "complete",
                        },
                    },
                    isError: false,
                },
            ])
        );

        expect(progress.changeReview).toBeUndefined();
    });

    it("attaches change review derived from edit tool result details", () => {
        const patch = `--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1,2 @@
 const keep = true;
+const added = true;
`;
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "edit-1",
                            name: "edit_text_file",
                            input: { path: "src/app.ts" },
                        },
                    ],
                },
                {
                    role: "toolResult",
                    toolCallId: "edit-1",
                    toolName: "edit_text_file",
                    content: [{ type: "text", text: "patched" }],
                    details: {
                        changeOperation: {
                            id: "op-1",
                            toolCallId: "edit-1",
                            kind: "patch",
                            path: "src/app.ts",
                            patch,
                            patchStatus: "complete",
                        },
                    },
                    isError: false,
                },
            ])
        );

        expect(progress.changeReview).toMatchObject({
            changeSetId: "run-1",
            changeSet: { id: "run-1", totals: { files: 1, hunks: 1, additions: 1, deletions: 0 } },
            modules: [],
            warnings: [],
        });
        expect(progress.changeReview?.ungroupedFiles).toEqual([
            expect.objectContaining({
                path: "src/app.ts",
                status: "modified",
                stats: { hunks: 1, additions: 1, deletions: 0 },
            }),
        ]);
    });

    it("uses the run change outline to group change review files", () => {
        const patch = `--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1,2 @@
 const keep = true;
+const added = true;
`;
        const progress = deriveAgentProgress({
            ...makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "edit-1",
                            name: "edit_text_file",
                            input: { path: "src/app.ts" },
                        },
                    ],
                },
                {
                    role: "toolResult",
                    toolCallId: "edit-1",
                    toolName: "edit_text_file",
                    content: [{ type: "text", text: "patched" }],
                    details: {
                        changeOperation: {
                            id: "op-1",
                            toolCallId: "edit-1",
                            kind: "patch",
                            path: "src/app.ts",
                            patch,
                            patchStatus: "complete",
                        },
                    },
                    isError: false,
                },
            ]),
            changeOutline: {
                modules: [
                    {
                        id: "app-flow",
                        title: "Application flow",
                        summary: "Review the app flow update.",
                        files: [{ path: "src/app.ts" }],
                    },
                ],
            },
        });

        expect(progress.changeReview?.modules).toEqual([
            expect.objectContaining({
                id: "app-flow",
                title: "Application flow",
                summary: "Review the app flow update.",
                files: [expect.objectContaining({ path: "src/app.ts" })],
            }),
        ]);
        expect(progress.changeReview?.ungroupedFiles).toEqual([]);
    });

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
            ])
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
            ])
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

    it("derives compact file summary and detail for edit child actions without raw output", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "edit-1",
                            name: "edit_text_file",
                            input: { path: "frontend/app/term/render/agent-progress.ts" },
                        },
                    ],
                },
                {
                    role: "toolResult",
                    toolCallId: "edit-1",
                    toolName: "edit_text_file",
                    content: [
                        {
                            type: "text",
                            text: "*** Begin Patch\n*** Update File: frontend/app/term/render/agent-progress.ts\nraw diff output",
                        },
                    ],
                    isError: false,
                },
            ])
        );

        expect(progress.stages[0].actionGroups[0]).toMatchObject({
            actions: [
                {
                    id: "edit-1",
                    summary: "Updated agent-progress.ts",
                    detail: "frontend/app/term/render/agent-progress.ts",
                    status: "done",
                },
            ],
        });
        expect(progress.stages[0].actionGroups[0].actions[0]).not.toHaveProperty("canViewDiff");
    });

    it("uses status-specific file-edit child action wording", () => {
        const progress = deriveAgentProgress(
            makeRun(
                [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "edit-running",
                                name: "edit_text_file",
                                input: { path: "frontend/app/term/render/agent-progress.ts" },
                            },
                            {
                                type: "toolCall",
                                id: "edit-failed",
                                name: "edit_text_file",
                                input: { path: "frontend/app/term/render/agent-progress-view.tsx" },
                            },
                            {
                                type: "toolCall",
                                id: "edit-done",
                                name: "edit_text_file",
                                input: { path: "frontend/app/term/render/agent-progress.test.ts" },
                            },
                        ],
                    },
                    {
                        role: "toolResult",
                        toolCallId: "edit-failed",
                        toolName: "edit_text_file",
                        content: [{ type: "text", text: "could not patch" }],
                        isError: true,
                    },
                    {
                        role: "toolResult",
                        toolCallId: "edit-done",
                        toolName: "edit_text_file",
                        content: [{ type: "text", text: "patched" }],
                        isError: false,
                    },
                ],
                "streaming"
            )
        );

        expect(progress.stages[0].actionGroups[0].actions).toEqual([
            expect.objectContaining({
                id: "edit-running",
                summary: "Updating agent-progress.ts",
                title: "Updating agent-progress.ts",
                status: "running",
            }),
            expect.objectContaining({
                id: "edit-failed",
                summary: "Could not update agent-progress-view.tsx",
                title: "Could not update agent-progress-view.tsx",
                status: "failed",
            }),
            expect.objectContaining({
                id: "edit-done",
                summary: "Updated agent-progress.test.ts",
                title: "Updated agent-progress.test.ts",
                status: "done",
            }),
        ]);
    });

    it("derives file details from alternate edit inputs and omits diff when no file detail exists", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "edit-file-path",
                            name: "edit_text_file",
                            input: { file_path: "frontend/app/term/render/agent-progress-view.tsx" },
                        },
                        {
                            type: "toolCall",
                            id: "edit-filePath",
                            name: "edit_text_file",
                            input: { filePath: "frontend/app/term/render/agent-progress.test.ts" },
                        },
                        {
                            type: "toolCall",
                            id: "edit-text-patch",
                            name: "functions.apply_patch",
                            input: {
                                text: "*** Begin Patch\n*** Update File: frontend/app/term/render/agent-progress.ts\nraw diff output",
                            },
                        },
                        {
                            type: "toolCall",
                            id: "edit-no-file",
                            name: "edit_text_file",
                            input: { oldText: "before", newText: "after" },
                        },
                    ],
                },
                {
                    role: "toolResult",
                    toolCallId: "edit-file-path",
                    toolName: "edit_text_file",
                    content: [{ type: "text", text: "patched" }],
                    isError: false,
                },
                {
                    role: "toolResult",
                    toolCallId: "edit-filePath",
                    toolName: "edit_text_file",
                    content: [{ type: "text", text: "patched" }],
                    isError: false,
                },
                {
                    role: "toolResult",
                    toolCallId: "edit-text-patch",
                    toolName: "functions.apply_patch",
                    content: [{ type: "text", text: "patched" }],
                    isError: false,
                },
                {
                    role: "toolResult",
                    toolCallId: "edit-no-file",
                    toolName: "edit_text_file",
                    content: [{ type: "text", text: "patched" }],
                    isError: false,
                },
            ])
        );

        expect(progress.stages[0].actionGroups[0].actions).toEqual([
            expect.objectContaining({
                id: "edit-file-path",
                summary: "Updated agent-progress-view.tsx",
                detail: "frontend/app/term/render/agent-progress-view.tsx",
            }),
            expect.objectContaining({
                id: "edit-filePath",
                summary: "Updated agent-progress.test.ts",
                detail: "frontend/app/term/render/agent-progress.test.ts",
            }),
            expect.objectContaining({
                id: "edit-text-patch",
                summary: "Updated agent-progress.ts",
                detail: "frontend/app/term/render/agent-progress.ts",
            }),
            expect.objectContaining({
                id: "edit-no-file",
                summary: "Updated file",
                detail: undefined,
            }),
        ]);
        for (const action of progress.stages[0].actionGroups[0].actions) {
            expect(action).not.toHaveProperty("canViewDiff");
        }
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
                "streaming"
            )
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
            ])
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

    it("keeps a stage running while a later call in the same stage is still pending", () => {
        const progress = deriveAgentProgress(
            makeRun(
                [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "grep-failed",
                                name: "grep",
                                input: { pattern: "(", path: "frontend/app" },
                            },
                            {
                                type: "toolCall",
                                id: "read-running",
                                name: "read_text_file",
                                input: { path: "frontend/app/term/render/agent-progress.ts" },
                            },
                        ],
                    },
                    {
                        role: "toolResult",
                        toolCallId: "grep-failed",
                        toolName: "grep",
                        content: [{ type: "text", text: "Invalid regex pattern" }],
                        isError: true,
                    },
                ],
                "streaming"
            )
        );

        expect(progress.stages[0]).toMatchObject({
            title: "Explore implementation",
            status: "running",
            currentAction: "Inspecting project files.",
        });
        expect(progress.stages[0].actionGroups[0]).toMatchObject({
            status: "running",
            summary: "Inspecting project files.",
        });
    });

    it("generates unique ids for non-contiguous stages of the same kind", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "read-before",
                            name: "read_text_file",
                            input: { path: "frontend/app/term/render/agent-block-element.tsx" },
                        },
                        {
                            type: "toolCall",
                            id: "edit-1",
                            name: "edit",
                            input: { path: "frontend/app/term/render/agent-progress.ts" },
                        },
                        {
                            type: "toolCall",
                            id: "read-after",
                            name: "read_text_file",
                            input: { path: "frontend/app/term/render/agent-progress.test.ts" },
                        },
                    ],
                },
                {
                    role: "toolResult",
                    toolCallId: "read-before",
                    toolName: "read_text_file",
                    content: [{ type: "text", text: "before" }],
                    isError: false,
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
                    toolCallId: "read-after",
                    toolName: "read_text_file",
                    content: [{ type: "text", text: "after" }],
                    isError: false,
                },
            ])
        );

        expect(progress.stages.map((stage) => stage.title)).toEqual([
            "Explore implementation",
            "Modify files",
            "Explore implementation",
        ]);
        expect(new Set(progress.stages.map((stage) => stage.id)).size).toBe(progress.stages.length);
    });
});

describe("AgentProgressView", () => {
    it("renders progress as a cardless activity rail without redundant success labels", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "edit-1",
                            name: "edit",
                            input: { path: "two_sum.py" },
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
            ])
        );

        const html = renderToStaticMarkup(createElement(AgentProgressView, { progress }));

        expect(html).toContain('class="py-1"');
        expect(html).toContain('data-agent-progress-rail="true"');
        expect(html).toContain('data-agent-progress-stage-rail-line="true"');
        expect(html).toContain('class="space-y-0.5"');
        expect(html).toContain('data-agent-progress-stage-row="modify-files"');
        expect(html).toContain('data-agent-progress-stage-row="verify-result"');
        expect(html).not.toContain('data-agent-progress-card="true"');
        expect(html).not.toContain("rounded-xl border border-[#25434a] bg-[#16282d] p-4");
        expect(html).not.toContain(">Done<");
        expect(html).not.toContain("View technical calls/details");
    });

    it("renders readable labels only for failed and running stages", () => {
        const html = renderToStaticMarkup(
            createElement(AgentProgressView, {
                progress: {
                    stages: [
                        {
                            id: "failed-stage",
                            title: "Verify result",
                            status: "failed",
                            summary: "Validation failed.",
                            recentActions: [],
                            actionGroups: [],
                        },
                        {
                            id: "running-stage",
                            title: "Explore implementation",
                            status: "running",
                            summary: "Inspecting project files.",
                            recentActions: [],
                            actionGroups: [],
                        },
                        {
                            id: "done-stage",
                            title: "Modify files",
                            status: "done",
                            summary: "Updated files.",
                            recentActions: [],
                            actionGroups: [],
                        },
                        {
                            id: "pending-stage",
                            title: "Run command",
                            status: "pending",
                            summary: "Waiting to run command.",
                            recentActions: [],
                            actionGroups: [],
                        },
                    ],
                },
            })
        );

        expect(html).toContain('data-agent-progress-status-label="failed-stage"');
        expect(html).toContain(">Failed<");
        expect(html).toContain('data-agent-progress-status-label="running-stage"');
        expect(html).toContain(">Running<");
        expect(html).not.toContain('data-agent-progress-status-label="done-stage"');
        expect(html).not.toContain('data-agent-progress-status-label="pending-stage"');
        expect(html).not.toContain(">Done<");
        expect(html).not.toContain(">Completed<");
        expect(html).not.toContain(">Not run<");
    });

    it("places the stage expansion control next to the stage title", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "edit-1",
                            name: "edit",
                            input: { path: "two_sum.py" },
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
            ])
        );

        const html = renderToStaticMarkup(createElement(AgentProgressView, { progress }));
        const titleRowIndex = html.indexOf('data-agent-progress-stage-title-row="modify-files"');
        const toggleIndex = html.indexOf('data-agent-progress-stage-toggle="modify-files"');
        const chevronIndex = html.indexOf('data-agent-progress-stage-chevron="modify-files"');
        const summaryIndex = html.indexOf("Updated files.", titleRowIndex);
        const toggleEndIndex = html.indexOf("</button>", toggleIndex);

        expect(titleRowIndex).toBeGreaterThanOrEqual(0);
        expect(toggleIndex).toBeGreaterThan(titleRowIndex);
        expect(chevronIndex).toBeGreaterThan(titleRowIndex);
        expect(chevronIndex).toBeLessThan(toggleEndIndex);
        expect(chevronIndex).toBeLessThan(summaryIndex);
        expect(html).not.toContain('data-agent-progress-row-end-chevron="modify-files"');
    });

    it("does not render expansion controls for stages without details", () => {
        const html = renderToStaticMarkup(
            createElement(AgentProgressView, {
                progress: {
                    stages: [
                        {
                            id: "understand-task",
                            title: "理解任务",
                            status: "done",
                            summary: "确认需要实现 two-sum。",
                            recentActions: [],
                            actionGroups: [],
                        },
                        {
                            id: "modify-files",
                            title: "更新代码",
                            status: "done",
                            summary: "补齐 two-sum 实现。",
                            recentActions: [],
                            actionGroups: [
                                {
                                    id: "modify-files-group",
                                    title: "更新代码",
                                    summary: "更新 two_sum.py",
                                    status: "done",
                                    risk: "file-edit",
                                    actions: [
                                        {
                                            id: "edit-two-sum",
                                            title: "更新 two_sum.py",
                                            summary: "更新 two_sum.py",
                                            detail: "two_sum.py",
                                            status: "done",
                                        },
                                    ],
                                    toolCalls: [],
                                },
                            ],
                            risk: "file-edit",
                        },
                    ],
                },
            })
        );

        expect(html).toContain('data-agent-progress-stage-title="understand-task"');
        expect(html).not.toContain('data-agent-progress-stage-toggle="understand-task"');
        expect(html).not.toContain('data-agent-progress-stage-chevron="understand-task"');
        expect(html).toContain('data-agent-progress-stage-toggle="modify-files"');
        expect(html).toContain('data-agent-progress-stage-chevron="modify-files"');
    });

    it("renders stage chevrons as icons instead of text characters", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "edit-1",
                            name: "edit_text_file",
                            input: { path: "two_sum.py" },
                        },
                    ],
                },
                {
                    role: "toolResult",
                    toolCallId: "edit-1",
                    toolName: "edit_text_file",
                    content: [{ type: "text", text: "patched" }],
                    isError: false,
                },
            ])
        );

        const html = renderToStaticMarkup(createElement(AgentProgressView, { progress }));

        expect(html).toContain('data-agent-progress-stage-chevron="modify-files"');
        expect(html).toContain("<svg");
        expect(html).not.toContain("&gt;");
        expect(html).not.toContain(">v<");
    });

    it("renders file edit evidence as a clickable file chip", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "edit-1",
                            name: "edit_text_file",
                            input: { path: "two_sum.py" },
                        },
                    ],
                },
                {
                    role: "toolResult",
                    toolCallId: "edit-1",
                    toolName: "edit_text_file",
                    content: [{ type: "text", text: "patched" }],
                    isError: false,
                },
            ])
        );

        const html = renderToStaticMarkup(createElement(AgentProgressView, { progress, showTechnicalDetails: true }));

        expect(html).toContain('data-agent-progress-file-link="edit-1"');
        expect(html).toContain('data-agent-progress-file-path="two_sum.py"');
        expect(html).toContain("two_sum.py");
        expect(html).not.toContain("file://two_sum.py");
        expect(html).not.toContain("`two_sum.py`");
    });

    it("renders change review modules, files, and hunks under the modify stage", () => {
        const html = renderToStaticMarkup(
            createElement(AgentProgressView, {
                showTechnicalDetails: true,
                progress: {
                    stages: [
                        {
                            id: "modify-files",
                            title: "Modify files",
                            status: "done",
                            summary: "Updated files.",
                            recentActions: [],
                            actionGroups: [],
                            risk: "file-edit",
                        },
                    ],
                    changeReview: {
                        changeSetId: "run-1",
                        changeSet: {
                            id: "run-1",
                            files: [],
                            totals: { files: 2, hunks: 2, additions: 3, deletions: 1 },
                        },
                        modules: [
                            {
                                id: "ui",
                                title: "UI rendering",
                                summary: "Review progress rendering updates.",
                                files: [
                                    {
                                        path: "frontend/app/term/render/agent-progress-view.tsx",
                                        status: "modified",
                                        stats: { hunks: 1, additions: 2, deletions: 1 },
                                        hunks: [
                                            {
                                                id: "frontend/app/term/render/agent-progress-view.tsx:1",
                                                path: "frontend/app/term/render/agent-progress-view.tsx",
                                                oldStart: 10,
                                                oldLines: 3,
                                                newStart: 10,
                                                newLines: 4,
                                                header: "function StageOverview",
                                                additions: 2,
                                                deletions: 1,
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                        ungroupedFiles: [
                            {
                                path: "frontend/app/term/render/agent-progress.test.ts",
                                status: "modified",
                                stats: { hunks: 1, additions: 1, deletions: 0 },
                                hunks: [
                                    {
                                        id: "frontend/app/term/render/agent-progress.test.ts:1",
                                        path: "frontend/app/term/render/agent-progress.test.ts",
                                        oldStart: 900,
                                        oldLines: 0,
                                        newStart: 900,
                                        newLines: 1,
                                        header: "AgentProgressView",
                                        additions: 1,
                                        deletions: 0,
                                    },
                                ],
                            },
                        ],
                        warnings: [],
                    },
                },
            })
        );

        expect(html).toContain('data-agent-progress-stage-toggle="modify-files"');
        expect(html).toContain('data-agent-progress-stage-details="modify-files"');
        expect(html).toContain('data-agent-progress-change-review="run-1"');
        expect(html).toContain('data-agent-progress-change-module="ui"');
        expect(html).toContain("UI rendering");
        expect(html).toContain("Review progress rendering updates.");
        expect(html).toContain('data-agent-progress-change-module="ungrouped"');
        expect(html).toContain("Other changes");
        expect(html).toContain('data-agent-progress-change-file="frontend/app/term/render/agent-progress-view.tsx"');
        expect(html).toContain('data-agent-progress-change-file="frontend/app/term/render/agent-progress.test.ts"');
        expect(html).toContain('data-agent-progress-change-file-chip="frontend/app/term/render/agent-progress-view.tsx"');
        expect(html).toContain("agent-progress-view.tsx");
        expect(html).toContain("+2");
        expect(html).toContain("-1");
        expect(html).toContain('data-agent-progress-change-hunk="frontend/app/term/render/agent-progress-view.tsx:1"');
        expect(html).toContain("function StageOverview");
        expect(html).toContain('data-agent-progress-change-hunk-diff="frontend/app/term/render/agent-progress-view.tsx:1"');
        expect(html).toContain("View diff");
        expect(html).toContain('disabled=""');
        expect(html).toContain('aria-disabled="true"');
        expect(html).toContain('title="Diff viewing is not available yet."');
        expect(html).toContain('data-agent-progress-change-hunk-explain="frontend/app/term/render/agent-progress-view.tsx:1"');
        expect(html).toContain("Explain");
        expect(html).toContain('title="Explanation is not available yet."');
    });

    it("enables change review hunk actions only when callbacks are provided", () => {
        const progress = {
            stages: [
                {
                    id: "modify-files",
                    title: "Modify files",
                    status: "done" as const,
                    summary: "Updated files.",
                    recentActions: [],
                    actionGroups: [],
                    risk: "file-edit" as const,
                },
            ],
            changeReview: {
                changeSetId: "run-1",
                changeSet: {
                    id: "run-1",
                    files: [],
                    totals: { files: 1, hunks: 1, additions: 1, deletions: 0 },
                },
                modules: [],
                ungroupedFiles: [
                    {
                        path: "frontend/app/term/render/agent-progress-view.tsx",
                        status: "modified" as const,
                        stats: { hunks: 1, additions: 1, deletions: 0 },
                        hunks: [
                            {
                                id: "frontend/app/term/render/agent-progress-view.tsx:1",
                                path: "frontend/app/term/render/agent-progress-view.tsx",
                                oldStart: 10,
                                oldLines: 1,
                                newStart: 10,
                                newLines: 2,
                                header: "function ChangeReviewHunk",
                                additions: 1,
                                deletions: 0,
                            },
                        ],
                    },
                ],
                warnings: [],
            },
        };

        const disabledHtml = renderToStaticMarkup(createElement(AgentProgressView, { progress, showTechnicalDetails: true }));
        const enabledHtml = renderToStaticMarkup(
            createElement(AgentProgressView, {
                progress,
                showTechnicalDetails: true,
                onExplainChange: () => {},
                onViewDiff: () => {},
            })
        );

        expect(disabledHtml).toContain('data-agent-progress-change-hunk-diff="frontend/app/term/render/agent-progress-view.tsx:1"');
        expect(disabledHtml).toContain('data-agent-progress-change-hunk-explain="frontend/app/term/render/agent-progress-view.tsx:1"');
        expect(disabledHtml).toContain('disabled=""');
        expect(disabledHtml).toContain('aria-disabled="true"');
        expect(disabledHtml).toContain('title="Diff viewing is not available yet."');
        expect(disabledHtml).toContain('title="Explanation is not available yet."');

        expect(enabledHtml).toContain('data-agent-progress-change-hunk-diff="frontend/app/term/render/agent-progress-view.tsx:1"');
        expect(enabledHtml).toContain('data-agent-progress-change-hunk-explain="frontend/app/term/render/agent-progress-view.tsx:1"');
        expect(enabledHtml).not.toContain('disabled=""');
        expect(enabledHtml).not.toContain('aria-disabled="true"');
        expect(enabledHtml).not.toContain('title="Diff viewing is not available yet."');
        expect(enabledHtml).not.toContain('title="Explanation is not available yet."');
    });

    it("renders run-level change review only under the first file-edit stage", () => {
        const html = renderToStaticMarkup(
            createElement(AgentProgressView, {
                showTechnicalDetails: true,
                progress: {
                    stages: [
                        {
                            id: "modify-files",
                            title: "Modify files",
                            status: "done",
                            summary: "Updated files.",
                            recentActions: [],
                            actionGroups: [],
                            risk: "file-edit",
                        },
                        {
                            id: "modify-files-2",
                            title: "Modify files",
                            status: "done",
                            summary: "Updated more files.",
                            recentActions: [],
                            actionGroups: [],
                            risk: "file-edit",
                        },
                    ],
                    changeReview: {
                        changeSetId: "run-1",
                        changeSet: {
                            id: "run-1",
                            files: [],
                            totals: { files: 1, hunks: 1, additions: 1, deletions: 0 },
                        },
                        modules: [
                            {
                                id: "ui",
                                title: "UI rendering",
                                files: [
                                    {
                                        path: "frontend/app/term/render/agent-progress-view.tsx",
                                        status: "modified",
                                        stats: { hunks: 1, additions: 1, deletions: 0 },
                                        hunks: [
                                            {
                                                id: "frontend/app/term/render/agent-progress-view.tsx:1",
                                                path: "frontend/app/term/render/agent-progress-view.tsx",
                                                oldStart: 10,
                                                oldLines: 1,
                                                newStart: 10,
                                                newLines: 2,
                                                header: "function StageOverview",
                                                additions: 1,
                                                deletions: 0,
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                        ungroupedFiles: [],
                        warnings: [],
                    },
                },
            })
        );

        expect(html.match(/UI rendering/g)).toHaveLength(1);
        expect(html).toContain('data-agent-progress-stage-details="modify-files"');
        expect(html).not.toContain('data-agent-progress-stage-details="modify-files-2"');
    });

    it("renders the default overview as stage toggles without global technical details", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "grep-1",
                            name: "grep",
                            input: { pattern: "ToolCallCard", path: "frontend/app" },
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
                    toolCallId: "grep-1",
                    toolName: "grep",
                    content: [{ type: "text", text: "ToolCallCard" }],
                    isError: false,
                },
                {
                    role: "toolResult",
                    toolCallId: "test-1",
                    toolName: "functions.exec_command",
                    content: [{ type: "text", text: "1 passed" }],
                    isError: false,
                },
            ])
        );

        const html = renderToStaticMarkup(createElement(AgentProgressView, { progress }));

        expect(html).toContain("Explore implementation");
        expect(html).toContain("Verify result");
        expect(html).toContain('data-agent-progress-rail="true"');
        expect(html).toContain('data-agent-progress-stage-toggle="explore-implementation"');
        expect(html).toContain('data-agent-progress-stage-toggle="verify-result"');
        expect(html).not.toContain('data-agent-progress-technical-details-toggle="true"');
        expect(html).not.toContain("View technical calls/details");
        expect(html).not.toContain('data-agent-progress-technical-details="true"');
        expect(html).not.toContain("grep");
        expect(html).not.toContain("functions.exec_command");
        expect(html).not.toContain("ToolCallCard");
    });

    it("keeps raw technical cards hidden in the progress UI path", () => {
        const progress = deriveAgentProgress(
            makeRun([
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
                {
                    role: "toolResult",
                    toolCallId: "grep-1",
                    toolName: "grep",
                    content: [{ type: "text", text: "frontend/app/term/render/tool-call-card.tsx" }],
                    isError: false,
                },
            ])
        );

        const html = renderToStaticMarkup(createElement(AgentProgressView, { progress, showTechnicalDetails: true }));

        expect(html).toContain('data-agent-progress-rail="true"');
        expect(html).toContain('data-agent-progress-stage-toggle="explore-implementation"');
        expect(html).toContain('data-agent-progress-stage-details="explore-implementation"');
        expect(html).not.toContain('data-agent-progress-technical-details-toggle="true"');
        expect(html).not.toContain("Hide technical calls/details");
        expect(html).not.toContain('data-agent-progress-technical-details="true"');
        expect(html).not.toContain('data-tool-callid="grep-1"');
        expect(html).not.toContain('data-tool-name="grep"');
        expect(html).not.toContain("ToolCallCard");
    });

    it("renders compact summary and non-action detail evidence for expanded file-edit child actions without raw output or tool cards", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "edit-1",
                            name: "edit_text_file",
                            input: { path: "frontend/app/term/render/agent-progress.ts" },
                        },
                    ],
                },
                {
                    role: "toolResult",
                    toolCallId: "edit-1",
                    toolName: "edit_text_file",
                    content: [
                        {
                            type: "text",
                            text: "*** Begin Patch\n*** Update File: frontend/app/term/render/agent-progress.ts\nraw diff output",
                        },
                    ],
                    isError: false,
                },
            ])
        );

        const html = renderToStaticMarkup(createElement(AgentProgressView, { progress, showTechnicalDetails: true }));

        expect(html).toContain('data-agent-progress-stage-details="modify-files"');
        expect(html).toContain('data-agent-progress-action-summary="edit-1"');
        expect(html).toContain('data-agent-progress-file-link="edit-1"');
        expect(html).toContain('data-agent-progress-file-path="frontend/app/term/render/agent-progress.ts"');
        expect(html).toContain('data-agent-progress-action-evidence="edit-1"');
        expect(html).toContain("Updated ");
        expect(html).toContain("frontend/app/term/render/agent-progress.ts");
        expect(html).not.toContain("View diff");
        expect(html).not.toContain('data-agent-progress-action-diff="edit-1"');
        expect(html).not.toContain('>agent-progress.ts</span><span class="ml-1');
        expect(html).not.toContain(">Updated file</span>");
        expect(html).not.toContain("*** Begin Patch");
        expect(html).not.toContain("raw diff output");
        expect(html).not.toContain('data-tool-callid="edit-1"');
        expect(html).not.toContain('data-tool-name="edit_text_file"');
        expect(html).not.toContain("ToolCallCard");
    });

    it("omits evidence detail when a file-edit child action has no file detail", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "edit-no-file",
                            name: "edit_text_file",
                            input: { oldText: "before", newText: "after" },
                        },
                    ],
                },
                {
                    role: "toolResult",
                    toolCallId: "edit-no-file",
                    toolName: "edit_text_file",
                    content: [{ type: "text", text: "raw edit output" }],
                    isError: false,
                },
            ])
        );

        const html = renderToStaticMarkup(createElement(AgentProgressView, { progress, showTechnicalDetails: true }));

        expect(html).toContain('data-agent-progress-action-summary="edit-no-file"');
        expect(html).toContain("Updated file");
        expect(html).not.toContain('data-agent-progress-action-detail="edit-no-file"');
        expect(html).not.toContain('data-agent-progress-action-diff="edit-no-file"');
        expect(html).not.toContain('data-agent-progress-action-evidence="edit-no-file"');
        expect(html).not.toContain("View diff");
        expect(html).not.toContain("raw edit output");
        expect(html).not.toContain("ToolCallCard");
    });

    it("does not render validation evidence in expanded validation stages", () => {
        const progress = deriveAgentProgress(
            makeRun([
                {
                    role: "assistant",
                    content: [
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
                    toolCallId: "test-1",
                    toolName: "functions.exec_command",
                    content: [{ type: "text", text: "16 passed" }],
                    isError: false,
                },
            ])
        );

        const html = renderToStaticMarkup(createElement(AgentProgressView, { progress, showTechnicalDetails: true }));

        expect(html).toContain('data-agent-progress-stage-details="verify-result"');
        expect(html).not.toContain('data-agent-progress-action-summary="test-1"');
        expect(html).not.toContain('data-agent-progress-action-detail="test-1"');
        expect(html).not.toContain('data-agent-progress-action-evidence="test-1"');
        expect(html).not.toContain("16 passed");
        expect(html).not.toContain("ToolCallCard");
    });

    it("renders running current action and recent actions in the overview", () => {
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
                                input: { pattern: "AgentProgressView", path: "frontend/app" },
                            },
                            {
                                type: "toolCall",
                                id: "read-1",
                                name: "read_text_file",
                                input: { path: "frontend/app/term/render/agent-progress-view.tsx" },
                            },
                        ],
                    },
                    {
                        role: "toolResult",
                        toolCallId: "grep-1",
                        toolName: "grep",
                        content: [{ type: "text", text: "agent-progress-view.tsx" }],
                        isError: false,
                    },
                ],
                "streaming"
            )
        );

        const html = renderToStaticMarkup(createElement(AgentProgressView, { progress }));

        expect(html).toContain('data-agent-progress-status="running"');
        expect(html).toContain('data-agent-progress-current-action="true"');
        expect(html).toContain("Inspecting project files.");
        expect(html).toContain('data-agent-progress-recent-action="grep-1"');
        expect(html).toContain('data-agent-progress-recent-action="read-1"');
        expect(html).toContain('data-agent-progress-recent-action-status="done"');
        expect(html).toContain('data-agent-progress-recent-action-status="running"');
    });
});
