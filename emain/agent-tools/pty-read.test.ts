import { describe, expect, it, vi } from "vitest";

let tailResp = { text: "recent output", isrunning: true, altscreen: false, exitcode: undefined as number | undefined };
const readBlockIds: string[] = [];
vi.mock("./_pty-rpc", () => ({
    getCmdBlockTail: async (blockId: string) => {
        readBlockIds.push(blockId);
        return tailResp;
    },
}));
// Screen snapshot backend: by default it fails (renderer unavailable) so
// pty_read falls back to transcript; individual tests can swap in a
// resolving snapshot via screenSnapshotImpl.
let screenSnapshotImpl: (blockId: string) => Promise<unknown> = async () => {
    throw new Error("renderer unavailable");
};
vi.mock("./_pty-screen", () => ({
    getScreenSnapshot: (blockId: string) => screenSnapshotImpl(blockId),
}));

import { createPtyReadTool } from "./pty-read";

describe("pty_read", () => {
    it("does not require the model to provide a block_id", () => {
        const tool = createPtyReadTool("blk1");
        expect((tool.parameters as { required?: string[] }).required ?? []).not.toContain("block_id");
    });

    it("always reads the bound block even if the model guesses a placeholder block_id", async () => {
        readBlockIds.length = 0;
        tailResp = { text: "recent output", isrunning: true, altscreen: false, exitcode: undefined };
        const tool = createPtyReadTool("blk-real");
        const r = await tool.execute("t1", { block_id: "default", mode: "auto" });
        expect(readBlockIds).toEqual(["blk-real"]);
        expect(r.details).toMatchObject({ block_id: "blk-real" });
    });

    it("auto + altscreen=false returns transcript_tail", async () => {
        readBlockIds.length = 0;
        tailResp = { text: "recent output", isrunning: true, altscreen: false, exitcode: undefined };
        const tool = createPtyReadTool("blk1");
        const r = await tool.execute("t1", { block_id: "blk1", mode: "auto" });
        expect(r.details).toMatchObject({ source: "transcript_tail", is_running: true, approximate: true });
        expect(r.content[0]).toMatchObject({ type: "text", text: "recent output" });
    });

    it("auto + altscreen=true degrades to transcript when renderer fails", async () => {
        tailResp = { text: "vim buffer tail", isrunning: true, altscreen: true, exitcode: undefined };
        const tool = createPtyReadTool("blk1");
        const r = await tool.execute("t1", { block_id: "blk1", mode: "auto" });
        expect(r.details).toMatchObject({ source: "transcript_tail", degraded: true });
    });

    it("auto + altscreen=true returns screen_snapshot when renderer answers", async () => {
        tailResp = { text: "vim buffer tail", isrunning: true, altscreen: true, exitcode: undefined };
        screenSnapshotImpl = async (blockId: string) => ({
            grid_contents: "line one\nline <|cursor|>two",
            cursor: "<|cursor|>",
            is_alt_screen_active: true,
            block_id: blockId,
        });
        try {
            const tool = createPtyReadTool("blk1");
            const r = await tool.execute("t1", { block_id: "blk1", mode: "auto" });
            expect(r.details).toMatchObject({
                source: "screen_snapshot",
                is_alt_screen_active: true,
                is_running: true,
            });
            expect((r.content[0] as { text: string }).text).toContain("line one");
            expect((r.content[0] as { text: string }).text).toContain("<|cursor|>");
        } finally {
            screenSnapshotImpl = async () => {
                throw new Error("renderer unavailable");
            };
        }
    });

    it("reports exit_code when finished", async () => {
        tailResp = { text: "done", isrunning: false, altscreen: false, exitcode: 0 };
        const tool = createPtyReadTool("blk1");
        const r = await tool.execute("t1", { block_id: "blk1", mode: "transcript" });
        expect(r.details).toMatchObject({ is_running: false, exit_code: 0 });
    });
});
