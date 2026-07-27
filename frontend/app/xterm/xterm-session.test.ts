// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeSlot = {
    term: any;
    writes: (string | Uint8Array)[];
    oscHandlers: Map<number, (data: string) => boolean | Promise<boolean>>;
    emitOsc: (code: number, data: string) => void;
    setAltScreen: (active: boolean) => void;
    searchAddon: { calls: any[][]; findNext: any; findPrevious: any; clearDecorations: any };
};

const h = vi.hoisted(() => {
    function makeFakeSlot(): any {
        const writes: (string | Uint8Array)[] = [];
        const oscHandlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
        let bufferListener: (() => void) | null = null;
        let writeParsedListener: (() => void) | null = null;
        const term: any = {
            cols: 80,
            rows: 24,
            options: {} as Record<string, unknown>,
            element: null,
            buffer: {
                active: {
                    type: "normal",
                    length: 0,
                    baseY: 0,
                    cursorY: 0,
                    viewportY: 0,
                    getLine: (_i: number) => null as any,
                },
                onBufferChange: (cb: () => void) => {
                    bufferListener = cb;
                    return {
                        dispose: () => {
                            bufferListener = null;
                        },
                    };
                },
            },
            parser: {
                registerOscHandler: (code: number, cb: any) => {
                    oscHandlers.set(code, cb);
                    return { dispose: () => oscHandlers.delete(code) };
                },
            },
            registerMarker: () => ({ line: 0, isDisposed: false, dispose: () => {} }),
            registerDecoration: () => ({ dispose: () => {}, onRender: () => {} }),
            onWriteParsed: (cb: () => void) => {
                writeParsedListener = cb;
                return {
                    dispose: () => {
                        writeParsedListener = null;
                    },
                };
            },
            onScroll: () => ({ dispose: () => {} }),
            onRender: () => ({ dispose: () => {} }),
            hasSelection: () => false,
            selectLines: () => {},
            clearSelection: () => {},
            scrollToLine: () => {},
            focus: () => {},
            write: (data: string | Uint8Array) => writes.push(data),
            clear: () => {},
            reset: () => {},
        };
        const searchCalls: any[][] = [];
        return {
            term,
            writes,
            oscHandlers,
            emitOsc: (code: number, data: string) => oscHandlers.get(code)?.(data),
            setAltScreen: (active: boolean) => {
                term.buffer.active.type = active ? "alternate" : "normal";
                bufferListener?.();
                writeParsedListener?.();
            },
            searchAddon: {
                calls: searchCalls,
                findNext: (term2: string, opts: any) => {
                    searchCalls.push(["findNext", term2, opts]);
                    return true;
                },
                findPrevious: (term2: string, opts: any) => {
                    searchCalls.push(["findPrevious", term2, opts]);
                    return true;
                },
                clearDecorations: () => searchCalls.push(["clearDecorations"]),
            },
        };
    }

    const pool = {
        adapter: null as any,
        slots: new Map<number, any>(),
        retained: new Map<number, any>(),
        acquireCalls: [] as any[],
        releaseCalls: [] as number[],
        parkCalls: [] as number[],
        refreshCalls: [] as number[],
        focusCalls: [] as number[],
        disposeCalls: [] as number[],
    };

    return {
        makeFakeSlot,
        pool,
        order: [] as string[],
        ptys: new Map<string, any>(),
        ptyHandlers: new Map<string, any>(),
        statusSubs: [] as any[],
        resyncCalls: [] as any[],
        fetchImpl: null as any,
        fgJobImpl: null as any,
        acquireSlot(params: any) {
            pool.acquireCalls.push(params);
            const retained = pool.retained.get(params.leafId);
            if (retained) {
                // Real pool fast path: the retained buffer is intact, so no
                // snapshot replay and no OSC re-registration — drain only.
                pool.retained.delete(params.leafId);
                pool.slots.set(params.leafId, retained);
                params.drainRing((bytes: Uint8Array) => retained.term.write(bytes));
                params.onSearchReady(retained.searchAddon);
                return retained;
            }
            let slot = pool.slots.get(params.leafId);
            if (!slot) {
                slot = makeFakeSlot();
                pool.slots.set(params.leafId, slot);
            }
            if (params.snapshot) slot.term.write(params.snapshot);
            if (params.altScreen) params.drainRing(() => {});
            else params.drainRing((bytes: Uint8Array) => slot.term.write(bytes));
            params.registerOsc(slot.term);
            params.onSearchReady(slot.searchAddon);
            return slot;
        },
        releaseSlot(leafId: number) {
            pool.releaseCalls.push(leafId);
            const slot = pool.slots.get(leafId);
            if (!slot) return null;
            pool.slots.delete(leafId);
            pool.retained.set(leafId, slot);
            return { cols: slot.term.cols, rows: slot.term.rows };
        },
    };
});

