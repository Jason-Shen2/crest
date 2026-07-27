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
    configureRendererPool,
    disposeLeafSlot,
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
});
