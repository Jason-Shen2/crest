// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { keyEventToBytes } from "./key-bindings";

function makeKeyEvent(
    key: string,
    opts: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}
): KeyboardEvent {
    return {
        key,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        ...opts,
    } as KeyboardEvent;
}

describe("keyEventToBytes", () => {
    test("Option+Left sends alt+left word-backward sequence", () => {
        const ev = makeKeyEvent("ArrowLeft", { altKey: true });
        expect(keyEventToBytes(ev)).toBe("\x1b[1;3D");
    });

    test("Option+Right sends alt+right word-forward sequence", () => {
        const ev = makeKeyEvent("ArrowRight", { altKey: true });
        expect(keyEventToBytes(ev)).toBe("\x1b[1;3C");
    });

    test("Option+Backspace sends alt+backspace (kill-word-backward)", () => {
        const ev = makeKeyEvent("Backspace", { altKey: true });
        expect(keyEventToBytes(ev)).toBe("\x1b\x7f");
    });

    test("Cmd+Backspace sends Ctrl+U (kill-line-to-start)", () => {
        const ev = makeKeyEvent("Backspace", { metaKey: true });
        expect(keyEventToBytes(ev)).toBe("\x15");
    });

    test("Cmd+Left sends Home (beginning-of-line)", () => {
        const ev = makeKeyEvent("ArrowLeft", { metaKey: true });
        expect(keyEventToBytes(ev)).toBe("\x1b[H");
    });

    test("Cmd+Right sends End (end-of-line)", () => {
        const ev = makeKeyEvent("ArrowRight", { metaKey: true });
        expect(keyEventToBytes(ev)).toBe("\x1b[F");
    });

    test("Cmd+C returns null (OS copy shortcut)", () => {
        const ev = makeKeyEvent("c", { metaKey: true });
        expect(keyEventToBytes(ev)).toBeNull();
    });

    test("Cmd+V returns null (OS paste shortcut)", () => {
        const ev = makeKeyEvent("v", { metaKey: true });
        expect(keyEventToBytes(ev)).toBeNull();
    });

    test("Cmd+A returns null (OS select-all shortcut)", () => {
        const ev = makeKeyEvent("a", { metaKey: true });
        expect(keyEventToBytes(ev)).toBeNull();
    });

    test("plain Backspace sends DEL byte", () => {
        const ev = makeKeyEvent("Backspace");
        expect(keyEventToBytes(ev)).toBe("\x7f");
    });

    test("plain ArrowLeft sends normal left arrow", () => {
        const ev = makeKeyEvent("ArrowLeft");
        expect(keyEventToBytes(ev)).toBe("\x1b[D");
    });

    test("application cursor mode sends SS3 arrow keys", () => {
        const ev = makeKeyEvent("ArrowUp");
        expect(keyEventToBytes(ev, { appCursor: true })).toBe("\x1bOA");
    });

    test("Ctrl+U sends NAK (line kill)", () => {
        const ev = makeKeyEvent("u", { ctrlKey: true });
        expect(keyEventToBytes(ev)).toBe("\x15");
    });
});
