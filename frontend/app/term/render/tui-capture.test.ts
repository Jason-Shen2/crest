// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DefaultTermMode, type BlockLifecycleState, type TermMode } from "../engine/types";
import { blockIsActiveTuiSurface, terminalCaptureActive } from "./tui-capture";

function mode(overrides: Partial<TermMode>): TermMode {
    return { ...DefaultTermMode, ...overrides };
}

function block(overrides: {
    state?: BlockLifecycleState;
    active?: boolean;
    durationMs?: number;
}) {
    return {
        state: overrides.state ?? "running",
        altScreen: { active: overrides.active ?? false },
        durationMs: () => overrides.durationMs,
    };
}

describe("tui-capture", () => {
    it("treats Warp-style terminal capture modes as active TUI signals", () => {
        expect(terminalCaptureActive(mode({ appCursor: true }))).toBe(true);
        expect(terminalCaptureActive(mode({ focusReport: true }))).toBe(true);
        expect(terminalCaptureActive(mode({ alternateScroll: true }))).toBe(true);
        expect(terminalCaptureActive(mode({ appKeypad: true }))).toBe(true);
        expect(terminalCaptureActive(mode({ mouseClick: true }))).toBe(true);
        expect(terminalCaptureActive(mode({ kittyKeyboardFlags: 1 }))).toBe(true);
    });

    it("does not let bracketed paste alone trigger TUI capture", () => {
        expect(terminalCaptureActive(mode({ bracketedPaste: true }))).toBe(false);
        expect(blockIsActiveTuiSurface(block({}), mode({ bracketedPaste: true }))).toBe(false);
    });

    it("requires a running block for raw terminal capture, but not for alt-screen", () => {
        expect(blockIsActiveTuiSurface(block({ state: "done-with-execution" }), mode({ appCursor: true }))).toBe(false);
        expect(blockIsActiveTuiSurface(block({ state: "done-with-execution", active: true }), mode({}))).toBe(true);
    });

    it("treats Warp-style active long-running commands as input-capture surfaces", () => {
        expect(blockIsActiveTuiSurface(block({ durationMs: 50 }), mode({}))).toBe(false);
        expect(blockIsActiveTuiSurface(block({ durationMs: 51 }), mode({}))).toBe(true);
        expect(blockIsActiveTuiSurface(block({ state: "done-with-execution", durationMs: 51 }), mode({}))).toBe(false);
    });
});
