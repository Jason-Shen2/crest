import { describe, expect, it, vi } from "vitest";

vi.mock("../../emain-wsh", () => ({ ElectronWshClient: {} }));

import * as factory from "../cli-subagent-factory";
import * as rpc from "./_pty-rpc";
import { createSpawnCliAgentTool, runSubagentToCompletion } from "./spawn-cli-agent";

function fakeSub(finalText: string) {
    return {
        harness: {
            prompt: vi.fn(async () => ({ role: "assistant", content: [{ type: "text", text: finalText }] })),
            abort: vi.fn(async () => {}),
        },
    } as any;
}

describe("runSubagentToCompletion", () => {
    it("returns the final assistant text as the summary", async () => {
        const sub = fakeSub("dev server listening on 3000");
        const summary = await runSubagentToCompletion(sub, "start dev server", { maxTurns: 5 });
        expect(summary).toBe("dev server listening on 3000");
        expect(sub.harness.prompt).toHaveBeenCalledWith("start dev server");
    });

    it("aborts and rethrows when the signal is already aborted", async () => {
        const sub = fakeSub("unused");
        const controller = new AbortController();
        controller.abort();
        await expect(
            runSubagentToCompletion(sub, "task", { maxTurns: 5, signal: controller.signal }),
        ).rejects.toThrow();
    });
});

describe("createSpawnCliAgentTool", () => {
    it("spawn_cli_agent starts a block, runs the subagent, returns the summary", async () => {
        vi.spyOn(rpc, "startAgentCommandBlock").mockResolvedValue("blk-new");
        vi.spyOn(rpc, "stopBlock").mockResolvedValue();
        vi.spyOn(factory, "buildCliSubagentHarness").mockReturnValue(fakeSub("listening on 3000"));

        const tool = createSpawnCliAgentTool({
            parentBlockId: "parent",
            model: { id: "small" } as any,
            createSession: async () => ({ getMetadata: async () => ({}) }) as any,
        });
        const r = await tool.execute("t1", {
            task: "start dev server and confirm port 3000",
            initial_command: "npm run dev",
            cwd: "/tmp",
        });
        expect(rpc.startAgentCommandBlock).toHaveBeenCalledWith("parent", "/tmp", "npm run dev");
        expect(r.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("3000") });
        expect(r.details).toMatchObject({ blockId: "blk-new" });
    });
});