vi.mock("./renderer-pool", () => ({
    configureRendererPool: (a: any) => {
        h.pool.adapter = a;
    },
    acquireSlot: (params: any) => h.acquireSlot(params),
    releaseSlot: (leafId: number) => h.releaseSlot(leafId),
    getSlotForLeaf: (leafId: number) => h.pool.slots.get(leafId) ?? null,
    getLiveSlotForLeaf: (leafId: number) => h.pool.slots.get(leafId) ?? h.pool.retained.get(leafId) ?? null,
    isLeafAltScreen: (leafId: number) => {
        const slot = h.pool.slots.get(leafId);
        return slot ? slot.term.buffer.active.type === "alternate" : false;
    },
    parkLeafSlot: (leafId: number) => h.pool.parkCalls.push(leafId),
    refreshLeafSlot: (leafId: number) => h.pool.refreshCalls.push(leafId),
    focusSlot: (leafId: number) => h.pool.focusCalls.push(leafId),
    setSlotFocused: () => {},
    disposeLeafSlot: (leafId: number) => {
        h.pool.disposeCalls.push(leafId);
        h.pool.slots.delete(leafId);
        h.pool.retained.delete(leafId);
    },
}));

vi.mock("./pty-bridge", () => ({
    attachPty: (blockId: string, handlers: any) => {
        h.order.push(`attachPty:${blockId}`);
        h.ptyHandlers.set(blockId, handlers);
        const pty = {
            blockId,
            writes: [] as string[],
            resizes: [] as [number, number][],
            kicks: [] as [number, number][],
            disposed: false,
            write: async (data: string) => {
                pty.writes.push(data);
            },
            resize: async (cols: number, rows: number) => {
                pty.resizes.push([cols, rows]);
            },
            kick: async (cols: number, rows: number) => {
                pty.kicks.push([cols, rows]);
            },
            dispose: () => {
                pty.disposed = true;
            },
        };
        h.ptys.set(blockId, pty);
        return pty;
    },
}));

vi.mock("@/store/global", () => ({
    atoms: { staticTabId: "static-tab-id" },
    fetchWaveFile: (zoneId: string, name: string) => {
        h.order.push(`fetch:${zoneId}`);
        return h.fetchImpl(zoneId, name);
    },
    globalStore: {
        get: (atom: unknown) => (atom === "static-tab-id" ? "tab-1" : undefined),
    },
}));

vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (sub: any) => {
        h.statusSubs.push(sub);
        return () => {
            const i = h.statusSubs.indexOf(sub);
            if (i >= 0) h.statusSubs.splice(i, 1);
        };
    },
}));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        ControllerResyncCommand: (_client: any, data: any) => {
            h.resyncCalls.push(data);
            return Promise.resolve();
        },
        ControllerHasForegroundJobCommand: (_client: any, blockId: string) => h.fgJobImpl(blockId),
    },
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {},
}));

import { markAgentActive, markAgentInactive } from "./agent-activity";
import {
    attachSession,
    clearSessionFind,
    detachSession,
    disposeSession,
    findInSession,
    findNextInSession,
    findPreviousInSession,
    getSessionBlockMode,
    getSessionBuffer,
    getSessionVisibleBlocks,
    getSessionWatermarkState,
    interruptSession,
    readSessionBlockOutput,
    resizeSession,
    searchSessionBlock,
    sessionCwd,
    sessionLeafId,
    setSessionInputActivity,
    setSessionInputFocus,
    setSessionVisibility,
    submitToSession,
    subscribeSessionBlockMode,
    subscribeSessionBlocks,
    writeToSession,
    type SessionCallbacks,
} from "./xterm-session";

let blockSeq = 0;

function newBlockId(): string {
    return `block-${++blockSeq}`;
}

function fakeContainer(): HTMLDivElement {
    return {} as HTMLDivElement;
}

function enc(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

function joined(slot: FakeSlot): string {
    const dec = new TextDecoder();
    return slot.writes.map((w) => (typeof w === "string" ? w : dec.decode(w))).join("");
}

async function flushAsync(times = 8): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
}

type AttachedSession = {
    blockId: string;
    leafId: number;
    pty: any;
    slot: FakeSlot;
    handlers: any;
    callbacks: SessionCallbacks;
};

async function attachReady(opts: { blocks?: boolean; visible?: boolean } = {}): Promise<AttachedSession> {
    const blockId = newBlockId();
    const callbacks: SessionCallbacks = { onShellExit: vi.fn(), onCwd: vi.fn(), onSearchReady: vi.fn() };
    attachSession(blockId, fakeContainer(), callbacks, { blocks: opts.blocks });
    if (opts.visible !== false) setSessionVisibility(blockId, true, true);
    await flushAsync();
    const leafId = sessionLeafId(blockId);
    return {
        blockId,
        leafId,
        pty: h.ptys.get(blockId),
        slot: h.pool.slots.get(leafId),
        handlers: h.ptyHandlers.get(blockId),
        callbacks,
    };
}

