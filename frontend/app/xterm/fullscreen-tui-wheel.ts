// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Terminal } from "@xterm/xterm";

export type WheelEventLike = Pick<
    WheelEvent,
    "deltaMode" | "deltaX" | "deltaY" | "ctrlKey" | "shiftKey" | "altKey" | "clientX" | "clientY" | "timeStamp"
>;

export type TuiMouseTrackingMode = "none" | "x10" | "vt200" | "drag" | "any";

export type TuiWheelGeometry = {
    left: number;
    top: number;
    width: number;
    height: number;
    cols: number;
    rows: number;
};

export type TuiWheelControllerOptions = {
    isActive: () => boolean;
    getTrackingMode: () => TuiMouseTrackingMode;
    getGeometry: () => TuiWheelGeometry | null;
    send: (data: string) => void;
    requestFrame: (callback: FrameRequestCallback) => number;
    cancelFrame: (handle: number) => void;
};

type MouseEncoding = "default" | "sgr" | "sgr-pixels";
type GestureKind = "trackpad" | "physical";
type WheelDirection = "up" | "down";

const GestureIdleMs = 120;
const MaxReportsPerFrame = 4;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function encodeSgrWheel(
    direction: WheelDirection,
    position: { col: number; row: number },
    modifiers: { shift?: boolean; alt?: boolean; ctrl?: boolean },
    cols: number,
    rows: number
): string {
    let code = direction === "up" ? 64 : 65;
    if (modifiers.shift) code += 4;
    if (modifiers.alt) code += 8;
    if (modifiers.ctrl) code += 16;
    const col = clamp(Math.trunc(position.col), 1, Math.max(1, Math.trunc(cols)));
    const row = clamp(Math.trunc(position.row), 1, Math.max(1, Math.trunc(rows)));
    return `\x1b[<${code};${col};${row}M`;
}

export class FullscreenTuiWheelController {
    private encoding: MouseEncoding = "default";
    private gestureKind: GestureKind | null = null;
    private lastEventTime = Number.NEGATIVE_INFINITY;
    private accumulator = 0;
    private direction: WheelDirection | null = null;
    private frameHandle: number | null = null;
    private latestEvent: WheelEventLike | null = null;
    private latestGeometry: TuiWheelGeometry | null = null;
    private disposed = false;

    constructor(private readonly options: TuiWheelControllerOptions) {}

    setPrivateModes(params: (number | number[])[], enabled: boolean): void {
        let nextEncoding = this.encoding;
        for (const param of params.flat()) {
            if (param === 1006) nextEncoding = enabled ? "sgr" : "default";
            if (param === 1016) nextEncoding = enabled ? "sgr-pixels" : "default";
        }
        if (nextEncoding === this.encoding) return;
        this.encoding = nextEncoding;
        this.cancelGesture();
    }

    handleWheel(event: WheelEventLike): boolean {
        if (!this.canHandle(event)) {
            this.cancelGesture();
            return true;
        }
        const geometry = this.options.getGeometry();
        if (!this.isValidGeometry(geometry)) {
            this.cancelGesture();
            return true;
        }

        const newGesture =
            this.gestureKind === null ||
            event.timeStamp < this.lastEventTime ||
            event.timeStamp - this.lastEventTime > GestureIdleMs;
        if (newGesture) {
            this.cancelGesture();
            this.gestureKind = this.classifyGesture(event);
        }
        this.lastEventTime = event.timeStamp;
        if (this.gestureKind !== "trackpad") return true;

        const nextDirection: WheelDirection = event.deltaY < 0 ? "up" : "down";
        if (this.direction !== null && this.direction !== nextDirection) {
            this.accumulator = 0;
        }
        this.direction = nextDirection;
        this.accumulator += event.deltaY;
        this.latestEvent = event;
        this.latestGeometry = geometry;
        this.scheduleFrame();
        return false;
    }

