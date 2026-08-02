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

        fireEvent.click(screen.getByRole("option", { name: /beta\.test\.ts/ }));
        expect(screen.getByTestId("backend-diff").textContent).toBe("backend beta patch");
        expect(diffViewerMock).toHaveBeenLastCalledWith(expect.objectContaining({ patch: "backend beta patch" }));
    });

    it("supports ArrowDown and ArrowUp selection from the accessible file list without external side effects", () => {
        const onSelectedPathChange = vi.fn();
        const files = [
            makeFile(),
            makeFile({ path: "src/beta.ts", diff: "backend beta patch" }),
            makeFile({ path: "src/gamma.ts", diff: "backend gamma patch" }),
        ];

        function ControlledDialog() {
            const [selectedPath, setSelectedPath] = useState(files[0].path);
            return (
                <DiffReviewDialog
                    open
                    title="Review changes"
                    files={files}
                    selectedPath={selectedPath}
                    footer={<button type="button">Close</button>}
                    onSelectedPathChange={(path) => {
                        onSelectedPathChange(path);
                        setSelectedPath(path);
                    }}
                    onOpenChange={vi.fn()}
                />
            );
        }

        render(<ControlledDialog />);
        const listbox = screen.getByRole("listbox", { name: "Workspace files" });
        expect(screen.getByRole("option", { name: /alpha\.ts/ }).getAttribute("aria-selected")).toBe("true");

        fireEvent.keyDown(listbox, { key: "ArrowDown" });
        expect(onSelectedPathChange).toHaveBeenLastCalledWith("src/beta.ts");
        expect(screen.getByTestId("backend-diff").textContent).toBe("backend beta patch");

        fireEvent.keyDown(listbox, { key: "ArrowUp" });
        expect(onSelectedPathChange).toHaveBeenLastCalledWith("src/alpha.ts");
        expect(screen.getByTestId("backend-diff").textContent).toBe("backend alpha patch");
    });

    it("uses the existing file icon and shows basename, muted directory, status, and nullable stats", () => {
        renderDialog({
            files: [
                makeFile({ path: "frontend/app/alpha.ts", operation: "create", additions: 7, deletions: 0 }),
                makeFile({ path: "README.md", operation: "delete", additions: null, deletions: 4 }),
                makeFile({ path: "src/modified.ts", operation: "write", additions: 1, deletions: null }),
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
        expect(screen.getByText("-4").className).toContain("text-destructive");
        expect(screen.getAllByLabelText("Additions unavailable")).not.toHaveLength(0);
        expect(screen.getAllByLabelText("Deletions unavailable")).not.toHaveLength(0);
        expect(screen.queryByText("+0")).toBeNull();
    });

    it("uses the magnified dialog shell with internal separators and the compact diff header icon", () => {
        renderDialog();

        const dialog = screen.getByRole("dialog");
        expect(dialog.hasAttribute("aria-describedby")).toBe(false);
        expect(dialog.className).toContain("border-0");
        expect(dialog.className).toContain("h-[calc(100vh-1rem)]");
        expect(dialog.className).toContain("max-h-[calc(100vh-1rem)]");
        expect(dialog.className).toContain("w-[calc(100vw-1rem)]");
        expect(dialog.className).toContain("max-w-[calc(100vw-1rem)]");
        expect(dialog.className).toContain("sm:h-[94vh]");
        expect(dialog.className).toContain("sm:max-h-[94vh]");
        expect(dialog.className).toContain("sm:w-[96vw]");
        expect(dialog.className).toContain("sm:max-w-[96vw]");
        expect(screen.getByTestId("diff-review-header-icon").className).toContain(
            "grid size-9 shrink-0 place-items-center rounded-lg bg-muted/40 text-muted-foreground"
        );
        expect(screen.getByText("Review changes").closest('[data-slot="dialog-header"]')?.className).toContain(
            "border-b"
        );
        expect(screen.getByRole("button", { name: "Caller action" }).parentElement?.className).toContain("border-t");
    });

    it("summarizes two files with known additions and deletions", () => {
        renderDialog({
            files: [
                makeFile({ additions: 100, deletions: 1 }),
                makeFile({ path: "src/beta.ts", additions: 255, deletions: 1 }),
            ],
        });

        const summary = screen.getByText("2 files").parentElement;
        expect(summary?.getAttribute("role")).toBe("status");
        expect(summary?.getAttribute("aria-atomic")).toBe("true");
        expect(summary?.textContent).toContain("+355");
        expect(summary?.textContent).toContain("-2");
        expect(screen.getByText("+355").className).toContain("text-success");
        expect(screen.getByText("-2").className).toContain("text-destructive");
    });

    it("uses singular file count and keeps unknown addition and deletion aggregates independent", () => {
        const { rerender, props } = renderDialog({ files: [makeFile({ additions: 3, deletions: 2 })] });
        let summary = screen.getByText("1 file").parentElement;
        expect(summary?.textContent).toContain("+3");
        expect(summary?.textContent).toContain("-2");

        rerender(
            <DiffReviewDialog
                {...props}
                files={[
                    makeFile({ additions: null, deletions: 1 }),
                    makeFile({ path: "src/beta.ts", additions: 8, deletions: 2 }),
                ]}
            />
        );
        summary = screen.getByText("2 files").parentElement;
        expect(summary?.textContent).toContain("+—");
        expect(summary?.textContent).toContain("-3");
        expect(summary?.querySelector('[aria-label="Additions unavailable"]')).not.toBeNull();
        expect(summary?.querySelector('[aria-label="Deletions unavailable"]')).toBeNull();
    });

    it("treats undefined additions as unavailable without losing known deletions", () => {
        renderDialog({
            files: [
                makeFile({ additions: undefined, deletions: 2 }),
                makeFile({ path: "src/beta.ts", additions: 8, deletions: 3 }),
            ],
        });

        const summary = screen.getByText("2 files").parentElement;
        expect(summary?.querySelector('[aria-label="Additions unavailable"]')).not.toBeNull();
        expect(summary?.textContent).toContain("-5");
        expect(summary?.querySelector('[aria-label="Deletions unavailable"]')).toBeNull();
    });

    it("shows zero-valued header stats when no files change", () => {
        renderDialog({ files: [] });

        const summary = screen.getByText("0 files").parentElement;
        expect(summary?.textContent).toBe("0 files+0-0");
    });

    it("shows only the loading summary while files are loading and omits color explanation copy", () => {
        const { rerender, props } = renderDialog({ loading: true });

        const summary = screen.getByText("Loading files…");
        expect(summary.parentElement?.getAttribute("role")).toBe("status");
        expect(summary.parentElement?.getAttribute("aria-atomic")).toBe("true");
        expect(summary.parentElement?.textContent).toBe("Loading files…");
        rerender(<DiffReviewDialog {...props} loading={false} />);
        expect(screen.getAllByRole("status").find((status) => !status.hasAttribute("aria-label"))?.textContent).toBe(
            "1 file+3-2"
        );
        expect(screen.queryByText(/red (will|was)/i)).toBeNull();
        expect(screen.queryByText(/green (will|was)/i)).toBeNull();
    });

    it("does not show coverage text for a normal file row", () => {
        renderDialog({ files: [makeFile({ coverage: "covered" })] });

        expect(screen.queryByText("covered")).toBeNull();
    });

    it("renders forceable conflicts, deduplicated warnings, and errors with destructive styling", () => {
        const warning = "files changed on disk since the agent last wrote them";
        const coverageWarning = "checkpoint excluded an unsupported path";
        renderDialog({
            warnings: [coverageWarning, warning, coverageWarning],
            errorMessage: "preview failed",
            files: [makeFile({ conflict: "forceable-drift", reason: warning })],
        });

        const visibleCoverageWarning = screen
            .getAllByText(coverageWarning)
            .find((message) => message.className.includes("text-destructive"));
        const visibleConflictWarning = screen
            .getAllByText(warning)
            .find((message) => !message.closest('[aria-label="Review warnings"]'));
        expect(visibleCoverageWarning).toBeDefined();
        expect(visibleConflictWarning).toBeDefined();
        expect(screen.getByRole("alert").textContent).toBe("preview failed");
        for (const message of [visibleConflictWarning!, visibleCoverageWarning!, screen.getByText("preview failed")]) {
            expect(message.className).toMatch(/destructive|red|rose/);
        }
        expect(screen.getByRole("option", { name: /alpha\.ts/ }).className).toMatch(/destructive|red|rose/);
    });

    it("pre-mounts one warning status that announces deduplicated coverage and conflict warnings", () => {
        const coverageWarning = "checkpoint excluded an unsupported path";
        const conflictWarning = "files changed on disk since the agent last wrote them";
        const files = [makeFile({ conflict: "forceable-drift", reason: conflictWarning })];
        const { rerender, props } = renderDialog({ files, warnings: [] });
        const initialWarningStatus = screen.getByRole("status", { name: "Review warnings" });

        expect(initialWarningStatus.textContent).toBe("");
        rerender(
            <DiffReviewDialog {...props} files={files} warnings={[coverageWarning, conflictWarning, coverageWarning]} />
        );

        const warningStatus = screen.getByRole("status", { name: "Review warnings" });
        expect(warningStatus).toBe(initialWarningStatus);
        expect(warningStatus.getAttribute("aria-atomic")).toBe("true");
        expect(warningStatus.querySelectorAll("p")).toHaveLength(2);
        expect(warningStatus.textContent).toContain(coverageWarning);
        expect(warningStatus.textContent).toContain(conflictWarning);
        expect(
            screen.getAllByText(coverageWarning).filter((message) => message.className.includes("text-destructive"))
        ).toHaveLength(1);
        expect(
            screen.getAllByText(conflictWarning).filter((message) => !message.closest('[aria-label="Review warnings"]'))
        ).toHaveLength(1);
        expect(screen.getAllByRole("status")).toHaveLength(2);
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

    it("resizes the desktop file pane within the review body's responsive bounds and stops after release", () => {
        renderDialog({ files: [makeFile(), makeFile({ path: "src/beta.ts" })] });

        const body = screen.getByTestId("diff-review-body");
        const handle = screen.getByRole("separator", { name: "Resize file list" });
        const filePane = screen.getByRole("listbox", { name: "Workspace files" }).closest("aside");
        const selectedFile = screen.getByRole("option", { name: /alpha\.ts/ });

        expect(body.style.getPropertyValue("--diff-review-file-pane-width")).toBe("250px");
        expect(handle.getAttribute("aria-orientation")).toBe("vertical");
        expect(handle.className).toContain("hidden md:block");
        expect(handle.className).toContain("w-1");
        expect(handle.className).toContain("cursor-col-resize");
        expect(handle.className).toContain("hover:bg-fg-overlay-2");
        expect(filePane?.className).toContain("md:w-[var(--diff-review-file-pane-width)]");
        expect(filePane?.className).toContain("md:max-w-[60%]");
        expect(filePane?.className).toContain("min-h-[120px]");
        expect(filePane?.className).toContain("md:min-h-0");
        expect(selectedFile.className).toContain("hover:bg-muted/40");
        expect(selectedFile.className).toContain("bg-muted/40");

        Object.defineProperty(body, "getBoundingClientRect", {
            configurable: true,
            value: () => ({ left: 100, width: 1000 }),
        });

        fireEvent.mouseDown(handle, { button: 2 });
        fireEvent.mouseMove(window, { clientX: 400 });
        expect(body.style.getPropertyValue("--diff-review-file-pane-width")).toBe("250px");

        const mouseDownEvent = new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true });
        fireEvent(handle, mouseDownEvent);
        expect(mouseDownEvent.defaultPrevented).toBe(true);

        fireEvent.mouseMove(window, { clientX: 400 });
        expect(body.style.getPropertyValue("--diff-review-file-pane-width")).toBe("300px");

        fireEvent.mouseMove(window, { clientX: 900 });
        expect(body.style.getPropertyValue("--diff-review-file-pane-width")).toBe("480px");

        fireEvent.mouseMove(window, { clientX: 0 });
        expect(body.style.getPropertyValue("--diff-review-file-pane-width")).toBe("160px");

        Object.defineProperty(body, "getBoundingClientRect", {
            configurable: true,
            value: () => ({ left: 100, width: 300 }),
        });
        fireEvent.mouseMove(window, { clientX: 500 });
        expect(body.style.getPropertyValue("--diff-review-file-pane-width")).toBe("180px");

        fireEvent.mouseUp(window);
        fireEvent.mouseMove(window, { clientX: 0 });
        expect(body.style.getPropertyValue("--diff-review-file-pane-width")).toBe("180px");
    });
});
