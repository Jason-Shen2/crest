// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atoms, fetchWaveFile, globalStore } from "@/store/global";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { ensureAgentActivityListener, isAgentActive } from "./agent-activity";
import { BlockDecorations, type BlockMatch, type BlockRowMeta, type VisibleBlocks } from "./block/block-decorations";
import type { WatermarkState } from "./block/block-watermark";
import {
    initialModeState,
    modeOf,
    reduceMode,
    type BlockMode,
    type ModeEvent,
    type ModeState,
} from "./block/mode-machine";
import { DormantRing } from "./dormant-ring";
import {
    createShellIntegrationState,
    registerCwdHandler,
    registerOsc52ClipboardHandler,
    registerPromptTracker,
} from "./osc-handlers";
import { attachPty, type PtySession } from "./pty-bridge";
import {
    acquireSlot,
    configureRendererPool,
    disposeLeafSlot,
    focusSlot,
    getLiveSlotForLeaf,
    getSlotForLeaf,
    isLeafAltScreen,
    parkLeafSlot,
    refreshLeafSlot,
    releaseSlot,
    setSlotFocused,
} from "./renderer-pool";

const TermFileName = "term";
const ShellStatusDone = "done";
const HiddenReleaseDelayMs = 300;
const RowStateDone = "done";
const RowKindShell = "shell";
// cmdblock:row events buffered while no BlockDecorations instance exists yet
// (pre-bind, mid-rebind). Rows older than the age cap can no longer time-align
// with anything and are dropped instead of being retried every frame.
const PendingRowsMax = 32;
const PendingRowMaxAgeMs = 15000;
// Cursor marker interpolated into the screen text at the cursor position.
// Mirrors Warp's CURSOR_MARKER — the exact string is part of the pty_read
// contract with emain (emain/agent/tools/pty-read.ts renders it verbatim).
const CursorMarker = "<|cursor|>";
// Row window cap for non-alt-screen snapshots; alt-screen reads the full
// buffer. Same 1000-row cap as the old engine's SCREEN_SNAPSHOT_MAX_ROWS.
const ScreenSnapshotMaxRows = 1000;
// Fallbacks for the find-decoration colors when the CSS vars are unreadable
// (headless test env); values mirror tailwindsetup.css --color-term-*.
const FindMatchBackgroundFallback = "#76a7fa";
const FindActiveMatchFallback = "#19aad8";
const AnsiRe =
    /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[78=>]|\x1bc|\x1b[NOP\]X^_]/g;

export type SessionCallbacks = {
    onSearchReady?: (addon: SearchAddon) => void;
    onShellExit?: () => void;
    onShellRestart?: () => void;
    onCwd?: (cwd: string) => void;
};

export type AttachSessionOptions = {
    blocks?: boolean;
};

type XtermSession = {
    blockId: string;
    leafId: number;
    pty: PtySession;
    lastCwd: string;
    shellExited: boolean;
    callbacks: SessionCallbacks;
    visibleNow: boolean;
    focusedNow: boolean;
    disposed: boolean;
    cols: number;
    rows: number;
    container: HTMLDivElement;
    snapshot: string;
    searchQuery: string;
    dormantRing: DormantRing;
    hasSlot: boolean;
    blocks: boolean;
    blockMode: BlockMode;
    modeState: ModeState;
    blockDecorations: BlockDecorations;
    // Set by the block input bar; called to pull focus back when the xterm
    // grid steals it at the prompt (e.g. on a click), so typing stays in the bar.
    inputFocus: () => void;
    // Live "input has text" flag from the block input bar (gates the watermark).
    inputActive: boolean;
    // Go cmdblock:row metadata not yet matched to a decoration entry.
    pendingRows: BlockRowMeta[];
    // A command was submitted on this session; kills the watermark synchronously,
    // before the shell's OSC 133 C round-trips through the PTY.
    everSubmitted: boolean;
    // True if the slot was in alt-screen mode (TUI like vim, htop, dofek)
    // at the most recent release. Read once on the next bind to trigger a
    // SIGWINCH-driven repaint instead of replaying dormant bytes.
    altScreenAtRelease: boolean;
    // OSC 133 C..D window: a foreground process owns the terminal, so the
    // session must keep its live grid while hidden.
    commandRunning: boolean;
    // Cold restore in flight: appends must ring until the fetched blockfile
    // replays, even when a live slot is already bound.
    restoring: boolean;
    hiddenReleaseTimer: ReturnType<typeof setTimeout>;
    statusUnsub: () => void;
    rowUnsub: () => void;
};

const sessions = new Map<string, XtermSession>();

// Mode/viewport listeners live at module scope keyed by blockId (not on the
// session) so a React useSyncExternalStore subscription made before the attach
// effect creates the session still receives updates — same reasoning as
// terax's blockViewportListeners map.
const blockModeListeners = new Map<string, Set<() => void>>();
const blockViewportListeners = new Map<string, Set<() => void>>();

