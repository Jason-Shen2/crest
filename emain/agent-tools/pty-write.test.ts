import { describe, expect, it, vi } from "vitest";

const sent: Array<{ blockId: string; input: string }> = [];
vi.mock("./_pty-rpc", () => ({
    sendControllerInput: async (blockId: string, input: string) => {
        sent.push({ blockId, input });
    },
}));

import { createPtyWriteTool } from "./pty-write";

describe("pty_write", () => {
    it("does not require the model to provide a block_id", () => {
        const tool = createPtyWriteTool("blk1");
        expect((tool.parameters as { required?: string[] }).required).not.toContain("block_id");
    });

    it("always writes to the bound block even if the model guesses a placeholder block_id", async () => {
        sent.length = 0;
        const tool = createPtyWriteTool("blk-real");
        await tool.execute("t1", { block_id: "default", input: "\x03", mode: "raw" });
        expect(sent).toEqual([{ blockId: "blk-real", input: "\x03" }]);
    });

    it("raw mode sends bytes unchanged", async () => {
        sent.length = 0;
        const tool = createPtyWriteTool("blk1");
        await tool.execute("t1", { block_id: "blk1", input: "\x03", mode: "raw" });
        expect(sent).toEqual([{ blockId: "blk1", input: "\x03" }]);
    });

    it("line mode wraps input with SOH prefix and submit char", async () => {
        sent.length = 0;
        const tool = createPtyWriteTool("blk1");
        await tool.execute("t1", { block_id: "blk1", input: "yes", mode: "line" });
        const submit = process.platform === "win32" ? "\r" : "\n";
        expect(sent[0].input).toBe(`\x01yes${submit}`);
    });

    it("does not replay the startup command into the already-running CLI", async () => {
        sent.length = 0;
        const tool = createPtyWriteTool("blk1", { initialCommand: "pi", cwd: "/Users/bytedance/Documents/crest" });
        const result = await tool.execute("t1", {
            input: "cd /Users/bytedance/Documents/crest && pi",
            mode: "line",
        });

        expect(sent).toEqual([]);
        expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("already running") });
    });

    it("block mode wraps in bracketed-paste when enabled", async () => {
        sent.length = 0;
        const tool = createPtyWriteTool("blk1");
        await tool.execute("t1", { block_id: "blk1", input: "a\nb", mode: "block" });
        expect(sent[0].input).toBe("\x1b[200~a\nb\x1b[201~");
    });
});
