// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { getRightPanelButtonActive, toggleRightPanelFromTopBar } from "./topbar-right-panel";

function makeModel() {
    return {
        setRightToolPanelFocused: vi.fn(),
        setRightToolPanelVisible: vi.fn(),
    };
}

describe("TopBar right panel button", () => {
    it("shows active state when the right tool panel is visible", () => {
        expect(getRightPanelButtonActive({ visible: true })).toBe(true);
        expect(getRightPanelButtonActive({ visible: false })).toBe(false);
    });

    it("hides the visible right tool panel from the workspace chrome button", () => {
        const model = makeModel();

        toggleRightPanelFromTopBar(model, true);

        expect(model.setRightToolPanelFocused).toHaveBeenCalledWith(false);
        expect(model.setRightToolPanelVisible).toHaveBeenCalledWith(false);
    });

    it("shows the hidden right tool panel from the same workspace chrome button", () => {
        const model = makeModel();

        toggleRightPanelFromTopBar(model, false);

        expect(model.setRightToolPanelFocused).toHaveBeenCalledWith(false);
        expect(model.setRightToolPanelVisible).toHaveBeenCalledWith(true);
    });
});
