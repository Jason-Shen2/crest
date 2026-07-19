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
        const summary = await runSubagentToCompletion(sub, "start dev server");
        expect(summary).toBe("dev server listening on 3000");
        expect(sub.harness.prompt).toHaveBeenCalledWith("start dev server");
    });

    it("aborts and rethrows when the signal is already aborted", async () => {
        const sub = fakeSub("unused");
        const controller = new AbortController();
        controller.abort();
        await expect(
            runSubagentToCompletion(sub, "task", { signal: controller.signal }),
        ).rejects.toThrow();
    });
});

describe("createSpawnCliAgentTool", () => {
    it("uses the current model and auth resolver when execution starts", async () => {
        vi.spyOn(rpc, "startAgentCommandBlock").mockResolvedValue("blk-new");
        const sub = fakeSub("done");
        vi.spyOn(factory, "buildCliSubagentHarness").mockReturnValue(sub);
        let model = { id: "first" } as any;
        const getModel = vi.fn(() => model);
        const getApiKeyAndHeaders = vi.fn(async () => ({ apiKey: "current" }));
        const tool = createSpawnCliAgentTool({
            parentBlockId: "parent",
            getModel,
            createSession: async () => ({ getMetadata: async () => ({}) }) as any,
            getApiKeyAndHeaders,
        });
        model = { id: "second" } as any;

        await tool.execute("t1", {
            task: "run current config",
            initial_command: "npm run dev",
            cwd: "/tmp",
        });

        expect(factory.buildCliSubagentHarness).toHaveBeenCalledWith(
            expect.objectContaining({
                model: expect.objectContaining({ id: "second" }),
                getApiKeyAndHeaders,
            })
        );
    });

    it("spawn_cli_agent starts a block, runs the subagent, returns the summary", async () => {
        vi.spyOn(rpc, "startAgentCommandBlock").mockResolvedValue("blk-new");
        vi.spyOn(rpc, "stopBlock").mockResolvedValue();
        const sub = fakeSub("listening on 3000");
        vi.spyOn(factory, "buildCliSubagentHarness").mockReturnValue(sub);

        const tool = createSpawnCliAgentTool({
            parentBlockId: "parent",
            getModel: () => ({ id: "small" }) as any,
            createSession: async () => ({ getMetadata: async () => ({}) }) as any,
        });
        const r = await tool.execute("t1", {
            task: "start dev server and confirm port 3000",
            initial_command: "npm run dev",
            cwd: "/tmp",
        });
        expect(rpc.startAgentCommandBlock).toHaveBeenCalledWith("parent", "/tmp", "npm run dev");
        expect(factory.buildCliSubagentHarness).toHaveBeenCalledWith(
            expect.objectContaining({
                blockId: "blk-new",
                cwd: "/tmp",
                initialCommand: "npm run dev",
            }),
        );
        expect(sub.harness.prompt).toHaveBeenCalledWith(expect.stringContaining("already been started"));
        expect(sub.harness.prompt).toHaveBeenCalledWith(expect.stringContaining("Do not type"));
        expect(r.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("3000") });
        expect(r.details).toMatchObject({ blockId: "blk-new" });
        // On success the command block is left running for the user.
        expect(rpc.stopBlock).not.toHaveBeenCalled();
    });

    it("tears down the command block when the subagent run fails", async () => {
        vi.spyOn(rpc, "startAgentCommandBlock").mockResolvedValue("blk-new");
        const stop = vi.spyOn(rpc, "stopBlock").mockResolvedValue();
        const sub = fakeSub("unused");
        sub.harness.prompt = vi.fn(async () => {
            throw new Error("boom");
        });
        vi.spyOn(factory, "buildCliSubagentHarness").mockReturnValue(sub);

        const tool = createSpawnCliAgentTool({
            parentBlockId: "parent",
            getModel: () => ({ id: "small" }) as any,
            createSession: async () => ({ getMetadata: async () => ({}) }) as any,
        });
        await expect(
            tool.execute("t1", { task: "t", initial_command: "npm run dev", cwd: "/tmp" }),
        ).rejects.toThrow("boom");
        expect(stop).toHaveBeenCalledWith("blk-new");
    });
});