function subscribeKeyed(map: Map<string, Set<() => void>>, blockId: string, cb: () => void): () => void {
    let set = map.get(blockId);
    if (!set) {
        set = new Set();
        map.set(blockId, set);
    }
    set.add(cb);
    return () => {
        const live = map.get(blockId);
        live?.delete(cb);
        if (live && live.size === 0) map.delete(blockId);
    };
}

function notifyKeyed(map: Map<string, Set<() => void>>, blockId: string): void {
    const set = map.get(blockId);
    if (!set) return;
    for (const l of set) l();
}

// renderer-pool's SlotAdapter/LeafBridge seam kept terax's numeric leafId while
// crest keys sessions by blockId (the leaf IS the block), so each block gets a
// stable numeric alias here. Registry entries are never removed: a reused
// number could otherwise point a stale retained slot at a new block's session.
const blockToLeaf = new Map<string, number>();
const leafToBlock = new Map<number, string>();
let nextLeafId = 1;

function leafIdForBlock(blockId: string): number {
    const existing = blockToLeaf.get(blockId);
    if (existing != null) return existing;
    const leafId = nextLeafId++;
    blockToLeaf.set(blockId, leafId);
    leafToBlock.set(leafId, blockId);
    return leafId;
}

function sessionForLeaf(leafId: number): XtermSession {
    const blockId = leafToBlock.get(leafId);
    if (blockId == null) return null;
    return sessions.get(blockId) ?? null;
}

export function sessionLeafId(blockId: string): number {
    return sessions.get(blockId)?.leafId ?? null;
}

export function writeToSession(blockId: string, data: string): boolean {
    const s = sessions.get(blockId);
    if (!s || s.shellExited || !s.pty) return false;
    void s.pty.write(data);
    return true;
}

export function submitToSession(blockId: string, text: string): void {
    const s = sessions.get(blockId);
    if (!s || s.shellExited || !s.pty) return;
    s.everSubmitted = true;
    // Bracketed paste keeps a multiline command atomic; trailing CR runs it.
    const data = text.includes("\n") ? `\x1b[200~${text}\x1b[201~\r` : `${text}\r`;
    void s.pty.write(data);
    // The watermark reads everSubmitted through the viewport subscription; the
    // next OSC 133 C is a PTY round-trip away, so notify now.
    notifyKeyed(blockViewportListeners, blockId);
}

export function interruptSession(blockId: string): void {
    const s = sessions.get(blockId);
    if (!s?.pty) return;
    void s.pty.write("\x03");
}

export function resizeSession(blockId: string, cols: number, rows: number): void {
    const s = sessions.get(blockId);
    if (!s?.pty || cols <= 0 || rows <= 0) return;
    s.cols = cols;
    s.rows = rows;
    void s.pty.resize(cols, rows);
}

export function sessionCwd(blockId: string): string {
    return sessions.get(blockId)?.lastCwd ?? null;
}

export function getSessionBlockMode(blockId: string): BlockMode {
    return sessions.get(blockId)?.blockMode ?? "prompt";
}

export function subscribeSessionBlockMode(blockId: string, cb: () => void): () => void {
    return subscribeKeyed(blockModeListeners, blockId, cb);
}

export function subscribeSessionBlocks(blockId: string, cb: () => void): () => void {
    return subscribeKeyed(blockViewportListeners, blockId, cb);
}

const EmptyVisibleBlocks: VisibleBlocks = { blocks: [], sticky: null };

export function getSessionVisibleBlocks(blockId: string): VisibleBlocks {
    return sessions.get(blockId)?.blockDecorations?.visibleBlocks() ?? EmptyVisibleBlocks;
}

export function readSessionBlockOutput(blockId: string, id: string): string | null {
    return sessions.get(blockId)?.blockDecorations?.readById(id)?.output ?? null;
}

export function searchSessionBlock(blockId: string, id: string, query: string): BlockMatch[] {
    return sessions.get(blockId)?.blockDecorations?.searchBlock(id, query) ?? [];
}

export function revealSessionBlockMatch(blockId: string, m: BlockMatch): void {
    sessions.get(blockId)?.blockDecorations?.revealMatch(m);
}

export function clearSessionBlockSearch(blockId: string): void {
    sessions.get(blockId)?.blockDecorations?.clearSearch();
}

export function selectSessionBlockAt(blockId: string, clientY: number): void {
    sessions.get(blockId)?.blockDecorations?.selectBlockAt(clientY);
}

export function setSessionInputFocus(blockId: string, fn: (() => void) | null): void {
    const s = sessions.get(blockId);
    if (s) s.inputFocus = fn;
}

export function focusSessionInput(blockId: string): void {
    sessions.get(blockId)?.inputFocus?.();
}

