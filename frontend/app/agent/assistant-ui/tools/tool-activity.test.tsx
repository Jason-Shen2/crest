// @vitest-environment jsdom

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReadToolActivity, SearchToolActivity } from "./tool-activity";
import type { ToolActivityPart } from "./tool-activity-model";

const Complete = { type: "complete" } as const;

function part(toolName: string, args: Record<string, unknown>, id: string): ToolActivityPart {
    return { type: "tool-call", toolCallId: id, toolName, args, status: Complete };
}

afterEach(cleanup);

describe("SearchToolActivity", () => {
    it("shows every search rule without a disclosure control or raw payload", () => {
        const { container } = render(
            <SearchToolActivity
                parts={[
                    part("find", { pattern: "*.md" }, "find-1"),
                    part("grep", { pattern: "TODO", glob: "*.ts" }, "grep-1"),
                ]}
            />
        );

        expect(screen.getByText("Searched")).toBeTruthy();
        expect(screen.getByText("*.md")).toBeTruthy();
        expect(screen.getByText("TODO")).toBeTruthy();
        expect(screen.getByText("*.ts")).toBeTruthy();
        expect(container.querySelector('[data-slot="tool-activity-search"] button')).toBeNull();
        expect(container.textContent).not.toContain('"pattern"');
    });
});

describe("ReadToolActivity", () => {
    it("starts collapsed and opens files through the injected callback", () => {
        const onOpenFile = vi.fn();
        render(
            <ReadToolActivity
                parts={[
                    part("read", { path: "src/app.ts" }, "read-1"),
                    part("read", { path: "src/util.ts" }, "read-2"),
                ]}
                workspaceDir="/repo"
                onOpenFile={onOpenFile}
            />
        );

        const trigger = screen.getByRole("button", { name: /Read app\.ts and util\.ts/i });
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByRole("button", { name: /Open src\/app\.ts/i })).toBeNull();

        fireEvent.click(trigger);
        fireEvent.click(screen.getByRole("button", { name: "Open src/app.ts" }));

        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        expect(onOpenFile).toHaveBeenCalledWith("/repo/src/app.ts");
    });

    it("keeps failed read paths visible but inactive and exposes errors outside collapsed content", () => {
        const failed: ToolActivityPart = {
            ...part("read", { path: "missing.ts" }, "read-1"),
            status: { type: "incomplete", reason: "error", error: "not found" },
        };
        render(<ReadToolActivity parts={[failed]} workspaceDir="/repo" onOpenFile={vi.fn()} />);

        expect(screen.getByText("not found")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: /Read missing\.ts/i }));
        expect(screen.queryByRole("button", { name: "Open missing.ts" })).toBeNull();
        expect(screen.getAllByText("missing.ts")).toHaveLength(2);
    });
});
