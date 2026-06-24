// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { blurActiveEditableInRoot, TerminalView } from "./terminal-view";

const testState = vi.hoisted(() => {
    const atomValue = <T,>(value: T) => ({ read: () => value });
    const sendBytes = vi.fn();
    const documentListeners = new Map<string, Array<(event: unknown) => void>>();
    const effectCleanups: Array<() => void> = [];
    return {
        atomValue,
        documentListeners,
        effectCleanups,
        sendBytes,
        activeElement: null as HTMLElement | null,
        lastModel: null as ReturnType<typeof makeModel> | null,
        blocks: null as Array<{
            id: string;
            state: string;
            altScreen: { active: boolean };
            commandText: () => string;
            durationMs?: () => number | undefined;
        }> | null,
        modeOverride: null as Record<string, unknown> | null,
    };
});

vi.mock("react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react")>();
    return {
        ...actual,
        useEffect: (effect: () => void | (() => void)) => {
            const cleanup = effect();
            if (typeof cleanup === "function") {
                testState.effectCleanups.push(cleanup);
            }
        },
    };
});

vi.mock("jotai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("jotai")>();
    return {
        ...actual,
        useAtomValue: (atom: { read?: () => unknown; value?: unknown }) => {
            if (typeof atom?.read === "function") return atom.read();
            return atom?.value;
        },
    };
});

vi.mock("@/app/store/ai-catalog", () => ({
    CATALOG: [],
}));

vi.mock("@/app/store/ai-provider-models", () => ({
    providerModelsMapAtom: testState.atomValue({}),
}));

vi.mock("@/app/store/ai-resolver", () => ({
    resolveAIConfig: vi.fn(),
}));

vi.mock("@/app/store/ai-user-config", () => ({
    aiUserConfigAtom: testState.atomValue({ config: null, status: "loaded", error: null }),
}));

vi.mock("@/app/store/jotaiStore", () => ({
    globalStore: {
        set: vi.fn(),
    },
}));

vi.mock("@/app/store/modalmodel", () => ({
    modalsModel: {
        pushModal: vi.fn(),
    },
}));

vi.mock("@/app/store/services", () => ({
    ObjectService: {
        UpdateObjectMeta: vi.fn(),
    },
}));

vi.mock("@/app/store/use-pi-chat", () => ({
    indexRunsById: () => new Map(),
}));

vi.mock("@/app/view/cmdblock/cmdblock-input", () => ({
    CmdBlockInput: ({ placeholder }: { placeholder?: string }) => (
        <div contentEditable role="textbox" data-testid="cmd-input" data-placeholder={placeholder ?? ""} />
    ),
}));

vi.mock("@/store/global", () => ({
    atoms: {
        staticTabId: testState.atomValue("tab-1"),
    },
    getApi: () => ({
        getHomeDir: () => "/Users/test",
        openExternal: vi.fn(),
    }),
    useOrefMetaKeyAtom: () => null,
    WOS: {
        makeORef: (type: string, id: string) => ({ type, id }),
    },
}));

vi.mock("../contextchip/chip-model", () => ({
    ContextChipModel: vi.fn().mockImplementation(() => ({
        valuesAtom: testState.atomValue({}),
        setCwd: vi.fn(),
        setGitBranch: vi.fn(),
        onCommandCompleted: vi.fn(),
        dispose: vi.fn(),
    })),
}));

vi.mock("../nld", () => ({
    NLDModel: vi.fn().mockImplementation(() => ({
        modeAtom: testState.atomValue("terminal"),
        effectiveModeAtom: testState.atomValue("terminal"),
        setMode: vi.fn(),
        triggerDetectionImmediate: vi.fn(),
        onTextChange: vi.fn(),
        dispose: vi.fn(),
    })),
}));

vi.mock("../terminal-model", () => ({
    TerminalModel: vi.fn().mockImplementation(() => makeModel()),
}));

vi.mock("./agent-activity-bar", () => ({
    AgentActivityBar: () => <div data-testid="agent-activity-bar" />,
}));

