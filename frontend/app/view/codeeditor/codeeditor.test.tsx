// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Provider, atom } from "jotai";
import { globalStore } from "@/app/store/jotaiStore";

const mockReact = vi.hoisted(() => ({
    useSyncExternalStore: vi.fn((_subscribe: any, getSnapshot: any) => getSnapshot()),
    useEffect: vi.fn(),
}));

const mockCodeEditor = vi.hoisted(() => ({
    monacoProps: [] as any[],
}));

const mockRegistry = vi.hoisted(() => ({
    getOrCreateModel: vi.fn(() => ({ id: "block-model" })),
    disposePath: vi.fn(),
    migratePath: vi.fn(),
}));

const mockRightEditorRpc = vi.hoisted(() => ({
    readFile: vi.fn(async () => ({ text: "const x = 1;", readonly: false })),
    writeFile: vi.fn(async () => undefined),
}));

const mockLspManager = vi.hoisted(() => ({
    acquireClient: vi.fn(() => vi.fn()),
    getStatus: vi.fn((input: any) => ({
        workspaceRoot: input.workspaceRoot,
        language: input.language,
        serverId: input.serverId ?? null,
        displayName: input.displayName ?? input.language,
        state: "stopped",
        message: null,
    })),
    getStatusSnapshot: vi.fn(() => 0),
    subscribeStatus: vi.fn((_input: any, _listener: () => void) => vi.fn()),
}));

vi.mock("react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react")>();
    return {
        ...actual,
        useEffect: mockReact.useEffect,
        useSyncExternalStore: mockReact.useSyncExternalStore,
    };
});

vi.mock("@/app/monaco/monaco-react", () => ({
    MonacoCodeEditor: (props: any) => {
        mockCodeEditor.monacoProps.push(props);
        return <div>Monaco Code Editor</div>;
    },
}));

vi.mock("@/app/store/global", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    return {
        getApi: () => ({
            getHomeDir: () => "/repo",
        }),
        getSettingsKeyAtom: () => jotaiActual.atom(false),
        useOverrideConfigAtom: () => undefined,
    };
});

vi.mock("monaco-editor", () => ({}));

vi.mock("@/app/righteditor/monaco-model-registry", () => ({
    MonacoModelRegistry: {
        getInstance: () => ({
            getOrCreateModel: mockRegistry.getOrCreateModel,
            disposePath: mockRegistry.disposePath,
            migratePath: mockRegistry.migratePath,
        }),
    },
}));

vi.mock("@/app/righteditor/right-editor-rpc", () => ({
    RightEditorProductionRpc: mockRightEditorRpc,
}));

vi.mock("@/app/righteditor/lsp/language-client-manager", () => ({
    languageClientManager: mockLspManager,
}));

import { CodeEditor } from "./codeeditor";
import { RightEditorModel } from "@/app/righteditor/right-editor-model";
import { FileEditorViewModel } from "./file-editor-model";

function makeFileEditorHarness(filePath = ""): { initOpts: ViewModelInitType; metaAtoms: Map<string, ReturnType<typeof atom>> } {
    const metaAtoms = new Map<string, ReturnType<typeof atom>>();
    return {
        metaAtoms,
        initOpts: {
            blockId: "block-1",
            nodeModel: {} as any,
            tabModel: {} as any,
            waveEnv: {
                getBlockMetaKeyAtom: (_blockId: string, key: string) => {
                    if (!metaAtoms.has(key)) {
                        metaAtoms.set(key, atom(key === "file" ? filePath : ""));
                    }
                    return metaAtoms.get(key);
                },
            } as any,
        },
    };
}

function makeFileEditorInitOpts(filePath = ""): ViewModelInitType {
    return makeFileEditorHarness(filePath).initOpts;
}

function makeOpenFile(path: string, text = "const x = 1;") {
    return {
        path,
        uri: `file://${path}`,
        language: "typescript",
        workspaceRoot: "/repo",
        readonly: false,
        savedText: text,
        dirtyText: null,
        saveStatus: "idle" as const,
        error: null,
    };
}

function renderFileEditor(model: FileEditorViewModel) {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <model.viewComponent blockId="block-1" blockRef={{ current: null }} contentRef={{ current: null }} model={model} />
        </Provider>
    );
}

function makeDeferredRead(text: string): { promise: Promise<{ text: string; readonly: boolean }>; resolve: () => void } {
    let resolve: () => void;
    const promise = new Promise<{ text: string; readonly: boolean }>((res) => {
        resolve = () => res({ text, readonly: false });
    });
    return {
        promise,
        resolve,
    };
}

function makeDeferredRejectedRead(error: Error): {
    promise: Promise<{ text: string; readonly: boolean }>;
    reject: () => void;
} {
    let reject: () => void;
    const promise = new Promise<{ text: string; readonly: boolean }>((_res, rej) => {
        reject = () => rej(error);
    });
    promise.catch(() => undefined);
    return {
        promise,
        reject,
    };
}

function flushPromises(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}

