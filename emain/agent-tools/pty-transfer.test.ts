import { describe, expect, it } from "vitest";
import { createPtyTransferTool } from "./pty-transfer";

describe("pty_transfer_to_user", () => {
    it("does not require the model to provide a block_id", () => {
        const tool = createPtyTransferTool("blk1");
        expect((tool.parameters as { required?: string[] }).required).not.toContain("block_id");
    });

    it("always reports the bound block even if the model guesses a placeholder block_id", async () => {
        const tool = createPtyTransferTool("blk-real");
        const r = await tool.execute("t1", { block_id: "default", reason: "needs sudo password" });
        expect(r.details).toMatchObject({ transferred: true, block_id: "blk-real" });
    });

    it("terminates and echoes the reason", async () => {
        const tool = createPtyTransferTool("blk1");
        const r = await tool.execute("t1", { block_id: "blk1", reason: "needs sudo password" });
        expect(r.terminate).toBe(true);
        expect(r.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("needs sudo password") });
        expect(r.details).toMatchObject({ transferred: true, block_id: "blk1" });
    });
});
