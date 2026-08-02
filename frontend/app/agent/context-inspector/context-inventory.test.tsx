// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextCategoryItems } from "./context-inventory";

const VirtualizerHarness = vi.hoisted(() => ({
    measure: vi.fn(),
    measureElement: vi.fn(),
    resizeItem: vi.fn(),
    options: undefined as
        | {
              count: number;
              estimateSize: (index: number) => number;
              getItemKey?: (index: number) => string | number;
          }
        | undefined,
    totalSize: undefined as number | undefined,
    visibleIndexes: undefined as number[] | undefined,
    collapsedSizes: new Map<string | number, number>(),
    expandedSizes: new Map<string | number, number>(),
    sizeCache: new Map<string | number, number>(),
}));

vi.mock("@tanstack/react-virtual", () => {
    const keyAt = (index: number) => VirtualizerHarness.options?.getItemKey?.(index) ?? index;
    const sizeAt = (index: number) =>
        VirtualizerHarness.sizeCache.get(keyAt(index)) ?? VirtualizerHarness.options?.estimateSize(index) ?? 0;
    const virtualizer = {
        measure: VirtualizerHarness.measure,
        measureElement: VirtualizerHarness.measureElement,
        resizeItem: VirtualizerHarness.resizeItem,
        getTotalSize: () => {
            if (VirtualizerHarness.totalSize != null) return VirtualizerHarness.totalSize;
            return Array.from({ length: VirtualizerHarness.options?.count ?? 0 }, (_, index) => sizeAt(index)).reduce(
                (total, size) => total + size,
                0
            );
        },
        getVirtualItems: () => {
            const count = VirtualizerHarness.options?.count ?? 0;
            const indexes =
                VirtualizerHarness.visibleIndexes ?? Array.from({ length: Math.min(count, 12) }, (_, index) => index);
            return indexes.map((index) => {
                const size = sizeAt(index);
                const start = Array.from({ length: index }, (_, previousIndex) => sizeAt(previousIndex)).reduce(
                    (total, previousSize) => total + previousSize,
                    0
                );
                return { index, key: keyAt(index), start, size, end: start + size, lane: 0 };
            });
        },
    };
    return {
        useVirtualizer: (options: NonNullable<typeof VirtualizerHarness.options>) => {
            VirtualizerHarness.options = options;
            VirtualizerHarness.measure.mockImplementation(() => VirtualizerHarness.sizeCache.clear());
            VirtualizerHarness.resizeItem.mockImplementation((index: number, size: number) => {
                VirtualizerHarness.sizeCache.set(keyAt(index), size);
            });
            VirtualizerHarness.measureElement.mockImplementation((element?: HTMLElement | null) => {
                if (!element) return;
                const index = Number(element.dataset.index);
                const key = keyAt(index);
                const expanded = element.querySelector("[data-testid^='context-payload-']") != null;
                const size = expanded
                    ? (VirtualizerHarness.expandedSizes.get(key) ?? 500)
                    : (VirtualizerHarness.collapsedSizes.get(key) ?? sizeAt(index));
                VirtualizerHarness.sizeCache.set(key, size);
            });
            return virtualizer;
        },
    };
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    VirtualizerHarness.options = undefined;
    VirtualizerHarness.totalSize = undefined;
    VirtualizerHarness.visibleIndexes = undefined;
    VirtualizerHarness.collapsedSizes.clear();
    VirtualizerHarness.expandedSizes.clear();
    VirtualizerHarness.sizeCache.clear();
});

function turn(index: number): AgentContextSnapshotItemView {
    return {
        id: `turn-${index}`,
        category: "conversation",
        kind: "turn",
        title: `Turn ${index + 1}`,
        preview: `Turn preview ${index + 1}`,
        tokens: 10,
        tokenAccuracy: "estimated",
        source: { entryIds: [`entry-${index}`] },
        children: [
            {
                id: `assistant-${index}`,
                category: "conversation",
                kind: "assistant_message",
                title: `Assistant message ${index + 1}`,
                preview: "Answer with tool activity",
                content: `Full answer ${index + 1}`,
                tokens: 5,
                tokenAccuracy: "estimated",
                source: { toolCallId: `call-${index}`, pairedResultEntryId: `result-${index}` },
            },
        ],
    };
}

