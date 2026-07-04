// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { PiRun } from "@/app/store/use-pi-chat";
import {
    compactToolCommand,
    compactToolIcon,
    compactToolKind,
    compactToolLabel,
    compactToolPath,
    compactToolSummary,
    deriveAgentToolViewModel,
    deriveCompactToolKind,
    deriveCompactToolStatus,
    groupCompactTools,
    isCompactReadGroup,
    isHeavyCompactTool,
    renderCompactToolResultText,
    type CompactToolCall,
    type CompactToolItem,
    type CompactToolResult,
} from "./agent-tool-view-model";

function makeRun(responseMessages: PiRun["responseMessages"], status: PiRun["status"] = "done"): PiRun {
    return {
        runId: "run-1",
        userMessage: {
            role: "user",
            content: [{ type: "text", text: "update the app" }],
            timestamp: 1,
        },
        responseMessages,
        status,
    };
}

const doneResult: CompactToolResult = {
    content: [{ type: "text", text: "ok" }],
    isError: false,
};

function compactCall(overrides: Partial<CompactToolCall>): CompactToolCall {
    return {
        id: "tool-1",
        name: "read_text_file",
        input: { path: "src/app.ts" },
        ...overrides,
    };
}

function compactItem(call: CompactToolCall, result?: CompactToolResult): CompactToolItem {
    return {
        call,
        status: deriveCompactToolStatus(call, result),
        kind: compactToolKind(call),
        result,
    };
}

describe("deriveAgentToolViewModel", () => {
    it("matches tool results to assistant tool calls while preserving call order", () => {
        const viewModel = deriveAgentToolViewModel(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        { type: "toolCall", id: "read-1", name: "read_text_file", input: { path: "src/app.ts" } },
                        { type: "toolCall", id: "edit-1", name: "edit_text_file", input: { path: "src/app.ts" } },
                        { type: "toolCall", id: "test-1", name: "bash", input: { command: "npm test -- --run app.test.ts" } },
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
                    content: [
                        {
                            type: "toolResult",
                            toolCallId: "edit-1",
                            content: [{ type: "text", text: "patched" }],
                            isError: true,
                        },
                    ],
                },
            ])
        );

        expect(viewModel.tools.map((tool) => tool.id)).toEqual(["read-1", "edit-1", "test-1"]);
        expect(viewModel.tools.map((tool) => tool.status)).toEqual(["done", "failed", "running"]);
        expect(viewModel.tools[0].result?.content?.[0]?.text).toBe("source");
        expect(viewModel.tools[1].result?.isError).toBe(true);
        expect(viewModel.tools[2].result).toBeUndefined();
    });

    it("derives product-facing categories, summaries, risks, and file details", () => {
        const viewModel = deriveAgentToolViewModel(
            makeRun([
                {
                    role: "assistant",
                    content: [
                        { type: "toolCall", id: "find-1", name: "find", input: { pattern: "*.ts" } },
                        { type: "toolCall", id: "edit-1", name: "edit", input: { file_path: "frontend/app/term/render/agent-progress.ts" } },
                        { type: "toolCall", id: "test-1", name: "functions.exec_command", input: { cmd: "npm test -- --run agent-progress.test.ts" } },
                        { type: "toolCall", id: "fetch-1", name: "web_fetch", input: { url: "https://example.com" } },
                    ],
                },
                {
                    role: "toolResult",
                    toolCallId: "find-1",
                    toolName: "find",
                    content: [{ type: "text", text: "agent-progress.ts" }],
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
                    toolCallId: "test-1",
                    toolName: "functions.exec_command",
                    content: [{ type: "text", text: "1 passed" }],
                    isError: false,
                },
                {
                    role: "toolResult",
                    toolCallId: "fetch-1",
                    toolName: "web_fetch",
                    content: [{ type: "text", text: "html" }],
                    isError: false,
                },
            ])
        );

        expect(viewModel.tools).toEqual([
            expect.objectContaining({
                id: "find-1",
                category: "explore",
                title: "Explore implementation",
                summary: "Inspected project files.",
                risk: "read-only",
            }),
            expect.objectContaining({
                id: "edit-1",
                category: "modify",
                title: "Modify files",
                summary: "Updated agent-progress.ts",
                detail: "frontend/app/term/render/agent-progress.ts",
                risk: "file-edit",
            }),
            expect.objectContaining({
                id: "test-1",
                category: "verify",
                title: "Verify result",
                summary: "Ran validation.",
                risk: "command",
            }),
            expect.objectContaining({
                id: "fetch-1",
                category: "external",
                title: "Gather external context",
                summary: "Gathered external context.",
                risk: "network",
            }),
        ]);
    });
});

