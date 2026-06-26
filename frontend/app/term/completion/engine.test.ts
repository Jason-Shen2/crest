// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { suggest } from "./engine";
import { historyProvider } from "./providers/history";
import { pathProvider } from "./providers/path";
import type { CompletionContext, DirEntry } from "./types";

const entries: DirEntry[] = [
    { name: "src", isDir: true },
    { name: "server.ts", isDir: false },
];

function ctx(buffer: string, history: string[], dir: DirEntry[]): CompletionContext {
    return { buffer, cursor: buffer.length, cwd: "/home/u", history, listDir: async () => dir };
}

describe("suggest", () => {
    it("path 候选 spanStart 指向 token 起点", async () => {
        const c = ctx("cat s", [], entries);
        const res = await suggest(c, [pathProvider]);
        expect(res.replacementSpan).toEqual({ start: 4, end: 5 });
        expect(res.suggestions.every((s) => s.spanStart === 4)).toBe(true);
    });
    it("history 候选 spanStart 为 0", async () => {
        const c = ctx("git ", ["git status"], []);
        const res = await suggest(c, [historyProvider]);
        expect(res.suggestions[0].spanStart).toBe(0);
        expect(res.replacementSpan.start).toBe(0);
    });
    it("多 provider 合并并按 priority 降序", async () => {
        const c = ctx("se", ["select all"], entries);
        const res = await suggest(c, [pathProvider, historyProvider]);
        const prios = res.suggestions.map((s) => s.priority);
        expect([...prios]).toEqual([...prios].sort((a, b) => b - a));
    });
    it("path 与 history 同时产出时保留各自异构的 spanStart", async () => {
        const c = ctx("cat s", ["cat something"], [
            { name: "server.ts", isDir: false },
            { name: "src", isDir: true },
        ]);
        const res = await suggest(c, [pathProvider, historyProvider]);
        const pathCands = res.suggestions.filter((s) => s.type === "path");
        const histCand = res.suggestions.find((s) => s.replacement === "cat something");
        expect(pathCands.length).toBeGreaterThan(0);
        expect(pathCands.every((s) => s.spanStart === 4)).toBe(true);
        expect(histCand).toBeDefined();
        expect(histCand!.spanStart).toBe(0);
    });
    it("无候选返回空集合但 span 合法", async () => {
        const c = ctx("xyz", [], []);
        const res = await suggest(c, [pathProvider, historyProvider]);
        expect(res.suggestions).toEqual([]);
        expect(res.replacementSpan.end).toBe(3);
    });
});
