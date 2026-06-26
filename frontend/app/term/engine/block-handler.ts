// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// BlockHandler — AnsiHandler implementation that applies parser events
// to a Block's active grid.  Translates ANSI / VT / xterm sequences into
// Grid method calls, drives OSC 133 shell-integration transitions,
// manages alt-screen entry/exit, and — via the optional TerminalContext —
// writes PTY replies for capability queries and tracks terminal-wide
// modes (mouse, paste, focus, app-cursor, sync output, …).
//
// Coverage:
//   * SGR (CSI m)
//   * Cursor positioning (H, f, A-G, d, `)
//   * Save / restore (s, u; ESC 7 / 8)
//   * Erase (J, K, X)
//   * Insert / delete (@, P, L, M)
//   * Scroll (S, T) + DECSTBM (CSI r)
//   * Tab stops: HTS (ESC H), TBC (CSI g), CHT (CSI I), CBT (CSI Z)
//   * DECSCUSR (CSI Ps SP q), DECTCEM (?25)
//   * Reverse line feed (ESC M)
//   * Charset selection: SO/SI, ESC ( c, ESC ) c
//   * Full reset (ESC c) — grid + terminal modes
//   * ANSI standard modes (CSI h/l): IRM (4)
//   * DEC private modes (CSI ? h/l): 1, 3, 5, 6, 7, 8, 9, 12, 25,
//     47, 1047, 1048, 1049, 1000, 1002, 1003, 1004, 1005, 1006, 1007,
//     1015, 2004, 2026
//   * Reply-bearing CSI: DSR (n) 5/6, DA (c) 1/2, XTVERSION (>q),
//     window size report (CSI 18 t)
//   * OSC 0/1/2 title, OSC 7 cwd, OSC 8 hyperlink, OSC 9 / 777
//     notification, OSC 52 clipboard write, OSC 133 with extended
//     A/B/C/D/P key-value properties, OSC 1337 dropped (deferred)

import { AnsiHandler } from "./handler";
import { Block } from "./block";
import { Grid } from "./grid";
import { applySgr, withLink } from "./style";
import { CharsetMode, CursorShape, DefaultTermMode, TermMode } from "./types";
import { base64ToArray } from "@/util/util";
import { parseColorSpec } from "../render/color";

// TerminalContext — capability surface the BlockHandler needs from its
// owner (TerminalModel).  Optional; without one, reply-bearing CSI
// commands silently drop and terminal-wide mode toggles are inert.
export interface TerminalContext {
    respond(bytes: string): void;
    getMode(): TermMode;
    setMode(patch: Partial<TermMode>): void;
    setTitle?(title: string): void;
    notify?(payload: string): void;
    writeClipboard?(data: string): void;
    // C0 bell (\a) hook — typically surfaces as a brief visual flash.
    bell?(): void;
    // Dynamic palette overrides (OSC 4 / 10 / 11 / 12 + resets).
    // CSS string already resolved (e.g. "rgb(255, 0, 0)" or "#ff0000").
    setPaletteColor?(index: number, css: string): void;
    // null index = reset all entries.
    resetPaletteColor?(index: number | null): void;
    setDefaultFg?(css: string | null): void;
    setDefaultBg?(css: string | null): void;
    setCursorColor?(css: string | null): void;
    // CSI 3J — drain all blocks preceding the active one, leaving the
    // current command's block as the only entry in the list.  Mirrors
    // warp's BlockList::clear_screen(ClearMode::ResetAndClear)
    // (terminal/model/blocks.rs:3556-3594).  No-op in alt-screen (so vim's
    // own clear doesn't blow away history).
    clearPriorBlocks?(): void;
    // Called when the parser detects a full-screen clear (ED 2 / ED 3 /
    // ESC c) on a running block — strong signal that an inline TUI is
    // initializing.  The model uses this to set a bounded viewport on
    // the outputGrid so LF/auto-wrap scroll instead of growing rows.
    onInlineTui?(): void;
}

const NoopCtx: TerminalContext = {
    respond: () => {},
    getMode: () => DefaultTermMode,
    setMode: () => {},
};

