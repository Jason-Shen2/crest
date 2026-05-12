// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// TerminalModel — the orchestrator that owns one terminal pane's block list
// and drives the engine from Go-side wps events.  Mirrors warp's
// `terminal_model.rs`, scaled down for the Electron event model:
//
//   wps cmdblock:row     → ensure-block + apply metadata
//   wps cmdblock:chunk   → ansiParser.feed(bytes) routed at block target
//   wps cmdblock:altscreen → block.enterAltScreen / exitAltScreen
//   wps cmdblock:clear   → Blocks.truncateBefore
//
// Atoms expose the model to React.  The pattern is "version-counter":
// `revisionAtom` bumps on any change, components subscribe to it and
// pull current state via getter methods.  Cheaper than maintaining a
// dozen fine-grained atoms while we iterate on shape.

import { atoms } from "@/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { base64ToArray, stringToBase64 } from "@/util/util";
import * as jotai from "jotai";

import {
    AnsiParser,
    Block,
    BlockHandler,
    BlockId,
    BlockLifecycleState,
    Blocks,
    DefaultTermMode,
    TermMode,
    TerminalContext,
} from "./engine";
import {
    BlockSelectionSlice,
    Selection,
    SelectionMode,
    computeBlockSlice,
    extractTextFromSlice,
} from "./render/selection";

const DefaultCols = 120;
const ResyncIntervalMs = 10_000;
const MaxRenderedBytesPerBlock = 256 * 1024;
// Auto-collapse threshold — finished blocks with more output rows than
// this start collapsed.
//
// Crest divergence from warp: warp doesn't auto-collapse at all (its
// GPU renderer handles 100k+ row blocks without DOM cost).  Crest uses
// React + DOM so we have to cap somewhere — 200 rows keeps typical
// build logs / READMEs expanded but folds `find /` or a massive test
// trace.  We compensate with a "jump to bottom" floating button (which
// warp also has, threshold 70px overhang) so users can still navigate
// long uncollapsed blocks.
const AutoCollapseRowThreshold = 200;

// ScrollPosition — enumerates the three modes used for auto-scroll vs.
// "user is reading history" behavior.
export type ScrollPosition =
    | { kind: "follow-bottom" }
    | { kind: "free"; scrollTop: number }
    | { kind: "anchored"; blockId: BlockId };

// FindMatch — one occurrence of the active find query inside a block's
// output grid.  Computed eagerly when setFind() runs and re-used by the
// per-block highlight layer.
export interface FindMatch {
    blockId: BlockId;
    row: number;
    startCol: number;
    endCol: number;
}

// Map the `state` string Go emits on CmdBlock rows onto our lifecycle enum.
// Go's vocabulary has drifted a bit over time so we accept several spellings
// and fall back to "waiting-for-input" rather than throwing.
function mapState(s: string | undefined, exitcode?: number): BlockLifecycleState {
    switch ((s ?? "").toLowerCase()) {
        case "running":
            return "running";
        case "done":
        case "done-with-execution":
        case "donewithexecution":
            return "done-with-execution";
        case "background":
            return "background";
        case "static":
            return "static";
        case "no-execution":
        case "donewithnoexecution":
            return "done-with-no-execution";
        case "prompt":
        case "before":
        case "waiting":
        case "waitingforinput":
        case "":
            return "waiting-for-input";
        default:
            // Unknown — be conservative.  We've seen Go's exit-code-only
            // updates land before the state string is fully populated, in
            // which case relying on exit code alone gives the right answer.
            if (exitcode != null) {
                return exitcode === 0 ? "done-with-execution" : "done-with-execution";
            }
            return "waiting-for-input";
    }
}

export class TerminalModel {
    readonly outerBlockId: string;
    cols: number;

    // Terminal-wide mode set — mutated by BlockHandler via ctx.setMode().
    // Readers (key bindings, paste handler, mouse capture, renderer)
    // snapshot through getMode() at event time.
    readonly mode: TermMode = { ...DefaultTermMode };

    private blocks = new Blocks();
    private parser: AnsiParser;
    private handler: BlockHandler | null = null;