export function setSessionInputActivity(blockId: string, active: boolean): void {
    const s = sessions.get(blockId);
    if (!s || s.inputActive === active) return;
    s.inputActive = active;
    notifyKeyed(blockViewportListeners, blockId);
}

// Watermark gate, ported from terax blockWatermarkState: a block terminal that
// has never run a command, whose grid is still untouched, and whose input is
// empty. Synchronous so tab switches, slot rebinds and the Enter-to-OSC-133
// gap never flash it over real content. "dead" is permanent and lets the
// component unmount for good. The grid check scans glyphs, not the cursor: the
// prompt integration prints a blank gap line at spawn, so the cursor sits
// below row 0 even on a visually empty terminal.
export function getSessionWatermarkState(blockId: string): WatermarkState {
    const s = sessions.get(blockId);
    if (!s || s.disposed) return "dead";
    if (s.everSubmitted || s.blockDecorations?.hasAnyBlock()) return "dead";
    if (!s.blockDecorations || s.inputActive) return "hidden";
    const slot = getSlotForLeaf(s.leafId);
    if (!slot) return "hidden";
    const buf = slot.term.buffer.active;
    if (buf.baseY > 0) return "dead";
    const rows = Math.min(buf.length, slot.term.rows);
    for (let i = 0; i < rows; i++) {
        if (buf.getLine(i)?.translateToString(true)) return "dead";
    }
    return "visible";
}

export function focusSession(blockId: string): void {
    const s = sessions.get(blockId);
    if (!s) return;
    focusSlot(s.leafId);
}

export function setSessionSearchQuery(blockId: string, query: string): void {
    const s = sessions.get(blockId);
    if (s) s.searchQuery = query;
}

export type SessionFindOptions = {
    caseSensitive?: boolean;
    regex?: boolean;
};

// Mirrors terax's TERM_DECORATIONS (SearchInline.tsx) but sourced from the
// crest palette so match highlights track the selection/accent CSS vars.
function findDecorations(): ISearchOptions["decorations"] {
    let selection: string;
    let accent: string;
    if (typeof document !== "undefined") {
        const style = getComputedStyle(document.documentElement);
        selection = style.getPropertyValue("--color-term-selection").trim();
        accent = style.getPropertyValue("--color-term-accent").trim();
    }
    return {
        matchBackground: selection || FindMatchBackgroundFallback,
        matchOverviewRuler: accent || FindActiveMatchFallback,
        activeMatchBackground: accent || FindActiveMatchFallback,
        activeMatchColorOverviewRuler: accent || FindActiveMatchFallback,
    };
}

function findSearchOptions(opts: SessionFindOptions): ISearchOptions {
    return {
        caseSensitive: opts.caseSensitive,
        regex: opts.regex,
        decorations: findDecorations(),
    };
}

// Find accessors delegate to the bound slot's SearchAddon and no-op while the
// session is dormant (no slot, or only a retained one). The query is always
// recorded on the session so the next bind replays the highlight
// (bindSlot's searchQuery param).
export function findInSession(blockId: string, query: string, opts: SessionFindOptions = {}): void {
    const s = sessions.get(blockId);
    if (!s) return;
    s.searchQuery = query || null;
    const slot = getSlotForLeaf(s.leafId);
    if (!slot) return;
    try {
        if (!query) {
            slot.searchAddon.clearDecorations();
            return;
        }
        slot.searchAddon.findNext(query, { ...findSearchOptions(opts), incremental: true });
    } catch {}
}

export function findNextInSession(blockId: string, query: string, opts: SessionFindOptions = {}): void {
    const s = sessions.get(blockId);
    if (!s || !query) return;
    s.searchQuery = query;
    const slot = getSlotForLeaf(s.leafId);
    if (!slot) return;
    try {
        slot.searchAddon.findNext(query, findSearchOptions(opts));
    } catch {}
}

export function findPreviousInSession(blockId: string, query: string, opts: SessionFindOptions = {}): void {
    const s = sessions.get(blockId);
    if (!s || !query) return;
    s.searchQuery = query;
    const slot = getSlotForLeaf(s.leafId);
    if (!slot) return;
    try {
        slot.searchAddon.findPrevious(query, findSearchOptions(opts));
    } catch {}
}

export function clearSessionFind(blockId: string): void {
    const s = sessions.get(blockId);
    if (!s) return;
    s.searchQuery = null;
    const slot = getSlotForLeaf(s.leafId);
    if (!slot) return;
    try {
        slot.searchAddon.clearDecorations();
    } catch {}
}

export function getSessionBuffer(blockId: string, maxLines = 200): string {
    const s = sessions.get(blockId);
    if (!s) return null;
    const slot = getLiveSlotForLeaf(s.leafId);
    if (slot) {
        const buf = slot.term.buffer.active;
        const total = buf.length;
        const lines: string[] = [];
        const start = Math.max(0, total - maxLines);
        for (let i = start; i < total; i++) {
            lines.push(buf.getLine(i)?.translateToString(true) ?? "");
        }
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        return lines.join("\n");
    }
    if (!s.snapshot) return "";
    const plain = stripAnsi(s.snapshot);
    const lines = plain.split(/\r?\n/);
    const tail = lines.slice(-maxLines);
    while (tail.length && tail[tail.length - 1] === "") tail.pop();
    return tail.join("\n");
}

