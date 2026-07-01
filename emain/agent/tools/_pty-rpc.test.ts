import { describe, expect, it, vi } from "vitest";

const controllerInput = vi.fn(async () => {});
const getTail = vi.fn(async () => ({ text: "hi", isrunning: true, altscreen: false }));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        ControllerInputCommand: (...a: unknown[]) => controllerInput(...a),
        GetCmdBlockTailCommand: (...a: unknown[]) => getTail(...a),
    },
}));
vi.mock("../../emain-wsh", () => ({ ElectronWshClient: {} }));

import { getCmdBlockTail, sendControllerInput } from "./_pty-rpc";

describe("_pty-rpc", () => {
    it("sendControllerInput base64-encodes input data", async () => {
        await sendControllerInput("blk1", "abc");
        expect(controllerInput).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ blockid: "blk1", inputdata64: Buffer.from("abc").toString("base64") }),
        );
    });

    it("getCmdBlockTail passes bounds and returns the response", async () => {
        const r = await getCmdBlockTail("blk1", { oid: "o1", maxLines: 40 });
        expect(getTail).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ blockid: "blk1", oid: "o1", maxlines: 40 }),
        );
        expect(r.text).toBe("hi");
    });
});
