// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// encodeMouseEvent — translate a logical mouse event into the byte
// sequence a real terminal would send to the running application when
// one of the mouse reporting modes (1000 / 1002 / 1003 + 1006 / 1015)
// is active.  Used by the alt-screen mouse router in TerminalView so
// vim / lazygit / btm / ranger / fzf-tmux preview can react to clicks
// and scrolls.
//
// Encodings supported:
//   * SGR (DEC 1006): ESC [ < <Cb> ; <Cx> ; <Cy> M|m   (M=press, m=release)
//   * urxvt (DEC 1015): ESC [ <Cb+32> ; <Cx> ; <Cy> M
//   * X10 binary (1000 default): ESC [ M <Cb+32> <Cx+32> <Cy+32>  — limited
//     to coordinates ≤ 223 due to single-byte encoding.
//
// Mode gating:
//   mouseX10 (9)        — press only
//   mouseClick (1000)   — press + release
//   mouseButton (1002)  — press + release + drag motion (button held)
//   mouseMotion (1003)  — press + release + all motion
//
// The caller is responsible for honoring the gate (e.g., not calling
// encode for "motion" unless mode permits it).  We only verify that
// SOME mouse mode is active before encoding.

import { TermMode } from "../engine";

export type MouseButton = "left" | "middle" | "right" | "wheelUp" | "wheelDown" | "none";
export type MouseAction = "press" | "release" | "motion";

export interface LogicalMouseEvent {
    button: MouseButton;
    row: number; // 0-based grid row within the active block
    col: number; // 0-based grid col
    action: MouseAction;
    shift: boolean;
    alt: boolean;
    ctrl: boolean;
}

export function encodeMouseEvent(ev: LogicalMouseEvent, mode: TermMode): string | null {
    if (
        !mode.mouseX10 &&
        !mode.mouseClick &&
        !mode.mouseButton &&
        !mode.mouseMotion
    ) {
        return null;
    }

    const isSgr = mode.mouseSgr;
    const isUrxvt = !isSgr && mode.mouseUrxvt;

    let cb: number;
    if (ev.action === "release" && !isSgr && !isUrxvt) {
        // Binary X10 encoding can't distinguish which button was released,
        // so it uses a special "release" code (3) instead of the button.
        cb = 3;
    } else {
        cb = buttonCode(ev.button);
    }
    if (ev.action === "motion") cb += 32;
    cb += (ev.shift ? 4 : 0) + (ev.alt ? 8 : 0) + (ev.ctrl ? 16 : 0);

    const cx = ev.col + 1;
    const cy = ev.row + 1;

    if (isSgr) {
        const final = ev.action === "release" ? "m" : "M";
        return `\x1b[<${cb};${cx};${cy}${final}`;
    }
    if (isUrxvt) {
        return `\x1b[${cb + 32};${cx};${cy}M`;
    }
    // X10 / 1000 binary — caps coordinates at codepoint 255 - 32 = 223.
    // Modern apps universally enable 1006 alongside 1000 to avoid this
    // cap, so silently dropping over-range events is acceptable.
    if (cx > 223 || cy > 223) return null;
    return (
        "\x1b[M" +
        String.fromCharCode(cb + 32) +
        String.fromCharCode(cx + 32) +
        String.fromCharCode(cy + 32)
    );
}

function buttonCode(b: MouseButton): number {
    switch (b) {
        case "left":
            return 0;
        case "middle":
            return 1;
        case "right":
            return 2;
        case "wheelUp":
            return 64;
        case "wheelDown":
            return 65;
        case "none":
            return 3;
    }
}

// shouldReportAction — convenience for callers wiring DOM events: returns
// whether the current mode permits forwarding this action.
export function shouldReportAction(action: MouseAction, dragging: boolean, mode: TermMode): boolean {
    if (mode.mouseMotion) return true;
    if (mode.mouseButton) {
        return action !== "motion" || dragging;
    }
    if (mode.mouseClick) return action !== "motion";
    if (mode.mouseX10) return action === "press";
    return false;
}
