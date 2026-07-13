// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { globalStore } from "./jotaiStore";
import { FocusManager } from "./focusManager";

describe("FocusManager", () => {
    it("switches between node and right tool panel focus scopes", () => {
        const focusManager = FocusManager.getInstance();

        focusManager.requestRightToolPanelFocus();
        expect(globalStore.get(focusManager.focusType)).toBe("righttool");

        focusManager.requestNodeFocus();
        expect(globalStore.get(focusManager.focusType)).toBe("node");
    });
});
