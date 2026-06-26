// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CursorOverlay } from "./cursor-overlay";

function makeGrid(overrides: { visible?: boolean; shape?: string; row?: number; col?: number } = {}) {
    return {
        cursor: { row: overrides.row ?? 0, col: overrides.col ?? 0 },
        cursorState: {
            visible: overrides.visible ?? true,
            shape: overrides.shape ?? "block",
            blink: false,
        },
    } as any;
}

describe("CursorOverlay", () => {
    it("renders a visible cursor by default when caller does not suppress it", () => {
        const html = renderToStaticMarkup(
            <CursorOverlay grid={makeGrid({ visible: false })} charWidth={8} lineHeight={16} />
        );

        // Visibility is controlled by the `visible` prop (default true),
        // NOT by grid.cursorState.visible — TUI apps send CSI ?25 l to
        // hide the host cursor but in a Warp-style renderer we are the
        // host and the caller (BlockElement) decides visibility.
        expect(html).toContain("position:absolute");
    });

    it("returns null when caller explicitly sets visible=false", () => {
        const html = renderToStaticMarkup(
            <CursorOverlay grid={makeGrid({ visible: true })} charWidth={8} lineHeight={16} visible={false} />
        );

        expect(html).toBe("");
    });

    it("renders block shape at full cell size with reduced opacity", () => {
        const html = renderToStaticMarkup(
            <CursorOverlay grid={makeGrid({ shape: "block", row: 2, col: 3 })} charWidth={8} lineHeight={16} />
        );

        expect(html).toContain("width:8px");
        expect(html).toContain("height:16px");
        expect(html).toContain("top:32px");
        expect(html).toContain("left:24px");
        expect(html).toContain("opacity:0.5");
    });

    it("renders underline shape as a 2px strip at the cell bottom", () => {
        const html = renderToStaticMarkup(
            <CursorOverlay grid={makeGrid({ shape: "underline", row: 0, col: 0 })} charWidth={8} lineHeight={16} />
        );

        expect(html).toContain("width:8px");
        expect(html).toContain("height:2px");
        expect(html).toContain("top:14px");
    });

    it("renders bar shape as a 2px wide vertical line", () => {
        const html = renderToStaticMarkup(
            <CursorOverlay grid={makeGrid({ shape: "bar", row: 0, col: 0 })} charWidth={8} lineHeight={16} />
        );

        expect(html).toContain("width:2px");
        expect(html).toContain("height:16px");
    });
});