const CSI = "\x1b[";
const DCS = "\x1bP";
const ST = "\x1b\\";

export class BlockHandler implements AnsiHandler {
    private block: Block;
    private ctx: TerminalContext;

    constructor(block: Block, ctx?: TerminalContext) {
        this.block = block;
        this.ctx = ctx ?? NoopCtx;
    }

    setBlock(block: Block): void {
        this.block = block;
    }

    setContext(ctx: TerminalContext): void {
        this.ctx = ctx;
    }

    private grid(): Grid {
        if (this.block.altScreen.active) {
            return this.block.altScreen.grid;
        }
        return this.block.activeGrid().raw();
    }

    // Defensive guard — agent blocks bypass the ANSI parser entirely
    // (their rendering lives in AgentBlockElement, not BlockElement).
    // In normal operation BlockHandler never gets pointed at an agent
    // block (the host swaps to a fresh shell block when a command starts),
    // but if it did, writes would corrupt the dummy outputGrid we keep
    // alongside agentPayload for shape uniformity.  Each on-* method that
    // touches the grid early-returns when this flag is true.
    private isAgent(): boolean {
        return this.block.kind === "agent";
    }

    // ---------- text & C0 ----------

    onText(text: string): void {
        if (this.isAgent()) return;
        this.grid().writeText(text);
        this.block.noteWrite();
    }

    onLineFeed(): void {
        if (this.isAgent()) return;
        this.grid().lineFeed();
    }
    onCarriageReturn(): void {
        if (this.isAgent()) return;
        this.grid().carriageReturn();
    }
    onBackspace(): void {
        if (this.isAgent()) return;
        this.grid().backspace();
    }
    onTab(): void {
        if (this.isAgent()) return;
        this.grid().tab();
    }
    onBell(): void {
        this.ctx.bell?.();
    }
    onShiftOut(): void {
        if (this.isAgent()) return;
        this.grid().setActiveCharset(1);
    }
    onShiftIn(): void {
        if (this.isAgent()) return;
        this.grid().setActiveCharset(0);
    }

    // ---------- CSI ----------

