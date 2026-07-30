// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
    buildReadActivityModel,
    buildSearchActivityModel,
    getToolActivityKind,
    type ToolActivityPart,
} from "./tool-activity-model";

function part(overrides: Partial<ToolActivityPart>): ToolActivityPart {
    return {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "find",
        args: { pattern: "*.md" },
        status: { type: "complete" },
        ...overrides,
    };
}

describe("Search tool activity model", () => {
    it("formats find with its glob and explicit path", () => {
        const model = buildSearchActivityModel([part({ args: { pattern: "*.md", path: "docs", limit: 20 } })]);

        expect(model.rules).toEqual([{ query: "*.md", scopes: ["docs"] }]);
        expect(model.label).toBe("Searched");
    });

    it("formats grep with query, path, and glob while omitting execution controls", () => {
        const model = buildSearchActivityModel([
            part({
                toolName: "grep",
                args: {
                    pattern: "TODO",
                    path: "frontend",
                    glob: "*.ts",
                    ignoreCase: true,
                    context: 3,
                    limit: 50,
                },
            }),
        ]);

        expect(model.rules).toEqual([{ query: "TODO", scopes: ["frontend", "*.ts"] }]);
    });

    it("groups only valid semantic calls without approval UI", () => {
        expect(getToolActivityKind(part({ toolName: "read", args: { path: "src/app.ts" } }))).toBe("read");
        expect(getToolActivityKind(part({ toolName: "find", args: {} }))).toBeUndefined();
        expect(
            getToolActivityKind(
                part({
                    toolName: "grep",
                    args: { pattern: "TODO" },
                    status: { type: "requires-action" },
                })
            )
        ).toBeUndefined();
    });
});

describe("Read tool activity model", () => {
    it("resolves paths, deduplicates continuation reads, and uses workspace-relative display paths", () => {
        const model = buildReadActivityModel(
            [
                part({ toolName: "read", args: { path: "src/app.ts" } }),
                part({ toolCallId: "call-2", toolName: "read", args: { path: "./src/app.ts", offset: 201 } }),
                part({ toolCallId: "call-3", toolName: "read", args: { path: "/outside/log.txt" } }),
            ],
            "/repo"
        );

        expect(model.entries).toEqual([
            {
                absolutePath: "/repo/src/app.ts",
                displayPath: "src/app.ts",
                basename: "app.ts",
                failed: false,
            },
            {
                absolutePath: "/outside/log.txt",
                displayPath: "/outside/log.txt",
                basename: "log.txt",
                failed: false,
            },
        ]);
        expect(model.summary).toBe("app.ts and log.txt");
    });

    it("summarizes three or more unique paths using the remaining count", () => {
        const model = buildReadActivityModel(
            [
                part({ toolName: "read", args: { path: "a.ts" } }),
                part({ toolCallId: "call-2", toolName: "read", args: { path: "b.ts" } }),
                part({ toolCallId: "call-3", toolName: "read", args: { path: "c.ts" } }),
            ],
            "/repo"
        );

        expect(model.summary).toBe("a.ts and 2 other files");
    });

    it("marks failed paths inactive and reports running state", () => {
        const model = buildReadActivityModel(
            [
                part({
                    toolName: "read",
                    args: { path: "missing.ts" },
                    status: { type: "incomplete", reason: "error", error: "not found" },
                }),
                part({
                    toolCallId: "call-2",
                    toolName: "read",
                    args: { path: "loading.ts" },
                    status: { type: "running" },
                }),
            ],
            "/repo"
        );

        expect(model.label).toBe("Reading");
        expect(model.entries[0]?.failed).toBe(true);
        expect(model.errors).toEqual(["not found"]);
    });
});
