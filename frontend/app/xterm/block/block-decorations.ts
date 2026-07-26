// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createShellIntegrationState, registerCwdHandler } from "@/app/xterm/osc-handlers";
import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { blockIndexAt, computeRange, type LineRange } from "./block-range";
import { type BlockMode, initialModeState, modeOf, type ModeState, reduceMode } from "./mode-machine";
import { readRangeText } from "./read-block";
import type { BlockMeta } from "./types";

const OkRuler = "#5fb3b3";
const FailRuler = "#e5706b";
const MaxBlocks = 1000;
// Loose wall-clock window for aligning a Go cmdblock:row with an OSC-133
// entry. There is no shared id between the two streams (row oid vs frontend
// marker), so time alignment is the seam; replayed scrollback re-parses
// markers at replay time and simply never matches (docs/terax-terminal-port.md
// §五 "decorations 与 cmdblock:row 的 oid 对齐错位").
const RowMatchWindowMs = 5000;

type Entry = {
    id: string;
    command: string;
    cwd: string;
    exitCode: number | null;
    startedAt: number;
    finishedAt: number;
    startMarker: IMarker;
    endMarker: IMarker;
    deco: IDecoration | null;
};

type LiveBlock = {
    id: string;
    command: string;
    cwd: string;
    startedAt: number;
    startMarker: IMarker;
    usedAlt: boolean;
};

export type BlockContext = {
    command: string;
    cwd: string;
    exitCode: number | null;
    output: string;
};

export type PositionedBlock = {
    id: string;
    command: string;
    cwd: string;
    exitCode: number | null;
    running: boolean;
    ok: boolean;
    startedAt: number;
    finishedAt: number;
    top: number;
    bottom: number;
    // Pixel top of the header row (one line above the command, in the blank gap).
    headerTop: number;
};

export type VisibleBlocks = {
    blocks: PositionedBlock[];
    sticky: PositionedBlock | null;
};

export type BlockMatch = { line: number; col: number; len: number };

// Normalized cmdblock:row metadata (Go Tracker sidecar). Timestamps are ms
// epoch; `running` rows may only enrich the live block's command.
export type BlockRowMeta = {
    cmd?: string;
    exitCode?: number;
    durationMs?: number;
    startedAt?: number;
    finishedAt?: number;
    running?: boolean;
};

export type BlockDecorationsOptions = {
    onCwd?: (cwd: string) => void;
    onMode?: (mode: BlockMode) => void;
    onViewport?: () => void;
};

export class BlockDecorations {
    readonly entries: Entry[] = [];
    live: LiveBlock | null = null;
    cwd = "";
    idSeq = 0;
    selectedId: string | null = null;
    searchDeco: IDecoration | null = null;
    searchMarker: IMarker | null = null;
    mode: ModeState = initialModeState();
    lastMode: BlockMode = modeOf(initialModeState());
    readonly shellState = createShellIntegrationState();
    readonly disposers: (() => void)[] = [];
    readonly onCwd?: (cwd: string) => void;
    readonly onMode?: (mode: BlockMode) => void;
    readonly onViewport?: () => void;
    viewportRaf: number | null = null;

    constructor(
        readonly term: Terminal,
        opts?: BlockDecorationsOptions
    ) {
        this.onCwd = opts?.onCwd;
        this.onMode = opts?.onMode;
        this.onViewport = opts?.onViewport;
        this.term.options.cursorInactiveStyle = "none";
        const osc133 = term.parser.registerOscHandler(133, (data) => {
            this.onOsc133(data);
            return true;
        });
        const cwd = registerCwdHandler(
            term,
            (c) => {
                this.cwd = c;
                this.onCwd?.(c);
            },
            this.shellState
        );
        const parsed = term.onWriteParsed(() => this.syncAlt());
        const scroll = term.onScroll(() => this.scheduleViewport());
        const render = term.onRender(() => this.scheduleViewport());
        this.disposers.push(
            () => osc133.dispose(),
            cwd,
            () => parsed.dispose(),
            () => scroll.dispose(),
            () => render.dispose()
        );
    }

    scheduleViewport(): void {
        if (this.viewportRaf != null) return;
        this.viewportRaf = requestAnimationFrame(() => {
            this.viewportRaf = null;
            this.onViewport?.();
        });
    }

    syncAlt(): void {
        const alt = this.term.buffer.active.type === "alternate";
        if (alt === this.mode.altScreen) return;
        this.mode = reduceMode(this.mode, { type: "altScreen", active: alt });
        if (alt && this.live) this.live.usedAlt = true;
        this.emitMode();
        this.scheduleViewport();
    }

