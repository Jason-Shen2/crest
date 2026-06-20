// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { getRightPanelButtonActive, toggleRightPanelFromTopBar } from "./topbar-code-review";

function makeModel() {
    return {
        setRightToolPanelFocused: vi.fn(),
        setRightToolPanelVisible: vi.fn(),
    };
}

describe("legacy topbar helper entry", () => {
    it("re-exports the workspace right panel toggle helpers", () => {
        const model = makeModel();

        toggleRightPanelFromTopBar(model, false);

        expect(model.setRightToolPanelFocused).toHaveBeenCalledWith(false);
        expect(model.setRightToolPanelVisible).toHaveBeenCalledWith(true);
    });

    it("uses right panel visibility for active state", () => {
        expect(getRightPanelButtonActive({ visible: true })).toBe(true);
        expect(getRightPanelButtonActive({ visible: false })).toBe(false);
    });
});
