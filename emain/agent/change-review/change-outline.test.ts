// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { AssistantMessage, Model, ToolResultMessage } from "../../ai";
import type { ChangeOperation } from "./change-operation";
import {
    buildChangeOutlinePrompt,
    buildCompactChangeSetJson,
    extractChangeOperationsFromMessages,
    generateChangeOutline,
    parseChangeOutlineText,
    type ChangeOutline,
} from "./change-outline";

const Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolResult(
    details: { changeOperation?: ChangeOperation },
    options: { isError?: boolean; toolCallId?: string } = {}
): ToolResultMessage {
    return {
        role: "toolResult",
        toolCallId: options.toolCallId ?? "tc-1",
        toolName: "edit",
        content: [{ type: "text", text: "ok" }],
        details,
        isError: options.isError ?? false,
        timestamp: 1,
    };
}

function assistantText(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai",
        provider: "openai",
        model: "fake",
        usage: Usage,
        stopReason: "stop",
        timestamp: 1,
    };
}

describe("extractChangeOperationsFromMessages", () => {
    it("extracts non-error tool result change operations and preserves run ids", () => {
        const operation: ChangeOperation = {
            id: "op-1",
            kind: "patch",
            path: "src/app.ts",
            patchStatus: "complete",
        };

        expect(
            extractChangeOperationsFromMessages(
                [toolResult({ changeOperation: operation }, { toolCallId: "tc-edit" })],
                {
                    runId: "run-1",
                }
            )
        ).toEqual([{ ...operation, runId: "run-1", toolCallId: "tc-edit" }]);
    });

    it("ignores errored tool results and messages without change operations", () => {
        const operation: ChangeOperation = { id: "op-1", kind: "write", path: "src/app.ts" };

        expect(
            extractChangeOperationsFromMessages([
                toolResult({ changeOperation: operation }, { isError: true }),
                { role: "user", content: "please edit", timestamp: 1 },
            ])
        ).toEqual([]);
    });
});

describe("buildCompactChangeSetJson", () => {
    it("builds deterministic compact JSON with file stats and hunk ids", () => {
        const patch = `--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@ function main
 const a = 1;
+const b = 2;
 const c = 3;
`;

        expect(
            JSON.parse(
                buildCompactChangeSetJson([
                    { id: "op-1", kind: "patch", path: "src/app.ts", patch, patchStatus: "complete" },
                ])
            )
        ).toEqual({
            files: [
                {
                    path: "src/app.ts",
                    status: "modified",
                    patchStatus: "complete",
                    stats: { hunks: 1, additions: 1, deletions: 0 },
                    hunks: [
                        {
                            id: "src/app.ts:1",
                            header: "function main",
                            oldStart: 1,
                            oldLines: 2,
                            newStart: 1,
                            newLines: 3,
                            additions: 1,
                            deletions: 0,
                        },
                    ],
                    operations: [{ id: "op-1", kind: "patch" }],
                },
            ],
            totals: { files: 1, hunks: 1, additions: 1, deletions: 0 },
        });
    });
});

describe("parseChangeOutlineText", () => {
    it("parses fenced JSON outlines and keeps only valid module fields", () => {
        const outline: ChangeOutline = parseChangeOutlineText(`
Here is the outline:

\`\`\`json
{
  "modules": [
    {
      "id": "ui",
      "title": "UI updates",
      "summary": "Adds controls",
      "files": [{ "path": "src/app.ts", "hunkIds": ["src/app.ts:1"] }]
    }
  ]
}
\`\`\`
`);

        expect(outline).toEqual({
            modules: [
                {
                    id: "ui",
                    title: "UI updates",
                    summary: "Adds controls",
                    files: [{ path: "src/app.ts", hunkIds: ["src/app.ts:1"] }],
                },
            ],
        });
    });

    it("throws a helpful error when the response is not a JSON object", () => {
        expect(() => parseChangeOutlineText("not json")).toThrow(/Unable to parse change outline JSON/);
    });
});

describe("buildChangeOutlinePrompt", () => {
    it("asks for a strict JSON outline using the compact change set", () => {
        const prompt = buildChangeOutlinePrompt(
            [
                {
                    id: "op-1",
                    kind: "write",
                    path: "src/new.ts",
                    patchStatus: "unavailable",
                    patchUnavailableReason: "not readable",
                },
            ],
            "Focus on review order"
        );

        expect(prompt).toContain("<changeSet>");
        expect(prompt).toContain('"path": "src/new.ts"');
        expect(prompt).toContain("Focus on review order");
        expect(prompt).toContain("Return only JSON");
    });
});

describe("generateChangeOutline", () => {
    it("uses the injected completion seam and parses the model response", async () => {
        const complete = vi.fn().mockResolvedValue(
            assistantText(`{
  "modules": [
    { "id": "backend", "title": "Backend seam", "files": [{ "path": "emain/agent/change-review/change-outline.ts" }] }
  ]
}`)
        );
        const model = { api: "openai", provider: "openai", id: "fake", contextWindow: 128000 } as unknown as Model;

        const outline = await generateChangeOutline({
            model,
            operations: [{ id: "op-1", kind: "write", path: "emain/agent/change-review/change-outline.ts" }],
            complete,
            apiKey: "test-key",
        });

        expect(outline.modules?.[0].title).toBe("Backend seam");
        expect(complete).toHaveBeenCalledTimes(1);
        expect(complete.mock.calls[0][0]).toBe(model);
        expect(complete.mock.calls[0][1].systemPrompt).toContain("change outline");
        expect(complete.mock.calls[0][2]).toMatchObject({ apiKey: "test-key" });
    });
});
