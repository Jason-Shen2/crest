// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RewindPreviewDialog, type RewindPreviewDialogProps } from "./rewind-preview-dialog";

function makePreview(overrides: Partial<AgentRewindPreviewResult> = {}): AgentRewindPreviewResult {
    return {
        confirmationToken: "opaque",
        target: { kind: "rewind", targetTurnId: "turn-a" },
        semanticLeafId: "leaf-a",
        displayLeafId: "turn-a",
        expectedSemanticLeafId: "leaf-a",
        messageCount: 2,
        fileCount: 1,
        files: [],
        coverageWarnings: [],
        forceRequired: false,
        hardBlocked: false,
        ...overrides,
    };
}

function renderDialog(overrides: Partial<RewindPreviewDialogProps> = {}) {
    const props: RewindPreviewDialogProps = {
        open: true,
        operation: "rewind",
        phase: "ready",
        busy: false,
        preview: makePreview(),
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
        ...overrides,
    };
    return { ...render(<RewindPreviewDialog {...props} />), props };
}

afterEach(cleanup);

describe("RewindPreviewDialog", () => {
    it.each([
        { phase: "loading" as const, operation: "rewind" as const },
        { phase: "applying" as const, operation: "rewind" as const },
        { phase: "loading" as const, operation: "redo" as const },
        { phase: "applying" as const, operation: "redo" as const },
    ])("locks cancellation and confirmation while $operation is $phase", ({ phase, operation }) => {
        renderDialog({ phase, operation, preview: undefined });

        expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
        expect(screen.queryByRole("button", { name: /^(Revert|Force revert|Redo)$/ })).toBeNull();
    });

    it("shows Cancel and Revert for a clean rewind", () => {
        const { props } = renderDialog();

        expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(false);
        fireEvent.click(screen.getByRole("button", { name: "Revert" }));
        expect(props.onConfirm).toHaveBeenCalledWith("normal");
        expect(screen.queryByRole("button", { name: "Force revert" })).toBeNull();
    });

    it("locks cancellation and confirmation while the shared rewind controller is busy", () => {
        renderDialog({ busy: true });

        expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
        expect(screen.queryByRole("button", { name: /^(Revert|Force revert|Redo)$/ })).toBeNull();
    });

    it("shows only Force revert for a forceable rewind and renders the backend conflict reason in red", () => {
        const reason = "files changed on disk since the agent last wrote them";
        const { props } = renderDialog({
            preview: makePreview({
                forceRequired: true,
                files: [
                    {
                        path: "src/drift.ts",
                        operation: "write",
                        coverage: "covered",
                        conflict: "forceable-drift",
                        reason,
                    },
                ],
            }),
        });

        expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
        const force = screen.getByRole("button", { name: "Force revert" });
        fireEvent.click(force);
        expect(props.onConfirm).toHaveBeenCalledWith("force-drift");
        const conflict = screen.getByText(reason);
        expect(conflict.className).toMatch(/red|destructive|rose/);
    });

    it("shows Cancel only for a hard-blocked rewind and preserves backend blocker text", () => {
        renderDialog({
            preview: makePreview({
                hardBlocked: true,
                files: [
                    {
                        path: "src/blocked.ts",
                        operation: "delete",
                        coverage: "unavailable",
                        conflict: "hard-blocker",
                        reason: "backend says this checkpoint is incomplete",
                    },
                ],
            }),
        });

        expect(screen.getByText("backend says this checkpoint is incomplete")).not.toBeNull();
        expect(screen.queryByRole("button", { name: /^(Revert|Force revert|Redo)$/ })).toBeNull();
    });

    it("shows Redo only for a clean redo and never offers Force", () => {
        const { props } = renderDialog({
            operation: "redo",
            preview: makePreview({ target: { kind: "redo" } }),
        });

        fireEvent.click(screen.getByRole("button", { name: "Redo" }));
        expect(props.onConfirm).toHaveBeenCalledWith("normal");
        expect(screen.queryByRole("button", { name: /force/i })).toBeNull();
    });

    it.each([
        { forceRequired: true, hardBlocked: false },
        { forceRequired: false, hardBlocked: true },
        { forceRequired: true, hardBlocked: true },
    ])("shows Cancel only for redo drift or blockers: %o", ({ forceRequired, hardBlocked }) => {
        renderDialog({
            operation: "redo",
            preview: makePreview({ target: { kind: "redo" }, forceRequired, hardBlocked }),
        });

        expect(screen.queryByRole("button", { name: /^(Revert|Force revert|Redo)$/ })).toBeNull();
    });

    it("renders file operations, stats, coverage, backend warnings, and supplied diffs", () => {
        renderDialog({
            preview: makePreview({
                files: [
                    {
                        path: "src/new.ts",
                        oldPath: "src/old.ts",
                        operation: "rename",
                        additions: 3,
                        deletions: 2,
                        coverage: "excluded",
                        conflict: "none",
                        reason: "backend excluded generated output",
                        diff: [
                            "diff --git a/src/old.ts b/src/new.ts",
                            "--- a/src/old.ts",
                            "+++ b/src/new.ts",
                            "@@ -1 +1 @@",
                            "-old",
                            "+new",
                        ].join("\n"),
                    },
                ],
                coverageWarnings: ["backend coverage warning"],
            }),
        });

        expect(screen.getByText("rename")).not.toBeNull();
        expect(screen.getAllByText("src/old.ts").length).toBeGreaterThan(0);
        expect(screen.getAllByText("src/new.ts").length).toBeGreaterThan(0);
        expect(screen.getByText("+3")).not.toBeNull();
        expect(screen.getByText("-2")).not.toBeNull();
        expect(screen.getByText("excluded")).not.toBeNull();
        expect(screen.getByText("backend excluded generated output")).not.toBeNull();
        expect(screen.getByText("backend coverage warning")).not.toBeNull();
        expect(document.querySelector('[data-slot="diff-viewer"]')).not.toBeNull();
    });
});