function statusSubFor(blockId: string): any {
    return h.statusSubs.find((s) => s.scope === `block:${blockId}`);
}

beforeEach(() => {
    h.pool.slots.clear();
    h.pool.retained.clear();
    h.pool.acquireCalls.length = 0;
    h.pool.releaseCalls.length = 0;
    h.pool.parkCalls.length = 0;
    h.pool.refreshCalls.length = 0;
    h.pool.focusCalls.length = 0;
    h.pool.disposeCalls.length = 0;
    h.order.length = 0;
    h.ptys.clear();
    h.ptyHandlers.clear();
    h.statusSubs.length = 0;
    h.resyncCalls.length = 0;
    h.fetchImpl = async () => ({ data: null, fileInfo: null });
    h.fgJobImpl = async () => false;
});

afterEach(() => {
    vi.useRealTimers();
});

describe("attach + cold restore", () => {
    it("resyncs the shell controller once when a session is first attached", async () => {
        const blockId = newBlockId();
        attachSession(blockId, fakeContainer(), {});
        attachSession(blockId, fakeContainer(), {});
        await flushAsync();

        expect(h.resyncCalls).toEqual([{ tabid: "tab-1", blockid: blockId }]);
    });

    it("subscribes to the pty stream before fetching the blockfile", async () => {
        const { blockId } = await attachReady();
        expect(h.order.indexOf(`attachPty:${blockId}`)).toBeGreaterThanOrEqual(0);
        expect(h.order.indexOf(`attachPty:${blockId}`)).toBeLessThan(h.order.indexOf(`fetch:${blockId}`));
    });

    it("replays the fetched blockfile before appends that raced in during the fetch", async () => {
        const blockId = newBlockId();
        let resolveFetch: (v: { data: Uint8Array; fileInfo: any }) => void;
        h.fetchImpl = () =>
            new Promise((r) => {
                resolveFetch = r;
            });
        attachSession(blockId, fakeContainer(), {});
        setSessionVisibility(blockId, true, true);
        const slot: FakeSlot = h.pool.slots.get(sessionLeafId(blockId));
        const handlers = h.ptyHandlers.get(blockId);

        handlers.onData(enc("APPEND-1"));
        handlers.onData(enc("APPEND-2"));
        // Nothing may reach the live term until the fetched file replays.
        expect(joined(slot)).toBe("");

        resolveFetch!({ data: enc("FILE|"), fileInfo: {} });
        await flushAsync();
        expect(joined(slot)).toBe("FILE|APPEND-1APPEND-2");

        // Post-restore appends flow straight to the live slot.
        handlers.onData(enc("|LIVE"));
        expect(joined(slot)).toBe("FILE|APPEND-1APPEND-2|LIVE");
    });

    it("without a slot, rebuilds the ring as file-then-appends for the next bind", async () => {
        const blockId = newBlockId();
        let resolveFetch: (v: { data: Uint8Array; fileInfo: any }) => void;
        h.fetchImpl = () =>
            new Promise((r) => {
                resolveFetch = r;
            });
        attachSession(blockId, fakeContainer(), {});
        const handlers = h.ptyHandlers.get(blockId);
        handlers.onData(enc("APPEND"));
        resolveFetch!({ data: enc("FILE|"), fileInfo: {} });
        await flushAsync();

        setSessionVisibility(blockId, true, true);
        const slot: FakeSlot = h.pool.slots.get(sessionLeafId(blockId));
        expect(joined(slot)).toBe("FILE|APPEND");
    });

    it("drains buffered appends even when the blockfile fetch fails", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const blockId = newBlockId();
        h.fetchImpl = async () => {
            throw new Error("offline");
        };
        attachSession(blockId, fakeContainer(), {});
        setSessionVisibility(blockId, true, true);
        h.ptyHandlers.get(blockId).onData(enc("BYTES"));
        await flushAsync();
        expect(joined(h.pool.slots.get(sessionLeafId(blockId)))).toBe("BYTES");
        warn.mockRestore();
    });

    it("treats a missing blockfile (null data) as empty history", async () => {
        const { blockId, slot, handlers } = await attachReady();
        handlers.onData(enc("FRESH"));
        expect(joined(slot)).toBe("FRESH");
        expect(sessionCwd(blockId)).toBeNull();
    });
});

