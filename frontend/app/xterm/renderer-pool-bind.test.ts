// @vitest-environment jsdom

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    events: [] as string[],
    deferWrites: false,
    evicted: [] as number[],
    snapshots: [] as Array<{ leafId: number; snapshot: string | null }>,
}));

vi.mock("@/store/global", () => ({
    getApi: () => ({ openExternal: vi.fn() }),
    getSettingsKeyAtom: (key: string) => key,
    globalStore: { get: () => undefined },
}));

vi.mock("./terminal-theme", () => ({
    buildTerminalTheme: () => ({}),
    getTermFontSize: () => 12,
    getTermScrollback: () => 2_000,
    isTermWebglEnabled: () => false,
    resolveFontFamily: () => "monospace",
}));

vi.mock("@xterm/xterm", () => ({
    Terminal: class {
        cols = 80;
        rows = 24;
        options: Record<string, unknown>;
        buffer = { active: { type: "normal", length: 0 } };
        parser = { registerOscHandler: () => ({ dispose: () => {} }) };
        writes: string[] = [];
        pendingWrites: Array<() => void> = [];

        constructor(options: Record<string, unknown>) {
            this.options = options;
        }

        loadAddon(addon: { activate?: (term: unknown) => void }) {
            addon.activate?.(this);
        }
        open() {}
        attachCustomKeyEventHandler() {}
        onData() {
            return { dispose: () => {} };
        }
        clear() {}
        reset() {
            this.writes = [];
        }
        resize(cols: number, rows: number) {
            this.cols = cols;
            this.rows = rows;
        }
        write(data: string | Uint8Array, callback?: () => void) {
            const text = typeof data === "string" ? data : new TextDecoder().decode(data);
            const apply = () => {
                this.writes.push(text);
                h.events.push(typeof data === "string" ? `write:${data}` : "write:bytes");
                callback?.();
            };
            if (h.deferWrites) this.pendingWrites.push(apply);
            else apply();
        }
        flushWrites() {
            for (const write of this.pendingWrites.splice(0)) write();
        }
        focus() {}
        refresh() {}
        dispose() {}
    },
}));

vi.mock("@xterm/addon-fit", () => ({
    FitAddon: class {
        fit() {}
    },
}));
vi.mock("@xterm/addon-search", () => ({
    SearchAddon: class {
        findNext() {}
    },
}));
vi.mock("@xterm/addon-serialize", () => ({
    SerializeAddon: class {
        term: { writes: string[] } | null = null;
        activate(term: { writes: string[] }) {
            this.term = term;
        }
        serialize() {
            return this.term?.writes.join("") ?? "";
        }
    },
}));
vi.mock("@xterm/addon-web-links", () => ({
    WebLinksAddon: class {},
}));
vi.mock("@xterm/addon-webgl", () => ({
    WebglAddon: class {},
}));

import {
    acquireSlot,
    beginLeafWriteBarrier,
    configureRendererPool,
    disposeLeafSlot,
    endLeafWriteBarrier,
    getSlotForLeaf,
    poolSize,
    poolSlotStats,
    releaseSlot,
    type Slot,
    writeToSlot,
} from "./renderer-pool";

