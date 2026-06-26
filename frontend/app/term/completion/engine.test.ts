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
    it("无候选返回空集合但 span 合法", async () => {
        const c = ctx("xyz", [], []);
        const res = await suggest(c, [pathProvider, historyProvider]);
        expect(res.suggestions).toEqual([]);
        expect(res.replacementSpan.end).toBe(3);
    });
});