describe("ring routing and rebind drain", () => {
    it("rings bytes when the session has no slot and drains them on bind", async () => {
        const blockId = newBlockId();
        attachSession(blockId, fakeContainer(), {});
        await flushAsync();
        h.ptyHandlers.get(blockId).onData(enc("HIDDEN"));
        expect(h.pool.acquireCalls.length).toBe(0);

        setSessionVisibility(blockId, true, true);
        expect(joined(h.pool.slots.get(sessionLeafId(blockId)))).toBe("HIDDEN");
    });

    it("restores the stolen snapshot before draining the ring on rebind", async () => {
        const { blockId, leafId, handlers } = await attachReady();
        setSessionVisibility(blockId, false, false);
        await flushAsync();
        expect(h.pool.releaseCalls).toContain(leafId);

        // Another leaf steals the retained buffer: the pool serializes it into
        // the session and discards the slot.
        h.pool.adapter.storeSnapshot(leafId, { snapshot: "SNAP|", cols: 100, rows: 30, altScreen: false });
        h.pool.retained.delete(leafId);
        handlers.onData(enc("RINGED"));

        setSessionVisibility(blockId, true, true);
        const params = h.pool.acquireCalls.at(-1);
        expect(params.snapshot).toBe("SNAP|");
        expect(params.cols).toBe(100);
        expect(params.rows).toBe(30);
        expect(params.altScreen).toBe(false);
        expect(joined(h.pool.slots.get(leafId))).toBe("SNAP|RINGED");
    });

    it("clears the stored snapshot after it is consumed by a bind", async () => {
        const { blockId, leafId } = await attachReady();
        setSessionVisibility(blockId, false, false);
        await flushAsync();
        h.pool.adapter.storeSnapshot(leafId, { snapshot: "SNAP", cols: 80, rows: 24, altScreen: false });
        h.pool.retained.delete(leafId);
        setSessionVisibility(blockId, true, true);

        setSessionVisibility(blockId, false, false);
        await flushAsync();
        h.pool.retained.delete(leafId);
        setSessionVisibility(blockId, true, true);
        expect(h.pool.acquireCalls.at(-1).snapshot).toBeNull();
    });

    it("discards ringed TUI bytes and flags altScreen for the kick path on rebind", async () => {
        const { blockId, leafId, handlers } = await attachReady();
        setSessionVisibility(blockId, false, false);
        await flushAsync();
        h.pool.adapter.storeSnapshot(leafId, { snapshot: "SNAP", cols: 80, rows: 24, altScreen: true });
        h.pool.retained.delete(leafId);
        handlers.onData(enc("TUI-GARBAGE"));

        setSessionVisibility(blockId, true, true);
        const params = h.pool.acquireCalls.at(-1);
        expect(params.altScreen).toBe(true);
        // Snapshot replays; incremental cursor-positioned TUI bytes must not.
        expect(joined(h.pool.slots.get(leafId))).toBe("SNAP");
    });

    it("keeps writing into a retained slot after release (live parse, paused render)", async () => {
        const { blockId, leafId, slot, handlers } = await attachReady();
        setSessionVisibility(blockId, false, false);
        await flushAsync();
        expect(h.pool.slots.has(leafId)).toBe(false);
        handlers.onData(enc("RETAINED"));
        expect(joined(slot)).toContain("RETAINED");
    });
});

