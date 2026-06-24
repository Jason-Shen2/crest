// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
    DefaultTermMode,
    deriveTerminalInputState,
    terminalCaptureActive,
    type BlockLifecycleState,
    type TermMode,
    type TerminalStateBlock,
} from ".";

function mode(patch: Partial<TermMode>): TermMode {
    return { ...DefaultTermMode, ...patch };
}

function block(patch: Partial<TerminalStateBlock> = {}): TerminalStateBlock {
    return {
        id: "b1",
        kind: "shell",
        state: "running" as BlockLifecycleState,
        altScreen: { active: false },
        durationMs: () => 0,
        ...patch,
    };
}

describe("terminalCaptureActive", () => {
    it("treats terminal ownership modes as capture signals", () => {
        expect(terminalCaptureActive(mode({ appCursor: true }))).toBe(true);
        expect(terminalCaptureActive(mode({ appKeypad: true }))).toBe(true);
        expect(terminalCaptureActive(mode({ focusReport: true }))).toBe(true);
        expect(terminalCaptureActive(mode({ alternateScroll: true }))).toBe(true);
        expect(terminalCaptureActive(mode({ mouseClick: true }))).toBe(true);
        expect(terminalCaptureActive(mode({ kittyKeyboardFlags: 1 }))).toBe(true);
    });

    it("does not treat bracketed paste alone as terminal capture", () => {
        expect(terminalCaptureActive(mode({ bracketedPaste: true }))).toBe(false);
    });
});

describe("deriveTerminalInputState", () => {
    it("returns not-bootstrapped before the terminal is ready", () => {
        expect(deriveTerminalInputState({ loading: true, blocks: [], mode: mode({}) })).toEqual({
            kind: "not-bootstrapped",
        });
    });

    it("returns input-editor when no shell block owns input", () => {
        expect(deriveTerminalInputState({ blocks: [], mode: mode({}) })).toEqual({ kind: "input-editor" });
    });

    it("lets alt-screen win over terminal capture and long-running", () => {
        expect(
            deriveTerminalInputState({
                blocks: [block({ altScreen: { active: true }, durationMs: () => 51 })],
                mode: mode({ appCursor: true }),
            })
        ).toEqual({ kind: "alt-screen", blockId: "b1" });
    });

    it("lets terminal capture win over long-running", () => {
        expect(
            deriveTerminalInputState({
                blocks: [block({ durationMs: () => 51 })],
                mode: mode({ mouseClick: true }),
            })
        ).toEqual({ kind: "terminal-capture", blockId: "b1" });
    });

    it("returns long-running-command only after the Warp threshold", () => {
        expect(
            deriveTerminalInputState({
                blocks: [block({ durationMs: () => 50 })],
                mode: mode({}),
            })
        ).toEqual({ kind: "input-editor" });

        expect(
            deriveTerminalInputState({
                blocks: [block({ durationMs: () => 51 })],
                mode: mode({}),
            })
        ).toEqual({ kind: "long-running-command", blockId: "b1" });
    });

    it("ignores agent blocks when deriving terminal input ownership", () => {
        expect(
            deriveTerminalInputState({
                blocks: [
                    block({
                        id: "agent-1",
                        kind: "agent",
                        altScreen: { active: true },
                        durationMs: () => 51,
                    }),
                ],
                mode: mode({ appCursor: true }),
            })
        ).toEqual({ kind: "input-editor" });
    });
});
