import { describe, expect, it } from "vitest";
import { parseToken } from "../parse";
import type { CompletionContext } from "../types";
import { historyProvider } from "./history";

function ctx(buffer: string, history: string[]): CompletionContext {
    return { buffer, cursor: buffer.length, cwd: "/home/u", history, listDir: async () => [] };
}

describe("historyProvider", () => {
    it("空 buffer 不产出历史候选", () => {
        const c = ctx("", ["git status"]);
        const out = historyProvider(c, parseToken(c.buffer, c.cursor));
        expect(out).toEqual([]);
    });
    it("前缀匹配整行历史，replacement 为整行", () => {
        const c = ctx("git ", ["git status", "ls -la", "git commit"]);
        const out = historyProvider(c, parseToken(c.buffer, c.cursor)) as any[];
        expect(out.map((s) => s.replacement)).toEqual(["git commit", "git status"]);
        expect(out[0].type).toBe("history");
    });
    it("去重并倒序优先最近项", () => {
        const c = ctx("e", ["echo a", "echo b", "echo a"]);
        const out = historyProvider(c, parseToken(c.buffer, c.cursor)) as any[];
        expect(out.map((s) => s.replacement)).toEqual(["echo a", "echo b"]);
    });
});
