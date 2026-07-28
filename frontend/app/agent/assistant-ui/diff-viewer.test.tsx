// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const pierreMocks = vi.hoisted(() => ({
    fileDiff: vi.fn((props: { fileDiff: { name: string } }) => (
        <div data-testid="pierre-file-diff" data-name={props.fileDiff.name} />
    )),
    multiFileDiff: vi.fn((_props: Record<string, unknown>) => <div data-testid="pierre-multi-file-diff" />),
}));

vi.mock("@pierre/diffs/react", () => ({
    FileDiff: pierreMocks.fileDiff,
    MultiFileDiff: pierreMocks.multiFileDiff,
}));

import { DiffViewer } from "./diff-viewer";

const Patch = [
    "diff --git a/frontend/app.tsx b/frontend/app.tsx",
    "--- a/frontend/app.tsx",
    "+++ b/frontend/app.tsx",
    "@@ -1 +1 @@",
    "-old line",
    "+new line",
].join("\n");

const MultiFilePatch = [
    Patch,
    "diff --git a/frontend/old.ts b/frontend/new.ts",
    "similarity index 90%",
    "rename from frontend/old.ts",
    "rename to frontend/new.ts",
    "--- a/frontend/old.ts",
    "+++ b/frontend/new.ts",
    "@@ -1 +1,2 @@",
    " same line",
    "+added line",
].join("\n");

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("DiffViewer", () => {
    it("starts expanded and toggles the diff body from the full header button", () => {
        render(<DiffViewer patch={Patch} />);

        const header = screen.getByRole("button", { name: /frontend\/app\.tsx/i });
        expect(header.getAttribute("aria-expanded")).toBe("true");
        expect(screen.getByTestId("pierre-file-diff")).toBeTruthy();
        expect(header.querySelector('[data-slot="diff-viewer-collapse-icon"]')).not.toBeNull();

        fireEvent.click(header);

        expect(header.getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByTestId("pierre-file-diff")).toBeNull();
    });

    it("passes the pinned OpenCode rendering options and dimensions to Pierre", () => {
        render(<DiffViewer patch={Patch} viewMode="unified" />);

        const props = pierreMocks.fileDiff.mock.calls[0]?.[0] as any;
        expect(props.options).toMatchObject({
            diffStyle: "unified",
            diffIndicators: "bars",
            overflow: "wrap",
            disableLineNumbers: false,
            disableBackground: false,
            disableFileHeader: true,
            lineHoverHighlight: "both",
            expansionLineCount: 20,
            hunkSeparators: "line-info-basic",
            lineDiffType: "none",
            maxLineDiffLength: 1000,
            tokenizeMaxLineLength: 1000,
        });
        expect(props.options.unsafeCSS).toContain("--diffs-bg-deletion-override");
        expect(props.style).toMatchObject({
            "--diffs-line-height": "24px",
            "--diffs-min-number-column-width": "4ch",
        });
    });

    it("keeps patch files independently collapsible", () => {
        render(<DiffViewer patch={MultiFilePatch} />);

        const headers = screen.getAllByRole("button");
        expect(headers).toHaveLength(2);
        expect(screen.getAllByTestId("pierre-file-diff")).toHaveLength(2);
        expect(pierreMocks.fileDiff.mock.calls.map(([props]) => props.fileDiff.name)).toEqual([
            "frontend/app.tsx",
            "frontend/new.ts",
        ]);

        fireEvent.click(headers[0]!);

        expect(headers[0]!.getAttribute("aria-expanded")).toBe("false");
        expect(headers[1]!.getAttribute("aria-expanded")).toBe("true");
        expect(screen.getAllByTestId("pierre-file-diff")).toHaveLength(1);
    });

    it("uses MultiFileDiff for full old and new file contents", () => {
        render(
            <DiffViewer
                oldFile={{ name: "src/example.ts", content: "const value = 1;\n" }}
                newFile={{ name: "src/example.ts", content: "const value = 2;\n" }}
                viewMode="split"
                showLineNumbers={false}
            />
        );

        const props = pierreMocks.multiFileDiff.mock.calls[0]?.[0] as any;
        expect(props.oldFile).toEqual({ name: "src/example.ts", contents: "const value = 1;\n" });
        expect(props.newFile).toEqual({ name: "src/example.ts", contents: "const value = 2;\n" });
        expect(props.options).toMatchObject({
            diffStyle: "split",
            lineDiffType: "word-alt",
            disableLineNumbers: true,
        });
        expect(screen.getByRole("button", { name: /src\/example\.ts/i }).textContent).toContain("+1");
        expect(screen.getByRole("button", { name: /src\/example\.ts/i }).textContent).toContain("-1");
    });

    it("keeps the existing empty-state fallback", () => {
        render(<DiffViewer />);

        expect(screen.getByText("No diff content provided")).toBeTruthy();
        expect(pierreMocks.fileDiff).not.toHaveBeenCalled();
        expect(pierreMocks.multiFileDiff).not.toHaveBeenCalled();
    });
});