vi.mock("./agent-chat-host", () => ({
    AgentChatHost: () => <div data-testid="agent-chat-host" />,
}));

vi.mock("./block-list-element", () => ({
    BlockListElement: () => <div data-testid="block-list" />,
}));

vi.mock("./find-bar", () => ({
    FindBar: () => <div data-testid="find-bar" />,
}));

function makeModel() {
    const defaultBlock = {
        id: "block-1",
        state: "running",
        altScreen: { active: true },
        commandText: () => "claude",
    };
    const blocks = testState.blocks ?? [defaultBlock];
    const mode = {
        appCursor: false,
        bracketedPaste: false,
        focusReport: false,
        mouseX10: false,
        mouseClick: false,
        mouseButton: false,
        mouseMotion: false,
        mouseSgr: false,
        mouseUtf8: false,
        mouseUrxvt: false,
        alternateScroll: false,
        appKeypad: false,
        kittyKeyboardFlags: 0,
        ...(testState.modeOverride ?? {}),
    };
    const model = {
        revisionAtom: testState.atomValue(1),
        loadingAtom: testState.atomValue(false),
        errorAtom: testState.atomValue(""),
        notificationAtom: testState.atomValue(""),
        paletteOverridesAtom: testState.atomValue({}),
        defaultFgOverrideAtom: testState.atomValue(null),
        defaultBgOverrideAtom: testState.atomValue(null),
        cursorColorOverrideAtom: testState.atomValue(null),
        bellTickAtom: testState.atomValue(0),
        commandHistoryAtom: testState.atomValue([]),
        titleAtom: testState.atomValue(""),
        cols: 80,
        setCols: vi.fn(),
        sendResize: vi.fn(),
        sendBytes: testState.sendBytes,
        getMode: () => mode,
        getBlocks: () => ({
            all: () => blocks,
            length: () => blocks.length,
            findById: (id?: string) => blocks.find((block) => block.id === id) ?? null,
        }),
        getFirstAgentSessionPath: () => "",
        submitInput: vi.fn().mockResolvedValue(undefined),
        sendInterrupt: vi.fn(),
        clearSelection: vi.fn(),
        endSelection: vi.fn(),
        copySelection: vi.fn().mockResolvedValue(false),
        toggleFindVisible: vi.fn(),
        toggleSnackbarVisible: vi.fn(),
        selectPreviousBlock: vi.fn(),
        selectNextBlock: vi.fn(),
        setScrollPosition: vi.fn(),
        dispose: vi.fn(),
    };
    testState.lastModel = model;
    return model;
}

function installDocumentStub() {
    testState.documentListeners.clear();
    const documentStub = {
        title: "",
        activeElement: testState.activeElement,
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
    };
    vi.stubGlobal("document", documentStub);
    vi.stubGlobal("window", {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        open: vi.fn(),
    });
}

function dispatchDocumentKeydown(event: {
    key: string;
    target?: { tagName?: string; isContentEditable?: boolean };
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    preventDefault?: () => void;
    stopPropagation?: () => void;
    stopImmediatePropagation?: () => void;
}) {
    const handlers = testState.documentListeners.get("keydown") ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    let stopped = false;
    const keyboardEvent = {
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        stopImmediatePropagation: vi.fn(() => {
            stopped = true;
        }),
        ...event,
    };
    for (const handler of handlers) {
        handler(keyboardEvent);
        if (stopped) break;
    }
}

