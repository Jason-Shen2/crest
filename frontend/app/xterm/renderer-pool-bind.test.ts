// @vitest-environment jsdom

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    events: [] as string[],
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

        constructor(options: Record<string, unknown>) {
            this.options = options;
        }

        loadAddon() {}
        open() {}
        attachCustomKeyEventHandler() {}
        onData() {
            return { dispose: () => {} };
        }
        clear() {}
        reset() {}
        resize(cols: number, rows: number) {
            this.cols = cols;
            this.rows = rows;
        }
        write(data: string | Uint8Array) {
            h.events.push(typeof data === "string" ? `write:${data}` : "write:bytes");
        }
        focus() {}
        refresh() {}
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
        serialize() {
            return "";
        }
    },
}));
vi.mock("@xterm/addon-web-links", () => ({
    WebLinksAddon: class {},
}));
vi.mock("@xterm/addon-webgl", () => ({
    WebglAddon: class {},
}));

import { acquireSlot, configureRendererPool } from "./renderer-pool";

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
        configureRendererPool({
            resolveLeaf: () => null,
            evictLeaf: () => {},
            isLeafFocused: () => false,
            isLeafBlocks: () => true,
            isLeafBusy: () => false,
            isLeafVisible: () => true,
            storeSnapshot: () => {},
        });
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
});
