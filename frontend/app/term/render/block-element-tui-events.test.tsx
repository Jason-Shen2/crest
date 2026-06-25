// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
    refValues: [] as Array<{ current: unknown }>,
    documentListeners: new Map<string, Array<(event: unknown) => void>>(),
    windowListeners: new Map<string, Array<(event: unknown) => void>>(),
    effectCleanups: [] as Array<() => void>,
}));

vi.mock("react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react")>();
    return {
        ...actual,
        memo: (component: unknown) => component,
        useCallback: (callback: unknown) => callback,
        useEffect: (effect: () => void | (() => void)) => {
            const cleanup = effect();
            if (typeof cleanup === "function") {
                testState.effectCleanups.push(cleanup);
            }
        },
        useRef: (initial: unknown) => testState.refValues.shift() ?? { current: initial },
        useState: (initial: unknown) => [initial, vi.fn()],
    };
});

vi.mock("@/app/view/cmdblock/cmdblock-header", () => ({
    CmdBlockHeader: () => <div />,
}));

vi.mock("@/app/view/cmdblock/cmdblock-snackbar", () => ({
    CmdBlockSnackbar: () => <div />,
}));

vi.mock("@/app/view/cmdblock/cmdblock-toolbelt", () => ({
    CmdBlockToolbelt: () => <div />,
}));

vi.mock("./block-context-menu", () => ({
    BlockContextMenu: () => <div />,
}));

vi.mock("./cursor-overlay", () => ({
    CursorOverlay: () => <div />,
}));

vi.mock("./find-highlight-layer", () => ({
    FindHighlightLayer: () => <div />,
}));

vi.mock("./grid-element", () => ({
    GridElement: () => <div />,
}));

vi.mock("./selection-layer", () => ({
    SelectionLayer: () => <div />,
}));

import { BlockElement } from "./block-element";

const EmptyCell = {
    char: "",
    width: 1,
};

function makeGrid() {
    const grid = {
        cols: 80,
        cursor: { row: 0, col: 0 },
        cursorState: { visible: false, shape: "block", blink: false },
        rowCount: () => 24,
        getRow: () => [EmptyCell],
        getRowVersion: () => 1,
        getLink: () => undefined,
        raw: () => grid,
    };
    return grid;
}

function makeBlock() {
    const grid = makeGrid();
    return {
        id: "block-1",
        state: "done",
        exitCode: undefined,
        hidden: false,
        collapsed: false,
        altScreen: { active: true, wasActive: true, grid },
        outputGrid: grid,
        commandText: () => "vim",
        durationMs: () => 1000,
    };
}

function installGlobalEventStubs() {
    testState.documentListeners.clear();
    testState.windowListeners.clear();
    vi.stubGlobal("document", {
        addEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
            const handlers = testState.documentListeners.get(type) ?? [];
            handlers.push(handler);
            testState.documentListeners.set(type, handlers);
        }),
        removeEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
            const handlers = testState.documentListeners.get(type) ?? [];
            testState.documentListeners.set(
                type,
                handlers.filter((registered) => registered !== handler)
            );
        }),
    });
    vi.stubGlobal("window", {
        addEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
            const handlers = testState.windowListeners.get(type) ?? [];
            handlers.push(handler);
            testState.windowListeners.set(type, handlers);
        }),
        removeEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
            const handlers = testState.windowListeners.get(type) ?? [];
            testState.windowListeners.set(
                type,
                handlers.filter((registered) => registered !== handler)
            );
        }),
    });
}

function findMouseHost(node: any): any {
    if (!node || typeof node !== "object") return null;
    if (node.props?.onMouseDown && node.props?.onMouseUp && node.props?.onMouseLeave) {
        return node;
    }
    const children = node.props?.children;
    const childList = Array.isArray(children) ? children : [children];
    for (const child of childList) {
        const found = findMouseHost(child);
        if (found) return found;
    }
    return null;
}

function makeMouseEvent(button: number) {
    return {
        button,
        clientX: 5,
        clientY: 5,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    };
}

function makeOutsideMouseEvent(button: number) {
    return {
        ...makeMouseEvent(button),
        clientY: 1000,
    };
}

describe("BlockElement TUI mouse events", () => {
    beforeEach(() => {
        testState.effectCleanups.length = 0;
        installGlobalEventStubs();
    });

    afterEach(() => {
        for (const cleanup of testState.effectCleanups.splice(0).reverse()) {
            cleanup();
        }
        testState.documentListeners.clear();
        testState.windowListeners.clear();
        vi.unstubAllGlobals();
    });

    function renderMouseHost() {
        const sendBytes = vi.fn();
        const model = {
            getMode: () => ({
                mouseClick: true,
                mouseSgr: true,
            }),
            sendBytes,
            endSelection: vi.fn(),
            submitInput: vi.fn(),
        };
        testState.refValues = [
            { current: null },
            {
                current: {
                    getBoundingClientRect: () => ({
                        left: 0,
                        top: 0,
                        width: 800,
                        height: 400,
                    }),
                },
            },
            { current: null },
        ];

        const element = (BlockElement as any)({
            block: makeBlock(),
            revision: 1,
            model,
            fontSize: 10,
            charWidth: 10,
        });
        const host = findMouseHost(element);
        expect(host).toBeTruthy();
        return { host, sendBytes };
    }

    function dispatch(type: "document" | "window", eventName: string, event: unknown) {
        const listeners =
            type === "document"
                ? testState.documentListeners.get(eventName) ?? []
                : testState.windowListeners.get(eventName) ?? [];
        for (const listener of listeners) {
            listener(event);
        }
    }

    it("keeps TUI mouse capture across mouseleave so release is forwarded", () => {
        const { host, sendBytes } = renderMouseHost();

        host.props.onMouseDown(makeMouseEvent(0));
        host.props.onMouseLeave();
        host.props.onMouseUp(makeMouseEvent(0));

        expect(sendBytes).toHaveBeenCalledWith("\x1b[<0;1;1M");
        expect(sendBytes).toHaveBeenCalledWith("\x1b[<0;1;1m");
    });

    it("forwards TUI mouse release when mouseup happens outside after mouseleave", () => {
        const { host, sendBytes } = renderMouseHost();

        host.props.onMouseDown(makeMouseEvent(0));
        host.props.onMouseLeave();
        dispatch("document", "mouseup", makeOutsideMouseEvent(0));
        dispatch("window", "mouseup", makeOutsideMouseEvent(0));

        expect(sendBytes).toHaveBeenCalledWith("\x1b[<0;1;1M");
        expect(sendBytes).toHaveBeenCalledWith("\x1b[<0;1;1m");
    });
});