function stripAnsi(text: string): string {
    return text.replace(AnsiRe, "");
}

// PtyScreenSnapshot — renderer→emain payload for the CLI subagent's
// pty_read screen branch. Field names are the wire contract mirrored in
// emain/emain-web.ts; keep them in sync.
export type PtyScreenSnapshot = {
    grid_contents: string;
    cursor: string;
    is_alt_screen_active: boolean;
    block_id: string;
};

// Ports the old engine's serializeGridForInput contract (terminal-model.ts,
// deleted in P1.7): rows windowed to maxRowCount centered on the cursor
// (null = full buffer, used for alt-screen), the cursor marker interpolated
// at the cursor cell, per-line trailing-whitespace trim, and trailing blank
// lines dropped ("" when the whole window is blank).
function serializeTermScreenForInput(term: Terminal, maxRowCount: number | null): string {
    const buf = term.buffer.active;
    const cursorRow = (buf.baseY ?? 0) + (buf.cursorY ?? 0);
    const cursorCol = buf.cursorX ?? 0;
    const maxContentRow = Math.max(buf.length - 1, 0);
    let startRow: number;
    let endRow: number;
    if (maxRowCount != null) {
        endRow = Math.min(maxContentRow, cursorRow + Math.floor(maxRowCount / 2));
        startRow = Math.max(endRow - maxRowCount, 0);
    } else {
        startRow = 0;
        endRow = maxContentRow;
    }
    const lines: string[] = [];
    let lastNonblank = -1;
    for (let r = startRow; r <= endRow; r++) {
        const line = buf.getLine(r);
        let s: string;
        if (line == null) {
            s = r === cursorRow ? CursorMarker : "";
        } else if (r === cursorRow) {
            // translateToString's column args are buffer cells, so wide
            // (CJK) glyphs before the cursor can't skew the marker position.
            s = line.translateToString(false, 0, cursorCol) + CursorMarker + line.translateToString(false, cursorCol);
        } else {
            s = line.translateToString(false);
        }
        const trimmed = s.replace(/\s+$/g, "");
        if (trimmed.length > 0) lastNonblank = lines.length;
        lines.push(trimmed);
    }
    if (lastNonblank < 0) return "";
    return lines.slice(0, lastNonblank + 1).join("\n");
}

// Non-destructive DormantRing read: drain() clears the ring, but the bytes
// still owe a replay to the next slot bind, so the snapshot must only peek.
function peekRingText(ring: DormantRing): string {
    const last = ring.blocks.length - 1;
    let total = 0;
    for (let i = ring.head; i <= last; i++) {
        total += i === last ? ring.tailLen : ring.blocks[i].length;
    }
    if (total === 0) return "";
    const merged = new Uint8Array(total);
    let off = 0;
    for (let i = ring.head; i <= last; i++) {
        const len = i === last ? ring.tailLen : ring.blocks[i].length;
        merged.set(ring.blocks[i].subarray(0, len), off);
        off += len;
    }
    return stripAnsi(new TextDecoder().decode(merged));
}

// Slotless fallback: the exact cursor cell is unknowable without a live
// grid, so the marker lands at the end of the last non-blank line (the
// prompt position for an idle shell).
function snapshotFallbackContents(s: XtermSession): string | null {
    const text = s.snapshot != null ? stripAnsi(s.snapshot) : peekRingText(s.dormantRing);
    if (!text) return null;
    const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/g, ""));
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) return null;
    const tail = lines.slice(-ScreenSnapshotMaxRows);
    tail[tail.length - 1] += CursorMarker;
    return tail.join("\n");
}

// getPtyScreenSnapshot — resolve a block's current screen for the CLI
// subagent's pty_read screen branch (window.getPtyScreenSnapshot in
// wave.ts; emain reaches it via executeJavaScript, see emain-web.ts
// webPtyScreenSnapshot). Returns null when there is nothing to snapshot
// so emain degrades to the transcript tail.
export function getPtyScreenSnapshot(blockId: string): PtyScreenSnapshot | null {
    const s = sessions.get(blockId);
    if (!s) return null;
    const slot = getLiveSlotForLeaf(s.leafId);
    if (slot) {
        const isAlt = slot.term.buffer.active.type === "alternate";
        return {
            grid_contents: serializeTermScreenForInput(slot.term, isAlt ? null : ScreenSnapshotMaxRows),
            cursor: CursorMarker,
            is_alt_screen_active: isAlt,
            block_id: blockId,
        };
    }
    const contents = snapshotFallbackContents(s);
    if (contents == null) return null;
    return {
        grid_contents: contents,
        cursor: CursorMarker,
        is_alt_screen_active: s.altScreenAtRelease,
        block_id: blockId,
    };
}

