// @vitest-environment jsdom

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    encodeSgrWheel,
    FullscreenTuiWheelController,
    installFullscreenTuiWheel,
    type TuiMouseTrackingMode,
    type WheelEventLike,
} from "./fullscreen-tui-wheel";

function wheel(partial: Partial<WheelEventLike> = {}): WheelEventLike {
    return {
        deltaMode: 0,
        deltaX: 0,
        deltaY: 6,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        clientX: 45,
        clientY: 45,
        timeStamp: 1,
        ...partial,
    };
}

function makeHarness() {
    let frame: FrameRequestCallback | null = null;
    let trackingMode: TuiMouseTrackingMode = "vt200";
    let active = true;
    const sent: string[] = [];
    const controller = new FullscreenTuiWheelController({
        isActive: () => active,
        getTrackingMode: () => trackingMode,
        getGeometry: () => ({
            left: 0,
            top: 0,
            width: 100,
            height: 100,
            cols: 10,
            rows: 5,
        }),
        send: (data) => sent.push(data),
        requestFrame: (callback) => {
            frame = callback;
            return 1;
        },
        cancelFrame: () => {
            frame = null;
        },
    });

    return {
        controller,
        sent,
        flushFrame() {
            const callback = frame;
            frame = null;
            callback?.(16);
        },
        hasPendingFrame: () => frame !== null,
        setActive(value: boolean) {
            active = value;
        },
        setTrackingMode(value: TuiMouseTrackingMode) {
            trackingMode = value;
        },
    };
}

