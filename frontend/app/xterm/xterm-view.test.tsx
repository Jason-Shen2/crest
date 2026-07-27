// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const state = {
        mode: "prompt",
        listeners,
        attachCalls: [] as { blockId: string; opts: any }[],
        submitCalls: [] as [string, string][],
        interruptCalls: [] as string[],
        inputActivity: [] as boolean[],
        clearFindCalls: [] as string[],
        focusCalls: [] as string[],
        focusInputCalls: [] as string[],
        setMode(next: string) {
            state.mode = next;
            for (const l of [...listeners]) l();
        },
        reset() {
            state.mode = "prompt";
            listeners.clear();
            state.attachCalls.length = 0;
            state.submitCalls.length = 0;
            state.interruptCalls.length = 0;
            state.inputActivity.length = 0;
            state.clearFindCalls.length = 0;
            state.focusCalls.length = 0;
            state.focusInputCalls.length = 0;
        },
    };
    return state;
});

vi.mock("./xterm-session", () => ({
    attachSession: (blockId: string, _host: any, _cbs: any, opts: any) => h.attachCalls.push({ blockId, opts }),
    detachSession: () => {},
    focusSession: (blockId: string) => h.focusCalls.push(blockId),
    focusSessionInput: (blockId: string) => h.focusInputCalls.push(blockId),
    setSessionVisibility: () => {},
    setSessionInputFocus: () => {},
    setSessionInputActivity: (_blockId: string, active: boolean) => h.inputActivity.push(active),
    getSessionBlockMode: () => h.mode,
    subscribeSessionBlockMode: (_blockId: string, cb: () => void) => {
        h.listeners.add(cb);
        return () => h.listeners.delete(cb);
    },
    subscribeSessionBlocks: () => () => {},
    getSessionVisibleBlocks: () => ({ blocks: [], sticky: null }),
    readSessionBlockOutput: () => null,
    searchSessionBlock: () => [],
    revealSessionBlockMatch: () => {},
    clearSessionBlockSearch: () => {},
    selectSessionBlockAt: () => {},
    getSessionWatermarkState: () => "hidden",
    submitToSession: (blockId: string, text: string) => h.submitCalls.push([blockId, text]),
    interruptSession: (blockId: string) => h.interruptCalls.push(blockId),
    writeToSession: () => true,
    findInSession: () => {},
    findNextInSession: () => {},
    findPreviousInSession: () => {},
    clearSessionFind: (blockId: string) => h.clearFindCalls.push(blockId),
}));

vi.mock("@/app/view/cmdblock/cmdblock-input", () => ({
    CmdBlockInput: (props: any) => (
        <div data-testid="cmdblock-input">
            <button data-testid="stub-submit" onClick={() => props.onSubmit("echo hi", "terminal")} />
            <button data-testid="stub-type" onClick={() => props.onTextChange?.("draft")} />
            <button data-testid="stub-clear" onClick={() => props.onTextChange?.("")} />
        </div>
    ),
}));

vi.mock("./block/block-overlay", () => ({
    BlockOverlay: () => <div data-testid="block-overlay" />,
}));

vi.mock("./block/block-watermark", () => ({
    BlockWatermark: () => <div data-testid="block-watermark" />,
}));

vi.mock("@/app/term/render/terminal-notification", () => ({
    TerminalNotification: () => null,
}));

import { XtermView } from "./xterm-view";

function inputBarHidden(): boolean {
    return screen.getByTestId("xterm-input-bar").className.split(/\s+/).includes("hidden");
}

beforeEach(() => {
    h.reset();
});

afterEach(() => {
    cleanup();
});

