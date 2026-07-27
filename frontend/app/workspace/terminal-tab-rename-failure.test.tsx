// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { WaveEnvContext, type WaveEnv } from "@/app/waveenv/waveenv";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalNavigationAdapter } from "./terminal-navigation";
import { TerminalTabList } from "./terminal-tab-list";

const renameTest = vi.hoisted(() => ({
    ensureSubscribed: vi.fn(),
}));

vi.mock("@/app/store/tabcmdstate", async () => {
    const jotai = await vi.importActual<typeof import("jotai")>("jotai");
    const actual = await vi.importActual<typeof import("@/app/store/tabcmdstate")>("@/app/store/tabcmdstate");
    const store = {
        blockCmdStateAtom: jotai.atom(new Map()),
        ensureSubscribed: renameTest.ensureSubscribed,
    };
    return {
        ...actual,
        TabCmdStateStore: {
            getInstance: () => store,
        },
    };
});

vi.mock("@/app/store/global", () => ({
    refocusNode: vi.fn(),
}));

function makeNavigation(overrides: Partial<TerminalNavigationAdapter> = {}): TerminalNavigationAdapter {
    return {
        getTerminalTabIds: () => ["terminal-a", "terminal-b"],
        activate: () => true,
        select: vi.fn(() => true),
        create: vi.fn().mockResolvedValue(undefined),
        rename: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        reorder: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function makeEnv(titles: Record<string, string>): WaveEnv {
    return {
        wos: {
            useWaveObjectValue: (oref: string) => {
                const terminalTabId = oref.slice(oref.indexOf(":") + 1);
                return [
                    {
                        otype: "tab",
                        oid: terminalTabId,
                        version: 1,
                        meta: {},
                        name: titles[terminalTabId],
                        blockids: [],
                        layoutstate: "",
                    },
                    false,
                ];
            },
        },
    } as unknown as WaveEnv;
}

function renderTerminalList(
    titles: Record<string, string>,
    navigation: TerminalNavigationAdapter,
    terminalTabIds = Object.keys(titles),
    activeTerminalTabId = terminalTabIds[0] ?? ""
) {
    return (
        <WaveEnvContext.Provider value={makeEnv(titles)}>
            <TerminalTabList
                terminalTabIds={terminalTabIds}
                activeTerminalTabId={activeTerminalTabId}
                navigation={navigation}
            />
        </WaveEnvContext.Provider>
    );
}

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
        }
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("Terminal tab rename failure", () => {
    it("restores the authoritative title after rejection and still accepts a later WOS title", async () => {
        const rename = vi.fn().mockRejectedValue(new Error("rename rejected"));
        const navigation = makeNavigation({ rename });
        const view = render(renderTerminalList({ "terminal-a": "Build" }, navigation));
        const search = screen.getByRole("searchbox", { name: "Search terminals" });

        fireEvent.doubleClick(screen.getByRole("option", { name: "Build" }));
        const editor = screen.getByRole("textbox", { name: "Tab name" });
        editor.textContent = "Local draft";
        fireEvent.blur(editor);

        await vi.waitFor(() => expect(rename).toHaveBeenCalledWith("terminal-a", "Local draft"));
        await vi.waitFor(() => expect(screen.queryByText("Local draft")).toBeNull());
        expect(screen.getByText("Build")).toBeTruthy();
        expect(screen.getByRole("searchbox", { name: "Search terminals" })).toBe(search);

        view.rerender(renderTerminalList({ "terminal-a": "Server title" }, navigation));
        expect(screen.getByText("Server title")).toBeTruthy();
        expect(screen.queryByText("Build")).toBeNull();
    });

    it("exposes selected Terminal rows to focus and keyboard actions without readonly textbox semantics", async () => {
        const navigation = makeNavigation();
        render(
            renderTerminalList(
                { "terminal-a": "Build", "terminal-b": "Tests" },
                navigation,
                ["terminal-a", "terminal-b"],
                "terminal-b"
            )
        );

        const build = screen.getByRole("option", { name: "Build" });
        const tests = screen.getByRole("option", { name: "Tests" });
        expect(build.getAttribute("aria-selected")).toBe("false");
        expect(build.tabIndex).toBe(-1);
        expect(tests.getAttribute("aria-selected")).toBe("true");
        expect(tests.tabIndex).toBe(0);
        expect(screen.getAllByRole("option").filter((row) => row.tabIndex === 0)).toEqual([tests]);
        expect(screen.queryByRole("textbox", { name: "Tab name" })).toBeNull();
        const options = screen.getByRole("button", { name: "Options for Tests" });
        const close = screen.getByRole("button", { name: "Close Tests" });
        expect(tests.contains(options)).toBe(false);
        expect(tests.contains(close)).toBe(false);
        expect(tests.parentElement?.contains(options)).toBe(true);
        expect(tests.parentElement?.getAttribute("role")).toBeNull();
        expect(tests.draggable).toBe(true);
        expect(options.draggable).toBe(false);

        tests.focus();
        expect(document.activeElement).toBe(tests);
        fireEvent.keyDown(tests, { key: "Enter" });
        fireEvent.keyDown(tests, { key: " " });
        expect(navigation.select).toHaveBeenCalledTimes(2);
        expect(navigation.select).toHaveBeenLastCalledWith("terminal-b");

        fireEvent.keyDown(tests, { key: "ArrowUp" });
        expect(navigation.select).toHaveBeenLastCalledWith("terminal-a");
        expect(document.activeElement).toBe(build);
        expect(build.tabIndex).toBe(0);
        expect(tests.tabIndex).toBe(-1);

        fireEvent.keyDown(build, { key: "F2" });
        expect(screen.getByRole("textbox", { name: "Tab name" })).toBeTruthy();
        expect(screen.queryByRole("option", { name: "Build" })).toBeNull();
        fireEvent.blur(screen.getByRole("textbox", { name: "Tab name" }));

        const restoredBuild = screen.getByRole("option", { name: "Build" });
        fireEvent.keyDown(restoredBuild, { key: "Delete" });
        await vi.waitFor(() => expect(navigation.close).toHaveBeenCalledWith("terminal-a"));
        fireEvent.keyDown(restoredBuild, { key: "ArrowDown", altKey: true });
        await vi.waitFor(() => expect(navigation.reorder).toHaveBeenCalledWith(["terminal-b", "terminal-a"]));
    });

    it("keeps one roving tab stop and Arrow navigation within filtered visible rows", async () => {
        const navigation = makeNavigation();
        render(
            renderTerminalList(
                {
                    "terminal-a": "Build API",
                    "terminal-b": "Build Tests",
                    "terminal-c": "Docs",
                },
                navigation,
                ["terminal-a", "terminal-b", "terminal-c"],
                "terminal-c"
            )
        );

        fireEvent.change(screen.getByRole("searchbox", { name: "Search terminals" }), {
            target: { value: "build" },
        });
        const visibleRows = await screen.findAllByRole("option");
        expect(visibleRows.map((row) => row.getAttribute("aria-label"))).toEqual(["Build API", "Build Tests"]);
        expect(visibleRows.filter((row) => row.tabIndex === 0)).toEqual([visibleRows[0]]);

        visibleRows[0].focus();
        fireEvent.keyDown(visibleRows[0], { key: "ArrowDown" });
        expect(document.activeElement).toBe(visibleRows[1]);
        expect(navigation.select).toHaveBeenLastCalledWith("terminal-b");
        expect(visibleRows[0].tabIndex).toBe(-1);
        expect(visibleRows[1].tabIndex).toBe(0);

        fireEvent.keyDown(visibleRows[1], { key: "Home" });
        expect(document.activeElement).toBe(visibleRows[0]);
        expect(navigation.select).toHaveBeenLastCalledWith("terminal-a");
        fireEvent.keyDown(visibleRows[0], { key: "End" });
        expect(document.activeElement).toBe(visibleRows[1]);
        expect(navigation.select).toHaveBeenLastCalledWith("terminal-b");
    });

    it("preserves list focus and only updates the roving candidate for activation outside the list", () => {
        const navigation = makeNavigation();
        const view = render(
            renderTerminalList(
                {
                    "terminal-a": "Build",
                    "terminal-b": "Tests",
                    "terminal-c": "Docs",
                },
                navigation,
                ["terminal-a", "terminal-b", "terminal-c"],
                "terminal-a"
            )
        );
        const tests = screen.getByRole("option", { name: "Tests" });
        tests.focus();
        expect(document.activeElement).toBe(tests);

        view.rerender(
            renderTerminalList(
                {
                    "terminal-a": "Build",
                    "terminal-b": "Tests",
                    "terminal-c": "Docs",
                },
                navigation,
                ["terminal-a", "terminal-b", "terminal-c"],
                "terminal-c"
            )
        );

        expect(document.activeElement).toBe(tests);
        expect(tests.tabIndex).toBe(0);
        expect(screen.getByRole("option", { name: "Docs" }).tabIndex).toBe(-1);

        const search = screen.getByRole("searchbox", { name: "Search terminals" });
        search.focus();
        view.rerender(
            renderTerminalList(
                {
                    "terminal-a": "Build",
                    "terminal-b": "Tests",
                    "terminal-c": "Docs",
                },
                navigation,
                ["terminal-a", "terminal-b", "terminal-c"],
                "terminal-a"
            )
        );

        expect(document.activeElement).toBe(search);
        expect(screen.getByRole("option", { name: "Build" }).tabIndex).toBe(0);
        expect(tests.tabIndex).toBe(-1);
    });

    it("focuses and selects the remaining fallback when the focused Terminal closes", () => {
        const navigation = makeNavigation();
        const view = render(
            renderTerminalList(
                { "terminal-a": "Build", "terminal-b": "Tests" },
                navigation,
                ["terminal-a", "terminal-b"],
                "terminal-a"
            )
        );
        const build = screen.getByRole("option", { name: "Build" });
        build.focus();

        view.rerender(renderTerminalList({ "terminal-b": "Tests" }, navigation, ["terminal-b"], "terminal-b"));

        const tests = screen.getByRole("option", { name: "Tests" });
        expect(document.activeElement).toBe(tests);
        expect(tests.tabIndex).toBe(0);
        expect(screen.getAllByRole("option").filter((row) => row.tabIndex === 0)).toEqual([tests]);
        expect(navigation.select).toHaveBeenLastCalledWith("terminal-b");

        view.rerender(renderTerminalList({}, navigation, [], ""));
        expect(screen.getByText("No terminals open")).toBeTruthy();
        expect(navigation.select).toHaveBeenCalledTimes(1);
    });

    it("announces an empty search result instead of leaving a blank list", async () => {
        const navigation = makeNavigation();
        render(renderTerminalList({ "terminal-a": "Build", "terminal-b": "Tests" }, navigation));

        fireEvent.change(screen.getByRole("searchbox", { name: "Search terminals" }), {
            target: { value: "build" },
        });
        const filteredRow = await screen.findByRole("option", { name: "Build" });
        fireEvent.keyDown(filteredRow, { key: "ArrowDown", altKey: true });
        expect(navigation.reorder).not.toHaveBeenCalled();

        fireEvent.change(screen.getByRole("searchbox", { name: "Search terminals" }), {
            target: { value: "missing" },
        });

        expect((await screen.findByRole("status")).textContent).toContain("No matching terminals");
        expect(screen.queryByRole("option")).toBeNull();
    });
});