    cancelGesture(): void {
        if (this.frameHandle !== null) {
            this.options.cancelFrame(this.frameHandle);
            this.frameHandle = null;
        }
        this.gestureKind = null;
        this.lastEventTime = Number.NEGATIVE_INFINITY;
        this.accumulator = 0;
        this.direction = null;
        this.latestEvent = null;
        this.latestGeometry = null;
    }

    resetTerminal(): void {
        this.encoding = "default";
        this.cancelGesture();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.cancelGesture();
    }

    private canHandle(event: WheelEventLike): boolean {
        return (
            !this.disposed &&
            this.options.isActive() &&
            this.options.getTrackingMode() !== "none" &&
            this.encoding === "sgr" &&
            event.deltaMode === 0 &&
            event.deltaY !== 0 &&
            !event.ctrlKey &&
            !event.shiftKey &&
            Math.abs(event.deltaY) >= Math.abs(event.deltaX)
        );
    }

    private classifyGesture(event: WheelEventLike): GestureKind {
        const trackpadLike =
            Math.abs(event.deltaY) < 50 ||
            !Number.isInteger(event.deltaY) ||
            (event.deltaX !== 0 && Math.abs(event.deltaY) >= Math.abs(event.deltaX));
        return trackpadLike ? "trackpad" : "physical";
    }

    private isValidGeometry(geometry: TuiWheelGeometry | null): geometry is TuiWheelGeometry {
        return geometry !== null && geometry.width > 0 && geometry.height > 0 && geometry.cols > 0 && geometry.rows > 0;
    }

    private scheduleFrame(): void {
        if (this.frameHandle !== null) return;
        this.frameHandle = this.options.requestFrame(() => this.flushFrame());
    }

    private flushFrame(): void {
        this.frameHandle = null;
        const event = this.latestEvent;
        const geometry = this.latestGeometry;
        if (
            !event ||
            !this.isValidGeometry(geometry) ||
            !this.canHandle(event) ||
            this.gestureKind !== "trackpad" ||
            this.direction === null
        ) {
            this.cancelGesture();
            return;
        }

        const pixelsPerReport = geometry.height / geometry.rows;
        const totalReports = Math.floor(Math.abs(this.accumulator) / pixelsPerReport);
        if (totalReports === 0) return;

        const reportCount = Math.min(MaxReportsPerFrame, totalReports);
        const remainder = Math.abs(this.accumulator) % pixelsPerReport;
        this.accumulator = (this.accumulator < 0 ? -1 : 1) * remainder;

        const col = Math.floor(((event.clientX - geometry.left) / geometry.width) * geometry.cols) + 1;
        const row = Math.floor(((event.clientY - geometry.top) / geometry.height) * geometry.rows) + 1;
        const report = encodeSgrWheel(
            this.direction,
            { col, row },
            { shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey },
            geometry.cols,
            geometry.rows
        );
        this.options.send(report.repeat(reportCount));
    }
}

export type FullscreenTuiWheelBinding = {
    cancelGesture(): void;
    resetTerminal(): void;
    dispose(): void;
};

export function installFullscreenTuiWheel(term: Terminal, isActive: () => boolean): FullscreenTuiWheelBinding {
    const controller = new FullscreenTuiWheelController({
        isActive,
        getTrackingMode: () => term.modes.mouseTrackingMode,
        getGeometry: () => {
            const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
            if (!screen) return null;
            const rect = screen.getBoundingClientRect();
            return {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                cols: term.cols,
                rows: term.rows,
            };
        },
        send: (data) => term.input(data, false),
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
    });

    term.attachCustomWheelEventHandler((event) => controller.handleWheel(event));
    const parserDisposables = [
        term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
            controller.setPrivateModes(params, true);
            return false;
        }),
        term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
            controller.setPrivateModes(params, false);
            return false;
        }),
        term.parser.registerEscHandler({ final: "c" }, () => {
            controller.resetTerminal();
            return false;
        }),
    ];

    return {
        cancelGesture: () => controller.cancelGesture(),
        resetTerminal: () => controller.resetTerminal(),
        dispose: () => {
            controller.dispose();
            for (const disposable of parserDisposables) disposable.dispose();
        },
    };
}