export function getSessionScreenSnapshot(blockId: string): string | null {
    return getPtyScreenSnapshot(blockId)?.grid_contents ?? null;
}

function sessionBusy(s: XtermSession): boolean {
    return s.commandRunning || isAgentActive(s.blockId);
}

// A parked hidden leaf went idle: give the post-command prompt a moment to
// render into the live buffer, then hand the slot back to the pool.
function scheduleHiddenRelease(s: XtermSession): void {
    if (s.visibleNow || !s.hasSlot) return;
    cancelHiddenRelease(s);
    s.hiddenReleaseTimer = setTimeout(() => {
        s.hiddenReleaseTimer = null;
        if (s.disposed || s.visibleNow || !s.hasSlot) return;
        if (s.blocks || isLeafAltScreen(s.leafId) || sessionBusy(s)) return;
        // terax released synchronously here; crest's foreground-job probe is an
        // async RPC, so the release funnels through releaseIfIdle to keep the
        // job veto on this path too.
        void releaseIfIdle(s);
    }, HiddenReleaseDelayMs);
}

function cancelHiddenRelease(s: XtermSession): void {
    if (s.hiddenReleaseTimer != null) {
        clearTimeout(s.hiddenReleaseTimer);
        s.hiddenReleaseTimer = null;
    }
}

async function releaseIfIdle(s: XtermSession): Promise<void> {
    const busy = await sessionHasForegroundJob(s);
    if (busy || s.disposed || s.visibleNow || !s.hasSlot) return;
    if (s.blocks || isLeafAltScreen(s.leafId) || sessionBusy(s)) return;
    unbindSessionFromSlot(s);
}

async function sessionHasForegroundJob(s: XtermSession): Promise<boolean> {
    if (!s.pty || s.shellExited) return false;
    try {
        return await RpcApi.ControllerHasForegroundJobCommand(TabRpcClient, s.blockId);
    } catch (e) {
        // Per the RPC's graceful-degradation contract an error means no veto:
        // remote/durable controllers report false, and a transport hiccup must
        // not pin a hidden slot's renderer forever. Hibernating a remote or
        // durable block is acceptable — its output keeps ringing and replays on
        // the next bind.
        console.error("[xterm-session] foreground-job check failed for block", s.blockId, e);
        return false;
    }
}

function onSessionCommandState(s: XtermSession, running: boolean): void {
    if (s.commandRunning === running) return;
    s.commandRunning = running;
    if (!running) {
        scheduleHiddenRelease(s);
        return;
    }
    cancelHiddenRelease(s);
    // A command started in a hidden released leaf (e.g. submitted by the AI):
    // rebind its retained slot so output parses live instead of filling the
    // ring. Deferred: this callback fires inside xterm's parse loop and the
    // rebind touches the same terminal (fit/resize).
    if (!s.visibleNow && !s.hasSlot && s.container && !s.disposed) {
        setTimeout(() => {
            if (s.disposed || s.visibleNow || s.hasSlot || !s.container) return;
            if (!sessionBusy(s)) return;
            bindSessionToSlot(s);
            parkLeafSlot(s.leafId);
        }, 0);
    }
}

ensureAgentActivityListener((blockId) => {
    const s = sessions.get(blockId);
    if (s) scheduleHiddenRelease(s);
});

configureRendererPool({
    resolveLeaf(leafId) {
        const s = sessionForLeaf(leafId);
        if (!s?.pty) return null;
        const pty = s.pty;
        return {
            writeToPty: (data) => {
                if (s.shellExited) return;
                void pty.write(data);
            },
            resizePty: (cols, rows) => {
                s.cols = cols;
                s.rows = rows;
                void pty.resize(cols, rows);
            },
            kickPty: (cols, rows) => {
                pty.kick(cols, rows).catch((e) => console.warn("[xterm-session] kickPty failed:", e));
            },
        };
    },
    evictLeaf(leafId) {
        const s = sessionForLeaf(leafId);
        if (!s) return;
        unbindSessionFromSlot(s);
    },
    isLeafFocused(leafId) {
        const s = sessionForLeaf(leafId);
        return !!s && s.visibleNow && s.focusedNow;
    },
    isLeafBlocks(leafId) {
        return sessionForLeaf(leafId)?.blocks ?? false;
    },
    isLeafBusy(leafId) {
        const s = sessionForLeaf(leafId);
        return !!s && sessionBusy(s);
    },
    isLeafVisible(leafId) {
        return sessionForLeaf(leafId)?.visibleNow ?? false;
    },
    storeSnapshot(leafId, out) {
        const s = sessionForLeaf(leafId);
        if (!s) return;
        s.snapshot = out.snapshot;
        if (out.cols > 0) s.cols = out.cols;
        if (out.rows > 0) s.rows = out.rows;
        s.altScreenAtRelease = out.altScreen;
    },
});

