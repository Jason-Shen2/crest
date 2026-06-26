// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
        expect(html).toContain('aria-label="Resize /model menu"');
        expect(html).toContain('data-command-inline-drag-handle="true"');
    });
});
