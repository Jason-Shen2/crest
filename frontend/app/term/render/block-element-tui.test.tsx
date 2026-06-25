// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DefaultTermMode } from "../engine/types";
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
    CursorOverlay: () => <div data-testid="cursor" />,
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

function makeSurfaceModel(block: { id: string }) {
    return {
        getMode: () => DefaultTermMode,
        getActiveSurfaceState: () => ({ kind: "alt-screen", blockId: block.id }),
        getCursorRenderState: () => ({ kind: "terminal" }),
    };
}

describe("BlockElement TUI layout", () => {
    it("renders active alternate screen as full-height and hides chrome without a model", () => {
        const block = makeBlock(true) as any;
        const html = renderToStaticMarkup(<BlockElement block={block} revision={1} />);

        expect(html).not.toContain('data-testid="cmd-header"');
        expect(html).not.toContain('data-testid="cmd-snackbar"');
        expect(html).toMatch(/data-testid="grid"[^>]*class="[^"]*min-h-full/);
    });

    it("hides block command chrome while active alternate screen is displayed", () => {
        const block = makeBlock(true) as any;
        const html = renderToStaticMarkup(
            <BlockElement block={block} revision={1} model={makeSurfaceModel(block) as any} />
        );
        expect(html).not.toContain('data-testid="cmd-header"');
        expect(html).not.toContain('data-testid="cmd-snackbar"');
    });

    it("renders active alternate screen with full-height terminal styling", () => {
        const block = makeBlock(true) as any;
        const html = renderToStaticMarkup(
            <BlockElement block={block} revision={1} model={makeSurfaceModel(block) as any} />
        );
        expect(html).toMatch(/data-testid="grid"[^>]*class="[^"]*min-h-full/);
    });

    it("does not crash when copy-output text is computed from a sparse alt-screen row", () => {
        const sparseRow = [] as any[];
        sparseRow[2] = EmptyCell;
        const block = makeBlock(true) as any;
        block.altScreen.grid.getRow = () => sparseRow;
        expect(() =>
            renderToStaticMarkup(
                <BlockElement block={block} revision={1} model={makeSurfaceModel(block) as any} />
            )
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
                    getActiveSurfaceState: () => ({ kind: "terminal-capture", blockId: block.id }),
                    getCursorRenderState: () => ({ kind: "terminal" }),
                } as any}
            />
        );
        expect(html).not.toContain('data-testid="cmd-header"');
        expect(html).not.toContain('data-testid="cmd-snackbar"');
        expect(html).toMatch(/data-testid="grid"[^>]*class="[^"]*min-h-full/);
        expect(html).toContain('data-testid="cursor"');
    });

    it("does not render a cursor when model suppresses terminal cursor rendering", () => {
        const block = makeBlock(false) as any;
        block.outputGrid.cursorState.visible = false;
        const html = renderToStaticMarkup(
            <BlockElement
                block={block}
                revision={1}
                model={{
                    getMode: () => DefaultTermMode,
                    getActiveSurfaceState: () => ({ kind: "long-running-pty", blockId: block.id }),
                    getCursorRenderState: () => ({ kind: "suppressed", reason: "rich-input-open" }),
                } as any}
            />
        );

        expect(html).not.toContain('data-testid="cursor"');
    });
});
