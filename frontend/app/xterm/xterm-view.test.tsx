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
        },
    };
    return state;
});

vi.mock("./xterm-session", () => ({
    attachSession: (blockId: string, _host: any, _cbs: any, opts: any) => h.attachCalls.push({ blockId, opts }),
    detachSession: () => {},
    focusSession: () => {},
    focusSessionInput: () => {},
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