describe("renderer slot replay", () => {
    beforeAll(() => {
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe() {}
                disconnect() {}
            }
        );
        vi.stubGlobal("requestAnimationFrame", () => 1);
        vi.stubGlobal("cancelAnimationFrame", () => {});
    });

    beforeEach(() => {
        h.events.length = 0;
        h.evicted.length = 0;
        h.snapshots.length = 0;
        h.deferWrites = false;
        configureRendererPool({
            resolveLeaf: () => null,
            evictLeaf: (leafId) => {
                h.evicted.push(leafId);
                releaseSlot(leafId);
            },
            isLeafFocused: () => false,
            isLeafBlocks: () => false,
            isLeafBusy: () => false,
            isLeafVisible: () => false,
            storeSnapshot: (leafId, out) => {
                h.snapshots.push({ leafId, snapshot: out.snapshot });
            },
        });
    });

    afterEach(() => {
        h.deferWrites = false;
        for (const stat of poolSlotStats()) {
            const leafId = stat.leafId ?? stat.retainedLeafId;
            if (leafId != null) disposeLeafSlot(leafId);
        }
        document.body.textContent = "";
    });

    it("registers the new leaf OSC handlers before replaying its snapshot and dormant bytes", () => {
        h.events.length = 0;
        const container = document.createElement("div");
        document.body.appendChild(container);

        acquireSlot({
            leafId: 1,
            container,
            snapshot: "snapshot",
            altScreen: false,
            drainRing: (write) => {
                h.events.push("drain");
                write(new TextEncoder().encode("\u001b]133;A\u0007"));
            },
            shellExited: false,
            searchQuery: null,
            cols: 80,
            rows: 24,
            registerOsc: () => {
                h.events.push("register");
                return [];
            },
            onSearchReady: () => {},
        });

        expect(h.events.slice(0, 4)).toEqual(["register", "write:snapshot", "drain", "write:bytes"]);
    });

    it("does not reset and reuse a slot until the evicted leaf's queued writes have parsed", async () => {
        const acquire = (leafId: number) =>
            acquireSlot({
                leafId,
                container: document.body.appendChild(document.createElement("div")),
                snapshot: null,
                altScreen: false,
                drainRing: () => {},
                shellExited: false,
                searchQuery: null,
                cols: 80,
                rows: 24,
                registerOsc: () => [],
                onSearchReady: () => {},
            });

        for (let leafId = 1; leafId <= 5; leafId++) acquire(leafId);
        const evictedSlot = getSlotForLeaf(1) as Slot & {
            term: Slot["term"] & { flushWrites(): void; writes: string[] };
        };

        h.deferWrites = true;
        writeToSlot(evictedSlot, "OLD-LEAF");
        h.deferWrites = false;

        const replacement = acquire(6) as typeof evictedSlot;

        expect(h.evicted).toEqual([1]);
        expect(replacement).not.toBe(evictedSlot);
        expect(replacement.term.writes).not.toContain("OLD-LEAF");
        expect(h.snapshots).toEqual([]);
        expect(poolSize()).toBe(6);

        evictedSlot.term.flushWrites();
        await Promise.resolve();

        expect(replacement.term.writes).not.toContain("OLD-LEAF");
        expect(h.snapshots).toEqual([{ leafId: 1, snapshot: "\u001b[?25hOLD-LEAF" }]);
        expect(poolSize()).toBe(5);
    });

    it("resets only after pre-truncate writes drain, then accepts new bytes", async () => {
        const slot = acquireSlot({
            leafId: 1,
            container: document.body.appendChild(document.createElement("div")),
            snapshot: null,
            altScreen: false,
            drainRing: () => {},
            shellExited: false,
            searchQuery: null,
            cols: 80,
            rows: 24,
            registerOsc: () => [],
            onSearchReady: () => {},
        }) as Slot & {
            term: Slot["term"] & { flushWrites(): void; writes: string[] };
        };

        h.deferWrites = true;
        writeToSlot(slot, "OLD");
        h.deferWrites = false;

        expect(
            beginLeafWriteBarrier(1, (barrierSlot) => {
                barrierSlot.term.clear();
                barrierSlot.term.reset();
                endLeafWriteBarrier(barrierSlot, 1);
                writeToSlot(barrierSlot, "NEW");
            })
        ).toBe(true);

        slot.term.flushWrites();
        await Promise.resolve();

        expect(slot.term.writes).toEqual(["NEW"]);
    });

    it("returns to the five-slot limit after all slots leave write barriers", async () => {
        const barrierSlots: Array<Slot & { term: Slot["term"] & { flushWrites(): void; writes: string[] } }> = [];
        for (let leafId = 1; leafId <= 5; leafId++) {
            const slot = acquireSlot({
                leafId,
                container: document.body.appendChild(document.createElement("div")),
                snapshot: null,
                altScreen: false,
                drainRing: () => {},
                shellExited: false,
                searchQuery: null,
                cols: 80,
                rows: 24,
                registerOsc: () => [],
                onSearchReady: () => {},
            }) as (typeof barrierSlots)[number];
            h.deferWrites = true;
            writeToSlot(slot, `OLD-${leafId}`);
            h.deferWrites = false;
            beginLeafWriteBarrier(leafId, (barrierSlot) => {
                endLeafWriteBarrier(barrierSlot, leafId);
                writeToSlot(barrierSlot, `NEW-${leafId}`);
            });
            barrierSlots.push(slot);
        }

        acquireSlot({
            leafId: 6,
            container: document.body.appendChild(document.createElement("div")),
            snapshot: null,
            altScreen: false,
            drainRing: () => {},
            shellExited: false,
            searchQuery: null,
            cols: 80,
            rows: 24,
            registerOsc: () => [],
            onSearchReady: () => {},
        });
        expect(poolSize()).toBe(6);

        h.deferWrites = true;
        for (const slot of barrierSlots) slot.term.flushWrites();
        await Promise.resolve();
        await Promise.resolve();

        expect(poolSize()).toBe(6);
        expect(h.evicted).toHaveLength(1);

        h.deferWrites = false;
        for (const slot of barrierSlots) slot.term.flushWrites();
        await Promise.resolve();
        await Promise.resolve();

        expect(poolSize()).toBe(5);
        expect(h.evicted).toHaveLength(1);
    });

    it("can trim a later overflow after the first trim target is disposed while draining", async () => {
        const acquire = (leafId: number) =>
            acquireSlot({
                leafId,
                container: document.body.appendChild(document.createElement("div")),
                snapshot: null,
                altScreen: false,
                drainRing: () => {},
                shellExited: false,
                searchQuery: null,
                cols: 80,
                rows: 24,
                registerOsc: () => [],
                onSearchReady: () => {},
            }) as Slot & {
                term: Slot["term"] & { flushWrites(): void; writes: string[] };
            };

        const firstWave = Array.from({ length: 5 }, (_, index) => {
            const leafId = index + 1;
            const slot = acquire(leafId);
            h.deferWrites = true;
            writeToSlot(slot, `OLD-${leafId}`);
            h.deferWrites = false;
            beginLeafWriteBarrier(leafId, (barrierSlot) => {
                endLeafWriteBarrier(barrierSlot, leafId);
                writeToSlot(barrierSlot, `NEW-${leafId}`);
            });
            return slot;
        });
        acquire(6);

        h.deferWrites = true;
        for (const slot of firstWave) slot.term.flushWrites();
        await Promise.resolve();
        await Promise.resolve();

        expect(poolSize()).toBe(6);
        expect(h.evicted).toHaveLength(1);
        disposeLeafSlot(h.evicted[0]);
        expect(poolSize()).toBe(5);

        h.deferWrites = false;
        for (const slot of firstWave) slot.term.flushWrites();
        await Promise.resolve();

        const liveLeafIds = poolSlotStats()
            .map((stat) => stat.leafId ?? stat.retainedLeafId)
            .filter((leafId): leafId is number => leafId !== null);
        expect(liveLeafIds).toHaveLength(5);

        const secondWave = liveLeafIds.map((leafId) => {
            const slot = getSlotForLeaf(leafId) as (typeof firstWave)[number];
            h.deferWrites = true;
            writeToSlot(slot, `OLD-AGAIN-${leafId}`);
            h.deferWrites = false;
            beginLeafWriteBarrier(leafId, (barrierSlot) => {
                endLeafWriteBarrier(barrierSlot, leafId);
            });
            return slot;
        });
        acquire(20);
        expect(poolSize()).toBe(6);

        for (const slot of secondWave) slot.term.flushWrites();
        await Promise.resolve();
        await Promise.resolve();

        expect(poolSize()).toBe(5);
        expect(h.evicted).toHaveLength(2);
    });

    it("serializes a barrier trim with an ordinary eviction finishing in the same turn", async () => {
        const acquire = (leafId: number) =>
            acquireSlot({
                leafId,
                container: document.body.appendChild(document.createElement("div")),
                snapshot: null,
                altScreen: false,
                drainRing: () => {},
                shellExited: false,
                searchQuery: null,
                cols: 80,
                rows: 24,
                registerOsc: () => [],
                onSearchReady: () => {},
            }) as Slot & {
                term: Slot["term"] & { flushWrites(): void; writes: string[] };
            };

        const slots = Array.from({ length: 5 }, (_, index) => acquire(index + 1));
        h.deferWrites = true;
        writeToSlot(slots[0], "ORDINARY-EVICTION");
        h.deferWrites = false;
        const sixth = acquire(6);
        expect(h.evicted).toEqual([1]);

        const barrierSlots = [...slots.slice(1), sixth];
        for (const [index, slot] of barrierSlots.entries()) {
            const leafId = index + 2;
            h.deferWrites = true;
            writeToSlot(slot, `BARRIER-${leafId}`);
            h.deferWrites = false;
            beginLeafWriteBarrier(leafId, (barrierSlot) => {
                endLeafWriteBarrier(barrierSlot, leafId);
                writeToSlot(barrierSlot, `POST-BARRIER-${leafId}`);
            });
        }

        const seventh = acquire(7);
        h.deferWrites = true;
        writeToSlot(seventh, "SEVENTH-PENDING");
        barrierSlots[0].term.flushWrites();
        slots[0].term.flushWrites();
        await Promise.resolve();
        await Promise.resolve();

        expect(poolSize()).toBe(6);
        expect(h.evicted).toHaveLength(2);
    });
});
