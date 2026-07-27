// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentPtyScreenView } from "./agent-pty-screen-view";

function makeSnapshot(overrides: Partial<AgentPtySnapshot> = {}): AgentPtySnapshot {
    return {
        commandId: "cmd-1",
        command: "vim README.md",
        cwd: "/repo",
        tail: "\u001b[?1049hhidden ansi",
        screen: {
            rows: [
                { text: "hello", cells: [{ char: "h" }, { char: "e" }, { char: "l" }, { char: "l" }, { char: "o" }] },
                { text: "world", cells: [{ char: "w" }, { char: "o" }, { char: "r" }, { char: "l" }, { char: "d" }] },
            ],
            cursor: { row: 1, col: 2, visible: true, shape: "block", blink: false },
            isAltScreenActive: true,
        },
        running: true,
        cols: 5,
        rows: 2,
        needsUserInput: false,
        ...overrides,
    };
}

describe("AgentPtyScreenView", () => {
    it("renders snapshot screen rows and cursor without raw ANSI tail text", () => {
        render(<AgentPtyScreenView snapshot={makeSnapshot()} />);

        expect(screen.getByText("hello")).toBeTruthy();
        expect(screen.getByText("world")).toBeTruthy();
        expect(screen.queryByText(/\u001b/)).toBeNull();
        expect(screen.getByTestId("agent-pty-cursor").getAttribute("data-row")).toBe("1");
        expect(screen.getByTestId("agent-pty-cursor").getAttribute("data-col")).toBe("2");
    });
});
