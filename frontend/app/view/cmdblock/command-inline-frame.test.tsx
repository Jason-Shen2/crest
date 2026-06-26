// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { COMMAND_INLINE_FRAME_CLASSNAME, CommandInlineFrame } from "./command-inline-frame";

describe("CommandInlineFrame", () => {
    it("renders the shared inline command frame with command label and drag handle", () => {
        const html = renderToStaticMarkup(
            <CommandInlineFrame commandName="/tree" onResizeStart={() => undefined}>
                <div>tree rows</div>
            </CommandInlineFrame>
        );

        expect(COMMAND_INLINE_FRAME_CLASSNAME).toContain("border-t");
        expect(COMMAND_INLINE_FRAME_CLASSNAME).toContain("border-fg-overlay-2");
        expect(COMMAND_INLINE_FRAME_CLASSNAME).toContain("bg-fg-overlay-1/40");
        expect(html).toContain("/tree");
        expect(html).toContain('aria-label="Resize /tree menu"');
        expect(html).toContain('data-command-inline-drag-handle="true"');
        expect(html).toContain("tree rows");
    });
});