describe("hibernation decision chain", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it("parks then releases a hidden idle session once the foreground-job probe clears", async () => {
        const { blockId, leafId } = await attachReady();
        setSessionVisibility(blockId, false, false);
        expect(h.pool.parkCalls).toContain(leafId);
        expect(h.pool.releaseCalls).not.toContain(leafId);
        await flushAsync();
        expect(h.pool.releaseCalls).toContain(leafId);
    });

    it("vetoes release while the slot is in alt-screen", async () => {
        const { blockId, leafId, slot } = await attachReady();
        slot.setAltScreen(true);
        setSessionVisibility(blockId, false, false);
        await flushAsync();
        expect(h.pool.parkCalls).toContain(leafId);
        expect(h.pool.releaseCalls).not.toContain(leafId);
    });

    it("vetoes release for blocks-mode sessions", async () => {
        const { blockId, leafId } = await attachReady({ blocks: true });
        setSessionVisibility(blockId, false, false);
        await flushAsync();
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.pool.parkCalls).toContain(leafId);
        expect(h.pool.releaseCalls).not.toContain(leafId);
    });

    it("vetoes release while an agent is active, then releases 300ms after it exits", async () => {
        const { blockId, leafId } = await attachReady();
        markAgentActive(blockId);
        setSessionVisibility(blockId, false, false);
        await flushAsync();
        expect(h.pool.releaseCalls).not.toContain(leafId);

        markAgentInactive(blockId);
        await vi.advanceTimersByTimeAsync(299);
        expect(h.pool.releaseCalls).not.toContain(leafId);
        await vi.advanceTimersByTimeAsync(1);
        await flushAsync();
        expect(h.pool.releaseCalls).toContain(leafId);
    });

    it("vetoes release while a foreground job is running", async () => {
        h.fgJobImpl = async () => true;
        const { blockId, leafId, slot } = await attachReady();
        setSessionVisibility(blockId, false, false);
        await flushAsync();
        expect(h.pool.parkCalls).toContain(leafId);
        expect(h.pool.releaseCalls).not.toContain(leafId);

        h.fgJobImpl = async () => false;
        slot.emitOsc(133, "C");
        slot.emitOsc(133, "D");
        await vi.advanceTimersByTimeAsync(300);
        await flushAsync();
        expect(h.pool.releaseCalls).toContain(leafId);
    });

    it("treats a foreground-job RPC error as no veto", async () => {
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        h.fgJobImpl = async () => {
            throw new Error("rpc down");
        };
        const { blockId, leafId } = await attachReady();
        setSessionVisibility(blockId, false, false);
        await flushAsync();
        expect(h.pool.releaseCalls).toContain(leafId);
        expect(err).toHaveBeenCalled();
        err.mockRestore();
    });

    it("holds a hidden session with a running command, releasing 300ms after OSC 133 D", async () => {
        const { blockId, leafId, slot } = await attachReady();
        slot.emitOsc(133, "C");
        setSessionVisibility(blockId, false, false);
        await flushAsync();
        expect(h.pool.releaseCalls).not.toContain(leafId);

        slot.emitOsc(133, "D");
        await vi.advanceTimersByTimeAsync(299);
        await flushAsync();
        expect(h.pool.releaseCalls).not.toContain(leafId);
        await vi.advanceTimersByTimeAsync(1);
        await flushAsync();
        expect(h.pool.releaseCalls).toContain(leafId);
    });

    it("rebinds a hidden released session when a command starts in its retained buffer", async () => {
        const { blockId, leafId, slot } = await attachReady();
        setSessionVisibility(blockId, false, false);
        await flushAsync();
        expect(h.pool.slots.has(leafId)).toBe(false);
        const acquiresBefore = h.pool.acquireCalls.length;

        // e.g. the AI submits a command: the retained slot still parses, OSC
        // 133 C fires, and the session must re-park a live grid for output.
        slot.emitOsc(133, "C");
        await vi.advanceTimersByTimeAsync(0);
        expect(h.pool.acquireCalls.length).toBe(acquiresBefore + 1);
        expect(h.pool.slots.get(leafId)).toBe(slot);
        expect(h.pool.parkCalls.at(-1)).toBe(leafId);
    });
});

describe("input API", () => {
    it("writeToSession forwards to the pty and reports failure for unknown blocks", async () => {
        const { blockId, pty } = await attachReady();
        expect(writeToSession(blockId, "ls\r")).toBe(true);
        expect(pty.writes).toContain("ls\r");
        expect(writeToSession("no-such-block", "x")).toBe(false);
    });

    it("submitToSession sends a single-line command with a trailing CR", async () => {
        const { blockId, pty } = await attachReady();
        submitToSession(blockId, "echo hi");
        expect(pty.writes).toContain("echo hi\r");
    });

    it("submitToSession wraps multiline commands in bracketed paste", async () => {
        const { blockId, pty } = await attachReady();
        submitToSession(blockId, "line1\nline2");
        expect(pty.writes).toContain("\x1b[200~line1\nline2\x1b[201~\r");
    });

    it("interruptSession writes ETX", async () => {
        const { blockId, pty } = await attachReady();
        interruptSession(blockId);
        expect(pty.writes).toContain("\x03");
    });

    it("resizeSession updates dims and rejects non-positive sizes", async () => {
        const { blockId, pty } = await attachReady();
        resizeSession(blockId, 132, 43);
        expect(pty.resizes).toContainEqual([132, 43]);
        resizeSession(blockId, 0, 43);
        resizeSession(blockId, 132, -1);
        expect(pty.resizes.length).toBe(1);
    });
});

describe("shell exit", () => {
    it("marks the session exited, disables stdin, and notifies the view", async () => {
        const { blockId, slot, callbacks, pty } = await attachReady();
        statusSubFor(blockId).handler({ event: "controllerstatus", data: { shellprocstatus: "done" } });
        expect(callbacks.onShellExit).toHaveBeenCalledTimes(1);
        expect(slot.term.options.disableStdin).toBe(true);
        expect(writeToSession(blockId, "x")).toBe(false);
        submitToSession(blockId, "x");
        expect(pty.writes).toEqual([]);
    });

    it("re-enables the session when the backend restarts the shell", async () => {
        const { blockId, slot } = await attachReady();
        const sub = statusSubFor(blockId);
        sub.handler({ event: "controllerstatus", data: { shellprocstatus: "done" } });
        sub.handler({ event: "controllerstatus", data: { shellprocstatus: "running" } });
        expect(slot.term.options.disableStdin).toBe(false);
        expect(writeToSession(blockId, "x")).toBe(true);
    });

    it("blocks writeToPty through the slot adapter after exit", async () => {
        const { blockId, leafId, pty } = await attachReady();
        statusSubFor(blockId).handler({ event: "controllerstatus", data: { shellprocstatus: "done" } });
        h.pool.adapter.resolveLeaf(leafId).writeToPty("typed");
        expect(pty.writes).toEqual([]);
    });
});