describe("XtermView blocks mode", () => {
    it("attaches the session with the blocks flag", () => {
        render(<XtermView outerBlockId="blk-1" blocks />);
        expect(h.attachCalls).toEqual([{ blockId: "blk-1", opts: { blocks: true } }]);
    });

    it("shows the input bar at the prompt and hides it during running/alt", () => {
        render(<XtermView outerBlockId="blk-1" blocks />);
        expect(screen.getByTestId("cmdblock-input")).toBeTruthy();
        expect(inputBarHidden()).toBe(false);

        act(() => h.setMode("running"));
        expect(inputBarHidden()).toBe(true);
        // Hidden, not unmounted: the draft must survive the command run.
        expect(screen.getByTestId("cmdblock-input")).toBeTruthy();

        act(() => h.setMode("alt"));
        expect(inputBarHidden()).toBe(true);

        act(() => h.setMode("prompt"));
        expect(inputBarHidden()).toBe(false);
    });

    it("mounts the block overlay and watermark over the host", () => {
        render(<XtermView outerBlockId="blk-1" blocks />);
        expect(screen.getByTestId("block-overlay")).toBeTruthy();
        expect(screen.getByTestId("block-watermark")).toBeTruthy();
    });

    it("routes input submits to submitToSession", () => {
        render(<XtermView outerBlockId="blk-1" blocks />);
        fireEvent.click(screen.getByTestId("stub-submit"));
        expect(h.submitCalls).toEqual([["blk-1", "echo hi"]]);
    });

    it("forwards input activity to the session watermark gate", () => {
        render(<XtermView outerBlockId="blk-1" blocks />);
        fireEvent.click(screen.getByTestId("stub-type"));
        expect(h.inputActivity).toEqual([true]);
    });

    it("interrupts on Ctrl+C only while the input buffer is empty", () => {
        render(<XtermView outerBlockId="blk-1" blocks />);
        const bar = screen.getByTestId("xterm-input-bar");
        fireEvent.keyDown(bar, { key: "c", ctrlKey: true });
        expect(h.interruptCalls).toEqual(["blk-1"]);

        fireEvent.click(screen.getByTestId("stub-type"));
        fireEvent.keyDown(bar, { key: "c", ctrlKey: true });
        expect(h.interruptCalls).toEqual(["blk-1"]);

        fireEvent.click(screen.getByTestId("stub-clear"));
        fireEvent.keyDown(bar, { key: "c", ctrlKey: true });
        expect(h.interruptCalls).toEqual(["blk-1", "blk-1"]);
    });

    it("renders no block chrome or input bar for plain sessions", () => {
        render(<XtermView outerBlockId="blk-1" />);
        expect(h.attachCalls).toEqual([{ blockId: "blk-1", opts: { blocks: false } }]);
        expect(screen.queryByTestId("xterm-input-bar")).toBeNull();
        expect(screen.queryByTestId("block-overlay")).toBeNull();
        expect(screen.queryByTestId("block-watermark")).toBeNull();
    });
});

describe("XtermView find bar", () => {
    function openFindBar(): void {
        fireEvent.keyDown(screen.getByTestId("xterm-host"), { key: "f", metaKey: true });
    }

    it("stays hidden until the find shortcut", () => {
        render(<XtermView outerBlockId="blk-1" />);
        expect(screen.queryByTestId("xterm-find-bar")).toBeNull();
    });

    it("opens on Cmd+F and focuses the input", () => {
        render(<XtermView outerBlockId="blk-1" />);
        openFindBar();
        expect(screen.getByTestId("xterm-find-bar")).toBeTruthy();
        expect(document.activeElement).toBe(screen.getByPlaceholderText("Find in terminal"));
    });

    it("opens on Ctrl+Shift+F for non-Mac keyboards", () => {
        render(<XtermView outerBlockId="blk-1" />);
        fireEvent.keyDown(screen.getByTestId("xterm-host"), { key: "F", ctrlKey: true, shiftKey: true });
        expect(screen.getByTestId("xterm-find-bar")).toBeTruthy();
    });

    it("refocuses the input when Cmd+F fires while already open", () => {
        render(<XtermView outerBlockId="blk-1" />);
        openFindBar();
        (document.activeElement as HTMLElement).blur();
        openFindBar();
        expect(document.activeElement).toBe(screen.getByPlaceholderText("Find in terminal"));
    });

    it("closes on Escape, clears the search, and returns focus to the terminal", () => {
        render(<XtermView outerBlockId="blk-1" />);
        openFindBar();
        fireEvent.keyDown(screen.getByPlaceholderText("Find in terminal"), { key: "Escape" });
        expect(screen.queryByTestId("xterm-find-bar")).toBeNull();
        expect(h.clearFindCalls).toEqual(["blk-1"]);
        expect(h.focusCalls).toContain("blk-1");
    });

    it("returns focus to the input bar when closed at a blocks-mode prompt", () => {
        render(<XtermView outerBlockId="blk-1" blocks />);
        openFindBar();
        fireEvent.keyDown(screen.getByPlaceholderText("Find in terminal"), { key: "Escape" });
        expect(h.focusInputCalls).toContain("blk-1");
        expect(h.focusCalls).toEqual([]);
    });

    it("closes from the close button", () => {
        render(<XtermView outerBlockId="blk-1" />);
        openFindBar();
        fireEvent.click(screen.getByLabelText("Close find (Esc)"));
        expect(screen.queryByTestId("xterm-find-bar")).toBeNull();
    });
});
