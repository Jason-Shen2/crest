// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type RightToolId = "editor" | "browser" | "terminal" | "codeReview";

export type RightToolPanelState = {
    visible: boolean;
    width: number;
    openedTools: RightToolId[];
    activeTool?: RightToolId;
    toolState: Partial<Record<RightToolId, unknown>>;
    focused: boolean;
    magnified: boolean;
};

export const RightToolIds: RightToolId[] = ["editor", "browser", "terminal", "codeReview"];
export const DefaultRightToolPanelWidth = 400;
export const MinRightToolPanelWidth = 320;
export const MaxRightToolPanelWidthRatio = 0.7;

export const DefaultRightToolPanelState: RightToolPanelState = {
    visible: true,
    width: DefaultRightToolPanelWidth,
    openedTools: [],
    activeTool: undefined,
    toolState: {},
    focused: false,
    magnified: false,
};

function isRightToolId(value: unknown): value is RightToolId {
    return typeof value === "string" && RightToolIds.includes(value as RightToolId);
}

function clamp(value: number, min: number, max: number): number {
    if (max < min) {
        return min;
    }
    return Math.max(min, Math.min(value, max));
}

export function getRightToolPanelMaxWidth(windowWidth: number): number {
    return Math.max(MinRightToolPanelWidth, Math.floor(windowWidth * MaxRightToolPanelWidthRatio));
}

export function clampRightToolPanelWidth(width: unknown, windowWidth: number): number {
    const numericWidth = typeof width === "number" && Number.isFinite(width) ? width : DefaultRightToolPanelWidth;
    return clamp(numericWidth, MinRightToolPanelWidth, getRightToolPanelMaxWidth(windowWidth));
}

function normalizeInputState(value: unknown): Partial<RightToolPanelState> {
    if (value == null || typeof value !== "object") {
        return {};
    }
    return value as Partial<RightToolPanelState>;
}

export function normalizeRightToolPanelState(value: unknown, windowWidth: number): RightToolPanelState {
    const input = normalizeInputState(value);
    const openedTools: RightToolId[] = [];
    const incomingOpenedTools = Array.isArray(input.openedTools) ? input.openedTools : [];
    for (const tool of incomingOpenedTools) {
        if (!isRightToolId(tool) || openedTools.includes(tool)) {
            continue;
        }
        openedTools.push(tool);
    }

    const activeTool =
        isRightToolId(input.activeTool) && openedTools.includes(input.activeTool) ? input.activeTool : openedTools[0];

    const toolState: Partial<Record<RightToolId, unknown>> = {};
    const incomingToolState = normalizeInputState(input.toolState);
    for (const tool of RightToolIds) {
        if (Object.prototype.hasOwnProperty.call(incomingToolState, tool)) {
            toolState[tool] = incomingToolState[tool];
        }
    }

    return {
        visible: typeof input.visible === "boolean" ? input.visible : DefaultRightToolPanelState.visible,
        width: clampRightToolPanelWidth(input.width, windowWidth),
        openedTools,
        activeTool,
        toolState,
        focused: false,
        magnified: false,
    };
}

export function openRightTool(state: RightToolPanelState, tool: RightToolId): RightToolPanelState {
    const openedTools = state.openedTools.includes(tool) ? state.openedTools : [...state.openedTools, tool];
    return {
        ...state,
        visible: true,
        openedTools,
        activeTool: tool,
        focused: state.visible ? state.focused : false,
    };
}

export function selectRightTool(state: RightToolPanelState, tool: RightToolId): RightToolPanelState {
    if (!state.openedTools.includes(tool)) {
        return state;
    }
    return { ...state, activeTool: tool };
}

export function closeRightTool(state: RightToolPanelState, tool: RightToolId): RightToolPanelState {
    const idx = state.openedTools.indexOf(tool);
    if (idx === -1) {
        return state;
    }
    const openedTools = state.openedTools.filter((openedTool) => openedTool !== tool);
    let activeTool = state.activeTool;
    if (activeTool === tool) {
        activeTool = openedTools[Math.max(0, idx - 1)];
    }
    return { ...state, openedTools, activeTool, magnified: openedTools.length > 0 ? state.magnified : false };
}

export function setRightToolPanelWidth(
    state: RightToolPanelState,
    width: number,
    windowWidth: number
): RightToolPanelState {
    return { ...state, width: clampRightToolPanelWidth(width, windowWidth) };
}

export function makePersistedRightToolPanelState(state: RightToolPanelState): Partial<RightToolPanelState> {
    return {
        visible: state.visible,
        width: state.width,
        openedTools: state.openedTools,
        activeTool: state.activeTool,
        toolState: state.toolState,
    };
}