function deliverPtyBytes(s: XtermSession, bytes: Uint8Array): void {
    if (s.disposed) return;
    // Cold restore in flight: even a live slot must not see appends before the
    // fetched blockfile replays, so everything rings until then.
    if (s.restoring) {
        s.dormantRing.push(bytes);
        return;
    }
    // Retained slots keep parsing live (render paused); the ring is only for
    // leaves whose buffer was stolen or never bound.
    const slot = getLiveSlotForLeaf(s.leafId);
    if (slot) slot.term.write(bytes);
    else s.dormantRing.push(bytes);
}

// Cold-restore ordering (docs/terax-terminal-port.md §五 risk 3): the pty
// subscription is live BEFORE this fetch starts, and every append that lands
// while it is in flight rings behind the restoring flag. Replaying the fetched
// file first and draining the ring after guarantees no append is lost; an
// append the backend also folded into the fetched file may replay twice, which
// the doc accepts over byte-offset reconciliation (the bug class that froze
// the old engine).
async function coldRestoreScrollback(s: XtermSession): Promise<void> {
    let data: Uint8Array = null;
    try {
        const file = await fetchWaveFile(s.blockId, TermFileName);
        data = file.data;
    } catch (e) {
        console.warn("[xterm-session] scrollback fetch failed for block", s.blockId, e);
    }
    if (s.disposed) return;
    s.restoring = false;
    const slot = getLiveSlotForLeaf(s.leafId);
    if (slot) {
        if (data != null && data.length > 0) slot.term.write(data);
        s.dormantRing.drain((bytes) => slot.term.write(bytes));
        return;
    }
    if (data == null || data.length === 0) return;
    // No slot yet: rebuild the ring with the file first so the next bind
    // replays history before the appends that raced in during the fetch.
    const ring = new DormantRing();
    ring.push(data);
    s.dormantRing.drain((bytes) => ring.push(bytes));
    s.dormantRing = ring;
}

function handleTruncate(s: XtermSession): void {
    s.snapshot = null;
    s.dormantRing = new DormantRing();
    const slot = getLiveSlotForLeaf(s.leafId);
    if (slot) {
        slot.term.clear();
        slot.term.reset();
    }
}

function applyShellStatus(s: XtermSession, exited: boolean): void {
    if (s.disposed || s.shellExited === exited) return;
    s.shellExited = exited;
    const slot = getSlotForLeaf(s.leafId);
    // Blocks mode keeps stdin gated at the prompt regardless of exit state.
    if (slot) slot.term.options.disableStdin = exited || (s.blocks && s.blockMode === "prompt");
    if (!exited) {
        s.callbacks.onShellRestart?.();
        return;
    }
    s.commandRunning = false;
    scheduleHiddenRelease(s);
    s.callbacks.onShellExit?.();
}

function applyModeEvent(s: XtermSession, event: ModeEvent): void {
    s.modeState = reduceMode(s.modeState, event);
    const mode = modeOf(s.modeState);
    if (s.blockMode === mode) return;
    s.blockMode = mode;
    notifyKeyed(blockModeListeners, s.blockId);
}

// Blocks-mode counterpart of applyModeEvent, ported from terax's
// applyBlockMode (useTerminalSession.ts:563-583): at the prompt the xterm grid
// is read-only — stdin disabled so stray keys can't reach the pty, the helper
// textarea disabled so a grid click can't flash the xterm cursor or steal
// focus from the input bar. During running/alt the grid takes over (raw
// passthrough) and the input bar hides.
function applySessionBlockMode(s: XtermSession, mode: BlockMode): void {
    s.blockMode = mode;
    s.commandRunning = mode !== "prompt";
    const slot = getSlotForLeaf(s.leafId);
    if (slot) {
        const prompt = mode === "prompt";
        slot.term.options.disableStdin = prompt || s.shellExited;
        if (slot.term.textarea) slot.term.textarea.disabled = prompt;
        // Focus moves only while this pane actually holds focus — a parked
        // hidden slot parsing AI-submitted output must not steal it.
        if (!prompt) {
            if (s.visibleNow && s.focusedNow) slot.term.focus();
        } else if (s.visibleNow && s.focusedNow && s.inputFocus) {
            const inputFocus = s.inputFocus;
            setTimeout(inputFocus, 0);
        }
    }
    notifyKeyed(blockModeListeners, s.blockId);
}

function rowMetaFromCmdBlock(row: CmdBlock): BlockRowMeta {
    return {
        cmd: row.cmd,
        exitCode: row.exitcode,
        durationMs: row.durationms,
        startedAt: row.tscmdns != null ? Math.round(row.tscmdns / 1e6) : null,
        finishedAt: row.tsdonens != null ? Math.round(row.tsdonens / 1e6) : null,
        running: row.state !== RowStateDone,
    };
}

