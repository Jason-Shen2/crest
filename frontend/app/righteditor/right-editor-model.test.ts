import { beforeEach, describe, expect, it, vi } from "vitest";
import { RightEditorModel } from "./right-editor-model";

function makeRpc() {
    return {
        readFile: vi.fn(async () => ({ text: "initial", readonly: false })),
        writeFile: vi.fn(async () => undefined),
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
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

    it("preserves newer edits made while a save is pending", async () => {
        const save = deferred<void>();
        const rpc = makeRpc();
        rpc.writeFile.mockReturnValueOnce(save.promise);
        const model = RightEditorModel.getInstance(rpc);
        await model.openFile("/repo/src/app.ts", "/repo");

        model.updateText("/repo/src/app.ts", "first change");
        const savePromise = model.saveFile("/repo/src/app.ts");
        model.updateText("/repo/src/app.ts", "second change");
        save.resolve();
        await savePromise;

        expect(rpc.writeFile).toHaveBeenCalledWith("/repo/src/app.ts", "first change");
        expect(model.getOpenFileNow("/repo/src/app.ts")?.savedText).toBe("first change");
        expect(model.getOpenFileNow("/repo/src/app.ts")?.dirtyText).toBe("second change");
    });

    it("dedupes concurrent opens for the same file", async () => {
        const read = deferred<{ text: string; readonly: boolean }>();
        const rpc = makeRpc();
        rpc.readFile.mockReturnValue(read.promise);
        const model = RightEditorModel.getInstance(rpc);

        const firstOpen = model.openFile("/repo/src/app.ts", "/repo");
        const secondOpen = model.openFile("/repo/src/app.ts", "/repo");
        read.resolve({ text: "initial", readonly: false });
        await Promise.all([firstOpen, secondOpen]);

        expect(rpc.readFile).toHaveBeenCalledTimes(1);
        expect(model.getStateNow().openFiles).toHaveLength(1);
        expect(model.getStateNow().activePath).toBe("/repo/src/app.ts");
    });

    it("disposes the Monaco model when closing a file", async () => {
        const disposeModelPath = vi.fn();
        const model = RightEditorModel.getInstance(makeRpc(), { disposeModelPath });
        await model.openFile("/repo/src/app.ts", "/repo");

        model.closeFile("/repo/src/app.ts");

        expect(disposeModelPath).toHaveBeenCalledWith("/repo/src/app.ts");
    });
});
