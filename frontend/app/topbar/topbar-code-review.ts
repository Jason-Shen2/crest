// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RightToolPanelState } from "@/app/workspace/right-tool-panel-state";

type CodeReviewToolOpener = {
    openRightTool: (tool: "codeReview") => void;
    setRightToolPanelFocused: (focused: boolean) => void;
};

export function getCodeReviewButtonActive(state: Pick<RightToolPanelState, "visible" | "activeTool">): boolean {
    return state.visible && state.activeTool === "codeReview";
}

export function openCodeReviewFromTopBar(layoutModel: CodeReviewToolOpener): void {
    layoutModel.setRightToolPanelFocused(false);
    layoutModel.openRightTool("codeReview");
}
