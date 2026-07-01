import { describe, expect, it, vi } from "vitest";

let tailResp = { text: "recent output", isrunning: true, altscreen: false, exitcode: undefined as number | undefined };
vi.mock("./_pty-rpc", () => ({
    getCmdBlockTail: async () => tailResp,
}));
// No screen snapshot backend yet; the module falls back to transcript.
vi.mock("./_pty-screen", () => ({
    getScreenSnapshot: async () => {
        throw new Error("renderer unavailable");
    },
}));

import { createPtyReadTool } from "./pty-read";

describe("pty_read", () => {
    it("auto + altscreen=false returns transcript_tail", async () => {
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

    it("reports exit_code when finished", async () => {
        tailResp = { text: "done", isrunning: false, altscreen: false, exitcode: 0 };
        const tool = createPtyReadTool("blk1");
        const r = await tool.execute("t1", { block_id: "blk1", mode: "transcript" });
        expect(r.details).toMatchObject({ is_running: false, exit_code: 0 });
    });
});