function onSessionRow(s: XtermSession, row: CmdBlock): void {
    if (s.disposed || row == null) return;
    if (row.kind != null && row.kind !== RowKindShell) return;
    const meta = rowMetaFromCmdBlock(row);
    if (s.blockDecorations?.applyRowMeta(meta)) {
        notifyKeyed(blockViewportListeners, s.blockId);
        return;
    }
    // Running rows are superseded by their own done row; only done rows are
    // worth retrying once decorations (re)exist.
    if (meta.running) return;
    s.pendingRows.push(meta);
    if (s.pendingRows.length > PendingRowsMax) s.pendingRows.shift();
}

function replayPendingRows(s: XtermSession): void {
    const deco = s.blockDecorations;
    if (!deco || s.pendingRows.length === 0) return;
    const cutoff = Date.now() - PendingRowMaxAgeMs;
    let applied = false;
    s.pendingRows = s.pendingRows.filter((row) => {
        if (deco.applyRowMeta(row)) {
            applied = true;
            return false;
        }
        return (row.finishedAt ?? row.startedAt ?? 0) >= cutoff;
    });
    if (applied) notifyKeyed(blockViewportListeners, s.blockId);
}

function registerSessionBlockOsc(s: XtermSession, term: Terminal): (() => void)[] {
    const osc52 = registerOsc52ClipboardHandler(term);
    const deco = new BlockDecorations(term, {
        onCwd: (next) => {
            if (s.lastCwd === next) return;
            s.lastCwd = next;
            s.callbacks.onCwd?.(next);
        },
        onMode: (mode) => applySessionBlockMode(s, mode),
        onViewport: () => {
            replayPendingRows(s);
            notifyKeyed(blockViewportListeners, s.blockId);
        },
    });
    s.blockDecorations = deco;
    const onGridFocus = () => {
        if (s.blockMode === "prompt") s.inputFocus?.();
    };
    term.textarea?.addEventListener("focus", onGridFocus);
    return [
        () => {
            if (s.blockDecorations === deco) s.blockDecorations = null;
            osc52();
            deco.dispose();
            term.textarea?.removeEventListener("focus", onGridFocus);
        },
    ];
}

function registerSessionOsc(s: XtermSession, term: Terminal): (() => void)[] {
    if (s.blocks) return registerSessionBlockOsc(s, term);
    // Shared in-command flag — see osc-handlers.ts. The prompt tracker flips it
    // on OSC 133 B/C/D/A; the cwd handler reads it to ignore OSC 7 emitted by
    // untrusted command output (remote SSH, `cat` of an attacker file, etc.).
    const shellState = createShellIntegrationState();
    const prompt = registerPromptTracker(
        term,
        shellState,
        (running) => onSessionCommandState(s, running),
        (event) => applyModeEvent(s, event)
    );
    const cwd = registerCwdHandler(
        term,
        (next) => {
            if (s.lastCwd === next) return;
            s.lastCwd = next;
            s.callbacks.onCwd?.(next);
        },
        shellState
    );
    const osc52 = registerOsc52ClipboardHandler(term);
    const bufferChange = term.buffer.onBufferChange(() => {
        applyModeEvent(s, { type: "altScreen", active: term.buffer.active.type === "alternate" });
    });
    return [prompt.dispose, cwd, osc52, () => bufferChange.dispose()];
}

function bindSessionToSlot(s: XtermSession): void {
    if (!s.container) return;
    const altScreen = s.altScreenAtRelease;
    s.altScreenAtRelease = false;
    acquireSlot({
        leafId: s.leafId,
        container: s.container,
        snapshot: s.snapshot,
        altScreen,
        // Cold restore still in flight: the ring holds appends that must land
        // AFTER the fetched blockfile replays, so the bind must not drain it.
        drainRing: (write) => {
            if (s.restoring) return;
            s.dormantRing.drain(write);
        },
        shellExited: s.shellExited,
        searchQuery: s.searchQuery,
        cols: s.cols,
        rows: s.rows,
        registerOsc: (term) => registerSessionOsc(s, term),
        onSearchReady: (addon) => s.callbacks.onSearchReady?.(addon),
    });
    s.snapshot = null;
    s.hasSlot = true;
    if (s.blocks) {
        applySessionBlockMode(s, s.blockMode);
        replayPendingRows(s);
    }
    if (s.lastCwd != null) s.callbacks.onCwd?.(s.lastCwd);
}

function unbindSessionFromSlot(s: XtermSession): void {
    if (!s.hasSlot) return;
    const out = releaseSlot(s.leafId);
    if (out) {
        if (out.cols > 0) s.cols = out.cols;
        if (out.rows > 0) s.rows = out.rows;
    }
    s.hasSlot = false;
}

