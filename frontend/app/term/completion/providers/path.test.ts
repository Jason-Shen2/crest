// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseToken } from "../parse";
import type { CompletionContext, DirEntry } from "../types";
import { pathProvider } from "./path";

function ctx(buffer: string, entries: DirEntry[]): CompletionContext {
    return { buffer, cursor: buffer.length, cwd: "/home/u", history: [], listDir: async () => entries };
}

const entries: DirEntry[] = [
    { name: "src", isDir: true },
    { name: "server.ts", isDir: false },
    { name: "README.md", isDir: false },
];

describe("pathProvider", () => {
    it("首词命令位不做路径补全", async () => {
        const c = ctx("git", entries);
        const out = await pathProvider(c, parseToken(c.buffer, c.cursor));
        expect(out).toEqual([]);
    });
    it("按前缀过滤当前目录项，目录补尾斜杠", async () => {
        const c = ctx("cat s", entries);
        const out = await pathProvider(c, parseToken(c.buffer, c.cursor));
        expect(out.map((s) => s.replacement).sort()).toEqual(["server.ts", "src/"]);
        const dir = out.find((s) => s.replacement === "src/");
        expect(dir?.type).toBe("path");
    });
    it("带目录前缀：列出子目录并保留前缀", async () => {
        const c = ctx("cat src/se", entries);
        const out = await pathProvider(c, parseToken(c.buffer, c.cursor));
        expect(out.map((s) => s.replacement)).toEqual(["src/server.ts"]);
    });
});