    // Per-block chunk offsets so out-of-order delivery (rare but possible)
    // doesn't corrupt the cell stream.  We only feed bytes whose offset
    // matches the next expected position.
    private writtenOffsets = new Map<BlockId, number>();
    // Blocks for which we've already fetched the historical output range
    // from the term file.  Prevents double-fetch when row events fire
    // multiple times during reconnect.
    private historicalOutputLoaded = new Set<BlockId>();

    // Subscriptions cleanup
    private unsubs: (() => void)[] = [];
    private resyncTimer: ReturnType<typeof setInterval> | null = null;
    private disposed = false;

    // ---------- atoms ----------

    // Single revision counter.  Bump on every block list mutation; React
    // reads this and re-pulls the (mutable) collection.  Cheap and avoids
    // having to maintain per-block atoms while the shape is unstable.
    readonly revisionAtom = jotai.atom(0) as jotai.PrimitiveAtom<number>;
    readonly selectedBlockIdAtom = jotai.atom(null) as jotai.PrimitiveAtom<BlockId | null>;
    readonly scrollPositionAtom = jotai.atom<ScrollPosition>({ kind: "follow-bottom" });
    readonly loadingAtom = jotai.atom(true) as jotai.PrimitiveAtom<boolean>;
    readonly errorAtom = jotai.atom("") as jotai.PrimitiveAtom<string>;
    // Selection is per-terminal — a single drag-selected region scoped to
    // one block at a time.  Cross-block selection is a follow-up.
    readonly selectionAtom = jotai.atom(null) as jotai.PrimitiveAtom<Selection | null>;
    // Find — query string applied as a regex filter across all blocks.
    // Bound to BlockGrid.setFilter() on every block as the user types.
    readonly findQueryAtom = jotai.atom("") as jotai.PrimitiveAtom<string>;
    readonly findVisibleAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;
    // Computed match ranges across all blocks.  Recomputed on setFind().
    // The layer draws one rectangle per match; the currentIndex drives
    // the "active" highlight color and scroll-to-match.
    readonly findMatchesAtom = jotai.atom<FindMatch[]>([]) as jotai.PrimitiveAtom<FindMatch[]>;
    readonly findCurrentIndexAtom = jotai.atom(0) as jotai.PrimitiveAtom<number>;
    readonly findCaseSensitiveAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;
    readonly findRegexAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;
    // Window title last set via OSC 0 / 1 / 2.  Exposed so the tab strip
    // can show it on hover; unused by the block list itself.
    readonly titleAtom = jotai.atom("") as jotai.PrimitiveAtom<string>;
    // Last notification text from OSC 9 / 777.  Renderers can pop a toast
    // by subscribing; we keep one slot rather than a queue since the
    // typical pattern is "tell me my command finished".
    readonly notificationAtom = jotai.atom("") as jotai.PrimitiveAtom<string>;
    // Dynamic palette overrides driven by OSC 4 / 10 / 11 / 12.  Apps that
    // theme their output at runtime (btop, custom prompt colors, terminal
    // games) write here; the renderer reads via PaletteContext.
    readonly paletteOverridesAtom = jotai.atom<Record<number, string>>({}) as jotai.PrimitiveAtom<Record<number, string>>;
    readonly defaultFgOverrideAtom = jotai.atom<string | null>(null) as jotai.PrimitiveAtom<string | null>;
    readonly defaultBgOverrideAtom = jotai.atom<string | null>(null) as jotai.PrimitiveAtom<string | null>;
    readonly cursorColorOverrideAtom = jotai.atom<string | null>(null) as jotai.PrimitiveAtom<string | null>;
    // Bell tick — bumped on every C0 BEL.  TerminalView watches this and
    // flashes the pane border briefly.  We use a counter rather than a
    // boolean so successive bells re-trigger the effect even if a previous
    // one is still animating.
    readonly bellTickAtom = jotai.atom(0) as jotai.PrimitiveAtom<number>;
    // Snackbar (sticky pinned prompt) visibility — toggleable via the
    // dismiss button on the snackbar or Cmd/Ctrl+Shift+S.  Matches warp's
    // `hidden_by_toggle` semantics (terminal-wide, not per-block).
    readonly snackbarVisibleAtom = jotai.atom(true) as jotai.PrimitiveAtom<boolean>;

