// @vitest-environment jsdom

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TurnFileChangesCard } from "./turn-file-changes-card";

afterEach(cleanup);

const Summary: AgentTurnChangeSummaryView = {
    turnId: "turn-1",
    semanticLeafId: "leaf-1",
    fileCount: 2,
    additions: 355,
    deletions: 2,
    files: [
        {
            path: "docs/superpowers/specs/agent-rewind-design.md",
            operation: "write",
            additions: 7,
            deletions: 2,
        },
        {
            path: "frontend/app/agent/card.tsx",
            operation: "create",
            additions: null,
            deletions: null,
        },
    ],
};

describe("TurnFileChangesCard", () => {
    it("renders the compact v5 layout and routes file, review, and undo actions", () => {
        const onOpenFile = vi.fn();
        const onReview = vi.fn();
        const onUndo = vi.fn();
        render(
            <TurnFileChangesCard
                summary={Summary}
                action="undo"
                disabled={false}
                onOpenFile={onOpenFile}
                onReview={onReview}
                onUndo={onUndo}
                onRedo={vi.fn()}
            />
        );

        expect(screen.getByText("已编辑 2 个文件")).toBeTruthy();
        expect(screen.getByText("+355").className).toContain("text-success");
        expect(screen.getAllByText("-2")[0].className).toContain("text-destructive");
        expect(screen.getByLabelText("Turn file changes").className).toContain("py-2.5");
        expect(screen.getByTestId("turn-file-changes-icon").className).toContain("size-10");
        expect(screen.getByTestId("turn-file-changes-icon").className).toContain("bg-muted/40");

        expect(screen.getByRole("button", { name: /撤销/ })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /重做/ })).toBeNull();
        expect(screen.getByRole("button", { name: "审核" })).toBeTruthy();

        const file = screen.getByRole("button", { name: /agent-rewind-design\.md/ });
        expect(file.className).toContain("hover:bg-muted/40");
        expect(file.className).not.toContain("bg-accent");
        expect(screen.getByText("docs/superpowers/specs/").className).toContain("text-muted-foreground");

        fireEvent.click(file);
        fireEvent.click(screen.getByRole("button", { name: "审核" }));
        fireEvent.click(screen.getByRole("button", { name: /撤销/ }));
        expect(onOpenFile).toHaveBeenCalledWith("docs/superpowers/specs/agent-rewind-design.md");
        expect(onReview).toHaveBeenCalledOnce();
        expect(onUndo).toHaveBeenCalledOnce();
    });

    it("shows redo instead of undo and preserves unknown statistics", () => {
        render(
            <TurnFileChangesCard
                summary={{ ...Summary, additions: null, deletions: null }}
                action="redo"
                disabled={false}
                onOpenFile={vi.fn()}
                onReview={vi.fn()}
                onUndo={vi.fn()}
                onRedo={vi.fn()}
            />
        );

        expect(screen.getByRole("button", { name: /重做/ })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /撤销/ })).toBeNull();
        expect(screen.getAllByLabelText("Additions unavailable").length).toBeGreaterThan(0);
        expect(screen.getAllByLabelText("Deletions unavailable").length).toBeGreaterThan(0);
        expect(screen.queryByText("+0")).toBeNull();
    });

    it("disables every action while mutation state is busy", () => {
        render(
            <TurnFileChangesCard
                summary={Summary}
                action="undo"
                disabled
                onOpenFile={vi.fn()}
                onReview={vi.fn()}
                onUndo={vi.fn()}
                onRedo={vi.fn()}
            />
        );

        expect(screen.getAllByRole("button").every((button) => button.hasAttribute("disabled"))).toBe(true);
    });
});
