// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PiRun } from "@/app/store/use-pi-chat";
import { AgentBlockElement } from "./agent-block-element";
import { ToolCallCard } from "./tool-call-card";

function makeRun(
    responseContent: Array<{ type: string; [field: string]: unknown }>,
    responseMessages?: PiRun["responseMessages"]
): PiRun {
    return {
        runId: "run-1",
        userMessageIndex: 0,
        userMessage: {
            role: "user",
            content: [{ type: "text", text: "show me" }],
            timestamp: 1,
        },
        responseMessages: responseMessages ?? [
            {
                role: "assistant",
                content: responseContent,
                stopReason: "stop",
            },
        ],
        status: "done",
    };
}

describe("AgentBlockElement content rendering", () => {
    it("renders assistant thinking content instead of dropping it", () => {
        const html = renderToStaticMarkup(
            <AgentBlockElement run={makeRun([{ type: "thinking", thinking: "I need to inspect the file first." }])} />
        );

        expect(html).toContain("Thinking");
        expect(html).toContain("I need to inspect the file first.");
    });

    it("keeps empty signed thinking visible after the run ends", () => {
        const html = renderToStaticMarkup(
            <AgentBlockElement
                run={makeRun([{ type: "thinking", thinking: "", thinkingSignature: "encrypted-reasoning" }])}
            />
        );

        expect(html).toContain("Thinking");
        expect(html).toContain("Reasoning content is not available.");
    });

    it("renders pi tool-call runs as compact tool rows by default", () => {
        const html = renderToStaticMarkup(
            <AgentBlockElement
                run={makeRun(
                    [],
                    [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "toolCall",
                                    id: "tc1",
                                    name: "shell_exec",
                                    arguments: { cmd: "echo hi" },
                                },
                            ],
                        },
                        {
                            role: "toolResult",
                            toolCallId: "tc1",
                            toolName: "shell_exec",
                            content: [{ type: "text", text: "hi\n" }],
                            isError: false,
                        },
                        {
                            role: "assistant",
                            content: [{ type: "text", text: "done" }],
                            stopReason: "stop",
                        },
                    ]
                )}
            />
        );

        expect(html).toContain('data-agent-compact-tool-list="true"');
        expect(html).toContain('data-agent-compact-tool-row="tc1"');
        expect(html).toContain('data-agent-compact-tool-kind="command"');
        expect(html).toContain('data-agent-compact-tool-status="done"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain("Run command");
        expect(html).toContain("Ran echo hi");
        expect(html).toContain("done");
        expect(html).not.toContain('data-agent-progress-view="true"');
        expect(html).not.toContain('data-tool-name="shell_exec"');
        expect(html).not.toContain('data-tool-callid="tc1"');
    });

    it("renders progress view instead of compact tool rows when requested", () => {
        const html = renderToStaticMarkup(
            <AgentBlockElement
                toolPresentation="progress"
                run={makeRun(
                    [],
                    [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "toolCall",
                                    id: "grep-1",
                                    name: "grep",
                                    input: { pattern: "AgentProgressView", path: "frontend/app/term/render" },
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
                    ]
                )}
            />
        );

        expect(html).toContain('data-agent-progress-view="true"');
        expect(html).toContain('data-agent-progress-rail="true"');
        expect(html).toContain("Inspected project files and existing implementation.");
        expect(html).not.toContain('data-agent-compact-tool-list="true"');
        expect(html).not.toContain('data-agent-compact-tool-row="grep-1"');
    });

    it("interleaves compact tool rows with assistant text, thinking, and images in order", () => {
        const html = renderToStaticMarkup(
            <AgentBlockElement
                run={makeRun(
                    [],
                    [
                        {
                            role: "assistant",
                            content: [
                                { type: "text", text: "Before **tools**." },
                                { type: "thinking", thinking: "Need to inspect the code." },
                                {
                                    type: "toolCall",
                                    id: "grep-1",
                                    name: "grep",
                                    input: { pattern: "AgentProgressView", path: "frontend/app/term/render" },
                                },
                                { type: "image", data: "abc123", mimeType: "image/png" },
                                { type: "text", text: "After tools." },
                            ],
                        },
                        {
                            role: "toolResult",
                            toolCallId: "grep-1",
                            toolName: "grep",
                            content: [{ type: "text", text: "agent-progress-view.tsx" }],
                            isError: false,
                        },
                    ]
                )}
            />
        );

        const beforeIndex = html.indexOf("Before <strong>tools</strong>.");
        const thinkingIndex = html.indexOf("Need to inspect the code.");
        const toolIndex = html.indexOf('data-agent-compact-tool-row="grep-1"');
        const imageIndex = html.indexOf('src="data:image/png;base64,abc123"');
        const afterIndex = html.indexOf("After tools.");

        expect(html).toContain('data-agent-compact-tool-list="true"');
        expect(html).toContain('data-agent-compact-tool-row="grep-1"');
        expect(html).toContain('data-agent-compact-tool-kind="search"');
        expect(html).toContain("Search frontend/app/term/render");
        expect(html).not.toContain('data-tool-name="grep"');
        expect(html).not.toContain('data-tool-callid="grep-1"');
        expect(html).toContain("Before <strong>tools</strong>.");
        expect(html).toContain("Thinking");
        expect(html).toContain("Need to inspect the code.");
        expect(html).toContain('src="data:image/png;base64,abc123"');
        expect(html).toContain("After tools.");
        expect(beforeIndex).toBeGreaterThan(-1);
        expect(thinkingIndex).toBeGreaterThan(beforeIndex);
        expect(toolIndex).toBeGreaterThan(thinkingIndex);
        expect(imageIndex).toBeGreaterThan(toolIndex);
        expect(afterIndex).toBeGreaterThan(imageIndex);
    });

    it("groups consecutive read tools inside the assistant content flow", () => {
        const html = renderToStaticMarkup(
            <AgentBlockElement
                run={makeRun(
                    [],
                    [
                        {
                            role: "assistant",
                            content: [
                                { type: "text", text: "Read these first." },
                                { type: "toolCall", id: "read-1", name: "read_text_file", input: { path: "src/a.ts" } },
                                { type: "toolCall", id: "read-2", name: "ls", input: { path: "src" } },
                                { type: "text", text: "Then edit." },
                                { type: "toolCall", id: "edit-1", name: "edit", input: { path: "src/a.ts" } },
                            ],
                        },
                        {
                            role: "toolResult",
                            toolCallId: "read-1",
                            toolName: "read_text_file",
                            content: [{ type: "text", text: "a" }],
                            isError: false,
                        },
                        {
                            role: "toolResult",
                            toolCallId: "read-2",
                            toolName: "ls",
                            content: [{ type: "text", text: "a.ts" }],
                            isError: false,
                        },
                        {
                            role: "toolResult",
                            toolCallId: "edit-1",
                            toolName: "edit",
                            content: [{ type: "text", text: "updated" }],
                            isError: false,
                        },
                    ]
                )}
            />
        );
        const readIntroIndex = html.indexOf("Read these first.");
        const readGroupIndex = html.indexOf('data-agent-compact-read-group="read-group-read-1"');
        const editIntroIndex = html.indexOf("Then edit.");
        const editRowIndex = html.indexOf('data-agent-compact-tool-row="edit-1"');

        expect(html).toContain('data-agent-compact-read-count="2"');
        expect(html).toContain("Read 2 files");
        expect(html).toContain("a.ts");
        expect(html).toContain('data-agent-compact-tool-row="edit-1"');
        expect(readIntroIndex).toBeGreaterThan(-1);
        expect(readGroupIndex).toBeGreaterThan(readIntroIndex);
        expect(editIntroIndex).toBeGreaterThan(readGroupIndex);
        expect(editRowIndex).toBeGreaterThan(editIntroIndex);
    });

    it("summarizes shell tool calls as compact validation rows", () => {
        const html = renderToStaticMarkup(
            <AgentBlockElement
                run={makeRun(
                    [],
                    [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "toolCall",
                                    id: "tc1",
                                    name: "shell_exec",
                                    input: {
                                        command: "npm test -- frontend/app/term/render/agent-block-element.test.tsx",
                                    },
                                },
                            ],
                        },
                        {
                            role: "toolResult",
                            toolCallId: "tc1",
                            toolName: "shell_exec",
                            content: [{ type: "text", text: "Test Files 1 passed\n" }],
                            isError: false,
                        },
                    ]
                )}
            />
        );

        expect(html).toContain('data-agent-compact-tool-row="tc1"');
        expect(html).toContain('data-agent-compact-tool-kind="command"');
        expect(html).toContain("Run command");
        expect(html).toContain("Ran npm test -- frontend/app/term/render/agent-block-element.test.tsx");
        expect(html).not.toContain('data-tool-action=""');
        expect(html).not.toContain('data-tool-name="shell_exec"');
    });

    it("summarizes namespaced command tools as compact rows without exposing raw tool metadata", () => {
        const html = renderToStaticMarkup(
            <AgentBlockElement
                run={makeRun(
                    [],
                    [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "toolCall",
                                    id: "tc1",
                                    name: "functions.exec_command",
                                    input: { cmd: "npm run lint", workdir: "/repo", yield_time_ms: 1000 },
                                },
                            ],
                        },
                    ]
                )}
            />
        );

        expect(html).toContain('data-agent-compact-tool-row="tc1"');
        expect(html).toContain('data-agent-compact-tool-kind="command"');
        expect(html).toContain("Run command");
        expect(html).toContain("Running npm run lint");
        expect(html).not.toContain('data-tool-title="npm run lint"');
        expect(html).not.toContain("functions.exec_command");
        expect(html).not.toContain("yield_time_ms");
    });

    it("summarizes failed tool results as compact rows without raw tool cards", () => {
        const html = renderToStaticMarkup(
            <AgentBlockElement
                run={makeRun(
                    [],
                    [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "toolCall",
                                    id: "tc1",
                                    name: "grep",
                                    input: { pattern: "ToolCallCard", path: "frontend/app" },
                                },
                            ],
                        },
                        {
                            role: "toolResult",
                            toolCallId: "tc1",
                            toolName: "grep",
                            content: [{ type: "text", text: "Invalid regex pattern: unterminated group" }],
                            isError: true,
                        },
                    ]
                )}
            />
        );

        expect(html).toContain('data-agent-compact-tool-row="tc1"');
        expect(html).toContain('data-agent-compact-tool-status="failed"');
        expect(html).toContain("Search frontend/app");
        expect(html).toContain("Could not inspect project files.");
        expect(html).not.toContain("Grepping for");
        expect(html).not.toContain('data-tool-status="error"');
    });

    it("auto-expands failed tool cards to show error details", () => {
        const html = renderToStaticMarkup(
            <ToolCallCard
                call={{
                    id: "tc1",
                    name: "grep",
                    input: { pattern: "(", path: "frontend/app" },
                }}
                result={{
                    content: [{ type: "text", text: "Invalid regex pattern: unterminated group" }],
                    isError: true,
                }}
            />
        );

        expect(html).toContain('data-tool-status="error"');
        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain('data-tool-detail-body="true"');
        expect(html).toContain('data-tool-detail-section="result"');
        expect(html).toContain("Invalid regex pattern: unterminated group");
    });

    it("renders file discovery tools with Warp file-glob wording", () => {
        const html = renderToStaticMarkup(
            <ToolCallCard
                call={{
                    id: "tc1",
                    name: "find",
                    input: { pattern: "*.tsx", path: "frontend/app" },
                }}
                result={{
                    content: [{ type: "text", text: "frontend/app/term/render/tool-call-card.tsx" }],
                    isError: false,
                }}
            />
        );

        expect(html).toContain('data-tool-kind="find"');
        expect(html).toContain('data-tool-title="Finding files that match *.tsx in frontend/app"');
        expect(html).not.toContain("Grepping for *.tsx");
    });

    it("renders write tool details as a file preview instead of escaped JSON", () => {
        const html = renderToStaticMarkup(
            <ToolCallCard
                defaultExpanded
                call={{
                    id: "tc1",
                    name: "write",
                    input: {
                        path: "main.go",
                        content: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("ok")\n}\n',
                    },
                }}
                result={{
                    content: [{ type: "text", text: "Successfully wrote 64 bytes to main.go" }],
                    isError: false,
                }}
            />
        );

        expect(html).toContain('data-tool-title="main.go"');
        expect(html).toContain("main.go");
        expect(html).toContain('data-tool-detail-body="true"');
        expect(html).toContain('data-tool-detail-section="content"');
        expect(html).toContain('data-tool-file-chip="main.go"');
        expect(html).toContain("package main");
        expect(html).toContain("fmt.Println");
        expect(html).toContain("Successfully wrote 64 bytes to main.go");
        expect(html).not.toContain('data-tool-diff-tabs="true"');
        expect(html).not.toContain("&quot;content&quot;");
        expect(html).not.toContain("\\n\\nimport");
    });

    it("renders edit tool details as a diff with file path actions", () => {
        const html = renderToStaticMarkup(
            <ToolCallCard
                defaultExpanded
                call={{
                    id: "tc1",
                    name: "edit",
                    input: {
                        path: "/repo/main.go",
                        edits: [{ oldText: 'fmt.Println("old")', newText: 'fmt.Println("new")' }],
                    },
                }}
                result={{
                    content: [{ type: "text", text: "Successfully replaced 1 block(s) in /repo/main.go." }],
                    details: {
                        diff: '- fmt.Println("old")\n+ fmt.Println("new")',
                        patch: '@@ -1 +1 @@\n- fmt.Println("old")\n+ fmt.Println("new")',
                    },
                    isError: false,
                }}
            />
        );

        expect(html).toContain("/repo/main.go");
        expect(html).toContain("Copy path");
        expect(html).toContain("Open file");
        expect(html).toContain('data-tool-diff="true"');
        expect(html).toContain('data-tool-diff-file="/repo/main.go"');
        expect(html).toContain('data-tool-diff-tabs="true"');
        expect(html).toContain('data-tool-diff-editor="true"');
        expect(html).toContain('data-diff-stat-added="1"');
        expect(html).toContain('data-diff-stat-removed="1"');
        expect(html).toContain('data-diff-line-type="remove"');
        expect(html).toContain('data-diff-line-type="add"');
        expect(html).toContain("fmt.Println(&quot;old&quot;)");
        expect(html).toContain("fmt.Println(&quot;new&quot;)");
        expect(html).not.toContain("@@ -1 +1 @@");
        expect(html).not.toContain("- fmt.Println(&quot;old&quot;)");
        expect(html).not.toContain("+ fmt.Println(&quot;new&quot;)");
        expect(html).not.toContain("(tc1)");
        expect(html).not.toContain("oldText");
    });

    it("renders completed edit diffs with Warp-style card chrome and hunk navigation", () => {
        const html = renderToStaticMarkup(
            <ToolCallCard
                defaultExpanded
                call={{
                    id: "tc1",
                    name: "edit",
                    input: {
                        path: ".gitconfig",
                        title: "Update .gitconfig with ByteDance Codebase configuration",
                    },
                }}
                result={{
                    content: [{ type: "text", text: "Successfully updated .gitconfig" }],
                    details: {
                        diff: [
                            "@@ -0,0 +1,11 @@",
                            "+[user]",
                            "+    email = zhenxing.shen@bytedance.com",
                            "+    name = zhenxing.shen",
                            '+[url "git"]',
                            "+    insteadOf = git://git.byted.org/",
                            '+[credential "https://code.byted.org"]',
                            "+    username = zhenxing.shen",
                            '+[url "ssh://zhenxing.shen@git.byted.org:29418"]',
                            "+    insteadOf = https://git.byted.org",
                            '+[url "git@code.byted.org:"]',
                            "+    insteadOf = https://code.byted.org/",
                        ].join("\n"),
                    },
                    isError: false,
                }}
            />
        );

        expect(html).toContain('data-warp-tool-card="true"');
        expect(html).toContain('data-tool-title="Update .gitconfig with ByteDance Codebase configuration"');
        expect(html).toContain("Update .gitconfig with ByteDance Codebase configuration");
        expect(html).toContain('data-diff-stat-added="11"');
        expect(html).toContain("+11");
        expect(html).toContain('data-warp-diff-file-bar="true"');
        expect(html).toContain(".gitconfig");
        expect(html).toContain('data-diff-new-line="1"');
        expect(html).toContain('data-diff-new-line="11"');
        expect(html).toContain('data-warp-added-gutter="true"');
        expect(html).toContain('data-warp-hunk-nav="true"');
        expect(html).toContain("Hunk:");
        expect(html).toContain("1/1");
        expect(html).toContain("Previous");
        expect(html).toContain("Next");
    });

    it("renders rich activity feed metadata for completed command calls", () => {
        const html = renderToStaticMarkup(
            <ToolCallCard
                call={{
                    id: "tc1",
                    name: "shell_exec",
                    input: { command: "npm test", cwd: "/repo" },
                }}
                result={{
                    content: [{ type: "text", text: "Test Files 1 passed\nTests 4 passed\n" }],
                    isError: false,
                }}
            />
        );

        expect(html).toContain('data-tool-activity="true"');
        expect(html).toContain('data-tool-kind="command"');
        expect(html).toContain('data-tool-title="npm test"');
        expect(html).toContain('data-tool-action=""');
    });

    it("renders rich activity feed metadata for completed file edits", () => {
        const html = renderToStaticMarkup(
            <ToolCallCard
                call={{
                    id: "tc1",
                    name: "edit",
                    input: { path: "frontend/app/term/render/tool-call-card.tsx" },
                }}
                result={{
                    content: [{ type: "text", text: "Successfully edited tool-call-card.tsx" }],
                    details: { diff: "- old\n+ new\n+ another" },
                    isError: false,
                }}
            />
        );

        expect(html).toContain('data-tool-title="tool-call-card.tsx"');
        expect(html).toContain("+2");
        expect(html).toContain("-1");
        expect(html).toContain('data-tool-action=""');
    });

    it("keeps structured edit input inspectable when no diff is available", () => {
        const html = renderToStaticMarkup(
            <ToolCallCard
                defaultExpanded
                call={{
                    id: "tc1",
                    name: "edit",
                    input: {
                        path: "main.go",
                        edits: [{ oldText: 'fmt.Println("old")', newText: 'fmt.Println("new")' }],
                    },
                }}
                result={{
                    content: [{ type: "text", text: "Successfully replaced 1 block(s) in main.go." }],
                    isError: false,
                }}
            />
        );

        expect(html).toContain("input");
        expect(html).toContain("oldText");
        expect(html).toContain("fmt.Println");
        expect(html).toContain("Successfully replaced 1 block(s) in main.go.");
    });

    it("keeps successful edit result text visible alongside rendered diffs", () => {
        const html = renderToStaticMarkup(
            <ToolCallCard
                defaultExpanded
                call={{ id: "tc1", name: "edit", input: { path: "main.go" } }}
                result={{
                    content: [{ type: "text", text: "Successfully replaced 1 block(s) in main.go." }],
                    details: { diff: "- old\n+ new" },
                    isError: false,
                }}
            />
        );

        expect(html).toContain('data-tool-diff="true"');
        expect(html).toContain("Successfully replaced 1 block(s) in main.go.");
    });

    it("renders assistant image content from base64 data", () => {
        const html = renderToStaticMarkup(
            <AgentBlockElement run={makeRun([{ type: "image", data: "abc123", mimeType: "image/png" }])} />
        );

        expect(html).toContain("<img");
        expect(html).toContain('src="data:image/png;base64,abc123"');
    });
});
