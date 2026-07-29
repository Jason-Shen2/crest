// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RewindSelector, type RewindSelectorProps } from "./rewind-selector";

function makePoint(
    turnId: string,
    preview: string,
    overrides: Partial<AgentRewindPointView> = {}
): AgentRewindPointView {
    return {
        turnId,
        preview,
        eligible: true,
        ...overrides,
    };
}

function renderSelector(overrides: Partial<RewindSelectorProps> = {}) {
    const props: RewindSelectorProps = {
        open: true,
        points: [],
        loading: false,
        onSelect: vi.fn(),
        onClose: vi.fn(),
        ...overrides,
    };
    return { ...render(<RewindSelector {...props} />), props };
}

beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: vi.fn(),
    });
});

afterEach(cleanup);

describe("RewindSelector", () => {
    it.each([
        {
            name: "loading",
            props: { points: [makePoint("turn-1", "Stale point")], loading: true },
        },
        {
            name: "error",
            props: {
                points: [makePoint("turn-1", "Stale point")],
                loading: false,
                errorMessage: "Rewind history unavailable",
            },
        },
        {
            name: "empty",
            props: { points: [], loading: false },
        },
        {
            name: "all unavailable",
            props: {
                points: [makePoint("turn-1", "Unavailable", { eligible: false, reason: "checkpoint missing" })],
                loading: false,
            },
        },
    ])("focuses the listbox and keeps Escape available in the $name state", async ({ props: stateProps }) => {
        const onClose = vi.fn();
        renderSelector({ ...stateProps, onClose });

        const listbox = screen.getByRole("listbox", { name: "Rewind point options" });
        await waitFor(() => expect(document.activeElement).toBe(listbox));
        expect(listbox.getAttribute("tabindex")).toBe("-1");
        fireEvent.keyDown(listbox, { key: "Escape" });

        expect(onClose).toHaveBeenCalledOnce();
    });

    it("renders nothing while closed and distinct loading, error, empty, and no-match states", () => {
        const { rerender } = render(
            <RewindSelector open={false} points={[]} loading onSelect={vi.fn()} onClose={vi.fn()} />
        );
        expect(screen.queryByRole("group", { name: "Rewind points" })).toBeNull();

        rerender(<RewindSelector open points={[]} loading onSelect={vi.fn()} onClose={vi.fn()} />);
        expect(screen.getByText("Loading rewind points…")).not.toBeNull();

        rerender(
            <RewindSelector
                open
                points={[]}
                loading={false}
                errorMessage="Rewind history unavailable"
                onSelect={vi.fn()}
                onClose={vi.fn()}
            />
        );
        expect(screen.getByRole("alert").textContent).toContain("Rewind history unavailable");

        rerender(<RewindSelector open points={[]} loading={false} onSelect={vi.fn()} onClose={vi.fn()} />);
        expect(screen.getByText("No rewind points available.")).not.toBeNull();

        rerender(
            <RewindSelector
                open
                points={[makePoint("turn-1", "Implement parser")]}
                loading={false}
                onSelect={vi.fn()}
                onClose={vi.fn()}
            />
        );
        fireEvent.change(screen.getByRole("combobox", { name: "Search rewind points" }), {
            target: { value: "missing" },
        });
        expect(screen.getByText("No matching rewind points.")).not.toBeNull();
    });

    it("filters by prompt preview and resets to the most recent eligible match", async () => {
        renderSelector({
            points: [
                makePoint("turn-1", "Fix parser"),
                makePoint("turn-2", "Add renderer tests"),
                makePoint("turn-3", "Renderer follow-up"),
            ],
        });

        const search = screen.getByRole("combobox", { name: "Search rewind points" });
        fireEvent.change(search, { target: { value: "renderer" } });

        expect(screen.queryByRole("option", { name: /Fix parser/ })).toBeNull();
        expect(screen.getByRole("option", { name: /Add renderer tests/ })).not.toBeNull();
        const latest = screen.getByRole("option", { name: /Renderer follow-up/ });
        await waitFor(() => expect(latest.getAttribute("aria-selected")).toBe("true"));
    });

    it("does not steal focus when a search transitions from no matches back to matches", async () => {
        renderSelector({
            points: [makePoint("turn-1", "Fix parser")],
        });

        await waitFor(() =>
            expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Rewind point options" }))
        );
        const search = screen.getByRole("combobox", { name: "Search rewind points" });
        search.focus();
        fireEvent.change(search, { target: { value: "missing" } });
        fireEvent.change(search, { target: { value: "parser" } });

        await waitFor(() => expect(screen.getByRole("option", { name: /Fix parser/ })).not.toBeNull());
        expect(document.activeElement).toBe(search);
    });

    it("does not commit stale points while loading or showing an error", () => {
        const onSelect = vi.fn();
        const point = makePoint("turn-1", "Stale point");
        const { rerender } = render(
            <RewindSelector open points={[point]} loading onSelect={onSelect} onClose={vi.fn()} />
        );
        const listbox = screen.getByRole("listbox", { name: "Rewind point options" });

        fireEvent.keyDown(listbox, { key: "Enter" });
        rerender(
            <RewindSelector
                open
                points={[point]}
                loading={false}
                errorMessage="Rewind history unavailable"
                onSelect={onSelect}
                onClose={vi.fn()}
            />
        );
        fireEvent.keyDown(screen.getByRole("listbox", { name: "Rewind point options" }), { key: "Enter" });

        expect(onSelect).not.toHaveBeenCalled();
    });

    it("initially highlights the most recent eligible point and skips unavailable rows with the keyboard", async () => {
        const onSelect = vi.fn();
        renderSelector({
            onSelect,
            points: [
                makePoint("turn-1", "First eligible"),
                makePoint("turn-2", "Most recent eligible"),
                makePoint("turn-3", "Checkpoint unavailable", {
                    eligible: false,
                    reason: "workspace checkpoint was not captured",
                }),
            ],
        });

        const first = screen.getByRole("option", { name: /First eligible/ });
        const latest = screen.getByRole("option", { name: /Most recent eligible/ });
        const unavailable = screen.getByRole("option", { name: /Checkpoint unavailable/ });
        const listbox = screen.getByRole("listbox", { name: "Rewind point options" });

        await waitFor(() => expect(latest.getAttribute("aria-selected")).toBe("true"));
        expect(listbox.getAttribute("aria-activedescendant")).toBe(latest.id);
        expect(unavailable.getAttribute("aria-disabled")).toBe("true");
        expect(unavailable.textContent).toContain("workspace checkpoint was not captured");

        fireEvent.keyDown(listbox, { key: "ArrowUp" });
        expect(first.getAttribute("aria-selected")).toBe("true");
        expect(listbox.getAttribute("aria-activedescendant")).toBe(first.id);
        fireEvent.keyDown(listbox, { key: "ArrowDown" });
        expect(latest.getAttribute("aria-selected")).toBe("true");
        expect(listbox.getAttribute("aria-activedescendant")).toBe(latest.id);
        fireEvent.keyDown(listbox, { key: "ArrowDown" });
        expect(first.getAttribute("aria-selected")).toBe("true");

        fireEvent.click(unavailable);
        expect(onSelect).not.toHaveBeenCalled();
    });

    it("Enter and click only request selection of an eligible turn", async () => {
        const onSelect = vi.fn();
        renderSelector({
            onSelect,
            points: [makePoint("turn-1", "Earlier"), makePoint("turn-2", "Latest")],
        });

        const listbox = screen.getByRole("listbox", { name: "Rewind point options" });
        const latest = screen.getByRole("option", { name: /Latest/ });
        await waitFor(() => expect(latest.getAttribute("aria-selected")).toBe("true"));

        fireEvent.keyDown(listbox, { key: "Enter" });
        expect(onSelect).toHaveBeenLastCalledWith("turn-2");

        fireEvent.click(screen.getByRole("option", { name: /Earlier/ }));
        expect(onSelect).toHaveBeenLastCalledWith("turn-1");
        expect(onSelect).toHaveBeenCalledTimes(2);
    });

    it("clears search on the first Escape and closes on the second", () => {
        const onClose = vi.fn();
        renderSelector({
            onClose,
            points: [makePoint("turn-1", "Fix parser")],
        });
        const search = screen.getByRole("combobox", { name: "Search rewind points" });

        fireEvent.change(search, { target: { value: "parser" } });
        fireEvent.keyDown(search, { key: "Escape" });
        expect((search as HTMLInputElement).value).toBe("");
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(search, { key: "Escape" });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("drops the previous active turn when controlled points switch sessions", async () => {
        const onSelect = vi.fn();
        const { rerender } = render(
            <RewindSelector
                open
                points={[makePoint("turn-a", "Session A")]}
                loading={false}
                onSelect={onSelect}
                onClose={vi.fn()}
            />
        );

        rerender(
            <RewindSelector
                open
                points={[makePoint("turn-b", "Session B")]}
                loading={false}
                onSelect={onSelect}
                onClose={vi.fn()}
            />
        );
        const current = screen.getByRole("option", { name: /Session B/ });
        await waitFor(() => expect(current.getAttribute("aria-selected")).toBe("true"));
        fireEvent.keyDown(screen.getByRole("listbox", { name: "Rewind point options" }), { key: "Enter" });

        expect(onSelect).toHaveBeenCalledOnce();
        expect(onSelect).toHaveBeenCalledWith("turn-b");
    });

    it("uses unique option ids across simultaneous agent surfaces", async () => {
        render(
            <>
                <RewindSelector
                    open
                    points={[makePoint("turn-a", "Surface A")]}
                    loading={false}
                    onSelect={vi.fn()}
                    onClose={vi.fn()}
                />
                <RewindSelector
                    open
                    points={[makePoint("turn-b", "Surface B")]}
                    loading={false}
                    onSelect={vi.fn()}
                    onClose={vi.fn()}
                />
            </>
        );

        const [first, second] = screen.getAllByRole("listbox", { name: "Rewind point options" });
        const [firstSearch, secondSearch] = screen.getAllByRole("combobox", { name: "Search rewind points" });
        await waitFor(() => expect(firstSearch.getAttribute("aria-activedescendant")).toBeTruthy());
        const firstOptionId = firstSearch.getAttribute("aria-activedescendant");
        const secondOptionId = secondSearch.getAttribute("aria-activedescendant");

        expect(firstOptionId).not.toBe(secondOptionId);
        expect(first.contains(document.getElementById(firstOptionId!))).toBe(true);
        expect(second.contains(document.getElementById(secondOptionId!))).toBe(true);
        expect(firstSearch.getAttribute("aria-controls")).toBe(first.id);
        expect(secondSearch.getAttribute("aria-controls")).toBe(second.id);
    });

    it("moves focus to the combobox with slash and keeps arrow announcements in sync", async () => {
        renderSelector({
            points: [makePoint("turn-1", "Earlier"), makePoint("turn-2", "Latest")],
        });
        const listbox = screen.getByRole("listbox", { name: "Rewind point options" });
        const search = screen.getByRole("combobox", { name: "Search rewind points" });
        const earlier = screen.getByRole("option", { name: /Earlier/ });
        const latest = screen.getByRole("option", { name: /Latest/ });

        await waitFor(() => expect(document.activeElement).toBe(listbox));
        expect(listbox.getAttribute("aria-activedescendant")).toBe(latest.id);
        fireEvent.keyDown(listbox, { key: "/" });
        expect(document.activeElement).toBe(search);
        expect(search.getAttribute("aria-controls")).toBe(listbox.id);
        expect(search.getAttribute("aria-activedescendant")).toBe(latest.id);

        fireEvent.keyDown(search, { key: "ArrowUp" });
        expect(search.getAttribute("aria-activedescendant")).toBe(earlier.id);
    });
});