    onCsi(
        final: string,
        params: number[],
        intermediate: string,
        isPrivate: boolean,
        privatePrefix?: string
    ): void {
        if (this.isAgent()) return;
        // Mode set/reset routes by private vs ANSI standard.
        if (isPrivate && (final === "h" || final === "l")) {
            const on = final === "h";
            for (const code of params) this.setDecPrivate(code, on);
            return;
        }
        if (!isPrivate && intermediate === "" && (final === "h" || final === "l")) {
            const on = final === "h";
            for (const code of params) this.setAnsiMode(code, on);
            return;
        }

        // Kitty keyboard protocol — CSI =/>/<?/u with private prefix.
        // CSI u with no prefix stays as cursor restore (handled below).
        if (final === "u" && privatePrefix) {
            this.handleKittyKeyboardCsi(privatePrefix, params);
            return;
        }

        const g = this.grid();
        switch (final) {
            case "m":
                g.setStyle(applySgr(g.currentStyle, params.length ? params : [0]));
                return;

            // ----- cursor positioning -----
            case "H":
            case "f": {
                const row = Math.max(1, params[0] || 1) - 1;
                const col = Math.max(1, params[1] || 1) - 1;
                g.cursorTo(row, col);
                return;
            }
            case "A":
                g.cursorMove(-(params[0] || 1), 0);
                return;
            case "B":
            case "e":
                g.cursorMove(params[0] || 1, 0);
                return;
            case "C":
            case "a":
                g.cursorMove(0, params[0] || 1);
                return;
            case "D":
                g.cursorMove(0, -(params[0] || 1));
                return;
            case "E":
                g.cursorMove(params[0] || 1, 0);
                g.carriageReturn();
                return;
            case "F":
                g.cursorMove(-(params[0] || 1), 0);
                g.carriageReturn();
                return;
            case "G":
            case "`":
                g.cursorTo(g.cursor.row, (params[0] || 1) - 1);
                return;
            case "d":
                g.cursorTo((params[0] || 1) - 1, g.cursor.col);
                return;
            case "I":
                // CHT — Cursor Forward Tabulation
                for (let n = params[0] || 1; n > 0; n--) g.tab();
                return;
            case "Z":
                // CBT — Cursor Backward Tabulation
                g.moveBackwardTabs(params[0] || 1);
                return;

            // ----- save / restore -----
            case "s":
                if (params.length >= 2) {
                    // DECSLRM — left/right margins, not supported; drop.
                    return;
                }
                g.saveCursor();
                return;
            case "u":
                g.restoreCursor();
                return;

            // ----- erase -----
            case "J": {
                const mode = clamp0123(params[0] || 0);
                g.eraseInDisplay(mode);
                // CSI 3J (and the conventional 2J pair that follows H/2J
                // from `clear`) wipe scrollback — in our block model that
                // means dropping every earlier block.  Skip when an alt-
                // screen is active so TUIs (vim/htop/less) that issue 2J
                // to repaint don't blow away the user's main-screen
                // history.  Mirrors warp blocks.rs:3556-3594.
                if (mode === 3 && !this.block.altScreen.active) {
                    this.ctx.clearPriorBlocks?.();
                }
                // ED 2 / ED 3 on a running block (not alt-screen) is a
                // strong signal that an inline TUI is initializing.
                if ((mode === 2 || mode === 3) && !this.block.altScreen.active && this.block.state === "running") {
                    this.ctx.onInlineTui?.();
                }
                return;
            }
            case "K":
                g.eraseInLine(clamp012(params[0] || 0));
                return;
            case "X":
                g.eraseChars(params[0] || 1);
                return;

            // ----- insert / delete -----
            case "@":
                g.insertChars(params[0] || 1);
                return;
            case "P":
                g.deleteChars(params[0] || 1);
                return;
            case "L":
                g.insertLines(params[0] || 1);
                return;
            case "M":
                g.deleteLines(params[0] || 1);
                return;

            // ----- scroll -----
            case "S":
                g.scrollUp(params[0] || 1);
                return;
            case "T":
                g.scrollDown(params[0] || 1);
                return;

            // ----- tab stops -----
            case "g":
                g.clearTabStop(params[0] === 3 ? 3 : 0);
                return;

            // ----- scroll region -----
            case "r": {
                if (isPrivate) {
                    // DECRSPM — restore private modes, not supported.
                    return;
                }
                const top = (params[0] || 1) - 1;
                let bot: number;
                if (params[1] != null && params[1] > 0) {
                    bot = params[1] - 1;
                } else {
                    // DECSTBM without a bottom parameter resets to the
                    // full viewport height (per VT spec).  In bounded
                    // (TUI) mode use viewportHeight(); in unbounded mode
                    // fall back to POSITIVE_INFINITY so normal command
                    // output can keep growing.
                    const vh = g.viewportHeight();
                    bot = vh > 0 ? vh - 1 : Number.POSITIVE_INFINITY;
                }
                g.setScrollRegion(top, bot);
                return;
            }

            // ----- cursor style / xtversion -----
            case "q":
                if (intermediate === " ") {
                    this.applyCursorStyle(params[0] ?? 0);
                    return;
                }
                if (isPrivate) {
                    this.respondXtversion();
                    return;
                }
                return;

            // ----- device status / device attributes -----
            case "n":
                if (isPrivate) return;
                this.respondDsr(params[0] || 0, g);
                return;
            case "c":
                if (isPrivate || intermediate === ">") {
                    this.respondDa2();
                } else {
                    this.respondDa1();
                }
                return;

            // ----- window operations -----
            case "t":
                this.handleWindowOp(params, g);
                return;

            default:
                return;
        }
    }

    private handleWindowOp(params: number[], g: Grid): void {
        // We don't implement window manipulation — most commands are
        // dropped silently.  A few queries get a useful reply:
        //   18 → text area size in chars: CSI 8 ; rows ; cols t
        //   19 → screen size in chars (same shape, here equal to 18)
        //   14 → text area size in pixels: CSI 4 ; height ; width t  (we don't know pixels; report 0)
        const op = params[0];
        if (op === 18 || op === 19) {
            const cols = g.cols;
            const rows = g.viewportHeight();
            this.ctx.respond(`${CSI}8;${rows};${cols}t`);
        }
    }

