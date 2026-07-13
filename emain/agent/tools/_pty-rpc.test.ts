import { beforeEach, describe, expect, it, vi } from "vitest";

const controllerInput = vi.fn(async (..._args: unknown[]) => {});
const getTail = vi.fn(async (..._args: unknown[]) => ({ text: "hi", isrunning: true, altscreen: false }));
const blockInfo = vi.fn(async (..._args: unknown[]) => ({ blockid: "parent", tabid: "tab-1" }));
const createBlock = vi.fn(async (..._args: unknown[]) => "block:blk-new");
const controllerDestroy = vi.fn(async (..._args: unknown[]) => {});
const controllerResync = vi.fn(async (..._args: unknown[]) => {});
const deleteBlock = vi.fn(async (..._args: unknown[]) => {});

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        ControllerInputCommand: (...a: unknown[]) => controllerInput(...a),
        GetCmdBlockTailCommand: (...a: unknown[]) => getTail(...a),
        BlockInfoCommand: (...a: unknown[]) => blockInfo(...a),
        CreateBlockCommand: (...a: unknown[]) => createBlock(...a),
        ControllerDestroyCommand: (...a: unknown[]) => controllerDestroy(...a),
        ControllerResyncCommand: (...a: unknown[]) => controllerResync(...a),
        DeleteBlockCommand: (...a: unknown[]) => deleteBlock(...a),
    },
}));
vi.mock("../../emain-wsh", () => ({ ElectronWshClient: {} }));

import { getCmdBlockTail, sendControllerInput, startAgentCommandBlock, stopBlock } from "./_pty-rpc";

describe("_pty-rpc", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createBlock.mockResolvedValue("block:blk-new");
        controllerDestroy.mockResolvedValue(undefined);
        controllerResync.mockResolvedValue(undefined);
        deleteBlock.mockResolvedValue(undefined);
    });

    it("sendControllerInput base64-encodes input data", async () => {
        await sendControllerInput("blk1", "abc");
        expect(controllerInput).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ blockid: "blk1", inputdata64: Buffer.from("abc").toString("base64") })
        );
    });

    it("getCmdBlockTail passes bounds and returns the response", async () => {
        const r = await getCmdBlockTail("blk1", { oid: "o1", maxLines: 40 });
        expect(getTail).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ blockid: "blk1", oid: "o1", maxlines: 40 })
        );
        expect(r.text).toBe("hi");
    });

    it("startAgentCommandBlock resolves the tabid and returns the bare blockId", async () => {
        const blockId = await startAgentCommandBlock("parent", "/tmp", "npm run dev");
        expect(blockId).toBe("blk-new");
        expect(blockInfo).toHaveBeenCalledWith(expect.anything(), "parent");
        expect(createBlock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                tabid: "tab-1",
                focused: true,
                blockdef: expect.objectContaining({
                    meta: expect.objectContaining({
                        view: "term",
                        controller: "cmd",
                        "cmd:cwd": "/tmp",
                        cmd: "npm run dev",
                    }),
                }),
            })
        );
        expect(controllerResync).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ tabid: "tab-1", blockid: "blk-new" })
        );
    });

    it("startAgentCommandBlock removes the new block if controller resync fails", async () => {
        controllerResync.mockRejectedValueOnce(new Error("resync failed"));

        await expect(startAgentCommandBlock("parent", "/tmp", "npm run dev")).rejects.toThrow("resync failed");
        expect(deleteBlock).toHaveBeenCalledWith(expect.anything(), { blockid: "blk-new" });
    });

    it("stopBlock destroys the controller and removes the failed command block", async () => {
        await stopBlock("blk-new");
        expect(controllerDestroy).toHaveBeenCalledWith(expect.anything(), "blk-new");
        expect(deleteBlock).toHaveBeenCalledWith(expect.anything(), { blockid: "blk-new" });
    });
});