describe("mode machine", () => {
    it("tracks prompt → running → alt → prompt and notifies subscribers", async () => {
        const { blockId, slot } = await attachReady();
        const listener = vi.fn();
        subscribeSessionBlockMode(blockId, listener);
        expect(getSessionBlockMode(blockId)).toBe("prompt");

        slot.emitOsc(133, "C");
        expect(getSessionBlockMode(blockId)).toBe("running");
        expect(listener).toHaveBeenCalledTimes(1);

        slot.setAltScreen(true);
        expect(getSessionBlockMode(blockId)).toBe("alt");

        // Alt-screen dominates: D alone does not leave alt mode (and must not
        // re-notify, since the derived mode did not change).
        slot.emitOsc(133, "D");
        expect(getSessionBlockMode(blockId)).toBe("alt");

        slot.setAltScreen(false);
        expect(getSessionBlockMode(blockId)).toBe("prompt");
        expect(listener).toHaveBeenCalledTimes(3);
    });

    it("reports cwd changes once per distinct OSC 7", async () => {
        const { blockId, slot, callbacks } = await attachReady();
        slot.emitOsc(7, "file://host/home/me");
        slot.emitOsc(7, "file://host/home/me");
        expect(callbacks.onCwd).toHaveBeenCalledTimes(1);
        expect(sessionCwd(blockId)).toBe("/home/me");
    });
});

describe("slot adapter", () => {
    it("exposes visibility, focus, blocks, and busy state to the pool", async () => {
        const { blockId, leafId } = await attachReady();
        const a = h.pool.adapter;
        expect(a.isLeafVisible(leafId)).toBe(true);
        expect(a.isLeafFocused(leafId)).toBe(true);
        expect(a.isLeafBlocks(leafId)).toBe(false);
        expect(a.isLeafBusy(leafId)).toBe(false);

        markAgentActive(blockId);
        expect(a.isLeafBusy(leafId)).toBe(true);
        markAgentInactive(blockId);

        setSessionVisibility(blockId, true, false);
        expect(a.isLeafFocused(leafId)).toBe(false);
        expect(a.resolveLeaf(999999)).toBeNull();
    });

    it("routes LeafBridge write/resize/kick to the pty session", async () => {
        const { blockId, leafId, pty, slot } = await attachReady();
        const bridge = h.pool.adapter.resolveLeaf(leafId);
        bridge.writeToPty("abc");
        // The pool calls resizePty after fitting the term, so the slot dims
        // already reflect the new size when the bridge is notified.
        slot.term.cols = 90;
        slot.term.rows = 25;
        bridge.resizePty(90, 25);
        bridge.kickPty(90, 25);
        await flushAsync();
        expect(pty.writes).toContain("abc");
        expect(pty.resizes).toContainEqual([90, 25]);
        expect(pty.kicks).toContainEqual([90, 25]);
        // The session dims survive release and seed the next bind.
        setSessionVisibility(blockId, false, false);
        await flushAsync();
        h.pool.retained.delete(leafId);
        setSessionVisibility(blockId, true, true);
        const params = h.pool.acquireCalls.at(-1);
        expect(params.cols).toBe(90);
        expect(params.rows).toBe(25);
    });

    it("evictLeaf releases the session's slot", async () => {
        const { leafId } = await attachReady();
        h.pool.adapter.evictLeaf(leafId);
        expect(h.pool.releaseCalls).toContain(leafId);
    });
});

describe("read seam", () => {
    it("reads the live buffer when a slot is bound", async () => {
        const { blockId, slot } = await attachReady();
        slot.term.buffer.active.length = 3;
        slot.term.buffer.active.getLine = (i: number) => ({ translateToString: () => (i < 2 ? `L${i}` : "") });
        expect(getSessionBuffer(blockId)).toBe("L0\nL1");
    });

    it("falls back to the ANSI-stripped snapshot when the buffer is gone", async () => {
        const { blockId, leafId } = await attachReady();
        setSessionVisibility(blockId, false, false);
        await flushAsync();
        h.pool.adapter.storeSnapshot(leafId, {
            snapshot: "\x1b[31mred\x1b[0m\r\nplain",
            cols: 80,
            rows: 24,
            altScreen: false,
        });
        h.pool.retained.delete(leafId);
        expect(getSessionBuffer(blockId)).toBe("red\nplain");
        expect(getSessionBuffer("no-such-block")).toBeNull();
    });
});