    // Kitty keyboard protocol dispatch — CSI {?, =, >, <} u.
    // Public spec: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
    // Crest implements the flag-tracking and reply contract; the actual
    // per-key encoding lives in key-bindings.ts (it reads the flag set
    // via TermMode at keypress time).  We don't maintain a flag stack —
    // push (`>`) just overwrites, pop (`<`) clears — apps that need the
    // stack semantics are rare and can re-push.
    private handleKittyKeyboardCsi(prefix: string, params: number[]): void {
        const mode = this.ctx.getMode();
        const current = mode.kittyKeyboardFlags;
        if (prefix === "?") {
            // Query current flags.
            this.ctx.respond(`${CSI}?${current}u`);
            return;
        }
        if (prefix === ">") {
            // Push (we treat as set).  Default 0 = disable everything.
            const flags = params[0] ?? 0;
            this.ctx.setMode({ kittyKeyboardFlags: flags });
            return;
        }
        if (prefix === "=") {
            // Set with optional combine mode: 1=set, 2=or, 3=and-not.
            const flags = params[0] ?? 0;
            const op = params[1] ?? 1;
            let next = current;
            if (op === 1) next = flags;
            else if (op === 2) next = current | flags;
            else if (op === 3) next = current & ~flags;
            this.ctx.setMode({ kittyKeyboardFlags: next });
            return;
        }
        if (prefix === "<") {
            // Pop — we don't keep a stack, so just reset to 0.
            this.ctx.setMode({ kittyKeyboardFlags: 0 });
            return;
        }
    }

    private applyCursorStyle(n: number): void {
        let shape: CursorShape = "block";
        let blink = true;
        switch (n) {
            case 0:
            case 1:
                shape = "block";
                blink = true;
                break;
            case 2:
                shape = "block";
                blink = false;
                break;
            case 3:
                shape = "underline";
                blink = true;
                break;
            case 4:
                shape = "underline";
                blink = false;
                break;
            case 5:
                shape = "bar";
                blink = true;
                break;
            case 6:
                shape = "bar";
                blink = false;
                break;
        }
        this.grid().setCursorShape(shape, blink);
    }

    private respondDsr(code: number, g: Grid): void {
        if (code === 5) {
            this.ctx.respond(`${CSI}0n`);
            return;
        }
        if (code === 6) {
            const row = g.cursor.row + 1;
            const col = g.cursor.col + 1;
            this.ctx.respond(`${CSI}${row};${col}R`);
            return;
        }
    }

    private respondDa1(): void {
        // VT100 with Advanced Video Option — covers everything we actually
        // implement and is the value TUIs check for the "real terminal"
        // gate.  Anything fancier (sixel, kitty) is signalled separately.
        this.ctx.respond(`${CSI}?1;2c`);
    }

    private respondDa2(): void {
        // Secondary DA — vendor / firmware / ROM.  Most TUIs don't parse
        // the values; they just want a response so they stop blocking.
        this.ctx.respond(`${CSI}>0;0;0c`);
    }

    private respondXtversion(): void {
        // DCS > | <name>(<ver>) ST — minimal identifier so probes finish.
        this.ctx.respond(`${DCS}>|crest(1)${ST}`);
    }

    // ---------- ANSI standard modes ----------

    private setAnsiMode(code: number, on: boolean): void {
        switch (code) {
            case 4:
                // IRM — Insert / Replace
                this.grid().setInsertMode(on);
                this.ctx.setMode({ insertMode: on });
                return;
            case 20:
                // LNM — Linefeed/Newline Mode; not user-visible for us.
                return;
            default:
                return;
        }
    }

    // ---------- DEC private modes ----------