    constructor(outerBlockId: string, cols: number = DefaultCols) {
        this.outerBlockId = outerBlockId;
        this.cols = cols;
        const ctx: TerminalContext = {
            respond: (bytes) => {
                void this.sendBytes(bytes);
            },
            getMode: () => this.mode,
            setMode: (patch) => this.applyModePatch(patch),
            setTitle: (title) => globalStore.set(this.titleAtom, title),
            notify: (payload) => globalStore.set(this.notificationAtom, payload),
            writeClipboard: (text) => {
                try {
                    void navigator.clipboard.writeText(text);
                } catch {
                    // sandbox / permissions failure — drop silently
                }
            },
            setPaletteColor: (idx, css) => this.setPaletteColor(idx, css),
            resetPaletteColor: (idx) => this.resetPaletteColor(idx),
            setDefaultFg: (css) => this.setDefaultFg(css),
            setDefaultBg: (css) => this.setDefaultBg(css),
            setCursorColor: (css) => this.setCursorColor(css),
            bell: () => {
                globalStore.set(
                    this.bellTickAtom,
                    globalStore.get(this.bellTickAtom) + 1
                );
            },
        };
        // The parser needs a handler at construction.  We start with a
        // throwaway block as the target — the first real chunk event will
        // call setBlock to point at the right one.
        const sentinel = this.ensureBlock("__sentinel__", -1, "static");
        this.handler = new BlockHandler(sentinel, ctx);
        this.parser = new AnsiParser(this.handler);

        this.subscribeEvents();
        this.kickoff();
    }

    private applyModePatch(patch: Partial<TermMode>): void {
        Object.assign(this.mode, patch);
    }

    getMode(): TermMode {
        return this.mode;
    }

    // ---------- palette overrides (OSC 4/10/11/12) ----------

    setPaletteColor(index: number, css: string): void {
        if (index < 0 || index > 255) return;
        const prev = globalStore.get(this.paletteOverridesAtom);
        globalStore.set(this.paletteOverridesAtom, { ...prev, [index]: css });
    }

    resetPaletteColor(index: number | null): void {
        if (index == null) {
            globalStore.set(this.paletteOverridesAtom, {});
            return;
        }
        const prev = globalStore.get(this.paletteOverridesAtom);
        if (prev[index] == null) return;
        const next = { ...prev };
        delete next[index];
        globalStore.set(this.paletteOverridesAtom, next);
    }

    setDefaultFg(css: string | null): void {
        globalStore.set(this.defaultFgOverrideAtom, css);
    }

    setDefaultBg(css: string | null): void {
        globalStore.set(this.defaultBgOverrideAtom, css);
    }

    setCursorColor(css: string | null): void {
        globalStore.set(this.cursorColorOverrideAtom, css);
    }

    setSnackbarVisible(on: boolean): void {
        globalStore.set(this.snackbarVisibleAtom, on);
    }

    toggleSnackbarVisible(): void {
        const cur = globalStore.get(this.snackbarVisibleAtom);
        globalStore.set(this.snackbarVisibleAtom, !cur);
    }

    // ---------- drag-selection state ----------
    //
    // Lives on the model so mousedown/mousemove handlers across multiple
    // BlockElements can coordinate a cross-block drag: block A's mousedown
    // starts the drag, block B's mousemove extends the focus, document
    // mouseup ends it.  Without this shared flag, B's mousemove couldn't
    // distinguish "user is dragging from A" from "user is just moving the
    // pointer over B".

    private dragging = false;

    isDraggingSelection(): boolean {
        return this.dragging;
    }

    beginSelection(blockId: BlockId, row: number, col: number, mode: SelectionMode): void {
        this.dragging = true;
        this.setSelection({
            anchorBlockId: blockId,
            anchorRow: row,
            anchorCol: col,
            focusBlockId: blockId,
            focusRow: row,
            focusCol: col,
            mode,
        });
    }

    extendSelection(blockId: BlockId, row: number, col: number): void {
        if (!this.dragging) return;
        const sel = globalStore.get(this.selectionAtom);
        if (!sel) return;
        this.setSelection({
            ...sel,
            focusBlockId: blockId,
            focusRow: row,
            focusCol: col,
        });
    }

    endSelection(): void {
        this.dragging = false;
    }

    // computeBlockSlice — convenience for renderers; resolves the block's
    // slice of the global selection given its position in the block list.
    getBlockSelectionSlice(blockId: BlockId): BlockSelectionSlice | null {
        const sel = globalStore.get(this.selectionAtom);
        if (!sel) return null;
        return computeBlockSlice(sel, blockId, (id) => this.blocks.indexOf(id));
    }

