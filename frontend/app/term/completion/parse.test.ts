import { describe, expect, it } from "vitest";
import { longestCommonPrefix, parseToken } from "./parse";

describe("parseToken", () => {
    it("空行光标在 0：token 为空且是首词", () => {
        const t = parseToken("", 0);
        expect(t).toMatchObject({ text: "", start: 0, isFirstWord: true });
    });
    it("第一个词：git", () => {
        const t = parseToken("git", 3);
        expect(t).toMatchObject({ text: "git", start: 0, isFirstWord: true });
    });
    it("第二个词：ls sr -> token=sr 非首词", () => {
        const t = parseToken("ls sr", 5);
        expect(t).toMatchObject({ text: "sr", start: 3, isFirstWord: false });
    });
    it("路径 token：cat ./foo", () => {
        const t = parseToken("cat ./foo", 9);
        expect(t).toMatchObject({ text: "./foo", start: 4, looksLikePath: true });
    });
    it("含斜杠视为路径：vim src/a", () => {
        const t = parseToken("vim src/a", 9);
        expect(t.looksLikePath).toBe(true);
    });
});

describe("longestCommonPrefix", () => {
    it("无公共前缀返回空串", () => {
        expect(longestCommonPrefix(["abc", "xyz"])).toBe("");
    });
    it("有公共前缀", () => {
        expect(longestCommonPrefix(["foobar", "foobaz", "fooqux"])).toBe("foo");
    });
    it("单元素返回自身", () => {
        expect(longestCommonPrefix(["only"])).toBe("only");
    });
    it("空数组返回空串", () => {
        expect(longestCommonPrefix([])).toBe("");
    });
});