    getBlocks(): BlockMeta[] {
        const out: BlockMeta[] = [];
        for (const e of this.entries) {
            const r = this.rangeOf(e);
            if (r) out.push(this.toMeta(e, r));
        }
        return out;
    }

    blockAt(line: number): BlockMeta | null {
        const ranges = this.entries.map((e) => this.rangeOf(e));
        const i = blockIndexAt(ranges, line);
        if (i < 0) return null;
        const r = ranges[i];
        return r ? this.toMeta(this.entries[i], r) : null;
    }

    read(block: BlockMeta): BlockContext {
        const e = this.entries.find((x) => x.id === block.id);
        const r = e ? this.rangeOf(e) : null;
        const start = r ? r.start : block.startLine;
        const end = r ? r.end : block.endLine;
        return {
            command: block.command,
            cwd: block.cwd,
            exitCode: block.exitCode,
            output: readRangeText(this.term, start, end),
        };
    }

    readById(id: string): BlockContext | null {
        const e = this.entries.find((x) => x.id === id);
        if (!e) return null;
        const r = this.rangeOf(e);
        if (!r) return null;
        return {
            command: e.command,
            cwd: e.cwd,
            exitCode: e.exitCode,
            output: readRangeText(this.term, r.start, r.end),
        };
    }

    searchBlock(id: string, query: string): BlockMatch[] {
        const e = this.entries.find((x) => x.id === id);
        if (!e || !query) return [];
        const r = this.rangeOf(e);
        if (!r) return [];
        const q = query.toLowerCase();
        const buf = this.term.buffer.active;
        const last = Math.min(r.end, buf.length - 1);
        const out: BlockMatch[] = [];
        for (let i = r.start; i <= last && out.length < 500; i++) {
            const lower = buf.getLine(i)?.translateToString(true).toLowerCase() ?? "";
            let from = 0;
            while (out.length < 500) {
                const idx = lower.indexOf(q, from);
                if (idx < 0) break;
                out.push({ line: i, col: idx, len: query.length });
                from = idx + Math.max(1, query.length);
            }
        }
        return out;
    }

    revealMatch(m: BlockMatch): void {
        this.clearSearch();
        try {
            const buf = this.term.buffer.active;
            this.term.scrollToLine(Math.max(0, m.line - Math.floor(this.term.rows / 2)));
            const marker = this.term.registerMarker(m.line - (buf.baseY + buf.cursorY));
            if (!marker) return;
            this.searchMarker = marker;
            this.searchDeco = this.term.registerDecoration({ marker, x: m.col, width: m.len }) ?? null;
            this.searchDeco?.onRender((el) => el.classList.add("bt-match"));
        } catch {}
    }

    clearSearch(): void {
        try {
            this.searchDeco?.dispose();
        } catch {}
        try {
            this.searchMarker?.dispose();
        } catch {}
        this.searchDeco = null;
        this.searchMarker = null;
    }

    commandLines(): number[] {
        const lines: number[] = [];
        for (const e of this.entries) {
            if (!e.startMarker.isDisposed && e.startMarker.line >= 0) lines.push(e.startMarker.line);
        }
        return lines;
    }

    hasAnyBlock(): boolean {
        return this.entries.length > 0 || this.live !== null;
    }

    // Go-side row metadata is richer than the frontend OSC parse (cmd captured
    // from the prompt region, exit/duration persisted), so its cmd wins on a
    // match; exitCode only fills a hole to avoid flipping a badge the OSC 133 D
    // already rendered. Returns true when a matching block was updated;
    // unmatched rows degrade silently per the port doc.
    applyRowMeta(row: BlockRowMeta): boolean {
        if (row.running) {
            const lb = this.live;
            if (!lb || row.startedAt == null) return false;
            if (Math.abs(lb.startedAt - row.startedAt) > RowMatchWindowMs) return false;
            if (!row.cmd || lb.command === row.cmd) return false;
            lb.command = row.cmd;
            this.scheduleViewport();
            return true;
        }
        const e = this.closestEntryByTime(row.startedAt, row.finishedAt);
        if (!e) return false;
        let changed = false;
        if (row.cmd && row.cmd !== e.command) {
            e.command = row.cmd;
            changed = true;
        }
        if (row.exitCode != null && e.exitCode == null) {
            e.exitCode = row.exitCode;
            changed = true;
        }
        if (row.durationMs != null && row.durationMs > 0) {
            const finishedAt = e.startedAt + row.durationMs;
            if (finishedAt !== e.finishedAt) {
                e.finishedAt = finishedAt;
                changed = true;
            }
        }
        if (changed) this.scheduleViewport();
        return changed;
    }