function ensureSession(blockId: string, blocks: boolean): XtermSession {
    const existing = sessions.get(blockId);
    if (existing) return existing;

    const s: XtermSession = {
        blockId,
        leafId: leafIdForBlock(blockId),
        pty: null,
        lastCwd: null,
        shellExited: false,
        callbacks: {},
        visibleNow: false,
        focusedNow: false,
        disposed: false,
        cols: 0,
        rows: 0,
        container: null,
        snapshot: null,
        searchQuery: null,
        dormantRing: new DormantRing(),
        hasSlot: false,
        blocks,
        blockMode: "prompt",
        modeState: initialModeState(),
        blockDecorations: null,
        inputFocus: null,
        inputActive: false,
        pendingRows: [],
        everSubmitted: false,
        altScreenAtRelease: false,
        commandRunning: false,
        restoring: true,
        hiddenReleaseTimer: null,
        statusUnsub: null,
        rowUnsub: null,
    };
    sessions.set(blockId, s);

    // Subscribe before asking the backend to start/resume the controller so
    // the first prompt bytes cannot race past the file subject.
    s.pty = attachPty(blockId, {
        onData: (bytes) => deliverPtyBytes(s, bytes),
        onTruncate: () => handleTruncate(s),
        onShellExit: () => applyShellStatus(s, true),
    });

    // A block's controller metadata is declarative; creating the block does
    // not itself spawn the shell. The legacy TerminalModel performed this
    // mount handshake, so the xterm session must retain it after the engine
    // replacement. One session issues one idempotent resync.
    const tabId = atoms.staticTabId == null ? null : globalStore.get(atoms.staticTabId);
    if (tabId) {
        void RpcApi.ControllerResyncCommand(TabRpcClient, {
            tabid: tabId,
            blockid: blockId,
        }).catch(() => {
            // Non-fatal: a live controller may already be running, and its
            // stream remains authoritative.
        });
    }

    s.statusUnsub = waveEventSubscribeSingle({
        eventType: "controllerstatus",
        scope: `block:${blockId}`,
        handler: (event) => {
            const status = event.data;
            if (status?.shellprocstatus == null) return;
            applyShellStatus(s, status.shellprocstatus === ShellStatusDone);
        },
    });

    // Go's Tracker publishes persisted per-command metadata (cmd/exitcode/
    // durationms) as a sidecar to the raw stream; decorations use it to
    // enrich the OSC-133 blocks (docs/terax-terminal-port.md §四 P3.1).
    if (blocks) {
        s.rowUnsub = waveEventSubscribeSingle({
            eventType: "cmdblock:row",
            scope: `block:${blockId}`,
            handler: (event) => onSessionRow(s, event.data as CmdBlock),
        });
    }

    void coldRestoreScrollback(s);
    return s;
}

export function attachSession(
    blockId: string,
    container: HTMLDivElement,
    callbacks: SessionCallbacks = {},
    opts: AttachSessionOptions = {}
): void {
    const s = ensureSession(blockId, opts.blocks ?? false);
    s.callbacks = callbacks;
    s.container = container;
    if (s.visibleNow) bindSessionToSlot(s);
    if (s.shellExited) callbacks.onShellExit?.();
}

export function detachSession(blockId: string): void {
    const s = sessions.get(blockId);
    if (!s) return;
    unbindSessionFromSlot(s);
    s.callbacks = {};
    s.container = null;
}

export function setSessionVisibility(blockId: string, visible: boolean, focused: boolean): void {
    const s = sessions.get(blockId);
    if (!s) return;
    s.visibleNow = visible;
    s.focusedNow = focused;
    if (visible) {
        cancelHiddenRelease(s);
        if (s.container && !s.hasSlot) bindSessionToSlot(s);
        else if (s.hasSlot) refreshLeafSlot(s.leafId);
        setSlotFocused(s.leafId, focused);
        if (focused && !s.blocks) focusSlot(s.leafId);
        else if (focused && s.blocks && s.blockMode === "prompt") s.inputFocus?.();
        return;
    }
    if (!s.hasSlot) return;
    // Always park first (keeps the grid live, pauses rendering); release only
    // after confirming nothing owns the terminal. Sync signals (OSC 133, agent
    // detect) short-circuit; the async foreground-job check covers shells
    // without integration.
    parkLeafSlot(s.leafId);
    if (!s.blocks && !isLeafAltScreen(s.leafId) && !sessionBusy(s)) {
        void releaseIfIdle(s);
    }
}

export function disposeSession(blockId: string): void {
    const s = sessions.get(blockId);
    if (!s) return;
    s.disposed = true;
    cancelHiddenRelease(s);
    disposeLeafSlot(s.leafId);
    s.hasSlot = false;
    s.snapshot = null;
    s.pty?.dispose();
    s.pty = null;
    s.statusUnsub?.();
    s.statusUnsub = null;
    s.rowUnsub?.();
    s.rowUnsub = null;
    s.inputFocus = null;
    s.pendingRows = [];
    sessions.delete(blockId);
}
