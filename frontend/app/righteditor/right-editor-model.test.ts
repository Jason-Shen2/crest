import { beforeEach, describe, expect, it, vi } from "vitest";
import { RightEditorModel } from "./right-editor-model";

function makeRpc() {
    return {
        readFile: vi.fn(async () => ({ text: "initial", readonly: false })),
        writeFile: vi.fn(async () => undefined),
    };
}

describe("RightEditorModel", () => {
    beforeEach(() => {
        RightEditorModel.resetInstance();
    });

    it("opens a file and makes it active", async () => {
        const rpc = makeRpc();
        const model = RightEditorModel.getInstance(rpc);

        await model.openFile("/repo/src/app.ts", "/repo");

        const state = model.getStateNow();
        expect(state.activePath).toBe("/repo/src/app.ts");
        expect(state.openFiles).toHaveLength(1);
        expect(state.openFiles[0].savedText).toBe("initial");
        expect(state.openFiles[0].language).toBe("typescript");
    });

    it("marks a file dirty and saves it", async () => {
        const rpc = makeRpc();
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/src/app.ts", "/repo");

        model.updateText("/repo/src/app.ts", "changed");
        expect(model.getOpenFileNow("/repo/src/app.ts")?.dirtyText).toBe("changed");

        await model.saveFile("/repo/src/app.ts");

        expect(rpc.writeFile).toHaveBeenCalledWith("/repo/src/app.ts", "changed");
        expect(model.getOpenFileNow("/repo/src/app.ts")?.savedText).toBe("changed");
        expect(model.getOpenFileNow("/repo/src/app.ts")?.dirtyText).toBeNull();
    });
});