describe("compact tool helpers", () => {
    it("derives compact tool status and kind from tool call/result pairs", () => {
        expect(deriveCompactToolStatus(compactCall({ id: "running" }))).toBe("running");
        expect(deriveCompactToolStatus(compactCall({ id: "done" }), doneResult)).toBe("done");
        expect(deriveCompactToolStatus(compactCall({ id: "failed" }), { ...doneResult, isError: true })).toBe("failed");

        expect(compactToolKind(compactCall({ name: "read_text_file" }))).toBe("read");
        expect(deriveCompactToolKind(compactCall({ name: "read_text_file" }))).toBe("read");
        expect(compactToolKind(compactCall({ name: "grep" }))).toBe("search");
        expect(compactToolKind(compactCall({ name: "edit_text_file" }))).toBe("edit");
        expect(compactToolKind(compactCall({ name: "functions.exec_command", input: { cmd: "npm test" } }))).toBe("command");
        expect(compactToolKind(compactCall({ name: "web_fetch" }))).toBe("web");
        expect(compactToolKind(compactCall({ name: "spawn_cli_agent" }))).toBe("agent");
        expect(compactToolKind(compactCall({ name: "unknown_tool" }))).toBe("other");
    });

    it("renders compact labels, icons, summaries, paths, and commands", () => {
        const read = compactItem(compactCall({ name: "read_text_file", input: { path: "src/app.ts" } }), doneResult);
        const search = compactItem(compactCall({ id: "grep-1", name: "grep", input: { pattern: "TODO", path: "src" } }));
        const edit = compactItem(compactCall({ id: "edit-1", name: "edit_text_file", input: { file_path: "frontend/app.ts" } }), doneResult);
        const command = compactItem(compactCall({ id: "cmd-1", name: "bash", input: { command: "npm test -- --run app.test.ts" } }));
        const failedWeb = compactItem(
            compactCall({ id: "web-1", name: "web_fetch", input: { url: "https://example.com/docs" } }),
            { content: [{ type: "text", text: "network failed" }], isError: true }
        );

        expect(compactToolLabel(read)).toBe("Read app.ts");
        expect(compactToolIcon(read)).toBe("file");
        expect(compactToolSummary(read)).toBe("Read src/app.ts");
        expect(compactToolPath(read)).toBe("src/app.ts");

        expect(compactToolLabel(search)).toBe("Search src");
        expect(compactToolIcon(search)).toBe("search");
        expect(compactToolSummary(search)).toBe("Searching src for TODO");

        expect(compactToolLabel(edit)).toBe("Edit app.ts");
        expect(compactToolSummary(edit)).toBe("Updated frontend/app.ts");

        expect(compactToolLabel(command)).toBe("Run command");
        expect(compactToolIcon(command)).toBe("terminal");
        expect(compactToolCommand(command)).toBe("npm test -- --run app.test.ts");
        expect(compactToolSummary(command)).toBe("Running npm test -- --run app.test.ts");

        expect(compactToolLabel(failedWeb)).toBe("Fetch example.com");
        expect(compactToolIcon(failedWeb)).toBe("globe");
        expect(compactToolSummary(failedWeb)).toBe("Failed to fetch https://example.com/docs");
    });

    it("renders compact result text from top-level and nested text parts", () => {
        expect(renderCompactToolResultText({ content: [{ type: "text", text: "plain output" }] })).toBe("plain output");
        expect(
            renderCompactToolResultText({
                content: [
                    {
                        type: "toolResult",
                        content: [
                            { type: "text", text: "nested" },
                            { type: "text", text: "output" },
                        ],
                    },
                ],
            })
        ).toBe("nested\noutput");
        expect(renderCompactToolResultText({ content: [{ type: "image", data: "..." }] })).toBe("");
    });

    it("groups consecutive compact read tools and identifies read groups and heavy tools", () => {
        const readOne = compactItem(compactCall({ id: "read-1", name: "read_text_file", input: { path: "src/a.ts" } }), doneResult);
        const readTwo = compactItem(compactCall({ id: "read-2", name: "ls", input: { path: "src" } }), doneResult);
        const edit = compactItem(compactCall({ id: "edit-1", name: "edit", input: { path: "src/a.ts" } }), doneResult);
        const grep = compactItem(compactCall({ id: "grep-1", name: "grep", input: { pattern: "TODO" } }), doneResult);

        const groups = groupCompactTools([readOne, readTwo, edit, grep]);

        expect(groups).toEqual([
            { id: "read-group-read-1", kind: "read-group", items: [readOne, readTwo] },
            { id: "tool-edit-1", kind: "tool", item: edit },
            { id: "tool-grep-1", kind: "tool", item: grep },
        ]);
        expect(isCompactReadGroup(groups[0])).toBe(true);
        expect(isCompactReadGroup(groups[1])).toBe(false);
        expect(isHeavyCompactTool(readOne)).toBe(false);
        expect(isHeavyCompactTool(grep)).toBe(false);
        expect(isHeavyCompactTool(edit)).toBe(true);
    });
});
