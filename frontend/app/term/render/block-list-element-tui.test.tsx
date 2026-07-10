// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DefaultTermMode } from "../engine/types";
import { BlockListElement } from "./block-list-element";

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

vi.mock("./block-element", () => ({
    BlockElement: () => <div data-testid="block-element" />,
}));

vi.mock("@/app/element/ui-icon", () => ({
    UIcon: () => <span data-testid="ui-icon" />,
}));

const atomValue = <T,>(value: T) => ({ read: () => value });

function makeActiveTuiBlock() {
    return {
        id: "block-1",
        kind: "shell",
        hidden: false,
        state: "running",
        isBackground: false,
        isStatic: false,
        altScreen: { active: true },
        commandText: () => "vim",
    };
}

function makeModel(
    block: ReturnType<typeof makeActiveTuiBlock>,
    activeSurfaceState: { kind: string; blockId: string } | null = block.altScreen.active
        ? { kind: "alt-screen", blockId: block.id }
        : null
) {
    return {
        revisionAtom: atomValue(1),
        scrollPositionAtom: atomValue({ kind: "follow-bottom" }),
        selectedBlockIdAtom: atomValue(""),
        selectionAtom: atomValue(null),
        findMatchesAtom: atomValue([]),
        findCurrentIndexAtom: atomValue(-1),
        snackbarVisibleAtom: atomValue(true),
        getBlocks: () => ({
            all: () => [block],
            indexOf: () => 0,
        }),
        getActiveSurfaceState: () => activeSurfaceState,
        getMode: () => ({
            appCursor: false,
            focusReport: false,
            mouseX10: false,
            mouseClick: false,
            mouseButton: false,
            mouseMotion: false,
            mouseSgr: false,
            mouseUtf8: false,
            mouseUrxvt: false,
            alternateScroll: false,
        }),
        clearSelection: vi.fn(),
        selectBlock: vi.fn(),
        setScrollPosition: vi.fn(),
    };
}

describe("BlockListElement TUI layout", () => {
    it("lets the active TUI block wrapper flex-fill the pane", () => {
        const html = renderToStaticMarkup(<BlockListElement model={makeModel(makeActiveTuiBlock()) as any} />);

        expect(html).toMatch(/data-block-oid="block-1"[^>]*class="[^"]*flex-1/);
        expect(html).toMatch(/data-block-oid="block-1"[^>]*class="[^"]*min-h-0/);
    });

    it("lets a running raw-capture TUI block wrapper flex-fill the pane", () => {
        const html = renderToStaticMarkup(
            <BlockListElement
                model={
                    {
                        ...makeModel(
                            {
                                id: "block-raw",
                                kind: "shell",
                                hidden: false,
                                state: "running",
                                isBackground: false,
                                isStatic: false,
                                altScreen: { active: false },
                                commandText: () => "claude",
                            } as any,
                            { kind: "terminal-capture", blockId: "block-raw" }
                        ),
                        getMode: () => ({
                            appCursor: true,
                            focusReport: false,
                            mouseX10: false,
                            mouseClick: true,
                            mouseButton: false,
                            mouseMotion: false,
                            mouseSgr: false,
                            mouseUtf8: false,
                            mouseUrxvt: false,
                            alternateScroll: false,
                        }),
                    } as any
                }
            />
        );

        expect(html).toMatch(/data-block-oid="block-raw"[^>]*class="[^"]*flex-1/);
        expect(html).toMatch(/data-block-oid="block-raw"[^>]*class="[^"]*min-h-0/);
    });

    it("lets the active surface wrapper flex-fill the pane from TerminalSurfaceState", () => {
        const html = renderToStaticMarkup(
            <BlockListElement
                model={
                    {
                        ...makeModel(
                            {
                                id: "block-surface",
                                kind: "shell",
                                hidden: false,
                                state: "running",
                                isBackground: false,
                                isStatic: false,
                                altScreen: { active: false },
                                commandText: () => "coco",
                            } as any,
                            { kind: "long-running-pty", blockId: "block-surface" }
                        ),
                        getMode: () => DefaultTermMode,
                    } as any
                }
            />
        );

        expect(html).toMatch(/data-block-oid="block-surface"[^>]*class="[^"]*flex-1/);
        expect(html).toMatch(/data-block-oid="block-surface"[^>]*class="[^"]*min-h-0/);
    });
});
