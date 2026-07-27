// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { AgentPtyScreen } from "./agent-pty-screen";

function rowText(screen: AgentPtyScreen): string[] {
    return screen.snapshot().rows.map((row) => row.text);
}

function makeScreen(): AgentPtyScreen {
    return new AgentPtyScreen({ cols: 40, rows: 4, respond: () => {} });
}

function snapshotForChunks(chunks: Uint8Array[]) {
    const screen = makeScreen();
    for (const chunk of chunks) {
        screen.feed(chunk);
    }
    return screen.snapshot();
}

function expectEveryByteSplitToMatchSingleChunk(text: string): void {
    const bytes = new TextEncoder().encode(text);
    const expected = snapshotForChunks([bytes]);
    for (let split = 1; split < bytes.length; split += 1) {
        expect(
            snapshotForChunks([bytes.slice(0, split), bytes.slice(split)]),
            `split after byte ${split} of ${bytes.length}`
        ).toEqual(expected);
    }
}

describe("Electron AgentPtyScreen", () => {
    it("feeds bytes through the ANSI parser instead of exposing raw escapes", () => {
        const screen = new AgentPtyScreen({ cols: 10, rows: 4, respond: () => {} });

        screen.feed("hello\nworld");
        screen.feed("\x1b[1;1Htop\x1b[K");

        expect(rowText(screen)[0]).toBe("top");
        expect(rowText(screen).join("\n")).not.toContain("\x1b[");
        expect(screen.snapshot().cursor).toMatchObject({ row: 0, col: 3, visible: true });
    });

    it("tracks alternate screen state and keeps both backing grids bounded", () => {
        const screen = new AgentPtyScreen({ cols: 8, rows: 3, respond: () => {} });

        for (let i = 0; i < 50; i += 1) {
            screen.feed(`primary-${i}\n`);
        }
        screen.feed("\x1b[?1049h");
        screen.feed("alt-one\x1b[2;1Halt-two");

        const active = screen.snapshot();
        expect(active.isAltScreenActive).toBe(true);
        expect(active.rows.map((row) => row.text)).toEqual(["alt-one", "alt-two", ""]);
        expect(screen.primaryRowCount()).toBeLessThanOrEqual(3);
        expect(screen.altRowCount()).toBeLessThanOrEqual(3);

        screen.feed("\x1b[?1049l");
        expect(screen.snapshot().isAltScreenActive).toBe(false);
        expect(screen.primaryRowCount()).toBeLessThanOrEqual(3);
        expect(screen.altRowCount()).toBeLessThanOrEqual(3);
    });

    it("resizes the fixed viewport without growing scrollback", () => {
        const screen = new AgentPtyScreen({ cols: 6, rows: 2, respond: () => {} });

        screen.feed("one\ntwo\nthree\nfour");
        screen.resize(12, 4);
        screen.feed("\x1b[?1049hfull\nscreen\nmode");
        screen.resize(5, 2);

        expect(screen.snapshot().rows).toHaveLength(2);
        expect(screen.primaryRowCount()).toBeLessThanOrEqual(2);
        expect(screen.altRowCount()).toBeLessThanOrEqual(2);
    });

    it("preserves CSI parser state across every byte boundary", () => {
        expectEveryByteSplitToMatchSingleChunk("before \x1b[31m红色\x1b[0m after");
        expect(snapshotForChunks([new TextEncoder().encode("before \x1b[31m红色\x1b[0m after")]).rows[0].text).toBe(
            "before 红色 after"
        );
    });

    it("preserves OSC parser state across every byte boundary", () => {
        expectEveryByteSplitToMatchSingleChunk("before\x1b]0;标题\x1b\\after");
        expect(snapshotForChunks([new TextEncoder().encode("before\x1b]0;标题\x1b\\after")]).rows[0].text).toBe(
            "beforeafter"
        );
    });

    it("preserves UTF-8 decoder state across every byte boundary", () => {
        expectEveryByteSplitToMatchSingleChunk("Aé中🙂Z");
        expect(snapshotForChunks([new TextEncoder().encode("Aé中🙂Z")]).rows[0].text).toBe("Aé中🙂Z");
    });

    it("does not turn an incomplete escape sequence into visible text or a style reset", () => {
        const screen = makeScreen();

        screen.feed(new TextEncoder().encode("base\x1b[31"));

        expect(rowText(screen)[0]).toBe("base");
        expect(screen.snapshot().cursor.col).toBe(4);
    });
});
