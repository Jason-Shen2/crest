import { describe, expect, it, vi } from "vitest";

const sent: Array<{ commandId: string; input: string }> = [];

import type { AgentPtyCommandPort } from "../agent-pty-host";
import { createPtyWriteTool } from "./pty-write";

function makePort(): AgentPtyCommandPort {
    return {
        commandId: "cmd-real",
        read: vi.fn() as any,
        write: vi.fn(async (input: string) => {
            sent.push({ commandId: "cmd-real", input });
        }),
        resize: vi.fn(),
        requestUserInput: vi.fn(),
        stop: vi.fn(async () => {}),
    };
}

describe("pty_write", () => {
    it("does not require the model to provide a block_id", () => {
        const tool = createPtyWriteTool(makePort());
        expect((tool.parameters as { required?: string[] }).required).not.toContain("command_id");
    });

    it("always writes to the bound command even if the model guesses a placeholder command_id", async () => {
        sent.length = 0;
        const tool = createPtyWriteTool(makePort());
        await tool.execute("t1", { command_id: "default", input: "\x03", mode: "raw" });
        expect(sent).toEqual([{ commandId: "cmd-real", input: "\x03" }]);
    });

    it("raw mode sends bytes unchanged", async () => {
        sent.length = 0;
        const tool = createPtyWriteTool(makePort());
        await tool.execute("t1", { input: "\x03", mode: "raw" });
        expect(sent).toEqual([{ commandId: "cmd-real", input: "\x03" }]);
    });

    it("line mode wraps input with SOH prefix and submit char", async () => {
        sent.length = 0;
        const tool = createPtyWriteTool(makePort());
        await tool.execute("t1", { input: "yes", mode: "line" });
        const submit = process.platform === "win32" ? "\r" : "\n";
        expect(sent[0].input).toBe(`\x01yes${submit}`);
    });

    it("does not replay the startup command into the already-running CLI", async () => {
        sent.length = 0;
        const tool = createPtyWriteTool(makePort(), { initialCommand: "pi", cwd: "/Users/bytedance/Documents/crest" });
        const result = await tool.execute("t1", {
            input: "cd /Users/bytedance/Documents/crest && pi",
            mode: "line",
        });

        expect(sent).toEqual([]);
        expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("already running") });
    });

    it("block mode wraps in bracketed-paste when enabled", async () => {
        sent.length = 0;
        const tool = createPtyWriteTool(makePort());
        await tool.execute("t1", { input: "a\nb", mode: "block" });
        expect(sent[0].input).toBe("\x1b[200~a\nb\x1b[201~");
    });
});
