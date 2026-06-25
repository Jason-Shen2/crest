// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CursorOverlay } from "./cursor-overlay";

function grid(visible: boolean) {
    return {
        cursor: { row: 0, col: 0 },
        cursorState: { visible, shape: "block", blink: false },
    } as any;
}

describe("CursorOverlay", () => {
    it("respects the grid cursor visibility by default", () => {
        const html = renderToStaticMarkup(
            <CursorOverlay grid={grid(false)} charWidth={8} lineHeight={16} />
        );

        expect(html).toBe("");
    });

    it("does not force a hidden terminal cursor visible", () => {
        const html = renderToStaticMarkup(
            <CursorOverlay grid={grid(false)} charWidth={8} lineHeight={16} />
        );

        expect(html).toBe("");
    });
});
