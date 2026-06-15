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

describe("right tool panel state", () => {
    it("defaults to visible with no opened tools", () => {
        expect(DefaultRightToolPanelState.visible).toBe(true);
        expect(DefaultRightToolPanelState.openedTools).toEqual([]);
        expect(DefaultRightToolPanelState.activeTool).toBeUndefined();
        expect(DefaultRightToolPanelState.focused).toBe(false);
        expect(DefaultRightToolPanelState.magnified).toBe(false);
    });

    it("normalizes unknown and duplicate tools from persisted state", () => {
        const state = normalizeRightToolPanelState({
            visible: true,
            width: 99999,
            openedTools: ["editor", "editor", "bad-tool", "browser"],
            activeTool: "bad-tool",
            toolState: { editor: { path: "a.ts" }, "bad-tool": { x: 1 } },
            focused: true,
            magnified: true,
        } as any, 1200);

        expect(state.openedTools).toEqual(["editor", "browser"]);
        expect(state.activeTool).toBe("editor");
        expect(state.toolState).toEqual({ editor: { path: "a.ts" } });
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
        const first = openRightTool(DefaultRightToolPanelState, "editor");
        const second = openRightTool(first, "browser");
        const third = openRightTool(second, "editor");

        expect(third.openedTools).toEqual(["editor", "browser"]);
        expect(third.activeTool).toBe("editor");
    });

    it("selects only opened tools", () => {
        const state = openRightTool(DefaultRightToolPanelState, "terminal");

        expect(selectRightTool(state, "terminal").activeTool).toBe("terminal");
        expect(selectRightTool(state, "browser").activeTool).toBe("terminal");
    });

    it("closes active tools and falls back to a neighbor", () => {
        const state = openRightTool(
            openRightTool(openRightTool(DefaultRightToolPanelState, "editor"), "browser"),
            "terminal"
        );

        const afterTerminal = closeRightTool(state, "terminal");
        expect(afterTerminal.openedTools).toEqual(["editor", "browser"]);
        expect(afterTerminal.activeTool).toBe("browser");

        const afterBrowser = closeRightTool(afterTerminal, "browser");
        expect(afterBrowser.activeTool).toBe("editor");

        const afterEditor = closeRightTool(afterBrowser, "editor");
        expect(afterEditor.openedTools).toEqual([]);
        expect(afterEditor.activeTool).toBeUndefined();
    });

    it("clamps width to a usable right panel range", () => {
        expect(setRightToolPanelWidth(DefaultRightToolPanelState, 20, 1400).width).toBe(MinRightToolPanelWidth);
        expect(setRightToolPanelWidth(DefaultRightToolPanelState, 2000, 1000).width).toBe(
            Math.floor(1000 * MaxRightToolPanelWidthRatio)
        );
    });
});
