// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalNavigationAdapter } from "./terminal-navigation";
import { TerminalTabList } from "./terminal-tab-list";

vi.mock("./terminal-tab-row", () => ({
    TerminalTabRow: ({
        terminalTabId,
        title,
        active,
        draggable,
        onSelect,
        onRename,
        onClose,
        onDragStart,
        onDragOver,
        onDrop,
        onDragEnd,
        query,
    }: any) =>
        !query || title.toLocaleLowerCase().includes(query) ? (
            <div
                data-testid={`terminal-row-${terminalTabId}`}
                data-active={active}
                draggable={draggable}
                onClick={onSelect}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDrop={onDrop}
                onDragEnd={onDragEnd}
            >
                <span>{title}</span>
                <button aria-label={`Rename ${title}`} onClick={() => onRename(`${title} renamed`)}>
                    Rename
                </button>
                <button aria-label={`Close ${title}`} onClick={onClose}>
                    Close
                </button>
            </div>
        ) : null,
}));

function makeNavigation(overrides: Partial<TerminalNavigationAdapter> = {}): TerminalNavigationAdapter {
    return {
        getTerminalTabIds: vi.fn(() => ["terminal-a", "terminal-b"]),
        activate: vi.fn(() => true),
        select: vi.fn(() => true),
        create: vi.fn().mockResolvedValue(undefined),
        rename: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        reorder: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function makeDataTransfer() {
    const values = new Map<string, string>();
    return {
        effectAllowed: "",
        dropEffect: "",
        setData: (type: string, value: string) => values.set(type, value),
        getData: (type: string) => values.get(type) ?? "",
    };
}

const rows = [
    { id: "terminal-a", title: "Build", runningKind: "codex" as const },
    { id: "non-terminal", title: "README.md" },
    { id: "terminal-b", title: "Tests" },
];

afterEach(cleanup);

describe("TerminalTabList", () => {
    it("renders only the authoritative Terminal ids and selects through the navigation adapter", () => {
        const navigation = makeNavigation();

        render(
            <TerminalTabList
                terminalTabIds={["terminal-a", "terminal-b"]}
                activeTerminalTabId="terminal-a"
                rows={rows}
                navigation={navigation}
            />
        );

        expect(screen.getByText("Build")).toBeTruthy();
        expect(screen.getByText("Tests")).toBeTruthy();
        expect(screen.queryByText("README.md")).toBeNull();
        fireEvent.click(screen.getByText("Tests"));
        expect(navigation.select).toHaveBeenCalledWith("terminal-b");
    });

    it("supports new, rename, close, and exact same-group reorder", async () => {
        const navigation = makeNavigation();
        render(
            <TerminalTabList
                terminalTabIds={["terminal-a", "terminal-b"]}
                activeTerminalTabId="terminal-a"
                rows={rows}
                navigation={navigation}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "New Terminal" }));
        fireEvent.click(screen.getByRole("button", { name: "Rename Build" }));
        fireEvent.click(screen.getByRole("button", { name: "Close Tests" }));
        expect(navigation.create).toHaveBeenCalledOnce();
        expect(navigation.rename).toHaveBeenCalledWith("terminal-a", "Build renamed");
        expect(navigation.close).toHaveBeenCalledWith("terminal-b");

        const dataTransfer = makeDataTransfer();
        fireEvent.dragStart(screen.getByTestId("terminal-row-terminal-a"), { dataTransfer });
        fireEvent.dragOver(screen.getByTestId("terminal-row-terminal-b"), { dataTransfer });
        fireEvent.drop(screen.getByTestId("terminal-row-terminal-b"), { dataTransfer });

        await vi.waitFor(() => expect(navigation.reorder).toHaveBeenCalledWith(["terminal-b", "terminal-a"]));
    });

    it("disables reorder while search filters the list", () => {
        const navigation = makeNavigation();
        render(
            <TerminalTabList
                terminalTabIds={["terminal-a", "terminal-b"]}
                activeTerminalTabId="terminal-a"
                rows={rows}
                navigation={navigation}
            />
        );

        fireEvent.change(screen.getByRole("searchbox", { name: "Search terminals" }), {
            target: { value: "build" },
        });
        expect(screen.getByText("Build")).toBeTruthy();
        expect(screen.queryByText("Tests")).toBeNull();

        const dataTransfer = makeDataTransfer();
        fireEvent.dragStart(screen.getByTestId("terminal-row-terminal-a"), { dataTransfer });
        expect(navigation.reorder).not.toHaveBeenCalled();
    });

    it("shows the New Terminal empty state after the final close", () => {
        const navigation = makeNavigation();
        const view = render(
            <TerminalTabList
                terminalTabIds={["terminal-a"]}
                activeTerminalTabId="terminal-a"
                rows={rows}
                navigation={navigation}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "Close Build" }));
        view.rerender(<TerminalTabList terminalTabIds={[]} activeTerminalTabId="" rows={[]} navigation={navigation} />);

        expect(screen.getByText("No terminals open")).toBeTruthy();
        expect(screen.getByRole("button", { name: "New Terminal" })).toBeTruthy();
    });

    it("reports failed create and close mutations with their specific error messages", async () => {
        const navigation = makeNavigation({
            create: vi.fn().mockRejectedValue(new Error("Terminal creation was rejected")),
            close: vi.fn().mockRejectedValue("Terminal close was rejected"),
        });
        render(
            <TerminalTabList
                terminalTabIds={["terminal-a", "terminal-b"]}
                activeTerminalTabId="terminal-a"
                rows={rows}
                navigation={navigation}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "New Terminal" }));
        expect((await screen.findByRole("alert")).textContent).toBe("Terminal creation was rejected");

        fireEvent.click(screen.getByRole("button", { name: "Close Build" }));
        expect((await screen.findByRole("alert")).textContent).toBe("Terminal close was rejected");
    });

    it("clears an old mutation error when the next mutation starts and keeps it clear after success", async () => {
        let resolveCreate: () => void;
        const secondCreate = new Promise<void>((resolve) => {
            resolveCreate = resolve;
        });
        const navigation = makeNavigation({
            create: vi
                .fn()
                .mockRejectedValueOnce(new Error("Terminal creation was rejected"))
                .mockImplementationOnce(() => secondCreate),
        });
        render(
            <TerminalTabList
                terminalTabIds={["terminal-a", "terminal-b"]}
                activeTerminalTabId="terminal-a"
                rows={rows}
                navigation={navigation}
            />
        );

        const createButton = screen.getByRole("button", { name: "New Terminal" });
        fireEvent.click(createButton);
        expect((await screen.findByRole("alert")).textContent).toBe("Terminal creation was rejected");

        fireEvent.click(createButton);
        expect(screen.queryByRole("alert")).toBeNull();

        resolveCreate!();
        await secondCreate;
        expect(navigation.create).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("ignores an older mutation failure after a newer mutation succeeds", async () => {
        let rejectFirstCreate: (error: Error) => void;
        const firstCreate = new Promise<void>((_resolve, reject) => {
            rejectFirstCreate = reject;
        });
        const navigation = makeNavigation({
            create: vi
                .fn()
                .mockImplementationOnce(() => firstCreate)
                .mockResolvedValueOnce(undefined),
        });
        render(
            <TerminalTabList
                terminalTabIds={["terminal-a", "terminal-b"]}
                activeTerminalTabId="terminal-a"
                rows={rows}
                navigation={navigation}
            />
        );

        const createButton = screen.getByRole("button", { name: "New Terminal" });
        fireEvent.click(createButton);
        fireEvent.click(createButton);
        await act(async () => {
            rejectFirstCreate!(new Error("Stale terminal creation failure"));
            await firstCreate.catch(() => undefined);
        });

        expect(navigation.create).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("recovers the displayed order from the latest authoritative ids after a failed reorder", async () => {
        const navigation = makeNavigation({
            reorder: vi.fn().mockRejectedValue(new Error("rejected")),
        });
        render(
            <TerminalTabList
                terminalTabIds={["terminal-a", "terminal-b"]}
                activeTerminalTabId="terminal-a"
                rows={rows}
                navigation={navigation}
            />
        );

        const list = screen.getByTestId("terminal-tab-rows");
        const dataTransfer = makeDataTransfer();
        fireEvent.dragStart(screen.getByTestId("terminal-row-terminal-a"), { dataTransfer });
        fireEvent.drop(screen.getByTestId("terminal-row-terminal-b"), { dataTransfer });

        await vi.waitFor(() => {
            const visibleTitles = within(list)
                .getAllByTestId(/terminal-row-/)
                .map((row) => row.querySelector("span")?.textContent);
            expect(visibleTitles).toEqual(["Build", "Tests"]);
        });
    });

    it("does not expose pane sidecars or non-Terminal projections", () => {
        render(
            <TerminalTabList
                terminalTabIds={["terminal-a"]}
                activeTerminalTabId="terminal-a"
                rows={rows}
                navigation={makeNavigation()}
            />
        );

        expect(screen.queryByTestId("vtab-detail-sidecar")).toBeNull();
        expect(screen.queryByText("README.md")).toBeNull();
    });
});