    private setDecPrivate(code: number, on: boolean): void {
        const ctx = this.ctx;
        const g = this.grid();
        switch (code) {
            case 1:
                ctx.setMode({ appCursor: on });
                return;
            case 3:
                // DECCOLM — per xterm, also clears the screen & homes cursor.
                ctx.setMode({ columnMode: on });
                g.eraseInDisplay(2);
                g.cursorTo(0, 0);
                if (!this.block.altScreen.active && this.block.state === "running") {
                    this.ctx.onInlineTui?.();
                }
                return;
            case 5:
                ctx.setMode({ reverseVideo: on });
                return;
            case 6:
                g.setOriginMode(on);
                ctx.setMode({ origin: on });
                return;
            case 7:
                g.setAutoWrap(on);
                ctx.setMode({ autoWrap: on });
                return;
            case 8:
                ctx.setMode({ autoRepeat: on });
                return;
            case 9:
                ctx.setMode({ mouseX10: on });
                return;
            case 12:
                g.cursorState.blink = on;
                return;
            case 25:
                g.setCursorVisible(on);
                return;
            case 47:
                // Legacy variant — no clear-on-entry, no cursor save.
                if (on) this.block.enterAltScreen(false);
                else this.block.exitAltScreen();
                return;
            case 1047:
                // Same as 1049 but without cursor save/restore.
                if (on) this.block.enterAltScreen(true);
                else this.block.exitAltScreen();
                return;
            case 1048:
                if (on) g.saveCursor();
                else g.restoreCursor();
                return;
            case 1049:
                // 1049 = save cursor + clear + enter alt-screen (on);
                //         exit alt-screen + restore cursor (off).
                if (on) {
                    g.saveCursor();
                    this.block.enterAltScreen(true);
                } else {
                    this.block.exitAltScreen();
                    this.grid().restoreCursor();
                }
                return;
            case 1000:
                ctx.setMode({ mouseClick: on, mouseButton: false, mouseMotion: false });
                return;
            case 1002:
                ctx.setMode({ mouseClick: false, mouseButton: on, mouseMotion: false });
                return;
            case 1003:
                ctx.setMode({ mouseClick: false, mouseButton: false, mouseMotion: on });
                return;
            case 1004:
                ctx.setMode({ focusReport: on });
                return;
            case 1005:
                ctx.setMode({ mouseUtf8: on });
                return;
            case 1006:
                ctx.setMode({ mouseSgr: on });
                return;
            case 1007:
                ctx.setMode({ alternateScroll: on });
                return;
            case 1015:
                ctx.setMode({ mouseUrxvt: on });
                return;
            case 2004:
                ctx.setMode({ bracketedPaste: on });
                return;
            case 2026:
                ctx.setMode({ syncOutput: on });
                return;
            default:
                return;
        }
    }

    // ---------- OSC ----------

    onOsc(payload: string): void {
        if (this.isAgent()) return;
        const semi = payload.indexOf(";");
        const code = semi >= 0 ? payload.slice(0, semi) : payload;
        const rest = semi >= 0 ? payload.slice(semi + 1) : "";
        switch (code) {
            case "0":
            case "1":
            case "2":
                this.ctx.setTitle?.(rest);
                return;
            case "4":
                this.handleOsc4(rest);
                return;
            case "7":
                this.handleOsc7(rest);
                return;
            case "8":
                this.handleOsc8(rest);
                return;
            case "9":
                this.ctx.notify?.(rest);
                return;
            case "10":
                this.handleOscDefaultColor(rest, "fg");
                return;
            case "11":
                this.handleOscDefaultColor(rest, "bg");
                return;
            case "12":
                this.handleOscDefaultColor(rest, "cursor");
                return;
            case "52":
                this.handleOsc52(rest);
                return;
            case "104":
                this.handleOscPaletteReset(rest);
                return;
            case "110":
                this.ctx.setDefaultFg?.(null);
                return;
            case "111":
                this.ctx.setDefaultBg?.(null);
                return;
            case "112":
                this.ctx.setCursorColor?.(null);
                return;
            case "133":
                this.handleOsc133(rest);
                return;
            case "777":
                this.ctx.notify?.(rest);
                return;
            case "1337":
                // iTerm proprietary (images + shell integration variant).
                // Deferred until image rendering lands.
                return;
            default:
                return;
        }
    }