function makeTerminalHarness() {
    let frame: FrameRequestCallback | null = null;
    let wheelHandler: ((event: WheelEvent) => boolean) | null = null;
    let trackingMode: TuiMouseTrackingMode = "vt200";
    const inputs: Array<[string, boolean | undefined]> = [];
    const csi = new Map<string, (params: (number | number[])[]) => boolean | Promise<boolean>>();
    const esc = new Map<string, () => boolean | Promise<boolean>>();
    const disposedHandlers: string[] = [];
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.getBoundingClientRect = () =>
        ({
            left: 0,
            top: 0,
            width: 100,
            height: 100,
            right: 100,
            bottom: 100,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        }) as DOMRect;
    const element = document.createElement("div");
    element.appendChild(screen);

    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
        frame = null;
    });

    const term = {
        cols: 10,
        rows: 5,
        element,
        modes: {
            get mouseTrackingMode() {
                return trackingMode;
            },
        },
        parser: {
            registerCsiHandler(
                id: { prefix?: string; final: string },
                callback: (params: (number | number[])[]) => boolean | Promise<boolean>
            ) {
                const key = `${id.prefix ?? ""}${id.final}`;
                csi.set(key, callback);
                return {
                    dispose: () => {
                        disposedHandlers.push(key);
                        csi.delete(key);
                    },
                };
            },
            registerEscHandler(id: { final: string }, callback: () => boolean | Promise<boolean>) {
                esc.set(id.final, callback);
                return {
                    dispose: () => {
                        disposedHandlers.push(id.final);
                        esc.delete(id.final);
                    },
                };
            },
        },
        attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) {
            wheelHandler = handler;
        },
        input(data: string, wasUserInput?: boolean) {
            inputs.push([data, wasUserInput]);
        },
    } as unknown as Terminal;

    return {
        term,
        csi,
        esc,
        inputs,
        disposedHandlers,
        wheel: (event: WheelEventLike) => wheelHandler?.(event as WheelEvent),
        flushFrame() {
            const callback = frame;
            frame = null;
            callback?.(16);
        },
        hasPendingFrame: () => frame !== null,
        setTrackingMode(value: TuiMouseTrackingMode) {
            trackingMode = value;
        },
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("FullscreenTuiWheelController", () => {
    it("accumulates raw trackpad pixels and sends an SGR report on the next frame", () => {
        const h = makeHarness();
        h.controller.setPrivateModes([1006], true);

        expect(h.controller.handleWheel(wheel({ deltaY: 20 }))).toBe(false);
        expect(h.sent).toEqual([]);

        h.flushFrame();
        expect(h.sent).toEqual(["\x1b[<65;5;3M"]);
    });

    it("keeps a fast momentum burst on the trackpad path and caps a frame at four reports", () => {
        const h = makeHarness();
        h.controller.setPrivateModes([1006], true);

        expect(h.controller.handleWheel(wheel({ deltaY: 2, timeStamp: 1 }))).toBe(false);
        expect(h.controller.handleWheel(wheel({ deltaY: 200, timeStamp: 20 }))).toBe(false);

        h.flushFrame();
        expect(h.sent).toEqual(["\x1b[<65;5;3M".repeat(4)]);
        expect(h.hasPendingFrame()).toBe(false);
        h.flushFrame();
        expect(h.sent).toHaveLength(1);
    });

    it("clears residual movement when direction reverses", () => {
        const h = makeHarness();
        h.controller.setPrivateModes([1006], true);

        h.controller.handleWheel(wheel({ deltaY: 10, timeStamp: 1 }));
        h.controller.handleWheel(wheel({ deltaY: -20, timeStamp: 10 }));
        h.flushFrame();

        expect(h.sent).toEqual(["\x1b[<64;5;3M"]);
    });

    it("reclassifies after the gesture idle gap", () => {
        const h = makeHarness();
        h.controller.setPrivateModes([1006], true);

        expect(h.controller.handleWheel(wheel({ deltaY: 2, timeStamp: 1 }))).toBe(false);
        expect(h.controller.handleWheel(wheel({ deltaY: 100, timeStamp: 500 }))).toBe(true);
        expect(h.hasPendingFrame()).toBe(false);
    });

    it("keeps a physical-wheel burst on the native xterm path", () => {
        const h = makeHarness();
        h.controller.setPrivateModes([1006], true);

        expect(h.controller.handleWheel(wheel({ deltaY: 100, timeStamp: 1 }))).toBe(true);
        expect(h.controller.handleWheel(wheel({ deltaY: 2, timeStamp: 20 }))).toBe(true);
        expect(h.hasPendingFrame()).toBe(false);
        expect(h.sent).toEqual([]);
    });

    it("falls back for inactive slots and terminals without mouse tracking", () => {
        const h = makeHarness();
        h.controller.setPrivateModes([1006], true);

        h.setActive(false);
        expect(h.controller.handleWheel(wheel())).toBe(true);

        h.setActive(true);
        h.setTrackingMode("none");
        expect(h.controller.handleWheel(wheel())).toBe(true);
    });

    it("falls back for physical wheels, pinch gestures, horizontal gestures, and unsupported encodings", () => {
        const h = makeHarness();
        h.controller.setPrivateModes([1006], true);

        expect(h.controller.handleWheel(wheel({ deltaMode: 1, deltaY: 3 }))).toBe(true);
        expect(h.controller.handleWheel(wheel({ ctrlKey: true }))).toBe(true);
        expect(h.controller.handleWheel(wheel({ shiftKey: true }))).toBe(true);
        expect(h.controller.handleWheel(wheel({ deltaX: 10, deltaY: 2 }))).toBe(true);

        h.controller.setPrivateModes([1016], true);
        expect(h.controller.handleWheel(wheel())).toBe(true);

        h.controller.setPrivateModes([1016], false);
        expect(h.controller.handleWheel(wheel())).toBe(true);
    });

    it("processes multi-parameter mode changes and terminal reset", () => {
        const h = makeHarness();

        h.controller.setPrivateModes([1000, [1002], 1006], true);
        expect(h.controller.handleWheel(wheel({ deltaY: 20 }))).toBe(false);

        h.controller.setPrivateModes([1006], false);
        expect(h.controller.handleWheel(wheel({ deltaY: 20, timeStamp: 20 }))).toBe(true);

        h.controller.setPrivateModes([1006], true);
        h.controller.resetTerminal();
        expect(h.controller.handleWheel(wheel({ deltaY: 20, timeStamp: 40 }))).toBe(true);
    });

    it("cancels a pending frame when disposed", () => {
        const h = makeHarness();
        h.controller.setPrivateModes([1006], true);
        h.controller.handleWheel(wheel({ deltaY: 20 }));

        expect(h.hasPendingFrame()).toBe(true);
        h.controller.dispose();
        expect(h.hasPendingFrame()).toBe(false);

        h.flushFrame();
        expect(h.sent).toEqual([]);
    });
});

describe("encodeSgrWheel", () => {
    it("encodes direction and modifier bits", () => {
        expect(encodeSgrWheel("down", { col: 5, row: 3 }, { shift: true, alt: true, ctrl: true }, 10, 5)).toBe(
            "\x1b[<93;5;3M"
        );
        expect(encodeSgrWheel("up", { col: 5, row: 3 }, {}, 10, 5)).toBe("\x1b[<64;5;3M");
    });

    it("clamps coordinates to terminal bounds", () => {
        expect(encodeSgrWheel("down", { col: 999, row: -1 }, { alt: true }, 10, 5)).toBe("\x1b[<73;10;1M");
    });
});

describe("installFullscreenTuiWheel", () => {
    it("observes DECSET without consuming xterm's own parser handler", () => {
        const h = makeTerminalHarness();
        const binding = installFullscreenTuiWheel(h.term, () => true);

        expect(h.csi.get("?h")?.([1000, 1006])).toBe(false);
        expect(h.wheel(wheel({ deltaY: 20 }))).toBe(false);
        h.flushFrame();

        expect(h.inputs).toEqual([["\x1b[<65;5;3M", false]]);
        binding.dispose();
    });

    it("observes DECRST and full reset without consuming them", () => {
        const h = makeTerminalHarness();
        const binding = installFullscreenTuiWheel(h.term, () => true);

        expect(h.csi.get("?h")?.([1006])).toBe(false);
        expect(h.csi.get("?l")?.([1006])).toBe(false);
        expect(h.wheel(wheel({ deltaY: 20 }))).toBe(true);

        expect(h.csi.get("?h")?.([1006])).toBe(false);
        expect(h.esc.get("c")?.()).toBe(false);
        expect(h.wheel(wheel({ deltaY: 20 }))).toBe(true);

        binding.dispose();
    });

    it("returns to native xterm handling when the Slot is inactive", () => {
        const h = makeTerminalHarness();
        const binding = installFullscreenTuiWheel(h.term, () => false);

        h.csi.get("?h")?.([1006]);
        expect(h.wheel(wheel({ deltaY: 20 }))).toBe(true);

        binding.dispose();
    });

    it("disposes parser observers and pending frame state", () => {
        const h = makeTerminalHarness();
        const binding = installFullscreenTuiWheel(h.term, () => true);

        h.csi.get("?h")?.([1006]);
        expect(h.wheel(wheel({ deltaY: 20 }))).toBe(false);
        expect(h.hasPendingFrame()).toBe(true);

        binding.dispose();

        expect(h.hasPendingFrame()).toBe(false);
        expect(h.disposedHandlers.sort()).toEqual(["?h", "?l", "c"]);
        expect(h.csi.size).toBe(0);
        expect(h.esc.size).toBe(0);
    });
});
