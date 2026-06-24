// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BlockElement } from "./block-element";

vi.mock("@/app/view/cmdblock/cmdblock-header", () => ({
    CmdBlockHeader: () => <div data-testid="cmd-header" />,
}));

vi.mock("@/app/view/cmdblock/cmdblock-snackbar", () => ({
    CmdBlockSnackbar: () => <div data-testid="cmd-snackbar" />,
}));

vi.mock("./grid-element", () => ({
    GridElement: ({ className }: { className?: string }) => (
        <div data-testid="grid" className={className} />
    ),
}));

vi.mock("./cursor-overlay", () => ({
    CursorOverlay: ({ forceVisible }: { forceVisible?: boolean }) => (
        <div data-testid="cursor" data-force-visible={forceVisible ? "true" : "false"} />
    ),
}));

const EmptyCell = {
    char: "",
    width: 1,
};

function makeGrid() {
    const grid = {
        cols: 80,
        cursor: { row: 0, col: 0 },
        cursorState: { visible: false, shape: "block", blink: false },
        rowCount: () => 24,
        getRow: () => [EmptyCell],
        getRowVersion: () => 1,
        getLink: () => undefined,
        raw: () => grid,
    };
    return grid;
}

function textRow(text: string) {
    return text.split("").map((char) => ({ ...EmptyCell, char }));
}

function makeBlock(active: boolean) {
    const grid = makeGrid();
    return {
        id: "block-1",
        state: "running",
        exitCode: undefined,
        hidden: false,
        collapsed: false,
        altScreen: { active, wasActive: active, grid },
        outputGrid: grid,
        commandText: () => "claude",
        durationMs: () => 1000,
    };
}

describe("BlockElement TUI layout", () => {
    it("hides block command chrome while active alternate screen is displayed", () => {
        const html = renderToStaticMarkup(
            <BlockElement block={makeBlock(true) as any} revision={1} />
        );
        expect(html).not.toContain('data-testid="cmd-header"');
        expect(html).not.toContain('data-testid="cmd-snackbar"');
    });

    it("renders active alternate screen with full-height terminal styling", () => {
        const html = renderToStaticMarkup(
            <BlockElement block={makeBlock(true) as any} revision={1} />
        );
        expect(html).toMatch(/data-testid="grid"[^>]*class="[^"]*min-h-full/);
    });

    it("does not crash when copy-output text is computed from a sparse alt-screen row", () => {
        const sparseRow = [] as any[];
        sparseRow[2] = EmptyCell;
        const block = makeBlock(true) as any;
        block.altScreen.grid.getRow = () => sparseRow;
        expect(() =>
            renderToStaticMarkup(<BlockElement block={block} revision={1} />)
        ).not.toThrow();
    });

    it("renders a running raw-capture TUI block as a full-height terminal surface", () => {
        const block = makeBlock(false) as any;
        const html = renderToStaticMarkup(
            <BlockElement
                block={block}
                revision={1}
                model={{
                    getMode: () => ({
                        appCursor: true,
                        focusReport: false,
                        mouseX10: false,
                        mouseClick: true,
                        mouseButton: false,
                        mouseMotion: false,
                        mouseSgr: false,
                        mouseUtf8: false,
                        mouseUrxvt: false,
                        alternateScroll: false,
                    }),
                } as any}
            />
        );
        expect(html).not.toContain('data-testid="cmd-header"');
        expect(html).not.toContain('data-testid="cmd-snackbar"');
        expect(html).toMatch(/data-testid="grid"[^>]*class="[^"]*min-h-full/);
        expect(html).toContain('data-force-visible="false"');
    });

    it("does not force a parked blank cursor visible for long-running PTY input surfaces", () => {
        const block = makeBlock(false) as any;
        block.outputGrid.cursorState.visible = false;
        const html = renderToStaticMarkup(
            <BlockElement
                block={block}
                revision={1}
                model={{
                    getMode: () => ({
                        appCursor: false,
                        appKeypad: false,
                        bracketedPaste: false,
                        focusReport: false,
                        mouseX10: false,
                        mouseClick: false,
                        mouseButton: false,
                        mouseMotion: false,
                        mouseSgr: false,
                        mouseUtf8: false,
                        mouseUrxvt: false,
                        alternateScroll: false,
                        autoWrap: true,
                        origin: false,
                        insertMode: false,
                        syncOutput: false,
                        reverseVideo: false,
                        columnMode: false,
                        autoRepeat: true,
                        kittyKeyboardFlags: 0,
                    }),
                } as any}
            />
        );

        expect(html).toContain('data-testid="cursor"');
        expect(html).toContain('data-force-visible="false"');
    });

    it("forces cursor visibility when the PTY cursor sits on a visible long-running input row", () => {
        const block = makeBlock(false) as any;
        block.outputGrid.cursorState.visible = false;
        block.outputGrid.cursor.col = 6;
        block.outputGrid.getRow = () => textRow("coco> ");
        const html = renderToStaticMarkup(
            <BlockElement
                block={block}
                revision={1}
                model={{
                    getMode: () => ({
                        appCursor: false,
                        appKeypad: false,
                        bracketedPaste: false,
                        focusReport: false,
                        mouseX10: false,
                        mouseClick: false,
                        mouseButton: false,
                        mouseMotion: false,
                        mouseSgr: false,
                        mouseUtf8: false,
                        mouseUrxvt: false,
                        alternateScroll: false,
                        autoWrap: true,
                        origin: false,
                        insertMode: false,
                        syncOutput: false,
                        reverseVideo: false,
                        columnMode: false,
                        autoRepeat: true,
                        kittyKeyboardFlags: 0,
                    }),
                } as any}
            />
        );

        expect(html).toContain('data-testid="cursor"');
        expect(html).toContain('data-force-visible="true"');
    });
});
