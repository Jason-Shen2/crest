// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DefaultRightToolPanelState, openRightTool } from "@/app/workspace/right-tool-panel-state";
import type { RightToolPanelState } from "@/app/workspace/right-tool-panel-state";
import { getCodeReviewButtonActive, openCodeReviewFromTopBar } from "./topbar-code-review";

function makeModel(initialState: RightToolPanelState) {
    let state = initialState;
    return {
        get state() {
            return state;
        },
        openRightTool(tool: "codeReview") {
            state = openRightTool(state, tool);
        },
    };
}

describe("TopBar code review button", () => {
    it("opens codeReview and shows the hidden right panel when clicked", () => {
        const model = makeModel({
            ...DefaultRightToolPanelState,
            visible: false,
            openedTools: [],
            activeTool: undefined,
        });

        openCodeReviewFromTopBar(model);

        expect(model.state).toMatchObject({
            visible: true,
            openedTools: ["codeReview"],
            activeTool: "codeReview",
        });
    });

    it("activates codeReview when another right tool tab is active", () => {
        const model = makeModel({
            ...DefaultRightToolPanelState,
            visible: true,
            openedTools: ["browser", "codeReview"],
            activeTool: "browser",
        });

        openCodeReviewFromTopBar(model);

        expect(model.state.openedTools).toEqual(["browser", "codeReview"]);
        expect(model.state.activeTool).toBe("codeReview");
    });

    it("does not duplicate the codeReview tab when clicked repeatedly", () => {
        const model = makeModel({
            ...DefaultRightToolPanelState,
            visible: true,
            openedTools: ["codeReview"],
            activeTool: "codeReview",
        });

        openCodeReviewFromTopBar(model);
        openCodeReviewFromTopBar(model);

        expect(model.state.openedTools).toEqual(["codeReview"]);
        expect(model.state.activeTool).toBe("codeReview");
    });

    it("marks the button active only for the visible active codeReview tab", () => {
        expect(getCodeReviewButtonActive({
            ...DefaultRightToolPanelState,
            visible: true,
            openedTools: ["codeReview"],
            activeTool: "codeReview",
        })).toBe(true);
        expect(getCodeReviewButtonActive({
            ...DefaultRightToolPanelState,
            visible: false,
            openedTools: ["codeReview"],
            activeTool: "codeReview",
        })).toBe(false);
        expect(getCodeReviewButtonActive({
            ...DefaultRightToolPanelState,
            visible: true,
            openedTools: ["browser", "codeReview"],
            activeTool: "browser",
        })).toBe(false);
    });
});