function InventoryHarness({
    category,
    items,
}: {
    category: AgentContextSnapshotCategoryView;
    items: AgentContextSnapshotItemView[];
}) {
    const [expandedItemId, setExpandedItemId] = useState<string>();
    return (
        <ContextCategoryItems
            category={category}
            items={items}
            expandedItemId={expandedItemId}
            onToggleItem={(itemId) => setExpandedItemId((current) => (current === itemId ? undefined : itemId))}
        />
    );
}

function payloadValues(): string {
    return screen
        .getAllByTestId("context-payload-line-value")
        .map((element) => element.textContent ?? "")
        .join("\n");
}

describe("ContextCategoryItems", () => {
    it("uses turns as quiet separators and exposes only concrete child disclosures", () => {
        const summary: AgentContextSnapshotItemView = {
            id: "summary",
            category: "conversation",
            kind: "compaction_summary",
            title: "Compacted history",
            preview: "Earlier conversation",
            content: "Complete compacted history",
            tokens: 20,
            tokenAccuracy: "estimated",
            source: { coveredEntryIds: ["entry-1"] },
        };
        render(<InventoryHarness category="conversation" items={[turn(0), summary]} />);

        expect(screen.getByText("Turn 1")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Turn 1" })).toBeNull();
        expect(
            screen.getByRole("button", { name: "Turn 1, Assistant message 1, Answer with tool activity" })
        ).toBeTruthy();
        expect(screen.getByRole("button", { name: "Compacted history, Earlier conversation" })).toBeTruthy();
        expect(screen.queryByText("Turn preview 1")).toBeNull();
    });

    it("renders string payloads verbatim with presentation-only line numbers", () => {
        const content = "  leading whitespace\nsecond <line>\ntrailing whitespace  \n";
        const item: AgentContextSnapshotItemView = {
            ...turn(0).children![0],
            id: "verbatim",
            title: "Verbatim source",
            content,
        };
        render(<InventoryHarness category="agent_instructions" items={[item]} />);

        fireEvent.click(screen.getByRole("button", { name: "Verbatim source, Answer with tool activity" }));

        expect(payloadValues()).toBe(content);
        const lineNumbers = screen.getAllByTestId("context-payload-line-number");
        expect(lineNumbers.map((line) => line.textContent)).toEqual(["1", "2", "3", "4"]);
        for (const lineNumber of lineNumbers) {
            expect(lineNumber.getAttribute("aria-hidden")).toBe("true");
            expect(lineNumber.classList.contains("select-none")).toBe(true);
        }
    });

    it("formats JSON deterministically without exposing provenance", () => {
        const item: AgentContextSnapshotItemView = {
            ...turn(0).children![0],
            id: "json",
            title: "Tool schema",
            content: { name: "read_file", enabled: true, count: 2 },
            source: { entryIds: ["private-entry"], toolCallId: "private-call" },
        };
        render(<InventoryHarness category="tools" items={[item]} />);

        fireEvent.click(screen.getByRole("button", { name: "Tool schema, Answer with tool activity" }));

        expect(payloadValues()).toBe(JSON.stringify(item.content, null, 2));
        expect(screen.queryByText(/private-entry|private-call/)).toBeNull();
        expect(screen.queryByText(/No additional provenance/i)).toBeNull();
        expect(screen.getAllByTestId("context-json-token").length).toBeGreaterThan(0);
    });

    it("shows unavailable instead of falling back to preview when content is missing", () => {
        const item: AgentContextSnapshotItemView = {
            ...turn(0).children![0],
            id: "missing",
            title: "Missing source",
            preview: "This preview is not the payload",
            content: undefined,
        };
        render(<InventoryHarness category="added_context" items={[item]} />);

        fireEvent.click(screen.getByRole("button", { name: "Missing source, This preview is not the payload" }));

        expect(payloadValues()).toBe("Content unavailable.");
        expect(screen.getAllByText("This preview is not the payload")).toHaveLength(1);
    });

    it("keeps a long payload fully mounted in an internally scrolling surface", () => {
        const content = Array.from({ length: 800 }, (_, index) => `line ${index + 1}`).join("\n");
        const item: AgentContextSnapshotItemView = {
            ...turn(0).children![0],
            id: "long",
            title: "Long source",
            content,
        };
        render(<InventoryHarness category="agent_instructions" items={[item]} />);

        fireEvent.click(screen.getByRole("button", { name: "Long source, Answer with tool activity" }));
        const payload = screen.getByTestId("context-payload-long");

        expect(payload.className).toContain("max-h-[min(");
        expect(payload.className).toContain("overflow-auto");
        expect(screen.getAllByTestId("context-payload-line-value")).toHaveLength(800);
        expect(payloadValues()).toContain("line 800");
    });

    it("virtualizes a long Conversation inventory while retaining concrete source rows", () => {
        const items = Array.from({ length: 1_000 }, (_, index) => turn(index));
        render(<InventoryHarness category="conversation" items={items} />);

        expect(screen.getByTestId("context-conversation-items").getAttribute("data-virtualized")).toBe("conversation");
        expect(VirtualizerHarness.options?.count).toBe(1_000);
        expect(VirtualizerHarness.options?.getItemKey?.(999)).toBe("turn-999");
        expect(screen.getByText("Turn 1")).toBeTruthy();
        expect(screen.queryByText("Turn 999")).toBeNull();
        expect(screen.getAllByTestId("context-inventory-item").length).toBeLessThan(100);
    });

    it("updates only the old and new parent rows while preserving unrelated cached heights", () => {
        const items = [turn(0), turn(1), turn(2)];
        VirtualizerHarness.collapsedSizes.set("turn-0", 101);
        VirtualizerHarness.collapsedSizes.set("turn-1", 202);
        VirtualizerHarness.collapsedSizes.set("turn-2", 303);
        VirtualizerHarness.expandedSizes.set("turn-0", 501);
        VirtualizerHarness.expandedSizes.set("turn-1", 602);
        render(<InventoryHarness category="conversation" items={items} />);
        VirtualizerHarness.measure.mockClear();
        VirtualizerHarness.measureElement.mockClear();
        VirtualizerHarness.resizeItem.mockClear();

        fireEvent.click(screen.getByText("Assistant message 1").closest("button")!);

        expect(VirtualizerHarness.measure).not.toHaveBeenCalled();
        expect(VirtualizerHarness.measureElement).toHaveBeenCalledTimes(1);
        expect((VirtualizerHarness.measureElement.mock.calls[0][0] as HTMLElement).dataset.index).toBe("0");
        expect(VirtualizerHarness.sizeCache.get("turn-0")).toBe(501);
        expect(VirtualizerHarness.sizeCache.get("turn-2")).toBe(303);

        VirtualizerHarness.measureElement.mockClear();
        VirtualizerHarness.resizeItem.mockClear();
        fireEvent.click(screen.getByText("Assistant message 2").closest("button")!);

        expect(VirtualizerHarness.measure).not.toHaveBeenCalled();
        expect(VirtualizerHarness.resizeItem).toHaveBeenCalledWith(0, 101);
        expect(VirtualizerHarness.measureElement).toHaveBeenCalledTimes(1);
        expect((VirtualizerHarness.measureElement.mock.calls[0][0] as HTMLElement).dataset.index).toBe("1");
        expect(VirtualizerHarness.sizeCache.get("turn-0")).toBe(101);
        expect(VirtualizerHarness.sizeCache.get("turn-1")).toBe(602);
        expect(VirtualizerHarness.sizeCache.get("turn-2")).toBe(303);
    });

    it("restores the previous row by index when it has scrolled out of the rendered range", () => {
        const items = [turn(0), turn(1), turn(2)];
        VirtualizerHarness.collapsedSizes.set("turn-0", 111);
        VirtualizerHarness.expandedSizes.set("turn-0", 511);
        const view = render(<InventoryHarness category="conversation" items={items} />);
        fireEvent.click(screen.getByText("Assistant message 1").closest("button")!);

        VirtualizerHarness.visibleIndexes = [1, 2];
        view.rerender(<InventoryHarness category="conversation" items={items} />);
        expect(screen.queryByText("Assistant message 1")).toBeNull();
        VirtualizerHarness.resizeItem.mockClear();
        VirtualizerHarness.measureElement.mockClear();

        fireEvent.click(screen.getByText("Assistant message 2").closest("button")!);

        expect(VirtualizerHarness.resizeItem).toHaveBeenCalledWith(0, 111);
        expect(VirtualizerHarness.measureElement).toHaveBeenCalledTimes(1);
        expect((VirtualizerHarness.measureElement.mock.calls[0][0] as HTMLElement).dataset.index).toBe("1");
    });

    it("does not invalidate Conversation sizes when only non-Conversation sources change", () => {
        const items = [turn(0), turn(1)];
        const onToggleItem = vi.fn();
        const view = render(
            <ContextCategoryItems
                category="conversation"
                items={items}
                expandedItemId="instruction-source"
                onToggleItem={onToggleItem}
            />
        );
        VirtualizerHarness.measure.mockClear();
        VirtualizerHarness.measureElement.mockClear();
        VirtualizerHarness.resizeItem.mockClear();

        view.rerender(
            <ContextCategoryItems
                category="conversation"
                items={items}
                expandedItemId="tool-source"
                onToggleItem={onToggleItem}
            />
        );

        expect(VirtualizerHarness.measure).not.toHaveBeenCalled();
        expect(VirtualizerHarness.measureElement).not.toHaveBeenCalled();
        expect(VirtualizerHarness.resizeItem).not.toHaveBeenCalled();
    });

    it("drops saved collapsed sizes for removed ids before an id is reintroduced", () => {
        const original = turn(0);
        const second = turn(1);
        const onToggleItem = vi.fn();
        VirtualizerHarness.collapsedSizes.set(original.id, 111);
        const view = render(
            <ContextCategoryItems
                category="conversation"
                items={[original, second]}
                expandedItemId={undefined}
                onToggleItem={onToggleItem}
            />
        );
        view.rerender(
            <ContextCategoryItems
                category="conversation"
                items={[original, second]}
                expandedItemId={original.children![0].id}
                onToggleItem={onToggleItem}
            />
        );
        view.rerender(
            <ContextCategoryItems
                category="conversation"
                items={[second]}
                expandedItemId="instruction-source"
                onToggleItem={onToggleItem}
            />
        );

        VirtualizerHarness.collapsedSizes.set(original.id, 222);
        VirtualizerHarness.sizeCache.set(original.id, 222);
        view.rerender(
            <ContextCategoryItems
                category="conversation"
                items={[original, second]}
                expandedItemId={original.children![0].id}
                onToggleItem={onToggleItem}
            />
        );
        VirtualizerHarness.resizeItem.mockClear();
        view.rerender(
            <ContextCategoryItems
                category="conversation"
                items={[original, second]}
                expandedItemId="tool-source"
                onToggleItem={onToggleItem}
            />
        );

        expect(VirtualizerHarness.resizeItem).toHaveBeenCalledWith(0, 222);
    });

    it("keeps an offscreen expanded row untouched when the same source survives snapshot reordering", () => {
        const first = turn(0);
        const second = turn(1);
        const third = turn(2);
        const onToggleItem = vi.fn();
        VirtualizerHarness.collapsedSizes.set(first.id, 111);
        VirtualizerHarness.expandedSizes.set(first.id, 511);
        const view = render(
            <ContextCategoryItems
                category="conversation"
                items={[first, second, third]}
                expandedItemId={undefined}
                onToggleItem={onToggleItem}
            />
        );
        view.rerender(
            <ContextCategoryItems
                category="conversation"
                items={[first, second, third]}
                expandedItemId={first.children![0].id}
                onToggleItem={onToggleItem}
            />
        );
        expect(VirtualizerHarness.sizeCache.get(first.id)).toBe(511);

        VirtualizerHarness.visibleIndexes = [0, 2];
        VirtualizerHarness.resizeItem.mockClear();
        VirtualizerHarness.measureElement.mockClear();
        view.rerender(
            <ContextCategoryItems
                category="conversation"
                items={[third, first, second]}
                expandedItemId={first.children![0].id}
                onToggleItem={onToggleItem}
            />
        );

        expect(VirtualizerHarness.resizeItem).not.toHaveBeenCalled();
        expect(VirtualizerHarness.measureElement.mock.calls.filter(([element]) => element != null)).toHaveLength(0);
        expect(VirtualizerHarness.sizeCache.get(first.id)).toBe(511);
    });

    it("invalidates a saved collapsed size when the same turn gains a child", () => {
        const original = turn(0);
        const other = turn(1);
        const updated = {
            ...original,
            children: [
                ...original.children!,
                {
                    ...original.children![0],
                    id: "tool-call-0",
                    kind: "tool_call",
                    title: "Tool call",
                },
            ],
        };
        const onToggleItem = vi.fn();
        VirtualizerHarness.collapsedSizes.set(original.id, 111);
        VirtualizerHarness.expandedSizes.set(original.id, 511);
        const view = render(
            <ContextCategoryItems
                category="conversation"
                items={[original, other]}
                expandedItemId={undefined}
                onToggleItem={onToggleItem}
            />
        );
        view.rerender(
            <ContextCategoryItems
                category="conversation"
                items={[original, other]}
                expandedItemId={original.children![0].id}
                onToggleItem={onToggleItem}
            />
        );

        VirtualizerHarness.visibleIndexes = [1];
        view.rerender(
            <ContextCategoryItems
                category="conversation"
                items={[updated, other]}
                expandedItemId={original.children![0].id}
                onToggleItem={onToggleItem}
            />
        );
        expect(VirtualizerHarness.sizeCache.get(original.id)).toBe(511);

        VirtualizerHarness.resizeItem.mockClear();
        view.rerender(
            <ContextCategoryItems
                category="conversation"
                items={[updated, other]}
                expandedItemId="instruction-source"
                onToggleItem={onToggleItem}
            />
        );

        expect(VirtualizerHarness.resizeItem).toHaveBeenCalledWith(0, 28 + updated.children.length * 48);
    });

    it("remeasures without collapsing when disclosure moves between children of one turn", () => {
        const item = turn(0);
        item.children!.push({
            ...item.children![0],
            id: "tool-result-0",
            kind: "tool_result",
            title: "Tool result",
        });
        const onToggleItem = vi.fn();
        const view = render(
            <ContextCategoryItems
                category="conversation"
                items={[item]}
                expandedItemId={item.children![0].id}
                onToggleItem={onToggleItem}
            />
        );
        VirtualizerHarness.resizeItem.mockClear();
        VirtualizerHarness.measureElement.mockClear();

        view.rerender(
            <ContextCategoryItems
                category="conversation"
                items={[item]}
                expandedItemId={item.children![1].id}
                onToggleItem={onToggleItem}
            />
        );

        expect(VirtualizerHarness.resizeItem).not.toHaveBeenCalled();
        expect(VirtualizerHarness.measureElement).toHaveBeenCalledTimes(1);
        expect((VirtualizerHarness.measureElement.mock.calls[0][0] as HTMLElement).dataset.index).toBe("0");
    });

    it("keys virtual measurements by turn id across snapshot reordering", () => {
        const first = turn(0);
        const second = turn(1);
        const onToggleItem = vi.fn();
        const view = render(
            <ContextCategoryItems
                category="conversation"
                items={[first, second]}
                expandedItemId={undefined}
                onToggleItem={onToggleItem}
            />
        );

        expect(VirtualizerHarness.options?.getItemKey?.(0)).toBe(first.id);
        expect(VirtualizerHarness.options?.getItemKey?.(1)).toBe(second.id);

        view.rerender(
            <ContextCategoryItems
                category="conversation"
                items={[second, first]}
                expandedItemId={undefined}
                onToggleItem={onToggleItem}
            />
        );

        expect(VirtualizerHarness.options?.getItemKey?.(0)).toBe(second.id);
        expect(VirtualizerHarness.options?.getItemKey?.(1)).toBe(first.id);
    });

    it("uses the virtualizer total height without a fixed estimate floor", () => {
        VirtualizerHarness.totalSize = 123;
        const items = Array.from({ length: 1_000 }, (_, index) => turn(index));
        render(<InventoryHarness category="conversation" items={items} />);

        const scrollContainer = screen.getByTestId("context-conversation-items");
        expect((scrollContainer.firstElementChild as HTMLElement).style.height).toBe("123px");
    });

    it("distinguishes repeated Conversation source names by visible preview and turn", () => {
        const first = turn(0);
        const second = turn(1);
        first.children![0] = {
            ...first.children![0],
            title: "Assistant",
            preview: "Same answer preview",
        };
        second.children![0] = {
            ...second.children![0],
            title: "Assistant",
            preview: "Same answer preview",
        };
        render(<InventoryHarness category="conversation" items={[first, second]} />);

        expect(screen.getByRole("button", { name: "Turn 1, Assistant, Same answer preview" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Turn 2, Assistant, Same answer preview" })).toBeTruthy();
    });
});