    // setBlockCollapsed — toggle the collapsed flag on a block.  Renderer
    // observes via revisionAtom; bumps and the block re-renders into the
    // truncated head+tail view (or back to full).
    setBlockCollapsed(blockId: BlockId, on: boolean): void {
        const block = this.blocks.findById(blockId);
        if (!block) return;
        if (block.collapsed === on) return;
        block.collapsed = on;
        this.bumpRevision();
    }

    toggleBlockCollapsed(blockId: BlockId): void {
        const block = this.blocks.findById(blockId);
        if (!block) return;
        block.collapsed = !block.collapsed;
        this.bumpRevision();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const u of this.unsubs) {
            try {
                u();
            } catch {
                // ignore
            }
        }
        this.unsubs = [];
        if (this.resyncTimer != null) {
            clearInterval(this.resyncTimer);
            this.resyncTimer = null;
        }
    }

    // ---------- public API (RPC outbound) ----------

    async submitInput(text: string): Promise<void> {
        const payload = text.endsWith("\n") || text.endsWith("\r") ? text : text + "\r";
        await RpcApi.ControllerInputCommand(TabRpcClient, {
            blockid: this.outerBlockId,
            inputdata64: stringToBase64(payload),
        });
    }

    async sendBytes(bytes: string): Promise<void> {
        await RpcApi.ControllerInputCommand(TabRpcClient, {
            blockid: this.outerBlockId,
            inputdata64: stringToBase64(bytes),
        });
    }

    async sendInterrupt(): Promise<void> {
        await this.sendBytes("\x03");
    }

    async sendResize(rows: number, cols: number): Promise<void> {
        if (rows <= 0 || cols <= 0) return;
        await RpcApi.ControllerInputCommand(TabRpcClient, {
            blockid: this.outerBlockId,
            termsize: { rows, cols },
        });
    }

    // setCols — change the column count used for *future* blocks.  Running
    // blocks keep their original cols (re-wrapping mid-flight is brittle —
    // warp also doesn't re-wrap, only the next prompt picks up new cols).
    // No-op when the value is unchanged so ResizeObserver thrashing during
    // drag doesn't burn cycles.
    setCols(cols: number): void {
        if (cols <= 0 || cols === this.cols) return;
        this.cols = cols;
    }

    // ---------- selection ----------

    setSelection(sel: Selection | null): void {
        globalStore.set(this.selectionAtom, sel);
    }

    // copySelection — extract the selected text from every block the
    // selection touches and put it on the clipboard.  Cmd+C handler calls
    // this; returns true if something was copied (so the caller can
    // decide whether to also let the browser's default copy handler fire
    // as a fallback).  Multi-block selections concatenate per-block text
    // with newline separators so block boundaries stay visible.
    async copySelection(): Promise<boolean> {
        const sel = globalStore.get(this.selectionAtom);
        if (!sel) return false;
        const blockIndex = (id: BlockId) => this.blocks.indexOf(id);
        const parts: string[] = [];
        for (const block of this.blocks.all()) {
            if (block.id === "__sentinel__") continue;
            const slice = computeBlockSlice(sel, block.id, blockIndex);
            if (!slice) continue;
            const grid = block.altScreen.active ? block.altScreen.grid : block.outputGrid.raw();
            const text = extractTextFromSlice(grid, slice);
            if (text) parts.push(text);
        }
        const joined = parts.join("\n");
        if (!joined) return false;
        try {
            await navigator.clipboard.writeText(joined);
            return true;
        } catch {
            return false;
        }
    }

    // ---------- find ----------

    setFind(query: string): void {
        globalStore.set(this.findQueryAtom, query);
        const matches = this.computeMatches(query);
        globalStore.set(this.findMatchesAtom, matches);
        // Reset index — when the query shrinks/grows, "where was I in the
        // result list" loses meaning.  Jump to the first match if there
        // is one; the caller can step from there.
        globalStore.set(this.findCurrentIndexAtom, matches.length > 0 ? 0 : -1);
        this.bumpRevision();
    }

    setFindCaseSensitive(on: boolean): void {
        globalStore.set(this.findCaseSensitiveAtom, on);
        // Re-scan with the new case rule.
        this.setFind(globalStore.get(this.findQueryAtom));
    }

    setFindRegex(on: boolean): void {
        globalStore.set(this.findRegexAtom, on);
        this.setFind(globalStore.get(this.findQueryAtom));
    }

    findNext(): void {
        const matches = globalStore.get(this.findMatchesAtom);
        if (matches.length === 0) return;
        const cur = globalStore.get(this.findCurrentIndexAtom);
        const next = (cur + 1) % matches.length;
        globalStore.set(this.findCurrentIndexAtom, next);
        this.scrollToMatch(matches[next]);
        this.bumpRevision();
    }

    findPrev(): void {
        const matches = globalStore.get(this.findMatchesAtom);
        if (matches.length === 0) return;
        const cur = globalStore.get(this.findCurrentIndexAtom);
        const prev = (cur - 1 + matches.length) % matches.length;
        globalStore.set(this.findCurrentIndexAtom, prev);
        this.scrollToMatch(matches[prev]);
        this.bumpRevision();
    }

    // getMatchesForBlock — slice of all matches that belong to this block.
    // Cheap linear scan; match counts in practice are small (tens, maybe
    // hundreds), so building a per-block index would be over-engineering.
    getMatchesForBlock(blockId: BlockId): FindMatch[] {
        const all = globalStore.get(this.findMatchesAtom);
        const out: FindMatch[] = [];
        for (const m of all) {
            if (m.blockId === blockId) out.push(m);
        }
        return out;
    }

    private computeMatches(rawQuery: string): FindMatch[] {
        const query = rawQuery.trim();
        if (!query) return [];
        const caseSensitive = globalStore.get(this.findCaseSensitiveAtom);
        const useRegex = globalStore.get(this.findRegexAtom);
        let re: RegExp | null = null;
        let needle = "";
        if (useRegex) {
            try {
                re = new RegExp(query, caseSensitive ? "g" : "gi");
            } catch {
                // Malformed regex — return nothing rather than tearing the
                // search apart.  User sees the empty match count and knows
                // to fix their pattern.
                return [];
            }
        } else {
            needle = caseSensitive ? query : query.toLowerCase();
        }
        const out: FindMatch[] = [];
        for (const block of this.blocks.all()) {
            if (block.id === "__sentinel__") continue;
            const grid = block.altScreen.active ? block.altScreen.grid : block.outputGrid.raw();
            for (let r = 0; r < grid.rowCount(); r++) {
                const row = grid.getRow(r);
                let s = "";
                for (const cell of row) {
                    if (cell.width === 0) continue;
                    s += cell.char.length > 0 ? cell.char : " ";
                }
                if (re) {
                    re.lastIndex = 0;
                    let m: RegExpExecArray | null;
                    while ((m = re.exec(s)) != null) {
                        if (m[0].length === 0) {
                            // Zero-width match — advance manually so we
                            // don't infinite-loop.
                            re.lastIndex++;
                            continue;
                        }
                        out.push({
                            blockId: block.id,
                            row: r,
                            startCol: m.index,
                            endCol: m.index + m[0].length,
                        });
                    }
                } else {
                    const hay = caseSensitive ? s : s.toLowerCase();
                    let from = 0;
                    while (from <= hay.length - needle.length) {
                        const idx = hay.indexOf(needle, from);
                        if (idx < 0) break;
                        out.push({
                            blockId: block.id,
                            row: r,
                            startCol: idx,
                            endCol: idx + needle.length,
                        });
                        from = idx + Math.max(1, needle.length);
                    }
                }
            }
        }
        return out;
    }

    private scrollToMatch(m: FindMatch): void {
        // Anchor the block list to this block — the block-level scroll
        // brings the match into view.  Per-row scroll within a block is
        // not yet wired (typical blocks are short enough that the row
        // is visible once the block top is on-screen).
        globalStore.set(this.scrollPositionAtom, { kind: "anchored", blockId: m.blockId });
    }

    toggleFindVisible(): void {
        const next = !globalStore.get(this.findVisibleAtom);
        globalStore.set(this.findVisibleAtom, next);
        if (!next) {
            // Closing find clears the query so the highlight layer drops
            // its rectangles.  Cheap reset; doesn't touch cell data.
            this.setFind("");
        }
    }

    // ---------- public API (read-side) ----------

    getBlocks(): Blocks {
        return this.blocks;
    }

    getRevision(): number {
        return globalStore.get(this.revisionAtom);
    }

    bumpRevision(): void {
        globalStore.set(this.revisionAtom, this.getRevision() + 1);
    }

    selectBlock(id: BlockId | null): void {
        globalStore.set(this.selectedBlockIdAtom, id);
    }

    clearSelection(): void {
        globalStore.set(this.selectedBlockIdAtom, null);
    }

    // Keyboard block navigation.  Direction is in document order:
    // "previous" = older / visually above current; "next" = newer.
    // Behavior reference: warp app/src/terminal/view.rs:25111-25148
    //   (`SelectPriorBlock` / `SelectNextBlock` under PinnedToBottom
    //   input mode, which is crest's only mode).
    selectPreviousBlock(): void {
        const all = this.blocks.all().filter((b) => b.id !== "__sentinel__");
        if (all.length === 0) return;
        const current = globalStore.get(this.selectedBlockIdAtom);
        // No selection yet → land on the newest block; first keypress
        // moves up from "implicit input-bar focus" to the most recent
        // command.
        let idx = current == null ? all.length : all.findIndex((b) => b.id === current);
        if (idx < 0) idx = all.length;
        idx = Math.max(0, idx - 1);
        const target = all[idx];
        if (!target) return;
        this.selectBlock(target.id);
        this.setScrollPosition({ kind: "anchored", blockId: target.id });
    }

    selectNextBlock(): void {
        const all = this.blocks.all().filter((b) => b.id !== "__sentinel__");
        if (all.length === 0) return;
        const current = globalStore.get(this.selectedBlockIdAtom);
        if (current == null) return; // already past the newest
        const idx = all.findIndex((b) => b.id === current);
        if (idx < 0) return;
        if (idx >= all.length - 1) {
            // At the newest block — moving "next" returns focus to
            // the input bar (no selected block, follow-bottom scroll).
            this.selectBlock(null);
            this.setScrollPosition({ kind: "follow-bottom" });
            return;
        }
        const target = all[idx + 1];
        this.selectBlock(target.id);
        this.setScrollPosition({ kind: "anchored", blockId: target.id });
    }

    setScrollPosition(pos: ScrollPosition): void {
        globalStore.set(this.scrollPositionAtom, pos);
    }

    // ---------- event subscription ----------

    private subscribeEvents(): void {
        const scope = `block:${this.outerBlockId}`;
        this.unsubs.push(
            waveEventSubscribeSingle({
                eventType: "cmdblock:row",
                scope,
                handler: (ev) => {
                    const row = ev.data as CmdBlock | undefined;
                    if (row) this.applyRow(row);
                },
            })
        );
        this.unsubs.push(
            waveEventSubscribeSingle({
                eventType: "cmdblock:chunk",
                scope,
                handler: (ev) => {
                    const chunk = ev.data as CmdBlockChunkEvent | undefined;
                    if (chunk) this.applyChunk(chunk);
                },
            })
        );
        this.unsubs.push(
            waveEventSubscribeSingle({
                eventType: "cmdblock:altscreen",
                scope,
                handler: (ev) => {
                    const e = ev.data as CmdBlockAltScreenEvent | undefined;
                    if (e) this.applyAltScreen(e);
                },
            })
        );
        this.unsubs.push(
            waveEventSubscribeSingle({
                eventType: "cmdblock:clear",
                scope,
                handler: (ev) => {
                    const e = ev.data as CmdBlockClearEvent | undefined;
                    if (e) this.applyClear(e);
                },
            })
        );
    }

    private async kickoff(): Promise<void> {
        // Tell the backend to (re)start the shell controller for this outer
        // block.  Same handshake the existing model does — without this the
        // shell never spawns.
        try {
            await RpcApi.ControllerResyncCommand(TabRpcClient, {
                tabid: globalStore.get(atoms.staticTabId),
                blockid: this.outerBlockId,
            });
        } catch (e) {
            // Resync failure isn't fatal — the shell may already be running.
        }
        await this.fetchInitial();
        // Periodic safety-net poll.  wps events should keep us in sync but
        // a one-shot drop would otherwise leave the block list stale.
        this.resyncTimer = setInterval(() => this.fetchInitial(), ResyncIntervalMs);
    }

    private async fetchInitial(): Promise<void> {
        try {
            const rows = await RpcApi.GetCmdBlocksCommand(TabRpcClient, {
                blockid: this.outerBlockId,
            });
            if (this.disposed) return;
            // Go returns null instead of an empty array when there are no
            // blocks, so guard the iteration.
            for (const row of rows ?? []) this.applyRow(row);
            globalStore.set(this.loadingAtom, false);
        } catch (e: any) {
            if (this.disposed) return;
            globalStore.set(this.errorAtom, e?.message ?? String(e));
            globalStore.set(this.loadingAtom, false);
        }
    }

    // ---------- event appliers ----------

    private applyRow(row: CmdBlock): void {
        if (!row.oid) return;
        const block = this.ensureBlock(row.oid, row.seq, row.state, row);
        // Update metadata.  We don't overwrite cell data — only the
        // out-of-band fields the parser doesn't see.
        block.pwd = row.cwd ?? block.pwd;
        block.cmd = row.cmd ?? block.cmd;
        block.agentSessionId = row.agentsessionid ?? block.agentSessionId;
        if (row.exitcode != null) block.exitCode = row.exitcode;
        const nextState = mapState(row.state, row.exitcode);
        // Drive lifecycle transitions when Go's state string changes, but
        // only forwards.  OSC 133 markers inside the chunk stream remain
        // the source of truth for cursor anchors; Go's state is a backstop
        // for cases where shell integration isn't configured.
        this.advanceState(block, nextState);

        // For finished blocks loaded from history, fetch the recorded
        // output bytes from the outer block's "term" file and feed them
        // through the parser so the cell grid is populated.  Live (still
        // running) blocks receive bytes via cmdblock:chunk events instead.
        if (!this.historicalOutputLoaded.has(row.oid) && row.state !== "running") {
            this.historicalOutputLoaded.add(row.oid);
            void this.fetchOutputFor(row);
        }

        this.bumpRevision();
    }

    private async fetchOutputFor(row: CmdBlock): Promise<void> {
        if (row.outputstartoffset == null || row.outputendoffset == null) return;
        const rawSize = row.outputendoffset - row.outputstartoffset;
        if (rawSize <= 0) return;
        const size = Math.min(rawSize, MaxRenderedBytesPerBlock);
        try {
            const resp = await RpcApi.ReadBlockFileRangeCommand(TabRpcClient, {
                blockid: this.outerBlockId,
                name: "term",
                offset: row.outputstartoffset,
                size,
            });
            if (this.disposed) return;
            const bytes = base64ToArray(resp.data64 ?? "");
            if (bytes.length === 0) return;
            const block = this.blocks.findById(row.oid);
            if (!block) return;
            if (this.handler == null) return;
            // Reset parser state so previous block's cursor / SGR doesn't
            // leak.  setBlock then aims subsequent writes at this block.
            this.parser.reset();
            this.handler.setBlock(block);
            this.parser.feed(bytes);
            this.writtenOffsets.set(row.oid, (this.writtenOffsets.get(row.oid) ?? 0) + bytes.length);
            block.noteWrite();
            this.bumpRevision();
        } catch (e) {
            console.warn("terminal-model: fetchOutputFor failed", row.oid, e);
        }
    }

    private applyChunk(chunk: CmdBlockChunkEvent): void {
        if (!chunk.oid) return;
        // Bytes belong to a specific block — if we haven't seen the row yet,
        // create a placeholder block; the row event will fill in metadata.
        const block = this.ensureBlock(chunk.oid, -1, "running");

        // `chunk.offset` is an absolute byte offset into the outer block's
        // `term` file (the same coordinate space as CmdBlock.outputstartoffset).
        // For the first chunk of a block we accept whatever offset arrives
        // and treat subsequent chunks as strict sequential.  Drops from
        // out-of-order delivery (rare) get repaired by the 10s safety poll
        // that re-fetches the historical range.
        const expected = this.writtenOffsets.get(chunk.oid);
        if (expected != null && chunk.offset !== expected) {
            return;
        }
        const bytes = base64ToArray(chunk.data64 ?? "");
        if (bytes.length === 0) return;

        // Swap parser target to this block, feed the chunk.  Reset the
        // parser state on first chunk for the block so a previous block's
        // cursor / SGR doesn't leak.
        if (this.handler != null) {
            if (expected == null) {
                this.parser.reset();
            }
            this.handler.setBlock(block);
            this.parser.feed(bytes);
            this.writtenOffsets.set(chunk.oid, chunk.offset + bytes.length);
        }
        block.noteWrite();
        // Sync output (DEC mode 2026): when on, the app is in the middle
        // of an atomic update — defer rendering so the user sees one
        // coherent frame.  The next chunk that ends with syncOutput=false
        // will bump and flush the accumulated changes.
        if (!this.mode.syncOutput) {
            this.bumpRevision();
        }
    }

    private applyAltScreen(e: CmdBlockAltScreenEvent): void {
        if (!e.oid) return;
        const block = this.blocks.findById(e.oid);
        if (!block) return;
        if (e.enter) block.enterAltScreen();
        else block.exitAltScreen();
        this.bumpRevision();
    }

    private applyClear(e: CmdBlockClearEvent): void {
        if (!e.throughoid) {
            // Clear everything before now.
            const last = this.blocks.last();
            if (!last) return;
            const idx = this.blocks.indexOf(last.id);
            this.blocks.truncateBefore(idx);
            this.bumpRevision();
            return;
        }
        const idx = this.blocks.indexOf(e.throughoid);
        if (idx < 0) return;
        // Hide everything up to and including `throughoid`.
        this.blocks.truncateBefore(idx + 1);
        this.bumpRevision();
    }

    // ---------- internal helpers ----------

    private ensureBlock(
        oid: BlockId,
        seq: number,
        rawState: string | undefined,
        row?: CmdBlock
    ): Block {
        const existing = this.blocks.findById(oid);
        if (existing) return existing;
        const block = new Block({
            id: oid,
            seq: seq < 0 ? 0 : seq,
            cols: this.cols,
            creationTs: row?.createdat != null ? row.createdat * 1000 : Date.now(),
        });
        // Apply initial metadata from the row, if we have it.
        if (row) {
            block.pwd = row.cwd ?? block.pwd;
            block.cmd = row.cmd ?? block.cmd;
            block.exitCode = row.exitcode ?? block.exitCode;
            block.agentSessionId = row.agentsessionid ?? block.agentSessionId;
            block.isStatic = (row.state ?? "").toLowerCase() === "static";
            block.isBackground = (row.state ?? "").toLowerCase() === "background";
        }
        // Sync block state with Go's view immediately so the renderer doesn't
        // briefly flash a "waiting" badge for blocks that are already running.
        const initialState = mapState(rawState, row?.exitcode);
        this.advanceState(block, initialState);
        this.blocks.push(block);
        return block;
    }

    // advanceState — only forward transitions.  Avoids the case where a
    // stale fetchInitial() pulls down a row with state="running" for a
    // block we already finished.
    private advanceState(block: Block, target: BlockLifecycleState): void {
        const order: BlockLifecycleState[] = [
            "waiting-for-input",
            "running",
            "done-with-execution",
            "done-with-no-execution",
        ];
        const isOrdered = order.includes(block.state) && order.includes(target);
        if (isOrdered) {
            if (order.indexOf(target) <= order.indexOf(block.state)) return;
        }
        // Drive the right method based on the destination so the block's
        // internal grids transition consistently (output_grid started,
        // header finished, timestamps set).
        switch (target) {
            case "running":
                if (block.state === "waiting-for-input") block.startCommand();
                else block.state = "running";
                break;
            case "done-with-execution":
                if (block.state !== "done-with-execution") {
                    block.finishCommand(block.exitCode);
                    // Auto-collapse on finish if the output grew beyond the
                    // threshold.  User can toggle back via the toolbelt /
                    // context menu.  Don't override an explicit setting:
                    // only auto-set on the transition, not on every render.
                    if (block.outputGrid.rowCount() > AutoCollapseRowThreshold) {
                        block.collapsed = true;
                    }
                }
                break;
            case "done-with-no-execution":
                block.state = "done-with-no-execution";
                break;
            case "background":
                block.state = "background";
                block.isBackground = true;
                break;
            case "static":
                block.state = "static";
                block.isStatic = true;
                break;
            case "waiting-for-input":
                // No-op — initial state, set at construction.
                break;
        }
    }
}
