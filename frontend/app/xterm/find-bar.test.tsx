// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
    const state = {
        findCalls: [] as [string, string, any][],
        nextCalls: [] as [string, string, any][],
        prevCalls: [] as [string, string, any][],
        clearCalls: [] as string[],
        reset() {
            state.findCalls.length = 0;
            state.nextCalls.length = 0;
            state.prevCalls.length = 0;
            state.clearCalls.length = 0;
        },
    };
    return state;
});

vi.mock("./xterm-session", () => ({
    findInSession: (blockId: string, query: string, opts: any) => h.findCalls.push([blockId, query, opts]),
    findNextInSession: (blockId: string, query: string, opts: any) => h.nextCalls.push([blockId, query, opts]),
    findPreviousInSession: (blockId: string, query: string, opts: any) => h.prevCalls.push([blockId, query, opts]),
    clearSessionFind: (blockId: string) => h.clearCalls.push(blockId),
}));

import { FindBar } from "./find-bar";

type ResultsListener = (e: { resultIndex: number; resultCount: number }) => void;

function makeFakeAddon() {
    const listeners = new Set<ResultsListener>();
    return {
        listeners,
        emit(e: { resultIndex: number; resultCount: number }) {
            for (const l of [...listeners]) l(e);
        },
        onDidChangeResults(cb: ResultsListener) {
            listeners.add(cb);
            return { dispose: () => listeners.delete(cb) };
        },
    };
}

function findInput(): HTMLInputElement {
    return screen.getByPlaceholderText("Find in terminal") as HTMLInputElement;
}

beforeEach(() => {
    h.reset();
});

afterEach(() => {
    cleanup();
});

describe("FindBar", () => {
    it("focuses its input on mount and refocuses when focusSeq bumps", () => {
        const { rerender } = render(<FindBar blockId="blk-1" addon={null} focusSeq={1} onClose={() => {}} />);
        expect(document.activeElement).toBe(findInput());

        (document.activeElement as HTMLElement).blur();
        expect(document.activeElement).not.toBe(findInput());

        rerender(<FindBar blockId="blk-1" addon={null} focusSeq={2} onClose={() => {}} />);
        expect(document.activeElement).toBe(findInput());
    });

    it("runs an incremental find on every keystroke and clears on empty", () => {
        render(<FindBar blockId="blk-1" addon={null} focusSeq={1} onClose={() => {}} />);
        fireEvent.change(findInput(), { target: { value: "err" } });
        expect(h.findCalls).toEqual([["blk-1", "err", { caseSensitive: false, regex: false }]]);

        fireEvent.change(findInput(), { target: { value: "" } });
        expect(h.findCalls).toEqual([
            ["blk-1", "err", { caseSensitive: false, regex: false }],
            ["blk-1", "", { caseSensitive: false, regex: false }],
        ]);
    });

    it("cycles matches with Enter / Shift+Enter", () => {
        render(<FindBar blockId="blk-1" addon={null} focusSeq={1} onClose={() => {}} />);
        fireEvent.change(findInput(), { target: { value: "err" } });

        fireEvent.keyDown(findInput(), { key: "Enter" });
        expect(h.nextCalls).toEqual([["blk-1", "err", { caseSensitive: false, regex: false }]]);

        fireEvent.keyDown(findInput(), { key: "Enter", shiftKey: true });
        expect(h.prevCalls).toEqual([["blk-1", "err", { caseSensitive: false, regex: false }]]);
    });

    it("closes on Escape", () => {
        const onClose = vi.fn();
        render(<FindBar blockId="blk-1" addon={null} focusSeq={1} onClose={onClose} />);
        fireEvent.keyDown(findInput(), { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("shows the match counter from onDidChangeResults", () => {
        const addon = makeFakeAddon();
        render(<FindBar blockId="blk-1" addon={addon as any} focusSeq={1} onClose={() => {}} />);
        fireEvent.change(findInput(), { target: { value: "err" } });

        act(() => addon.emit({ resultIndex: 1, resultCount: 5 }));
        expect(screen.getByText("2 / 5")).toBeTruthy();

        act(() => addon.emit({ resultIndex: -1, resultCount: 0 }));
        expect(screen.getByText("no matches")).toBeTruthy();

        act(() => addon.emit({ resultIndex: -1, resultCount: 1000 }));
        expect(screen.getByText("1000+")).toBeTruthy();
    });

    it("re-runs the search when the case/regex toggles flip", () => {
        render(<FindBar blockId="blk-1" addon={null} focusSeq={1} onClose={() => {}} />);
        fireEvent.change(findInput(), { target: { value: "err" } });

        fireEvent.click(screen.getByLabelText("Toggle case sensitivity"));
        expect(h.findCalls.at(-1)).toEqual(["blk-1", "err", { caseSensitive: true, regex: false }]);

        fireEvent.click(screen.getByLabelText("Toggle regex"));
        expect(h.findCalls.at(-1)).toEqual(["blk-1", "err", { caseSensitive: true, regex: true }]);
    });

    it("clears the session find on unmount", () => {
        const { unmount } = render(<FindBar blockId="blk-1" addon={null} focusSeq={1} onClose={() => {}} />);
        expect(h.clearCalls).toEqual([]);
        unmount();
        expect(h.clearCalls).toEqual(["blk-1"]);
    });
});