    // OSC 4 — set / query palette entries.  Payload is one or more
    // `<index>;<spec>` pairs; spec="?" is a query (we don't reply — most
    // apps just set), spec="rgb:RR/GG/BB" / "#RRGGBB" is a write.
    private handleOsc4(payload: string): void {
        const parts = payload.split(";");
        for (let i = 0; i + 1 < parts.length; i += 2) {
            const idx = parseInt(parts[i], 10);
            const spec = parts[i + 1];
            if (!Number.isFinite(idx) || idx < 0 || idx > 255) continue;
            if (spec === "?") continue; // query — not replying
            const css = parseColorSpec(spec);
            if (css) this.ctx.setPaletteColor?.(idx, css);
        }
    }

    // OSC 10 / 11 / 12 — set default foreground / background / cursor.
    // Payload is a single color spec (no leading index).  Reply queries
    // are not handled.
    private handleOscDefaultColor(payload: string, role: "fg" | "bg" | "cursor"): void {
        const spec = payload.split(";")[0];
        if (!spec || spec === "?") return;
        const css = parseColorSpec(spec);
        if (!css) return;
        if (role === "fg") this.ctx.setDefaultFg?.(css);
        else if (role === "bg") this.ctx.setDefaultBg?.(css);
        else this.ctx.setCursorColor?.(css);
    }

    // OSC 104 — reset palette colors.  Empty payload = reset all;
    // semicolon-separated indices = reset those.
    private handleOscPaletteReset(payload: string): void {
        const raw = payload.trim();
        if (!raw) {
            this.ctx.resetPaletteColor?.(null);
            return;
        }
        for (const part of raw.split(";")) {
            const idx = parseInt(part, 10);
            if (Number.isFinite(idx)) this.ctx.resetPaletteColor?.(idx);
        }
    }

    private handleOsc52(rest: string): void {
        // <selection>;<base64-data>.  We accept writes only — reading the
        // clipboard from a remote shell is a security risk and we don't
        // do it.  Empty data is sometimes used as "clear"; we surface as
        // an empty write.
        const semi = rest.indexOf(";");
        if (semi < 0) return;
        const data64 = rest.slice(semi + 1);
        try {
            const bytes = base64ToArray(data64);
            const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
            this.ctx.writeClipboard?.(text);
        } catch {
            // ignore malformed base64
        }
    }

    private handleOsc7(payload: string): void {
        let p = payload;
        if (p.startsWith("file://")) {
            p = p.slice("file://".length);
            const slash = p.indexOf("/");
            p = slash >= 0 ? p.slice(slash) : "";
        }
        this.block.pwd = decodeOscValue(p);
    }

    private handleOsc8(rest: string): void {
        const semi = rest.indexOf(";");
        if (semi < 0) {
            this.applyLink(0);
            return;
        }
        const params = rest.slice(0, semi);
        const uri = rest.slice(semi + 1);
        if (!uri) {
            this.applyLink(0);
            return;
        }
        const id = this.grid().addLink(uri, params || undefined);
        this.applyLink(id);
    }

    private applyLink(linkId: number): void {
        const g = this.grid();
        g.setStyle(withLink(g.currentStyle, linkId));
    }

    private handleOsc133(rest: string): void {
        const parts = rest.split(";");
        const kind = parts[0];
        switch (kind) {
            case "A":
                this.block.startPrompt();
                return;
            case "B":
                this.block.endPrompt();
                return;
            case "C":
                this.block.startCommand();
                return;
            case "D": {
                const exitStr = parts[1];
                const exit =
                    exitStr != null && exitStr.length > 0 ? parseInt(exitStr, 10) : undefined;
                this.block.finishCommand(Number.isFinite(exit as number) ? exit : undefined);
                // Defensive recovery on command completion — matches warp's
                // command_finished (terminal_model.rs:2787): force-clears
                // sticky mode state that buggy / SSH-disconnected shells
                // leave dangling.
                this.ctx.setMode({ bracketedPaste: false });
                if (this.block.altScreen.active) {
                    this.block.exitAltScreen();
                }
                return;
            }
            case "P":
                for (let i = 1; i < parts.length; i++) {
                    const kv = parts[i];
                    const eq = kv.indexOf("=");
                    if (eq < 0) continue;
                    const key = kv.slice(0, eq);
                    const value = decodeOscValue(kv.slice(eq + 1));
                    this.applyPrecmdKv(key, value);
                }
                return;
        }
    }