describe("TerminalView TUI mode", () => {
    beforeEach(() => {
        testState.effectCleanups.length = 0;
        testState.activeElement = null;
        testState.blocks = null;
        testState.modeOverride = null;
        installDocumentStub();
        testState.sendBytes.mockClear();
    });

    afterEach(() => {
        for (const cleanup of testState.effectCleanups.splice(0).reverse()) {
            cleanup();
        }
        testState.documentListeners.clear();
        vi.unstubAllGlobals();
    });

    it("does not render the command input while alternate screen is active", () => {
        const html = renderToStaticMarkup(<TerminalView outerBlockId="outer" />);

        expect(html).not.toContain('data-testid="cmd-input"');
    });

    it("does not render footer spacer or agent activity while alternate screen is active", () => {
        const html = renderToStaticMarkup(<TerminalView outerBlockId="outer" />);

        expect(html).not.toContain('class="mt-2.5"');
        expect(html).not.toContain('data-testid="agent-activity-bar"');
    });

    it("still hides the command input when the active alt-screen block is not the newest block", () => {
        testState.blocks = [
            {
                id: "block-tui",
                state: "done-with-execution",
                altScreen: { active: true },
                commandText: () => "claude",
            },
            {
                id: "block-newer",
                state: "waiting-for-input",
                altScreen: { active: false },
                commandText: () => "",
            },
        ];

        const html = renderToStaticMarkup(<TerminalView outerBlockId="outer" />);

        expect(html).not.toContain('data-testid="cmd-input"');
    });

    it("hides the command input when a running block enters raw TUI capture without alt-screen", () => {
        testState.blocks = [
            {
                id: "block-capture",
                state: "running",
                altScreen: { active: false },
                commandText: () => "claude",
            },
        ];
        testState.modeOverride = { appCursor: true, mouseClick: true };
        const html = renderToStaticMarkup(<TerminalView outerBlockId="outer" />);

        expect(html).not.toContain('data-testid="cmd-input"');
    });

    it("hides the command input when a running block becomes long-running without terminal mode signals", () => {
        testState.blocks = [
            {
                id: "block-long-running",
                state: "running",
                altScreen: { active: false },
                durationMs: () => 51,
                commandText: () => "coco",
            },
        ];
        testState.modeOverride = {};
        const html = renderToStaticMarkup(<TerminalView outerBlockId="outer" />);

        expect(html).not.toContain('data-testid="cmd-input"');
    });

    it("keeps the command input for a newly running block before the long-running threshold", () => {
        testState.blocks = [
            {
                id: "block-short-running",
                state: "running",
                altScreen: { active: false },
                durationMs: () => 50,
                commandText: () => "sleep 10",
            },
            {
                id: "block-newer",
                state: "waiting-for-input",
                altScreen: { active: false },
                durationMs: () => undefined,
                commandText: () => "",
            },
        ];
        testState.modeOverride = {};
        const html = renderToStaticMarkup(<TerminalView outerBlockId="outer" />);

        expect(html).toContain('data-testid="cmd-input"');
    });

    it("forwards ordinary document keydown to the running TUI", () => {
        renderToStaticMarkup(<TerminalView outerBlockId="outer" />);

        dispatchDocumentKeydown({
            key: "x",
            target: { tagName: "DIV", isContentEditable: false },
        });

        expect(testState.sendBytes).toHaveBeenCalledWith("x");
    });

    it("stops same-document global shortcuts after forwarding a TUI key", () => {
        renderToStaticMarkup(<TerminalView outerBlockId="outer" />);

        dispatchDocumentKeydown({
            key: "f",
            ctrlKey: true,
            target: { tagName: "DIV", isContentEditable: false },
        });

        expect(testState.sendBytes).toHaveBeenCalledWith("\x06");
        expect(testState.lastModel?.toggleFindVisible).not.toHaveBeenCalled();
    });

    it("blurs editable focus inside the current terminal root", () => {
        const activeElement = {
            tagName: "TEXTAREA",
            isContentEditable: false,
            blur: vi.fn(),
        } as unknown as HTMLElement;
        testState.activeElement = activeElement;
        installDocumentStub();
        const root = {
            contains: (node: Node | null) => node === activeElement,
        } as unknown as HTMLElement;

        blurActiveEditableInRoot(root);

        expect(activeElement.blur).toHaveBeenCalled();
    });

    it("does not blur editable focus outside the current terminal root", () => {
        const activeElement = {
            tagName: "TEXTAREA",
            isContentEditable: false,
            blur: vi.fn(),
        } as unknown as HTMLElement;
        testState.activeElement = activeElement;
        installDocumentStub();

        renderToStaticMarkup(<TerminalView outerBlockId="outer" />);

        expect(activeElement.blur).not.toHaveBeenCalled();
    });
});