describe("detach + dispose", () => {
    it("detach releases the slot but keeps the pty stream ringing", async () => {
        const { blockId, leafId, handlers } = await attachReady();
        detachSession(blockId);
        expect(h.pool.releaseCalls).toContain(leafId);
        h.pool.retained.delete(leafId);
        handlers.onData(enc("WHILE-DETACHED"));

        attachSession(blockId, fakeContainer(), {});
        setSessionVisibility(blockId, true, true);
        expect(joined(h.pool.slots.get(leafId))).toContain("WHILE-DETACHED");
    });

    it("dispose tears down the pty, slot, and status subscription", async () => {
        const { blockId, leafId, pty } = await attachReady();
        disposeSession(blockId);
        expect(pty.disposed).toBe(true);
        expect(h.pool.disposeCalls).toContain(leafId);
        expect(statusSubFor(blockId)).toBeUndefined();
        expect(writeToSession(blockId, "x")).toBe(false);
        expect(getSessionBuffer(blockId)).toBeNull();
        expect(sessionLeafId(blockId)).toBeNull();
    });

    it("dispose cancels a pending hidden release", async () => {
        vi.useFakeTimers();
        const { blockId, leafId, slot } = await attachReady();
        slot.emitOsc(133, "C");
        setSessionVisibility(blockId, false, false);
        await flushAsync();
        slot.emitOsc(133, "D");
        disposeSession(blockId);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.pool.releaseCalls).not.toContain(leafId);
    });

    it("ignores a cold-restore fetch that resolves after dispose", async () => {
        const blockId = newBlockId();
        let resolveFetch: (v: { data: Uint8Array; fileInfo: any }) => void;
        h.fetchImpl = () =>
            new Promise((r) => {
                resolveFetch = r;
            });
        attachSession(blockId, fakeContainer(), {});
        setSessionVisibility(blockId, true, true);
        const slot: FakeSlot = h.pool.slots.get(sessionLeafId(blockId));
        disposeSession(blockId);
        resolveFetch!({ data: enc("LATE"), fileInfo: {} });
        await flushAsync();
        expect(joined(slot)).toBe("");
    });

    it("drops post-dispose pty bytes", async () => {
        const { blockId, slot, handlers } = await attachReady();
        disposeSession(blockId);
        handlers.onData(enc("ZOMBIE"));
        expect(joined(slot)).toBe("");
    });
});

describe("find accessors", () => {
    it("delegates to the bound slot's SearchAddon with decorations", async () => {
        const { blockId, slot } = await attachReady();
        findInSession(blockId, "err", { caseSensitive: true });
        let call = slot.searchAddon.calls.at(-1);
        expect(call[0]).toBe("findNext");
        expect(call[1]).toBe("err");
        expect(call[2].incremental).toBe(true);
        expect(call[2].caseSensitive).toBe(true);
        expect(call[2].decorations).toBeTruthy();

        findNextInSession(blockId, "err", { regex: true });
        call = slot.searchAddon.calls.at(-1);
        expect(call[0]).toBe("findNext");
        expect(call[2].incremental).toBeUndefined();
        expect(call[2].regex).toBe(true);

        findPreviousInSession(blockId, "err");
        expect(slot.searchAddon.calls.at(-1)[0]).toBe("findPrevious");

        findInSession(blockId, "");
        expect(slot.searchAddon.calls.at(-1)).toEqual(["clearDecorations"]);

        clearSessionFind(blockId);
        expect(slot.searchAddon.calls.at(-1)).toEqual(["clearDecorations"]);
    });

    it("no-ops while dormant but records the query for the next bind", async () => {
        const { blockId } = await attachReady({ visible: false });
        expect(h.pool.acquireCalls.length).toBe(0);

        findInSession(blockId, "boot");
        findNextInSession(blockId, "boot");
        findPreviousInSession(blockId, "boot");
        expect(h.pool.acquireCalls.length).toBe(0);

        setSessionVisibility(blockId, true, true);
        expect(h.pool.acquireCalls.at(-1).searchQuery).toBe("boot");
    });

    it("clearSessionFind while dormant drops the recorded query", async () => {
        const { blockId } = await attachReady({ visible: false });
        findInSession(blockId, "boot");
        clearSessionFind(blockId);
        setSessionVisibility(blockId, true, true);
        expect(h.pool.acquireCalls.at(-1).searchQuery).toBeNull();
    });

    it("ignores unknown blocks", () => {
        findInSession("no-such-block", "x");
        findNextInSession("no-such-block", "x");
        findPreviousInSession("no-such-block", "x");
        clearSessionFind("no-such-block");
    });
});

