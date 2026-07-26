// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getSettingsKeyAtom, globalStore } from "@/store/global";
import type { ITheme } from "@xterm/xterm";

const DefaultFontFamily = "Hack";
const DefaultFontSize = 16;
const DefaultScrollback = 2000;
const MaxScrollback = 50000;

function readCssVar(style: CSSStyleDeclaration, name: string): string {
    // Empty string would make xterm's color parser warn and fall back per
    // field; undefined lets it use its own default silently.
    return style.getPropertyValue(name).trim() || undefined;
}

// Builds the xterm ITheme from the same CSS custom properties the DOM
// renderer resolves through frontend/app/term/render/color.ts, so xterm
// output and the rest of the terminal chrome stay on one palette. The
// cursor uses --color-accent to match cursor-overlay.tsx.
export function buildTerminalTheme(): ITheme {
    const style = getComputedStyle(document.documentElement);
    return {
        background: readCssVar(style, "--color-background"),
        foreground: readCssVar(style, "--color-foreground"),
        cursor: readCssVar(style, "--color-accent"),
        cursorAccent: readCssVar(style, "--color-background"),
        selectionBackground: readCssVar(style, "--color-term-selection"),
        black: readCssVar(style, "--ansi-black"),
        red: readCssVar(style, "--ansi-red"),
        green: readCssVar(style, "--ansi-green"),
        yellow: readCssVar(style, "--ansi-yellow"),
        blue: readCssVar(style, "--ansi-blue"),
        magenta: readCssVar(style, "--ansi-magenta"),
        cyan: readCssVar(style, "--ansi-cyan"),
        white: readCssVar(style, "--ansi-white"),
        brightBlack: readCssVar(style, "--ansi-brightblack"),
        brightRed: readCssVar(style, "--ansi-brightred"),
        brightGreen: readCssVar(style, "--ansi-brightgreen"),
        brightYellow: readCssVar(style, "--ansi-brightyellow"),
        brightBlue: readCssVar(style, "--ansi-brightblue"),
        brightMagenta: readCssVar(style, "--ansi-brightmagenta"),
        brightCyan: readCssVar(style, "--ansi-brightcyan"),
        brightWhite: readCssVar(style, "--ansi-brightwhite"),
    };
}

export function resolveFontFamily(family?: string): string {
    const configured = family ?? globalStore.get(getSettingsKeyAtom("term:fontfamily"));
    const name = typeof configured === "string" ? configured.trim() : "";
    return name || DefaultFontFamily;
}

export function getTermFontSize(): number {
    const size = globalStore.get(getSettingsKeyAtom("term:fontsize"));
    return typeof size === "number" && size > 0 ? size : DefaultFontSize;
}

// Clamp mirrors the legacy term view: floor, 0..50000, default 2000.
export function normalizeScrollback(value: unknown): number {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return DefaultScrollback;
    }
    const lines = Math.floor(value);
    if (lines < 0) {
        return 0;
    }
    if (lines > MaxScrollback) {
        return MaxScrollback;
    }
    return lines;
}

export function getTermScrollback(): number {
    return normalizeScrollback(globalStore.get(getSettingsKeyAtom("term:scrollback")));
}

export function isTermWebglEnabled(): boolean {
    return !globalStore.get(getSettingsKeyAtom("term:disablewebgl"));
}