    private applyPrecmdKv(key: string, value: string): void {
        const block = this.block;
        switch (key) {
            case "cwd":
                block.pwd = value;
                return;
            case "git_branch":
            case "branch":
                block.gitBranch = value;
                return;
            case "git_branch_name":
                block.gitBranchName = value;
                return;
            case "git_diff_stats": {
                // Raw shortstat output, e.g.
                //   " 3 files changed, 12 insertions(+), 3 deletions(-)".
                // A clean tree emits empty string (shell suppresses the kv).
                const files = /([0-9]+) files? changed/.exec(value);
                const added = /([0-9]+) insertion/.exec(value);
                const removed = /([0-9]+) deletion/.exec(value);
                block.gitDiffFiles = files ? parseInt(files[1], 10) : 0;
                block.gitDiffAdded = added ? parseInt(added[1], 10) : 0;
                block.gitDiffRemoved = removed ? parseInt(removed[1], 10) : 0;
                return;
            }
            case "virtual_env":
            case "venv":
                block.virtualEnv = value;
                return;
            case "node_version":
            case "node":
                block.nodeVersion = value;
                return;
            case "conda_env":
            case "conda":
                if (!block.virtualEnv) block.virtualEnv = value;
                return;
            default:
                return;
        }
    }

    // ---------- ESC ----------

    onEsc(final: string, intermediate: string): void {
        if (this.isAgent()) return;
        const g = this.grid();

        // Charset selection: ESC ( c (G0), ESC ) c (G1).  * / + slots are
        // obsolete and aliased to G0 / G1 here.
        if (
            intermediate === "(" ||
            intermediate === ")" ||
            intermediate === "*" ||
            intermediate === "+"
        ) {
            const slot: 0 | 1 = intermediate === "(" || intermediate === "*" ? 0 : 1;
            const mode: CharsetMode = final === "0" ? "dec-special" : "ascii";
            g.selectCharsetSlot(slot, mode);
            return;
        }

        switch (final) {
            case "7":
                g.saveCursor();
                return;
            case "8":
                g.restoreCursor();
                return;
            case "D":
                g.lineFeed();
                return;
            case "E":
                g.lineFeed();
                g.carriageReturn();
                return;
            case "H":
                g.setTabStop();
                return;
            case "M":
                g.reverseLineFeed();
                return;
            case "c":
                g.fullReset();
                this.ctx.setMode({
                    bracketedPaste: false,
                    focusReport: false,
                    mouseX10: false,
                    mouseClick: false,
                    mouseButton: false,
                    mouseMotion: false,
                    mouseSgr: false,
                    mouseUtf8: false,
                    mouseUrxvt: false,
                    appCursor: false,
                    appKeypad: false,
                    syncOutput: false,
                    insertMode: false,
                    origin: false,
                });
                return;
            case "=":
                this.ctx.setMode({ appKeypad: true });
                return;
            case ">":
                this.ctx.setMode({ appKeypad: false });
                return;
            default:
                return;
        }
    }

    onDcs(_final: string, _params: number[], _intermediate: string, _data: string): void {
        // DCS payloads (tmux passthrough, sixel) are not consumed yet.
    }

    onSosPmApc(_introducer: string, _data: string): void {
        // Drop.
    }
}

// ---------- helpers ----------

function decodeOscValue(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

function clamp012(n: number): 0 | 1 | 2 {
    return (n === 1 ? 1 : n === 2 ? 2 : 0) as 0 | 1 | 2;
}

function clamp0123(n: number): 0 | 1 | 2 | 3 {
    return (n === 1 ? 1 : n === 2 ? 2 : n === 3 ? 3 : 0) as 0 | 1 | 2 | 3;
}