describe("blocks mode", () => {
    // BlockDecorations schedules overlay refreshes through rAF; the node test
    // env has none and no test asserts on frame timing.
    beforeEach(() => {
        vi.stubGlobal("requestAnimationFrame", () => 1);
        vi.stubGlobal("cancelAnimationFrame", () => {});
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function giveFakeScreen(slot: FakeSlot): void {
        const screen = { getBoundingClientRect: () => ({ top: 0, height: 240 }) };
        slot.term.element = {
            querySelector: () => screen,
            getBoundingClientRect: () => ({ top: 0 }),
        };
    }

    function rowSubFor(blockId: string): any {
        return h.statusSubs.find((s) => s.eventType === "cmdblock:row" && s.scope === `block:${blockId}`);
    }

    it("gates xterm stdin at the prompt and hands the grid over while running", async () => {
        const { blockId, slot } = await attachReady({ blocks: true });
        expect(slot.term.options.disableStdin).toBe(true);

        slot.emitOsc(133, "C");
        expect(getSessionBlockMode(blockId)).toBe("running");
        expect(slot.term.options.disableStdin).toBe(false);

        slot.emitOsc(133, "D;0");
        expect(getSessionBlockMode(blockId)).toBe("prompt");
        expect(slot.term.options.disableStdin).toBe(true);
    });

    it("keeps stdin disabled at the prompt after the shell exits", async () => {
        const { blockId, slot } = await attachReady({ blocks: true });
        statusSubFor(blockId).handler({ event: "controllerstatus", data: { shellprocstatus: "done" } });
        statusSubFor(blockId).handler({ event: "controllerstatus", data: { shellprocstatus: "running" } });
        expect(slot.term.options.disableStdin).toBe(true);
    });

    it("notifies mode subscribers that registered before the session existed", async () => {
        const blockId = newBlockId();
        const listener = vi.fn();
        subscribeSessionBlockMode(blockId, listener);
        attachSession(blockId, fakeContainer(), {}, { blocks: true });
        setSessionVisibility(blockId, true, true);
        await flushAsync();

        const slot: FakeSlot = h.pool.slots.get(sessionLeafId(blockId));
        slot.emitOsc(133, "C");
        expect(getSessionBlockMode(blockId)).toBe("running");
        expect(listener).toHaveBeenCalled();
    });

    it("refocuses the input bar when a command returns to the prompt", async () => {
        vi.useFakeTimers();
        const { blockId, slot } = await attachReady({ blocks: true });
        const focusInput = vi.fn();
        setSessionInputFocus(blockId, focusInput);

        slot.emitOsc(133, "C");
        expect(focusInput).not.toHaveBeenCalled();
        slot.emitOsc(133, "D;0");
        await vi.advanceTimersByTimeAsync(0);
        expect(focusInput).toHaveBeenCalledTimes(1);
    });

    it("exposes finished blocks through the read/search accessors", async () => {
        const { blockId, slot } = await attachReady({ blocks: true });
        slot.emitOsc(133, "C");
        slot.emitOsc(133, "D;0");
        expect(readSessionBlockOutput(blockId, "b1")).toBe("");
        expect(readSessionBlockOutput(blockId, "nope")).toBeNull();
        expect(searchSessionBlock(blockId, "b1", "zzz")).toEqual([]);
        expect(readSessionBlockOutput("no-such-block", "b1")).toBeNull();
    });

    it("enriches decorations from cmdblock:row and skips non-shell rows", async () => {
        const { blockId, slot } = await attachReady({ blocks: true });
        giveFakeScreen(slot);
        slot.emitOsc(133, "C");
        slot.emitOsc(133, "D;0");

        const sub = rowSubFor(blockId);
        expect(sub).toBeTruthy();
        sub.handler({
            event: "cmdblock:row",
            data: {
                state: "done",
                kind: "agent",
                cmd: "not-a-shell-row",
                tscmdns: Date.now() * 1e6,
                tsdonens: Date.now() * 1e6,
            },
        });
        sub.handler({
            event: "cmdblock:row",
            data: {
                state: "done",
                kind: "shell",
                cmd: "make build",
                exitcode: 0,
                durationms: 250,
                tscmdns: Date.now() * 1e6,
                tsdonens: Date.now() * 1e6,
            },
        });

        const vis = getSessionVisibleBlocks(blockId);
        expect(vis.blocks).toHaveLength(1);
        expect(vis.blocks[0].command).toBe("make build");
        expect(vis.blocks[0].finishedAt - vis.blocks[0].startedAt).toBe(250);
    });

    it("does not subscribe to cmdblock:row for plain sessions", async () => {
        const { blockId } = await attachReady();
        expect(rowSubFor(blockId)).toBeUndefined();
    });

    it("drives the watermark visible → hidden (typing) → dead (submit)", async () => {
        const { blockId } = await attachReady({ blocks: true });
        expect(getSessionWatermarkState(blockId)).toBe("visible");

        setSessionInputActivity(blockId, true);
        expect(getSessionWatermarkState(blockId)).toBe("hidden");
        setSessionInputActivity(blockId, false);
        expect(getSessionWatermarkState(blockId)).toBe("visible");

        const ping = vi.fn();
        subscribeSessionBlocks(blockId, ping);
        submitToSession(blockId, "ls");
        expect(ping).toHaveBeenCalled();
        expect(getSessionWatermarkState(blockId)).toBe("dead");
        expect(getSessionWatermarkState("no-such-block")).toBe("dead");
    });
});
