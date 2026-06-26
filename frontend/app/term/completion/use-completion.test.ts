import { describe, expect, it } from "vitest";
import { createRunner } from "./use-completion";
import type { CompletionContext, DirEntry } from "./types";
import { pathProvider } from "./providers/path";

function delayedCtx(buffer: string, dir: DirEntry[], delayMs: number): CompletionContext {
    return {
        buffer,
        cursor: buffer.length,
        cwd: "/home/u",
        history: [],
        listDir: async () => {
            await new Promise((r) => setTimeout(r, delayMs));
            return dir;
        },
    };
}

const entries: DirEntry[] = [{ name: "server.ts", isDir: false }];

describe("createRunner", () => {
    it("旧的慢结果被新结果取代（snapshot 丢弃）", async () => {
        const runner = createRunner([pathProvider]);
        const slow = runner.run(delayedCtx("cat s", entries, 50));
        const fast = runner.run(delayedCtx("cat se", entries, 5));
        const fastRes = await fast;
        const slowRes = await slow;
        expect(fastRes?.suggestions.length).toBe(1);
        expect(slowRes).toBeNull();
    });
});