function mountCapturedEditor(): (event: any) => void {
    let keyDownHandler: (event: any) => void;
    mockCodeEditor.monacoProps[0].onMount({
        onKeyDown: (handler: (event: any) => void) => {
            keyDownHandler = handler;
            return { dispose: vi.fn() };
        },
    });
    return keyDownHandler;
}

describe("CodeEditor", () => {
    beforeEach(() => {
        mockCodeEditor.monacoProps = [];
        mockRegistry.getOrCreateModel.mockClear();
        mockRegistry.disposePath.mockClear();
        mockRegistry.migratePath.mockClear();
        mockRightEditorRpc.readFile.mockReset();
        mockRightEditorRpc.readFile.mockImplementation(async () => ({ text: "const x = 1;", readonly: false }));
        mockRightEditorRpc.writeFile.mockReset();
        mockRightEditorRpc.writeFile.mockImplementation(async () => undefined);
        mockLspManager.acquireClient.mockClear();
        mockLspManager.getStatus.mockClear();
        mockLspManager.getStatusSnapshot.mockClear();
        mockLspManager.subscribeStatus.mockClear();
        mockReact.useSyncExternalStore.mockReset();
        mockReact.useSyncExternalStore.mockImplementation((_subscribe: any, getSnapshot: any) => getSnapshot());
        mockReact.useEffect.mockReset();
        mockReact.useEffect.mockImplementation(() => undefined);
        RightEditorModel.resetInstance();
    });

    it("passes an external Monaco model through to MonacoCodeEditor", () => {
        const externalModel = { id: "external-model" };

        renderToStaticMarkup(
            <CodeEditor
                blockId="right-editor"
                text="const x = 1;"
                readonly={false}
                language="typescript"
                fileName="/repo/src/app.ts"
                model={externalModel as any}
            />
        );

        expect(mockCodeEditor.monacoProps[0].model).toBe(externalModel);
    });

    it("does not create the shared right editor model for codeeditor blocks", () => {
        const model = new FileEditorViewModel(makeFileEditorInitOpts());

        renderToStaticMarkup(
            <model.viewComponent blockId="block-1" blockRef={{ current: null }} contentRef={{ current: null }} model={model} />
        );

        expect(RightEditorModel.hasInstance()).toBe(false);
    });

    it("uses an LSP-compatible file Monaco uri for codeeditor blocks without creating RightEditorModel", () => {
        const filePath = "/repo/src/app.ts";
        const rawFileUri = "file:///repo/src/app.ts";
        const model = new FileEditorViewModel(makeFileEditorInitOpts(filePath));
        globalStore.set(model.stateAtom, {
            openFiles: [makeOpenFile(filePath)],
            activePath: filePath,
            workspaceRoot: "/repo",
        });

        renderFileEditor(model);

        expect(mockRegistry.getOrCreateModel).toHaveBeenCalledWith(
            expect.objectContaining({
                path: "codeeditor:block-1:/repo/src/app.ts",
                uri: rawFileUri,
            })
        );
        expect(RightEditorModel.hasInstance()).toBe(false);
    });

    it("stretches the editor tab content across the available width", () => {
        const filePath = "/repo/src/app.ts";
        const model = new FileEditorViewModel(makeFileEditorInitOpts(filePath));
        globalStore.set(model.stateAtom, {
            openFiles: [makeOpenFile(filePath)],
            activePath: filePath,
            workspaceRoot: "/repo",
        });

        const html = renderFileEditor(model);

        expect(html).toContain("flex h-full min-h-0 w-full flex-col");
        expect(html).toContain("min-h-0 min-w-0 flex-1 w-full");
    });

    it("ignores stale file reads after the block meta file changes", async () => {
        const firstRead = makeDeferredRead("old text");
        const secondRead = makeDeferredRead("new text");
        mockRightEditorRpc.readFile
            .mockImplementationOnce(() => firstRead.promise)
            .mockImplementationOnce(() => secondRead.promise);
        const { initOpts, metaAtoms } = makeFileEditorHarness("/repo/old.ts");
        const model = new FileEditorViewModel(initOpts);

        const firstOpen = model.openFile("/repo/old.ts", "/repo");
        globalStore.set(metaAtoms.get("file") as any, "/repo/new.ts");
        const secondOpen = model.openFile("/repo/new.ts", "/repo");

        secondRead.resolve();
        await secondOpen;
        firstRead.resolve();
        await firstOpen;

        expect(globalStore.get(model.stateAtom).openFiles).toEqual([
            expect.objectContaining({ path: "/repo/new.ts", savedText: "new text" }),
        ]);
    });

    it("dedupes pending reads for the same path", async () => {
        const pendingRead = makeDeferredRead("same text");
        mockRightEditorRpc.readFile.mockImplementationOnce(() => pendingRead.promise);
        const model = new FileEditorViewModel(makeFileEditorInitOpts("/repo/src/app.ts"));

        const firstOpen = model.openFile("/repo/src/app.ts", "/repo");
        const secondOpen = model.openFile("/repo/src/app.ts", "/repo");
        pendingRead.resolve();
        await Promise.all([firstOpen, secondOpen]);

        expect(mockRightEditorRpc.readFile).toHaveBeenCalledTimes(1);
        expect(globalStore.get(model.stateAtom).openFiles).toEqual([
            expect.objectContaining({ path: "/repo/src/app.ts", savedText: "same text" }),
        ]);
    });

    it("opens the current file when returning to a pending path", async () => {
        const firstRead = makeDeferredRead("first text");
        const secondRead = makeDeferredRead("second text");
        mockRightEditorRpc.readFile
            .mockImplementationOnce(() => firstRead.promise)
            .mockImplementationOnce(() => secondRead.promise);
        const { initOpts, metaAtoms } = makeFileEditorHarness("/repo/a.ts");
        const model = new FileEditorViewModel(initOpts);

        const firstAOpen = model.openFile("/repo/a.ts", "/repo");
        globalStore.set(metaAtoms.get("file") as any, "/repo/b.ts");
        const bOpen = model.openFile("/repo/b.ts", "/repo");
        globalStore.set(metaAtoms.get("file") as any, "/repo/a.ts");
        const secondAOpen = model.openFile("/repo/a.ts", "/repo");

        firstRead.resolve();
        await Promise.all([firstAOpen, secondAOpen]);
        secondRead.resolve();
        await bOpen;

        expect(mockRightEditorRpc.readFile).toHaveBeenCalledTimes(2);
        expect(globalStore.get(model.stateAtom).openFiles).toEqual([
            expect.objectContaining({ path: "/repo/a.ts", savedText: "first text" }),
        ]);
    });

    it("cleans up pending reads when readFile rejects", async () => {
        const rejectedRead = makeDeferredRejectedRead(new Error("read failed"));
        const nextRead = makeDeferredRead("recovered text");
        mockRightEditorRpc.readFile
            .mockImplementationOnce(() => rejectedRead.promise)
            .mockImplementationOnce(() => nextRead.promise);
        const model = new FileEditorViewModel(makeFileEditorInitOpts("/repo/src/app.ts"));

        const failedOpen = model.openFile("/repo/src/app.ts", "/repo");
        rejectedRead.reject();
        await expect(failedOpen).rejects.toThrow("read failed");
        const recoveredOpen = model.openFile("/repo/src/app.ts", "/repo");
        nextRead.resolve();
        await recoveredOpen;

        expect(mockRightEditorRpc.readFile).toHaveBeenCalledTimes(2);
        expect(globalStore.get(model.stateAtom).openFiles).toEqual([
            expect.objectContaining({ path: "/repo/src/app.ts", savedText: "recovered text" }),
        ]);
    });

    it("disposes block-scoped Monaco models when the active file changes", () => {
        const cleanupFns: Array<() => void> = [];
        mockReact.useEffect.mockImplementation((effect: any) => {
            const cleanup = effect();
            if (typeof cleanup === "function") {
                cleanupFns.push(cleanup);
            }
        });
        const model = new FileEditorViewModel(makeFileEditorInitOpts("/repo/old.ts"));
        globalStore.set(model.stateAtom, {
            openFiles: [makeOpenFile("/repo/old.ts")],
            activePath: "/repo/old.ts",
            workspaceRoot: "/repo",
        });
        renderFileEditor(model);
        cleanupFns.splice(0).forEach((cleanup) => cleanup());
        globalStore.set(model.stateAtom, {
            openFiles: [makeOpenFile("/repo/new.ts")],
            activePath: "/repo/new.ts",
            workspaceRoot: "/repo",
        });

        renderFileEditor(model);

        expect(mockRegistry.disposePath).toHaveBeenCalledWith("codeeditor:block-1:/repo/old.ts");
    });

    it("subscribes to LSP status changes for footer rerenders", () => {
        const model = new FileEditorViewModel(makeFileEditorInitOpts("/repo/src/app.ts"));
        globalStore.set(model.stateAtom, {
            openFiles: [makeOpenFile("/repo/src/app.ts")],
            activePath: "/repo/src/app.ts",
            workspaceRoot: "/repo",
        });
        mockReact.useSyncExternalStore.mockImplementation((subscribe: any, getSnapshot: any) => {
            subscribe(vi.fn());
            return getSnapshot();
        });

        renderFileEditor(model);

        expect(mockLspManager.subscribeStatus).toHaveBeenCalled();
        expect(mockLspManager.getStatusSnapshot).toHaveBeenCalled();
    });

    it("saves only the local active file on primary save", async () => {
        const model = new FileEditorViewModel(makeFileEditorInitOpts("/repo/src/app.ts"));
        globalStore.set(model.stateAtom, {
            openFiles: [{ ...makeOpenFile("/repo/src/app.ts"), dirtyText: "changed" }],
            activePath: "/repo/src/app.ts",
            workspaceRoot: "/repo",
        });
        renderFileEditor(model);
        const keyDownHandler = mountCapturedEditor();

        keyDownHandler({
            browserEvent: {
                key: "s",
                metaKey: true,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
            },
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        });
        await flushPromises();

        expect(mockRightEditorRpc.writeFile).toHaveBeenCalledWith("/repo/src/app.ts", "changed");
    });
});
