// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffReviewDialog, type DiffReviewDialogProps } from "./diff-review-dialog";

const getFileIconMock = vi.hoisted(() => vi.fn());
const diffViewerMock = vi.hoisted(() => vi.fn());

vi.mock("@/app/fileexplorer/file-icon", () => ({
    getFileIcon: getFileIconMock,
}));

vi.mock("@/app/agent/assistant-ui/diff-viewer", () => ({
    DiffViewer: (props: { patch?: string }) => {
        diffViewerMock(props);
        return <div data-testid="backend-diff">{props.patch}</div>;
    },
}));

function TestFileIcon(props: { className?: string; size?: number }) {
    return <svg data-testid="file-icon" className={props.className} data-size={props.size} />;
}

function makeFile(overrides: Partial<AgentRewindFileRowView> = {}): AgentRewindFileRowView {
    return {
        path: "src/alpha.ts",
        operation: "write",
        additions: 3,
        deletions: 2,
        diff: "backend alpha patch",
        coverage: "covered",
        conflict: "none",
        ...overrides,
    };
}

function renderDialog(overrides: Partial<DiffReviewDialogProps> = {}) {
    const props: DiffReviewDialogProps = {
        open: true,
        title: "Review changes",
        description: "Red will be removed · Green will be restored",
        files: [makeFile()],
        footer: <button type="button">Caller action</button>,
        onSelectedPathChange: vi.fn(),
        onOpenChange: vi.fn(),
        ...overrides,
    };
    return { ...render(<DiffReviewDialog {...props} />), props };
}

afterEach(cleanup);

beforeEach(() => {
    getFileIconMock.mockReset();
    getFileIconMock.mockReturnValue(TestFileIcon);
    diffViewerMock.mockReset();
});

describe("DiffReviewDialog", () => {
    it("selects the first file by default and switches only the displayed backend patch when a file is clicked", () => {
        const files = [
            makeFile(),
            makeFile({ path: "tests/beta.test.ts", operation: "create", diff: "backend beta patch" }),
        ];

        function ControlledDialog() {
            const [selectedPath, setSelectedPath] = useState<string>();
            return (
                <DiffReviewDialog
                    open
                    title="Review changes"
                    description="Immutable checkpoint diff"
                    files={files}
                    selectedPath={selectedPath}
                    footer={<button type="button">Close</button>}
                    onSelectedPathChange={setSelectedPath}
                    onOpenChange={vi.fn()}
                />
            );
        }

        render(<ControlledDialog />);
        expect(screen.getByTestId("backend-diff").textContent).toBe("backend alpha patch");

        fireEvent.click(screen.getByRole("button", { name: /beta\.test\.ts/ }));
        expect(screen.getByTestId("backend-diff").textContent).toBe("backend beta patch");
        expect(diffViewerMock).toHaveBeenLastCalledWith(expect.objectContaining({ patch: "backend beta patch" }));
    });

    it("uses the existing file icon and shows basename, muted directory, status, and nullable stats", () => {
        renderDialog({
            files: [
                makeFile({ path: "frontend/app/alpha.ts", operation: "create", additions: 7, deletions: 0 }),
                makeFile({ path: "README.md", operation: "delete", additions: null, deletions: null }),
                makeFile({ path: "src/modified.ts", operation: "write", additions: 1, deletions: 4 }),
            ],
        });

        expect(getFileIconMock).toHaveBeenCalledWith("alpha.ts", false, false);
        expect(getFileIconMock).toHaveBeenCalledWith("README.md", false, false);
        expect(screen.getByText("alpha.ts")).not.toBeNull();
        const directory = screen.getByText("frontend/app/");
        expect(directory.className).toContain("text-muted-foreground");
        expect(screen.getByText("A")).not.toBeNull();
        expect(screen.getByText("D")).not.toBeNull();
        expect(screen.getByText("M")).not.toBeNull();
        expect(screen.getByText("+7").className).toContain("text-success");
        expect(screen.getByText("-0").className).toContain("text-destructive");
        expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
        expect(screen.queryByText("+0 -0")).toBeNull();
    });

    it("does not show coverage text for a normal file row", () => {
        renderDialog({ files: [makeFile({ coverage: "covered" })] });

        expect(screen.queryByText("covered")).toBeNull();
    });

    it("renders forceable conflicts and the canonical warning with destructive styling", () => {
        const warning = "files changed on disk since the agent last wrote them";
        renderDialog({
            warning,
            files: [makeFile({ conflict: "forceable-drift", reason: warning })],
        });

        for (const message of screen.getAllByText(warning)) {
            expect(message.className).toMatch(/destructive|red|rose/);
        }
        expect(screen.getByRole("button", { name: /alpha\.ts/ }).className).toMatch(/destructive|red|rose/);
    });

    it("shows an unavailable reason instead of fabricating an empty diff", () => {
        renderDialog({
            files: [
                makeFile({
                    diff: undefined,
                    coverage: "unavailable",
                    previewUnavailableReason: "checkpoint snapshot is unavailable",
                }),
            ],
        });

        expect(screen.getByText("checkpoint snapshot is unavailable")).not.toBeNull();
        expect(screen.queryByTestId("backend-diff")).toBeNull();
        expect(diffViewerMock).not.toHaveBeenCalled();
    });

    it("renders the supplied empty message and caller-owned footer without legacy conversation content", () => {
        renderDialog({
            files: [],
            emptyMessage: "No workspace files will change.",
            footer: (
                <>
                    <button type="button">Cancel</button>
                    <button type="button">Custom apply</button>
                </>
            ),
        });

        expect(screen.getByText("No workspace files will change.")).not.toBeNull();
        expect(screen.getByRole("button", { name: "Cancel" })).not.toBeNull();
        expect(screen.getByRole("button", { name: "Custom apply" })).not.toBeNull();
        expect(screen.queryByText(/messages? (will be removed|and)/i)).toBeNull();
        expect(screen.queryByText(/conversation/i)).toBeNull();
        expect(screen.queryByText(/target prompt/i)).toBeNull();
    });

    it("forwards open-state changes unless the caller locks the dialog", () => {
        const unlocked = renderDialog();
        fireEvent.keyDown(document, { key: "Escape" });
        expect(unlocked.props.onOpenChange).toHaveBeenCalledWith(false);
        cleanup();

        const locked = renderDialog({ locked: true });
        fireEvent.keyDown(document, { key: "Escape" });
        expect(locked.props.onOpenChange).not.toHaveBeenCalled();
    });
});
