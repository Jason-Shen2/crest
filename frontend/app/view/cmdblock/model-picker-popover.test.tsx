// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { COMMAND_INLINE_FRAME_CLASSNAME } from "./command-inline-frame";
import { ModelPickerInline } from "./model-picker-popover";

describe("ModelPickerInline", () => {
    it("renders inside the shared command inline frame", () => {
        const html = renderToStaticMarkup(
            <ModelPickerInline
                open
                onOpenChange={() => undefined}
                selection={null}
                onSelectionChange={vi.fn()}
                userConfig={null}
                userConfigStatus="ok"
                catalog={[]}
            />
        );

        expect(html).toContain("/model");
        expect(COMMAND_INLINE_FRAME_CLASSNAME).toContain("rounded-2xl");
        expect(COMMAND_INLINE_FRAME_CLASSNAME).toContain("bg-[rgba(34,34,36,0.62)]");
        expect(COMMAND_INLINE_FRAME_CLASSNAME).toContain("backdrop-blur-2xl");
        expect(COMMAND_INLINE_FRAME_CLASSNAME).not.toContain("border-t");
        expect(html).toContain('aria-label="Resize /model menu"');
        expect(html).toContain('data-command-inline-drag-handle="true"');
        expect(html).toContain("flex min-w-0 flex-1 items-center gap-3");
        expect(html.indexOf("<span>Add</span>")).toBeLessThan(html.indexOf('data-command-inline-drag-handle="true"'));
        expect(html).not.toContain("absolute inset-0");
    });

    it("uses rounded attached-panel search and hint surfaces", () => {
        const html = renderToStaticMarkup(
            <ModelPickerInline
                open
                onOpenChange={() => undefined}
                selection={null}
                onSelectionChange={vi.fn()}
                userConfig={null}
                userConfigStatus="ok"
                catalog={[]}
            />
        );

        expect(html).toContain("rounded-xl");
        expect(html).toContain("bg-white/[0.045]");
        expect(html).toContain("border-t border-white/[0.06]");
        expect(html).not.toContain("border-b border-fg-overlay-2");
        expect(html).not.toContain("bg-fg-overlay-1/60");
    });
});
