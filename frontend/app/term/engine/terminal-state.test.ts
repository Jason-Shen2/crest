// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf, it } from "vitest";

import {
    DefaultTermMode,
    detectCLIAgent,
    terminalCaptureActive,
    type CLIAgent,
    type CLIAgentSession,
    type CursorRenderState,
    type TermMode,
    type TerminalInputState,
    type TerminalSurfaceState,
} from ".";

function mode(patch: Partial<TermMode>): TermMode {
    return { ...DefaultTermMode, ...patch };
}

describe("terminal state types", () => {
    it("exports the planned terminal state shapes", () => {
        const inputState: TerminalInputState = { kind: "terminal-capture", blockId: "b1" };
        const agent: CLIAgent = "claude";
        const surfaceState: TerminalSurfaceState = { kind: "cli-agent", blockId: "b1", agent };
        const cursorState: CursorRenderState = { kind: "cli-owned", agent };
        const terminalCursorState: CursorRenderState = { kind: "terminal" };
        const session: CLIAgentSession = {
            blockId: "b1",
            agent,
            status: "in-progress",
            inputState: { kind: "pty-owned" },
        };

        expect(inputState.kind).toBe("terminal-capture");
        expect(surfaceState.kind).toBe("cli-agent");
        expect(cursorState.kind).toBe("cli-owned");
        expect(terminalCursorState.kind).toBe("terminal");
        expect(session.status).toBe("in-progress");
        expectTypeOf(inputState).toEqualTypeOf<TerminalInputState>();
        expectTypeOf<Extract<CursorRenderState, { kind: "terminal" }>>().toEqualTypeOf<{ kind: "terminal" }>();
        expectTypeOf(session).toEqualTypeOf<CLIAgentSession>();
        expectTypeOf(detectCLIAgent).returns.toEqualTypeOf<CLIAgent | null>();
    });
});

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

    it("returns false for missing terminal mode", () => {
        expect(terminalCaptureActive(null)).toBe(false);
        expect(terminalCaptureActive(undefined)).toBe(false);
    });
});

describe("detectCLIAgent", () => {
    it("detects supported CLI agents from the command prefix", () => {
        expect(detectCLIAgent("claude")).toBe("claude");
        expect(detectCLIAgent("codex --model gpt-5")).toBe("codex");
        expect(detectCLIAgent("gemini chat")).toBe("gemini");
        expect(detectCLIAgent("pi")).toBe("pi");
        expect(detectCLIAgent("coco run")).toBe("coco");
    });

    it("detects basename when command is launched through a path", () => {
        expect(detectCLIAgent("/opt/homebrew/bin/claude --resume")).toBe("claude");
    });

    it("returns null for unsupported, empty, or non-prefix commands", () => {
        expect(detectCLIAgent("")).toBeNull();
        expect(detectCLIAgent("echo coco")).toBeNull();
        expect(detectCLIAgent("npm test")).toBeNull();
        expect(detectCLIAgent("npm run claude")).toBeNull();
        expect(detectCLIAgent("python script.py")).toBeNull();
        expect(detectCLIAgent(null)).toBeNull();
        expect(detectCLIAgent(undefined)).toBeNull();
    });
});
