import { globalStore } from "@/app/store/jotaiStore";
import { describe, expect, it, vi } from "vitest";
import { SourceControlModel } from "./source-control-model";

vi.mock("@/app/fileexplorer/file-explorer-atoms", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    return {
        focusedCwdAtom: jotaiActual.atom(""),
    };
});

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {},
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: { routeid: "tab" },
}));

describe("SourceControlModel", () => {
    it("keeps the selected source control view across panel remounts", () => {
        const model = SourceControlModel.getInstance();

        expect(globalStore.get(model.viewAtom)).toBe("changes");
        globalStore.set(model.viewAtom, "graph");
        expect(globalStore.get(SourceControlModel.getInstance().viewAtom)).toBe("graph");

        globalStore.set(model.viewAtom, "changes");
    });
});
