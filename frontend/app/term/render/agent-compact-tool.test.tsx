// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentCompactToolList, AgentCompactToolRow } from "./agent-compact-tool";
import {
    compactToolKind,
    deriveCompactToolStatus,
    groupCompactTools,
    type CompactToolCall,
    type CompactToolItem,
    type CompactToolResult,
} from "./agent-tool-view-model";

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

describe("AgentCompactToolRow", () => {
    it("renders a compact tool row from the view-model helpers", () => {
        const item = compactItem(
            compactCall({
                id: "cmd-1",
                name: "bash",
                input: { command: "npm test -- --run agent-compact-tool.test.tsx" },
            })
        );

        const html = renderToStaticMarkup(<AgentCompactToolRow item={item} />);

        expect(html).toContain('data-agent-compact-tool-row="cmd-1"');
        expect(html).toContain('data-agent-compact-tool-kind="command"');
        expect(html).toContain('data-agent-compact-tool-status="running"');
        expect(html).toContain("Run command");
        expect(html).toContain("Running npm test -- --run agent-compact-tool.test.tsx");
        expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain('data-agent-compact-tool-detail="cmd-1"');
    });

    it("defaults failed rows open and renders result detail text", () => {
        const item = compactItem(
            compactCall({ id: "grep-1", name: "grep", input: { pattern: "(", path: "frontend/app" } }),
            { content: [{ type: "text", text: "Invalid regex pattern: unterminated group" }], isError: true }
        );

        const html = renderToStaticMarkup(<AgentCompactToolRow item={item} />);

        expect(html).toContain('data-agent-compact-tool-row="grep-1"');
        expect(html).toContain('data-agent-compact-tool-status="failed"');
        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain('data-agent-compact-tool-detail="grep-1"');
        expect(html).toContain('data-agent-compact-tool-detail-section="result"');
        expect(html).toContain("Invalid regex pattern: unterminated group");
    });

    it("renders structured result details when expanded", () => {
        const item = compactItem(compactCall({ id: "edit-1", name: "edit", input: { path: "src/app.ts" } }), {
            content: [{ type: "text", text: "Updated src/app.ts" }],
            details: { diff: "-old\n+new", changedFiles: ["src/app.ts"] },
            isError: false,
        });

        const html = renderToStaticMarkup(<AgentCompactToolRow item={item} defaultExpanded />);

        expect(html).toContain('data-agent-compact-tool-detail="edit-1"');
        expect(html).toContain('data-agent-compact-tool-detail-section="result"');
        expect(html).toContain('data-agent-compact-tool-detail-section="details"');
        expect(html).toContain("Updated src/app.ts");
        expect(html).toContain("&quot;changedFiles&quot;");
        expect(html).toContain("src/app.ts");
    });
});

describe("AgentCompactToolList", () => {
    it("renders consecutive read tools as a compact read group", () => {
        const readOne = compactItem(
            compactCall({ id: "read-1", name: "read_text_file", input: { path: "src/a.ts" } }),
            doneResult
        );
        const readTwo = compactItem(compactCall({ id: "read-2", name: "ls", input: { path: "src" } }), doneResult);
        const edit = compactItem(compactCall({ id: "edit-1", name: "edit", input: { path: "src/a.ts" } }), doneResult);

        const html = renderToStaticMarkup(
            <AgentCompactToolList groups={groupCompactTools([readOne, readTwo, edit])} />
        );

        expect(html).toContain('data-agent-compact-tool-list="true"');
        expect(html).toContain('data-agent-compact-read-group="read-group-read-1"');
        expect(html).toContain('data-agent-compact-read-count="2"');
        expect(html).toContain("Read 2 files");
        expect(html).toContain("a.ts");
        expect(html).toContain("src");
        expect(html).toContain('data-agent-compact-tool-row="edit-1"');
    });
});
