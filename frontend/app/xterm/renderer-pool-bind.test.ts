// @vitest-environment jsdom

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    events: [] as string[],
    deferWrites: false,
    evicted: [] as number[],
    snapshots: [] as Array<{ leafId: number; snapshot: string | null }>,
    rafCallbacks: new Map<number, FrameRequestCallback>(),
    nextRaf: 1,
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
        modes = { mouseTrackingMode: "vt200" as const };
        element = document.createElement("div");
        csiHandlers = new Map<string, (params: (number | number[])[]) => boolean | Promise<boolean>>();
        escHandlers = new Map<string, () => boolean | Promise<boolean>>();
        parser = {
            registerOscHandler: () => ({ dispose: () => {} }),
            registerCsiHandler: (
                id: { prefix?: string; final: string },
                callback: (params: (number | number[])[]) => boolean | Promise<boolean>
            ) => {
                const key = `${id.prefix ?? ""}${id.final}`;
                this.csiHandlers.set(key, callback);
                return { dispose: () => this.csiHandlers.delete(key) };
            },
            registerEscHandler: (id: { final: string }, callback: () => boolean | Promise<boolean>) => {
                this.escHandlers.set(id.final, callback);
                return { dispose: () => this.escHandlers.delete(id.final) };
            },
        };
        writes: string[] = [];
        inputs: Array<[string, boolean | undefined]> = [];
        pendingWrites: Array<() => void> = [];
        wheelHandler: ((event: WheelEvent) => boolean) | null = null;
        disposed = false;

        constructor(options: Record<string, unknown>) {
            this.options = options;
            const screen = document.createElement("div");
            screen.className = "xterm-screen";
            screen.getBoundingClientRect = () =>
                ({
                    left: 0,
                    top: 0,
                    width: 800,
                    height: 480,
                    right: 800,
                    bottom: 480,
                    x: 0,
                    y: 0,
                    toJSON: () => ({}),
                }) as DOMRect;
            this.element.appendChild(screen);
        }

        loadAddon(addon: { activate?: (term: unknown) => void }) {
            addon.activate?.(this);
        }
        open() {}
        attachCustomKeyEventHandler() {}
        attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) {
            this.wheelHandler = handler;
        }
        onData() {
            return { dispose: () => {} };
        }
        input(data: string, wasUserInput?: boolean) {
            this.inputs.push([data, wasUserInput]);
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
        dispose() {
            this.disposed = true;
        }
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
    discardRetainedSlot,
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
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
            const id = h.nextRaf++;
            h.rafCallbacks.set(id, callback);
            return id;
        });
        vi.stubGlobal("cancelAnimationFrame", (id: number) => {
            h.rafCallbacks.delete(id);
        });
    });

    beforeEach(() => {
        h.events.length = 0;
        h.evicted.length = 0;
        h.snapshots.length = 0;
        h.deferWrites = false;
        h.rafCallbacks.clear();
        h.nextRaf = 1;
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

    it("installs fullscreen TUI wheel handling on an active slot", () => {
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
            term: Slot["term"] & {
                csiHandlers: Map<string, (params: (number | number[])[]) => boolean>;
                inputs: Array<[string, boolean | undefined]>;
                wheelHandler: (event: WheelEvent) => boolean;
            };
        };
        slot.term.csiHandlers.get("?h")?.([1006]);

        expect(
            slot.term.wheelHandler({
                deltaMode: 0,
                deltaX: 0,
                deltaY: 20,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                clientX: 45,
                clientY: 45,
                timeStamp: 1,
            } as WheelEvent)
        ).toBe(false);

        const wheelFrameId = Math.max(...h.rafCallbacks.keys());
        const wheelFrame = h.rafCallbacks.get(wheelFrameId);
        h.rafCallbacks.delete(wheelFrameId);
        wheelFrame?.(16);
        expect(slot.term.inputs).toEqual([["\x1b[<65;5;3M", false]]);
    });

    it("cancels pending TUI wheel input when a slot is released", () => {
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
            term: Slot["term"] & {
                csiHandlers: Map<string, (params: (number | number[])[]) => boolean>;
                inputs: Array<[string, boolean | undefined]>;
                wheelHandler: (event: WheelEvent) => boolean;
            };
        };
        slot.term.csiHandlers.get("?h")?.([1006]);
        slot.term.wheelHandler({
            deltaMode: 0,
            deltaX: 0,
            deltaY: 20,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
            clientX: 45,
            clientY: 45,
            timeStamp: 1,
        } as WheelEvent);

        releaseSlot(1);
        for (const [id, callback] of [...h.rafCallbacks]) {
            h.rafCallbacks.delete(id);
            callback(16);
        }

        expect(slot.term.inputs).toEqual([]);
    });

    it("resets TUI mouse encoding before a retained slot is reused", () => {
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
                term: Slot["term"] & {
                    csiHandlers: Map<string, (params: (number | number[])[]) => boolean>;
                    wheelHandler: (event: WheelEvent) => boolean;
                };
            };
        const first = acquire(1);
        first.term.csiHandlers.get("?h")?.([1006]);

        releaseSlot(1);
        discardRetainedSlot(1);
        const reused = acquire(2);

        expect(reused).toBe(first);
        expect(
            reused.term.wheelHandler({
                deltaMode: 0,
                deltaX: 0,
                deltaY: 20,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                clientX: 45,
                clientY: 45,
                timeStamp: 500,
            } as WheelEvent)
        ).toBe(true);
    });

    it("disposes TUI parser observers with the slot", () => {
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
            term: Slot["term"] & {
                csiHandlers: Map<string, (params: (number | number[])[]) => boolean>;
                escHandlers: Map<string, () => boolean>;
                disposed: boolean;
            };
        };
        expect(slot.term.csiHandlers.size).toBe(2);
        expect(slot.term.escHandlers.size).toBe(1);

        disposeLeafSlot(1);

        expect(slot.term.csiHandlers.size).toBe(0);
        expect(slot.term.escHandlers.size).toBe(0);
        expect(slot.term.disposed).toBe(true);
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
