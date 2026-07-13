// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
    COMMAND_INLINE_FRAME_CLASSNAME,
    CommandInlineFrame,
    isCommandInlineFrameDismissKey,
    shouldDismissCommandInlineFramePointerDown,
} from "./command-inline-frame";

describe("CommandInlineFrame", () => {
    it("renders the shared inline command frame with command label and drag handle", () => {
        const html = renderToStaticMarkup(
            <CommandInlineFrame commandName="/tree" onResizeStart={() => undefined}>
                <div>tree rows</div>
            </CommandInlineFrame>
        );

        expect(COMMAND_INLINE_FRAME_CLASSNAME).toContain("rounded-2xl");
        expect(COMMAND_INLINE_FRAME_CLASSNAME).toContain("border-white/[0.12]");
        expect(COMMAND_INLINE_FRAME_CLASSNAME).toContain("bg-[rgba(34,34,36,0.62)]");
        expect(COMMAND_INLINE_FRAME_CLASSNAME).toContain("backdrop-blur-2xl");
        expect(COMMAND_INLINE_FRAME_CLASSNAME).toContain("shadow-[0_10px_32px_-24px");
        expect(COMMAND_INLINE_FRAME_CLASSNAME).not.toContain("border-t");
        expect(html).toContain("/tree");
        expect(html).toContain("flex min-w-0 flex-1 items-center gap-3");
        expect(html).toContain('aria-label="Resize /tree menu"');
        expect(html).toContain('data-command-inline-drag-handle="true"');
        expect(html).not.toContain("absolute inset-0");
        expect(html).toContain("tree rows");
    });

    it("dismisses only for outside clicks and Escape", () => {
        const insidePanel = {} as Node;
        const insideAnchor = {} as Node;
        const outside = {} as Node;
        const panel = { contains: (node: Node) => node === insidePanel } as HTMLElement;
        const anchor = { contains: (node: Node) => node === insideAnchor } as HTMLElement;

        expect(shouldDismissCommandInlineFramePointerDown(panel, anchor, insidePanel)).toBe(false);
        expect(shouldDismissCommandInlineFramePointerDown(panel, anchor, insideAnchor)).toBe(false);
        expect(shouldDismissCommandInlineFramePointerDown(panel, anchor, outside)).toBe(true);
        expect(shouldDismissCommandInlineFramePointerDown(panel, anchor, null)).toBe(false);
        expect(isCommandInlineFrameDismissKey("Escape")).toBe(true);
        expect(isCommandInlineFrameDismissKey("Enter")).toBe(false);
    });
});
