import { describe, expect, it } from "vitest";
import { createPtyTransferTool } from "./pty-transfer";

describe("pty_transfer_to_user", () => {
    it("terminates and echoes the reason", async () => {
        const tool = createPtyTransferTool("blk1");
        const r = await tool.execute("t1", { block_id: "blk1", reason: "needs sudo password" });
        expect(r.terminate).toBe(true);
        expect(r.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("needs sudo password") });
        expect(r.details).toMatchObject({ transferred: true, block_id: "blk1" });
    });
});
