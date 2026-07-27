// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
    encodeSgrWheel,
    FullscreenTuiWheelController,
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
