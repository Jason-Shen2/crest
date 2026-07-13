// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    closeRightTool,
    DefaultRightToolPanelState,
    MaxRightToolPanelWidthRatio,
    MinRightToolPanelWidth,
    normalizeRightToolPanelState,
    openRightTool,
    selectRightTool,
    setRightToolPanelWidth,
} from "./right-tool-panel-state";
import type { RightToolPanelState } from "./right-tool-panel-state";

describe("right tool panel state", () => {
    it("defaults to visible with no opened tools", () => {
        expect(DefaultRightToolPanelState.visible).toBe(true);
        expect(DefaultRightToolPanelState.openedTools).toEqual([]);
        expect(DefaultRightToolPanelState.activeTool).toBeUndefined();
        expect(DefaultRightToolPanelState.focused).toBe(false);
        expect(DefaultRightToolPanelState.magnified).toBe(false);
    });

    it("normalizes unknown and duplicate tools from persisted state", () => {
        const state = normalizeRightToolPanelState(
            {
                visible: true,
                width: 99999,
                openedTools: ["editor", "editor", "bad-tool", "browser"],
                activeTool: "bad-tool",
                toolState: { editor: { path: "a.ts" }, "bad-tool": { x: 1 } },
                focused: true,
                magnified: true,
            } as any,
            1200
        );

        expect(state.openedTools).toEqual(["browser"]);
        expect(state.activeTool).toBe("browser");
        expect(state.toolState).toEqual({});
        expect(state.focused).toBe(false);
        expect(state.magnified).toBe(false);
        expect(state.width).toBeLessThanOrEqual(Math.floor(1200 * MaxRightToolPanelWidthRatio));
    });

    it("normalizes malformed persisted state without throwing", () => {
        expect(normalizeRightToolPanelState(null as any, 1200)).toMatchObject({
            visible: true,
            width: 400,
            openedTools: [],
            activeTool: undefined,
            toolState: {},
            focused: false,
            magnified: false,
        });
        expect(normalizeRightToolPanelState("bad-state" as any, 1200).openedTools).toEqual([]);
        expect(normalizeRightToolPanelState({ openedTools: "editor" } as any, 1200).openedTools).toEqual([]);
        expect(normalizeRightToolPanelState({ openedTools: 42 } as any, 1200).openedTools).toEqual([]);
    });

    it("opens each outer tool at most once and activates it", () => {
        const first = openRightTool(DefaultRightToolPanelState, "browser");
        const second = openRightTool(first, "sourceControl");
        const third = openRightTool(second, "browser");

        expect(third.openedTools).toEqual(["browser", "sourceControl"]);
        expect(third.activeTool).toBe("browser");
    });

    it("ignores the temporarily unavailable editor tool", () => {
        const state = openRightTool(DefaultRightToolPanelState, "editor");

        expect(state).toBe(DefaultRightToolPanelState);
    });

    it("does not carry stale focus when a hidden panel is reopened by a non-panel entry", () => {
        const state: RightToolPanelState = {
            ...DefaultRightToolPanelState,
            visible: false,
            focused: true,
            openedTools: ["codeReview"],
            activeTool: "codeReview",
        };

        expect(openRightTool(state, "codeReview")).toMatchObject({
            visible: true,
            openedTools: ["codeReview"],
            activeTool: "codeReview",
            focused: false,
        });
    });

    it("selects only opened tools", () => {
        const state = openRightTool(DefaultRightToolPanelState, "terminal");

        expect(selectRightTool(state, "terminal").activeTool).toBe("terminal");
        expect(selectRightTool(state, "browser").activeTool).toBe("terminal");
    });

    it("closes active tools and falls back to a neighbor", () => {
        const state = openRightTool(
            openRightTool(openRightTool(DefaultRightToolPanelState, "browser"), "sourceControl"),
            "terminal"
        );

        const afterTerminal = closeRightTool(state, "terminal");
        expect(afterTerminal.openedTools).toEqual(["browser", "sourceControl"]);
        expect(afterTerminal.activeTool).toBe("sourceControl");

        const afterSourceControl = closeRightTool(afterTerminal, "sourceControl");
        expect(afterSourceControl.activeTool).toBe("browser");

        const afterBrowser = closeRightTool(afterSourceControl, "browser");
        expect(afterBrowser.openedTools).toEqual([]);
        expect(afterBrowser.activeTool).toBeUndefined();
    });

    it("clears magnified when closing the last open tool so the launcher panel can render", () => {
        const state = {
            ...openRightTool(DefaultRightToolPanelState, "browser"),
            magnified: true,
        };

        const afterBrowser = closeRightTool(state, "browser");

        expect(afterBrowser.openedTools).toEqual([]);
        expect(afterBrowser.activeTool).toBeUndefined();
        expect(afterBrowser.visible).toBe(true);
        expect(afterBrowser.magnified).toBe(false);
    });

    it("clamps width to a usable right panel range", () => {
        expect(setRightToolPanelWidth(DefaultRightToolPanelState, 20, 1400).width).toBe(MinRightToolPanelWidth);
        expect(setRightToolPanelWidth(DefaultRightToolPanelState, 2000, 1000).width).toBe(
            Math.floor(1000 * MaxRightToolPanelWidthRatio)
        );
    });
});