    // Newest-first with a strict compare so a wall-clock tie (several entries
    // finishing in the same millisecond) resolves to the most recent entry.
    closestEntryByTime(startedAt?: number, finishedAt?: number): Entry | null {
        if (startedAt == null && finishedAt == null) return null;
        let best: Entry | null = null;
        let bestDelta = RowMatchWindowMs + 1;
        for (let i = this.entries.length - 1; i >= 0; i--) {
            const e = this.entries[i];
            const delta = Math.min(
                startedAt != null ? Math.abs(e.startedAt - startedAt) : Infinity,
                finishedAt != null ? Math.abs(e.finishedAt - finishedAt) : Infinity
            );
            if (delta < bestDelta) {
                bestDelta = delta;
                best = e;
            }
        }
        return best;
    }

    visibleBlocks(): VisibleBlocks {
        const term = this.term;
        // No block chrome over a full-screen TUI (vim/htop) — it owns the screen.
        if (this.mode.altScreen) return { blocks: [], sticky: null };
        const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
        if (!screen || term.rows === 0) return { blocks: [], sticky: null };
        const rect = screen.getBoundingClientRect();
        const cellHeight = rect.height / term.rows;
        if (cellHeight <= 0) return { blocks: [], sticky: null };
        const elTop = term.element?.getBoundingClientRect().top ?? rect.top;
        const offset = rect.top - elTop;
        const buf = term.buffer.active;
        const viewportY = buf.viewportY;
        const vpTop = viewportY;
        const vpBottom = viewportY + term.rows;

        const out: PositionedBlock[] = [];
        let sticky: PositionedBlock | null = null;

        const consider = (
            meta: Omit<PositionedBlock, "top" | "bottom" | "ok" | "headerTop">,
            startLine: number,
            endLine: number
        ) => {
            if (endLine < vpTop || startLine > vpBottom) return;
            const ok = meta.exitCode === 0 || meta.exitCode === null;
            const top = offset + (startLine - viewportY) * cellHeight;
            const bottom = offset + (endLine - viewportY + 1) * cellHeight;
            const pb: PositionedBlock = {
                ...meta,
                ok,
                top,
                bottom,
                // The C marker lands on the first output line, so the command echo is
                // one row above `top` and the blank header gap is two rows above.
                headerTop: top - 1.9 * cellHeight,
            };
            out.push(pb);
            if (startLine < vpTop && endLine >= vpTop) sticky = pb;
        };

        // entries are chronological, so binary search beats a full scan per frame
        for (let i = this.firstIndexEndingAtOrAfter(vpTop); i < this.entries.length; i++) {
            const e = this.entries[i];
            const r = this.rangeOf(e);
            if (!r) continue;
            if (r.start > vpBottom) break;
            consider(
                {
                    id: e.id,
                    command: e.command,
                    cwd: e.cwd,
                    exitCode: e.exitCode,
                    running: false,
                    startedAt: e.startedAt,
                    finishedAt: e.finishedAt,
                },
                r.start,
                r.end
            );
        }

        const lb = this.live;
        if (lb && !lb.startMarker.isDisposed && lb.startMarker.line >= 0) {
            const start = lb.startMarker.line;
            const end = Math.max(start, buf.baseY + buf.cursorY);
            consider(
                {
                    id: lb.id,
                    command: lb.command,
                    cwd: lb.cwd,
                    exitCode: null,
                    running: true,
                    startedAt: lb.startedAt,
                    finishedAt: 0,
                },
                start,
                end
            );
        }

        return { blocks: out, sticky };
    }

    selectBlockAt(clientY: number): void {
        const screen = this.term.element?.querySelector<HTMLElement>(".xterm-screen");
        if (!screen || this.term.rows === 0) return;
        const rect = screen.getBoundingClientRect();
        const cellHeight = rect.height / this.term.rows;
        if (cellHeight <= 0) return;
        const row = Math.floor((clientY - rect.top) / cellHeight);
        const bufferRow = this.term.buffer.active.viewportY + row;
        const block = this.blockAt(bufferRow);
        if (!block) {
            this.clearBlockSelection();
            return;
        }
        if (block.id === this.selectedId && this.term.hasSelection()) {
            this.clearBlockSelection();
            return;
        }
        this.selectBlock(block.id);
    }

    selectBlock(id: string): void {
        const e = this.entries.find((x) => x.id === id);
        const r = e ? this.rangeOf(e) : null;
        if (!r) return;
        this.term.selectLines(r.start, r.end);
        this.selectedId = id;
    }

    clearBlockSelection(): boolean {
        const had = this.term.hasSelection();
        this.term.clearSelection();
        this.selectedId = null;
        return had;
    }

