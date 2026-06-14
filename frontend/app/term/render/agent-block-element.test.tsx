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

    it("renders pi tool calls with arguments and top-level tool results", () => {
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

        expect(html).toContain("echo hi");
        expect(html).toContain('data-tool-title="echo hi"');
        expect(html).toContain('data-tool-status="done"');
        expect(html).toContain('data-tool-callid="tc1"');
    });

    it("renders shell tool calls as readable inline action headers", () => {
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

        expect(html).toContain("npm test -- frontend/app/term/render/agent-block-element.test.tsx");
        expect(html).toContain('data-tool-action=""');
        expect(html).toContain('data-tool-title="npm test -- frontend/app/term/render/agent-block-element.test.tsx"');
    });

    it("summarizes namespaced command tools without dumping JSON into the header", () => {
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

        expect(html).toContain("npm run lint");
        expect(html).toContain('data-tool-title="npm run lint"');
        expect(html).toContain("functions.exec_command");
        expect(html).not.toContain("yield_time_ms");
    });

    it("shows error result previews in collapsed tool call headers", () => {
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

        expect(html).toContain("Grepping for");
        expect(html).toContain("ToolCallCard");
        expect(html).toContain('data-tool-status="error"');
        expect(html).toContain('data-tool-action=""');
        expect(html).toContain("Invalid regex pattern");
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
                        edits: [{ oldText: "fmt.Println(\"old\")", newText: "fmt.Println(\"new\")" }],
                    },
                }}
                result={{
                    content: [{ type: "text", text: "Successfully replaced 1 block(s) in /repo/main.go." }],
                    details: {
                        diff: "- fmt.Println(\"old\")\n+ fmt.Println(\"new\")",
                        patch: "@@ -1 +1 @@\n- fmt.Println(\"old\")\n+ fmt.Println(\"new\")",
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
                            "+[url \"git\"]",
                            "+    insteadOf = git://git.byted.org/",
                            "+[credential \"https://code.byted.org\"]",
                            "+    username = zhenxing.shen",
                            "+[url \"ssh://zhenxing.shen@git.byted.org:29418\"]",
                            "+    insteadOf = https://git.byted.org",
                            "+[url \"git@code.byted.org:\"]",
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
                        edits: [{ oldText: "fmt.Println(\"old\")", newText: "fmt.Println(\"new\")" }],
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
