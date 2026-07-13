// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DefaultTermMode } from "../engine/types";
import { BlockElement } from "./block-element";

vi.mock("@/app/view/cmdblock/cmdblock-header", () => ({
    CmdBlockHeader: ({ cmd }: { cmd?: string }) => <div data-testid="cmd-header">{cmd}</div>,
}));

vi.mock("@/app/view/cmdblock/cmdblock-snackbar", () => ({
    CmdBlockSnackbar: () => <div data-testid="cmd-snackbar" />,
}));

vi.mock("./grid-element", () => ({
    GridElement: ({ className }: { className?: string }) => <div data-testid="grid" className={className} />,
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
    it("does not paint a selected background when a block is clicked", () => {
        const block = makeBlock(false) as any;
        const html = renderToStaticMarkup(<BlockElement block={block} revision={1} selected />);

        expect(html).not.toContain("bg-[var(--color-term-accent-10)]");
    });

    it("renders active alternate screen as full-height while keeping the command header without a model", () => {
        const block = makeBlock(true) as any;
        const html = renderToStaticMarkup(<BlockElement block={block} revision={1} />);

        expect(html).toContain('data-testid="cmd-header"');
        expect(html).toContain("claude");
        expect(html).not.toContain('data-testid="cmd-snackbar"');
        expect(html).toMatch(/data-testid="grid"[^>]*class="[^"]*min-h-full/);
    });

    it("keeps command header visible while active alternate screen is displayed", () => {
        const block = makeBlock(true) as any;
        const html = renderToStaticMarkup(
            <BlockElement block={block} revision={1} model={makeSurfaceModel(block) as any} />
        );
        expect(html).toContain('data-testid="cmd-header"');
        expect(html).toContain("claude");
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
            renderToStaticMarkup(<BlockElement block={block} revision={1} model={makeSurfaceModel(block) as any} />)
        ).not.toThrow();
    });

    it("renders a running raw-capture TUI block as a full-height terminal surface", () => {
        const block = makeBlock(false) as any;
        block.outputGrid.cursorState.visible = true;
        const html = renderToStaticMarkup(
            <BlockElement
                block={block}
                revision={1}
                model={
                    {
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
                    } as any
                }
            />
        );
        expect(html).toContain('data-testid="cmd-header"');
        expect(html).not.toContain('data-testid="cmd-snackbar"');
        expect(html).toMatch(/data-testid="grid"[^>]*class="[^"]*min-h-full/);
        expect(html).toContain('data-testid="cursor"');
    });

    it("renders long-running PTY output as normal scrollback when the app has no terminal capture mode", () => {
        const block = makeBlock(false) as any;
        block.outputGrid.cursorState.visible = false;
        const html = renderToStaticMarkup(
            <BlockElement
                block={block}
                revision={1}
                model={
                    {
                        getMode: () => DefaultTermMode,
                        getActiveSurfaceState: () => ({ kind: "long-running-pty", blockId: block.id }),
                        getCursorRenderState: () => ({ kind: "suppressed", reason: "rich-input-open" }),
                    } as any
                }
            />
        );

        expect(html).not.toContain('data-testid="cursor"');
        expect(html).not.toContain("h-full min-h-full");
    });

    it("does not render a cursor for non-TUI running blocks when cursor is suppressed", () => {
        // Non-TUI running blocks (e.g. the 50ms window before long-running
        // heuristic fires, or shell prompt input) respect the suppressed state.
        const block = makeBlock(false) as any;
        block.state = "running";
        block.outputGrid.cursorState.visible = true;
        const html = renderToStaticMarkup(
            <BlockElement
                block={block}
                revision={1}
                model={
                    {
                        getMode: () => DefaultTermMode,
                        getActiveSurfaceState: () => null,
                        getCursorRenderState: () => ({ kind: "suppressed", reason: "rich-input-open" }),
                    } as any
                }
            />
        );

        expect(html).not.toContain('data-testid="cursor"');
    });
});