    // Steps relative to the selected block when one is selected, otherwise
    // starts from the most recent block.
    navigateBlocks(dir: -1 | 1): void {
        if (this.entries.length === 0) return;
        let idx: number;
        const cur = this.selectedId ? this.entries.findIndex((e) => e.id === this.selectedId) : -1;
        if (cur >= 0 && this.term.hasSelection()) {
            idx = cur + dir;
        } else {
            idx = dir < 0 ? this.entries.length - 1 : -1;
        }
        while (idx >= 0 && idx < this.entries.length) {
            const e = this.entries[idx];
            const r = this.rangeOf(e);
            if (r) {
                this.term.selectLines(r.start, r.end);
                this.selectedId = e.id;
                this.term.scrollToLine(Math.max(0, r.start - 2));
                return;
            }
            idx += dir;
        }
    }

    dispose(): void {
        if (this.viewportRaf != null) cancelAnimationFrame(this.viewportRaf);
        this.clearSearch();
        for (const e of this.entries) this.disposeEntry(e);
        this.entries.length = 0;
        this.live?.startMarker.dispose();
        this.live = null;
        for (const d of this.disposers) {
            try {
                d();
            } catch {}
        }
        this.disposers.length = 0;
    }

    rangeOf(e: Entry): LineRange | null {
        return computeRange(e.startMarker, e.endMarker);
    }

    // Disposed ranges (trimmed-oldest prefix) sort as -1, before any viewport.
    firstIndexEndingAtOrAfter(line: number): number {
        let lo = 0;
        let hi = this.entries.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            const r = this.rangeOf(this.entries[mid]);
            if ((r?.end ?? -1) < line) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    toMeta(e: Entry, r: LineRange): BlockMeta {
        return {
            id: e.id,
            command: e.command,
            cwd: e.cwd,
            exitCode: e.exitCode,
            startLine: r.start,
            endLine: r.end,
            startedAt: e.startedAt,
            finishedAt: e.finishedAt,
        };
    }

    emitMode(): void {
        const m = modeOf(this.mode);
        if (m === this.lastMode) return;
        this.lastMode = m;
        this.onMode?.(m);
    }

    onOsc133(data: string): void {
        const marker = data[0];
        const rest = data.length > 2 && data[1] === ";" ? data.slice(2) : "";
        switch (marker) {
            case "A":
                this.shellState.inCommand = false;
                this.mode = reduceMode(this.mode, { type: "osc133", marker: "A" });
                break;
            case "B":
                this.shellState.inCommand = true;
                this.mode = reduceMode(this.mode, { type: "osc133", marker: "B" });
                break;
            case "C":
                this.shellState.inCommand = true;
                this.mode = reduceMode(this.mode, { type: "osc133", marker: "C" });
                this.startBlock(rest);
                break;
            case "D":
                this.shellState.inCommand = false;
                this.finishBlock(rest);
                this.mode = reduceMode(this.mode, { type: "osc133", marker: "D" });
                break;
        }
        this.emitMode();
    }

    startBlock(commandFromMarker: string): void {
        if (this.live) this.finishBlock("");
        const marker = this.term.registerMarker(0);
        if (!marker) return;
        this.live = {
            id: `b${++this.idSeq}`,
            command: commandFromMarker,
            cwd: this.cwd,
            startedAt: Date.now(),
            startMarker: marker,
            usedAlt: false,
        };
        this.scheduleViewport();
    }

    finishBlock(codeStr: string): void {
        const lb = this.live;
        if (!lb) return;
        this.live = null;
        const exit = parseExitCode(codeStr);
        const ok = exit === 0 || exit === null;
        const endMarker = this.term.registerMarker(0);
        if (!endMarker) {
            lb.startMarker.dispose();
            return;
        }
        // Only the scrollbar overview mark; the visible divider is drawn full-width
        // in the host overlay (xterm decorations stop at the padded content edge).
        const deco =
            this.term.registerDecoration({
                marker: endMarker,
                width: 1,
                overviewRulerOptions: { color: ok ? OkRuler : FailRuler },
            }) ?? null;
        this.entries.push({
            id: lb.id,
            command: lb.command,
            cwd: lb.cwd,
            exitCode: exit,
            startedAt: lb.startedAt,
            finishedAt: Date.now(),
            startMarker: lb.startMarker,
            endMarker,
            deco,
        });
        while (this.entries.length > MaxBlocks) {
            const old = this.entries.shift();
            if (old) this.disposeEntry(old);
        }
        this.scheduleViewport();
    }

    disposeEntry(e: Entry): void {
        try {
            e.deco?.dispose();
        } catch {}
        try {
            e.startMarker.dispose();
        } catch {}
        try {
            e.endMarker.dispose();
        } catch {}
    }
}

function parseExitCode(s: string): number | null {
    if (!s) return null;
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
}
