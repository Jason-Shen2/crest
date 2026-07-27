// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    settings: new Map<string, unknown>(),
}));

vi.mock("@/store/global", () => ({
    getApi: () => ({ openExternal: vi.fn() }),
    getSettingsKeyAtom: (key: string) => key,
    globalStore: { get: (key: string) => mocks.settings.get(key) },
}));

import {
    configureRendererPool,
    evictionScore,
    snapshotScrollbackCap,
    type Slot,
    type SlotAdapter,
} from "./renderer-pool";

function makeAdapter(overrides: Partial<SlotAdapter> = {}): SlotAdapter {
    return {
        resolveLeaf: () => null,
        evictLeaf: () => {},
        isLeafFocused: () => false,
        isLeafBlocks: () => false,
        isLeafBusy: () => false,
        isLeafVisible: () => false,
        storeSnapshot: () => {},
        ...overrides,
    };
}

function makeSlot(partial: Partial<Slot> = {}): Slot {
    return {
        currentLeafId: 1,
        lastUsedAt: 0,
        term: { buffer: { active: { type: "normal" } } },
        ...partial,
    } as unknown as Slot;
}

describe("evictionScore", () => {
    beforeEach(() => {
        mocks.settings.clear();
        configureRendererPool(makeAdapter());
    });

    it("scores an unbound idle slot by recency only", () => {
        configureRendererPool(
            makeAdapter({ isLeafVisible: () => true, isLeafBusy: () => true, isLeafFocused: () => true })
        );
        const slot = makeSlot({ currentLeafId: null, lastUsedAt: 1e9 });
        expect(evictionScore(slot)).toBeCloseTo(1e9 / 1e12, 9);
    });

    it("weights visible above every other flag combined", () => {
        configureRendererPool(
            makeAdapter({
                isLeafVisible: (id) => id === 1,
                isLeafBusy: (id) => id === 2,
                isLeafBlocks: (id) => id === 2,
                isLeafFocused: (id) => id === 2,
            })
        );
        const visibleOnly = makeSlot({ currentLeafId: 1 });
        const altBusyBlocksFocused = makeSlot({
            currentLeafId: 2,
            term: { buffer: { active: { type: "alternate" } } },
        } as unknown as Partial<Slot>);
        expect(evictionScore(visibleOnly)).toBeGreaterThan(evictionScore(altBusyBlocksFocused));
    });

    it("orders alt-screen > busy > blocks > focused", () => {
        configureRendererPool(
            makeAdapter({
                isLeafBusy: (id) => id === 2,
                isLeafBlocks: (id) => id === 3,
                isLeafFocused: (id) => id === 4,
            })
        );
        const alt = makeSlot({
            currentLeafId: 1,
            term: { buffer: { active: { type: "alternate" } } },
        } as unknown as Partial<Slot>);
        const busy = makeSlot({ currentLeafId: 2 });
        const blocks = makeSlot({ currentLeafId: 3 });
        const focused = makeSlot({ currentLeafId: 4 });
        const altScore = evictionScore(alt);
        const busyScore = evictionScore(busy);
        const blocksScore = evictionScore(blocks);
        const focusedScore = evictionScore(focused);
        expect(altScore).toBeGreaterThan(busyScore);
        expect(busyScore).toBeGreaterThan(blocksScore);
        expect(blocksScore).toBeGreaterThan(focusedScore);
        expect(focusedScore).toBeGreaterThan(0);
    });

    it("breaks ties by recency without overriding any flag", () => {
        const older = makeSlot({ currentLeafId: 1, lastUsedAt: 0 });
        const newer = makeSlot({ currentLeafId: 2, lastUsedAt: 1e9 });
        expect(evictionScore(newer)).toBeGreaterThan(evictionScore(older));
        // Recency contribution stays far below the smallest flag weight (10).
        expect(evictionScore(newer) - evictionScore(older)).toBeLessThan(1);
    });

    it("treats a buffer that throws as not alt-screen", () => {
        const term = {
            get buffer(): never {
                throw new Error("disposed");
            },
        };
        const slot = makeSlot({ currentLeafId: 1, term } as unknown as Partial<Slot>);
        expect(evictionScore(slot)).toBe(0);
    });
});

describe("snapshotScrollbackCap", () => {
    beforeEach(() => {
        mocks.settings.clear();
    });

    it("caps a large configured scrollback at 5000", () => {
        mocks.settings.set("term:scrollback", 50000);
        expect(snapshotScrollbackCap()).toBe(5000);
    });

    it("uses the configured scrollback when below the cap", () => {
        mocks.settings.set("term:scrollback", 100);
        expect(snapshotScrollbackCap()).toBe(100);
    });

    it("falls back to the default scrollback when unset", () => {
        expect(snapshotScrollbackCap()).toBe(2000);
    });
});
