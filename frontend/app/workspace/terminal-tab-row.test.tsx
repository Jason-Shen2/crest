// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalTabRow } from "./terminal-tab-row";

const rowTest = vi.hoisted(() => ({
    menu: null as ContextMenuItem[] | null,
    getTabRunningKind: vi.fn(() => "codex"),
    ensureSubscribed: vi.fn(),
}));

vi.mock("@/app/waveenv/waveenv", () => ({
    useWaveEnv: () => ({
        wos: {
            useWaveObjectValue: () => [
                {
                    oid: "terminal-a",
                    name: "Build",
                    blockids: ["block-a"],
                },
                false,
            ],
        },
    }),
}));

vi.mock("@/app/store/tabcmdstate", async () => {
    const jotai = await vi.importActual<typeof import("jotai")>("jotai");
    const store = {
        blockCmdStateAtom: jotai.atom(new Map()),
        ensureSubscribed: rowTest.ensureSubscribed,
    };
    return {
        TabCmdStateStore: {
            getInstance: () => store,
        },
        getTabRunningKind: rowTest.getTabRunningKind,
    };
});

vi.mock("@/app/store/contextmenu", () => ({
    ContextMenuModel: {
        getInstance: () => ({
            showContextMenu: (menu: ContextMenuItem[]) => {
                rowTest.menu = menu;
            },
        }),
    },
}));

vi.mock("@/app/tab/vtab", () => ({
    VTab: (props: any) => {
        useEffect(() => {
            props.renameRef.current = () => props.onRename("Renamed");
        }, [props.onRename, props.renameRef]);
        return (
            <div
                data-testid="vtab"
                data-running-kind={props.tab.runningKind}
                data-draggable={props.draggable}
                onContextMenu={props.onContextMenu}
            >
                {props.tab.name}
            </div>
        );
    },
}));

afterEach(() => {
    cleanup();
    rowTest.menu = null;
    vi.clearAllMocks();
});

describe("TerminalTabRow", () => {
    it("projects only title and runtime status into VTab and uses the shared context menu model", () => {
        const onRename = vi.fn();
        const onClose = vi.fn();
        const onMoveUp = vi.fn();
        const onMoveDown = vi.fn();

        render(
            <TerminalTabRow
                terminalTabId="terminal-a"
                active
                tabIndex={0}
                query=""
                draggable
                isDragging={false}
                onSelect={vi.fn()}
                onFocus={vi.fn()}
                onNavigate={vi.fn()}
                onRename={onRename}
                onClose={onClose}
                onMoveUp={onMoveUp}
                onMoveDown={onMoveDown}
                onDragStart={vi.fn()}
                onDragOver={vi.fn()}
                onDrop={vi.fn()}
                onDragEnd={vi.fn()}
                selectionRef={vi.fn()}
            />
        );

        expect(screen.getByText("Build").getAttribute("data-running-kind")).toBe("codex");
        expect(rowTest.getTabRunningKind).toHaveBeenCalledWith(["block-a"], expect.any(Map));
        expect(rowTest.ensureSubscribed).toHaveBeenCalledOnce();

        fireEvent.contextMenu(screen.getByTestId("vtab"));
        expect(rowTest.menu?.map((item) => item.label ?? item.type)).toEqual([
            "Rename",
            "Move Up",
            "Move Down",
            "separator",
            "Close",
        ]);
        rowTest.menu?.[0].click?.();
        rowTest.menu?.[1].click?.();
        rowTest.menu?.[2].click?.();
        rowTest.menu?.[4].click?.();
        expect(onRename).toHaveBeenCalledWith("Renamed");
        expect(onMoveUp).toHaveBeenCalledOnce();
        expect(onMoveDown).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("marks the reused VTab as non-draggable while a search is active", () => {
        render(
            <TerminalTabRow
                terminalTabId="terminal-a"
                active={false}
                tabIndex={-1}
                query="build"
                draggable={false}
                isDragging={false}
                onSelect={vi.fn()}
                onFocus={vi.fn()}
                onNavigate={vi.fn()}
                onRename={vi.fn()}
                onClose={vi.fn()}
                onDragStart={vi.fn()}
                onDragOver={vi.fn()}
                onDrop={vi.fn()}
                onDragEnd={vi.fn()}
                selectionRef={vi.fn()}
            />
        );

        expect(screen.getByTestId("vtab").getAttribute("data-draggable")).toBe("false");
    });
});
