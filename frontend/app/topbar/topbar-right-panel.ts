// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RightToolPanelState } from "@/app/workspace/right-tool-panel-state";

type RightPanelToggler = {
    setRightToolPanelFocused: (focused: boolean) => void;
    setRightToolPanelVisible: (visible: boolean) => void;
};

export function getRightPanelButtonActive(state: Pick<RightToolPanelState, "visible">): boolean {
    return state.visible;
}

export function toggleRightPanelFromTopBar(layoutModel: RightPanelToggler, currentlyVisible: boolean): void {
    layoutModel.setRightToolPanelFocused(false);
    layoutModel.setRightToolPanelVisible(!currentlyVisible);
}
