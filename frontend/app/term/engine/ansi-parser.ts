// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AnsiParser — VTE-style state machine that decodes ANSI/VT escape sequences
// from a byte stream and dispatches structured events to an AnsiHandler.
// Mirrors warp's `terminal/ansi.rs` Processor (which itself follows the
// reference table at https://vt100.net/emu/dec_ansi_parser).
//
// Design choices:
//
// * We decode UTF-8 first (via streaming TextDecoder) and run the state
//   machine on Unicode characters.  This is simpler than running on bytes,
//   because ESC sequences are pure ASCII so byte vs codepoint doesn't matter
//   for them, and UTF-8 multi-byte data only appears as printable text
//   anyway.
// * State transitions and entry actions match the canonical VT table.  We
//   don't implement the C1 8-bit aliases (0x9B = CSI etc.) — almost no shell
//   emits them, and adding them is straightforward later if needed.
// * Printable text in GROUND state is *batched*: we accumulate runs of
//   printable code points and flush via a single `onText()` call when the
//   state machine has to transition for an escape.  This is a real perf win
//   for command output where 99% of bytes are text.
// * DCS, SOS/PM/APC are recognized but their data is dropped at the
//   `onDcs`/`onSosPmApc` boundary — useful in test/debug but no real handler
//   currently consumes them.

import { AnsiHandler } from "./handler";

// State-machine states.  Names follow the VT reference table for easy
// cross-referencing.
type ParserState =
    | "ground"
    | "escape"
    | "escape_intermediate"
    | "csi_entry"
    | "csi_param"
    | "csi_intermediate"
    | "csi_ignore"
    | "osc_string"
    | "dcs_entry"
    | "dcs_param"
    | "dcs_intermediate"
    | "dcs_passthrough"
    | "dcs_ignore"
    | "sos_pm_apc_string";

// ASCII control codes.
const NUL = 0x00;
const BEL = 0x07;
const BS = 0x08;
const HT = 0x09;
const LF = 0x0a;
const VT = 0x0b;
const FF = 0x0c;
const CR = 0x0d;
const SO = 0x0e;
const SI = 0x0f;
const CAN = 0x18;
const SUB = 0x1a;
const ESC = 0x1b;
const DEL = 0x7f;

export class AnsiParser {
    private handler: AnsiHandler;
    private decoder = new TextDecoder("utf-8", { fatal: false });

    private state: ParserState = "ground";
    private textBuf = "";

    // CSI/DCS accumulators.  Reset on state entry.
    private paramBuf = ""; // raw param chars, may contain ';' and ':'
    private intermediateBuf = "";
    private isPrivate = false;
    // Exact private-prefix char ('?', '>', '=', '<') when isPrivate is set.
    // Needed because Kitty keyboard protocol distinguishes CSI =/>/< u
    // from CSI ? u, which the boolean alone can't carry.
    private privatePrefix = "";
    // OSC payload.  Closed on BEL or ST (ESC \).
    private oscBuf = "";
    // SOS/PM/APC raw data + which introducer we entered with.
    private sosPmApcBuf = "";
    private sosPmApcIntroducer = "";
    // DCS passthrough body.
    private dcsBuf = "";

    constructor(handler: AnsiHandler) {
        this.handler = handler;
    }

    setHandler(handler: AnsiHandler): void {
        this.flushText();
        this.handler = handler;
    }

    // feed — primary entry point.  Decode incoming bytes as UTF-8 (streaming
    // so a multi-byte sequence split across chunks is recombined), then
    // run the state machine on each code point.
    feed(bytes: Uint8Array): void {
        if (bytes.length === 0) return;
        const text = this.decoder.decode(bytes, { stream: true });
        for (const ch of text) {
            const cp = ch.codePointAt(0)!;
            this.step(ch, cp);
        }
    }

    // reset — clear all in-flight state.  Useful when switching the active
    // block / handler in the middle of a sequence (rare but possible during
    // wps event re-ordering).
    reset(): void {
        this.flushText();
        this.state = "ground";
        this.paramBuf = "";
        this.intermediateBuf = "";
        this.oscBuf = "";
        this.dcsBuf = "";
        this.sosPmApcBuf = "";
        this.isPrivate = false;
        this.privatePrefix = "";
    }

    // ---------- state machine core ----------

    private step(ch: string, cp: number): void {
        // CAN / SUB cancel any in-progress sequence and return to ground —
        // unconditional across all states per the VT table.
        if (cp === CAN || cp === SUB) {
            this.flushText();
            this.state = "ground";
            return;
        }

        switch (this.state) {
            case "ground":
                this.stepGround(ch, cp);
                return;
            case "escape":
                this.stepEscape(ch, cp);
                return;
            case "escape_intermediate":
                this.stepEscapeIntermediate(ch, cp);
                return;
            case "csi_entry":
                this.stepCsiEntry(ch, cp);
                return;
            case "csi_param":
                this.stepCsiParam(ch, cp);
                return;
            case "csi_intermediate":
                this.stepCsiIntermediate(ch, cp);
                return;
            case "csi_ignore":
                this.stepCsiIgnore(cp);
                return;
            case "osc_string":
                this.stepOscString(ch, cp);
                return;
            case "dcs_entry":
                this.stepDcsEntry(ch, cp);
                return;
            case "dcs_param":
                this.stepDcsParam(ch, cp);
                return;
            case "dcs_intermediate":
                this.stepDcsIntermediate(ch, cp);
                return;
            case "dcs_passthrough":
                this.stepDcsPassthrough(ch, cp);
                return;
            case "dcs_ignore":
                this.stepDcsIgnore(cp);
                return;
            case "sos_pm_apc_string":
                this.stepSosPmApcString(ch, cp);
                return;
        }
    }

    // ---------- GROUND ----------

    private stepGround(ch: string, cp: number): void {
        if (cp === ESC) {
            this.flushText();
            this.state = "escape";
            this.paramBuf = "";
            this.intermediateBuf = "";
            return;
        }
        if (cp < 0x20 || cp === DEL) {
            this.flushText();
            this.handleC0(cp);
            return;
        }
        // Printable — batch into textBuf.
        this.textBuf += ch;
    }

    private handleC0(cp: number): void {
        switch (cp) {
            case LF:
            case VT:
            case FF:
                this.handler.onLineFeed();
                break;
            case CR:
                this.handler.onCarriageReturn();
                break;
            case BS:
                this.handler.onBackspace();
                break;
            case HT:
                this.handler.onTab();
                break;
            case BEL:
                this.handler.onBell();
                break;
            case SO:
                this.handler.onShiftOut();
                break;
            case SI:
                this.handler.onShiftIn();
                break;
            case NUL:
                // NUL is padding — drop.
                break;
            default:
                // ENQ, ACK, etc. — ignored.
                break;
        }
    }

    // ---------- ESCAPE ----------

    private stepEscape(ch: string, cp: number): void {
        if (cp === ESC) {
            // ESC ESC: silently restart.  Shouldn't happen but be tolerant.
            this.paramBuf = "";
            this.intermediateBuf = "";
            return;
        }
        if (cp === 0x5b) {
            // ESC [ — CSI
            this.state = "csi_entry";
            this.paramBuf = "";
            this.intermediateBuf = "";
            this.isPrivate = false;
            return;
        }
        if (cp === 0x5d) {
            // ESC ] — OSC
            this.state = "osc_string";
            this.oscBuf = "";
            return;
        }
        if (cp === 0x50) {
            // ESC P — DCS
            this.state = "dcs_entry";
            this.paramBuf = "";
            this.intermediateBuf = "";
            this.dcsBuf = "";
            this.isPrivate = false;
            return;
        }
        if (cp === 0x58 /* X */ || cp === 0x5e /* ^ */ || cp === 0x5f /* _ */) {
            // ESC X = SOS, ESC ^ = PM, ESC _ = APC
            this.state = "sos_pm_apc_string";
            this.sosPmApcBuf = "";
            this.sosPmApcIntroducer = ch;
            return;
        }
        if (cp >= 0x20 && cp <= 0x2f) {
            // ESC intermediates (rare for us — e.g. ESC ( B selects ASCII G0)
            this.intermediateBuf += ch;
            this.state = "escape_intermediate";
            return;
        }
        if (cp < 0x20 || cp === DEL) {
            // Embedded C0 — execute it but stay in escape.
            this.handleC0(cp);
            return;
        }
        // Otherwise it's a final byte: dispatch ESC <final>.
        this.handler.onEsc(ch, this.intermediateBuf);
        this.state = "ground";
    }

    private stepEscapeIntermediate(ch: string, cp: number): void {
        if (cp >= 0x20 && cp <= 0x2f) {
            this.intermediateBuf += ch;
            return;
        }
        if (cp >= 0x30 && cp <= 0x7e) {
            this.handler.onEsc(ch, this.intermediateBuf);
            this.state = "ground";
            return;
        }
        if (cp < 0x20 || cp === DEL) {
            this.handleC0(cp);
            return;
        }
        // Otherwise abort.
        this.state = "ground";
    }

    // ---------- CSI ----------

    private stepCsiEntry(ch: string, cp: number): void {
        if (cp === 0x3f /* ? */ || cp === 0x3e /* > */ || cp === 0x3c /* < */ || cp === 0x3d /* = */) {
            // DEC private / Kitty keyboard introducer.
            this.isPrivate = true;
            this.privatePrefix = ch;
            this.state = "csi_param";
            return;
        }
        if ((cp >= 0x30 && cp <= 0x39) || cp === 0x3b /* ; */ || cp === 0x3a /* : */) {
            this.paramBuf += ch;
            this.state = "csi_param";
            return;
        }
        if (cp >= 0x20 && cp <= 0x2f) {
            this.intermediateBuf += ch;
            this.state = "csi_intermediate";
            return;
        }
        if (cp >= 0x40 && cp <= 0x7e) {
            this.dispatchCsi(ch);
            return;
        }
        if (cp < 0x20 || cp === DEL) {
            this.handleC0(cp);
            return;
        }
        this.state = "csi_ignore";
    }

    private stepCsiParam(ch: string, cp: number): void {
        if ((cp >= 0x30 && cp <= 0x39) || cp === 0x3b /* ; */ || cp === 0x3a /* : */) {
            this.paramBuf += ch;
            return;
        }
        if (cp >= 0x20 && cp <= 0x2f) {
            this.intermediateBuf += ch;
            this.state = "csi_intermediate";
            return;
        }
        if (cp >= 0x40 && cp <= 0x7e) {
            this.dispatchCsi(ch);
            return;
        }
        if (cp < 0x20 || cp === DEL) {
            this.handleC0(cp);
            return;
        }
        this.state = "csi_ignore";
    }

    private stepCsiIntermediate(ch: string, cp: number): void {
        if (cp >= 0x20 && cp <= 0x2f) {
            this.intermediateBuf += ch;
            return;
        }
        if (cp >= 0x40 && cp <= 0x7e) {
            this.dispatchCsi(ch);
            return;
        }
        if (cp < 0x20 || cp === DEL) {
            this.handleC0(cp);
            return;
        }
        this.state = "csi_ignore";
    }

    private stepCsiIgnore(cp: number): void {
        if (cp >= 0x40 && cp <= 0x7e) {
            this.state = "ground";
            return;
        }
        // otherwise stay in ignore
    }

    private dispatchCsi(final: string): void {
        const params = parseParams(this.paramBuf);
        this.handler.onCsi(
            final,
            params,
            this.intermediateBuf,
            this.isPrivate,
            this.privatePrefix
        );
        this.state = "ground";
        this.paramBuf = "";
        this.intermediateBuf = "";
        this.isPrivate = false;
        this.privatePrefix = "";
    }

    // ---------- OSC ----------

    private stepOscString(ch: string, cp: number): void {
        if (cp === BEL) {
            this.dispatchOsc();
            return;
        }
        if (cp === ESC) {
            // OSC terminated by ST: we expect the next char to be '\'.  Look
            // ahead by switching to a sub-state — but VT's table actually
            // says "ESC seen in OSC → escape state" which then on '\' returns
            // to ground.  Simpler: peek-via-state.  We just stash and handle
            // in escape state.  Since our escape handler treats ESC \ as
            // "drop", we end the OSC here as a workaround.
            this.dispatchOsc();
            this.state = "escape";
            this.paramBuf = "";
            this.intermediateBuf = "";
            return;
        }
        if (cp < 0x20 && cp !== HT) {
            // Drop other C0 — but allow tabs (some OSC payloads use them
            // as separators, e.g., OSC 7 in some implementations).
            return;
        }
        this.oscBuf += ch;
    }

    private dispatchOsc(): void {
        this.handler.onOsc(this.oscBuf);
        this.oscBuf = "";
        this.state = "ground";
    }

    // ---------- DCS ----------

    private stepDcsEntry(ch: string, cp: number): void {
        if (cp === 0x3f /* ? */ || cp === 0x3e /* > */ || cp === 0x3c /* < */ || cp === 0x3d /* = */) {
            this.isPrivate = true;
            this.state = "dcs_param";
            return;
        }
        if ((cp >= 0x30 && cp <= 0x39) || cp === 0x3b || cp === 0x3a) {
            this.paramBuf += ch;
            this.state = "dcs_param";
            return;
        }
        if (cp >= 0x20 && cp <= 0x2f) {
            this.intermediateBuf += ch;
            this.state = "dcs_intermediate";
            return;
        }
        if (cp >= 0x40 && cp <= 0x7e) {
            this.beginDcsPassthrough(ch);
            return;
        }
        this.state = "dcs_ignore";
    }
    private stepDcsParam(ch: string, cp: number): void {
        if ((cp >= 0x30 && cp <= 0x39) || cp === 0x3b || cp === 0x3a) {
            this.paramBuf += ch;
            return;
        }
        if (cp >= 0x20 && cp <= 0x2f) {
            this.intermediateBuf += ch;
            this.state = "dcs_intermediate";
            return;
        }
        if (cp >= 0x40 && cp <= 0x7e) {
            this.beginDcsPassthrough(ch);
            return;
        }
        this.state = "dcs_ignore";
    }
    private stepDcsIntermediate(ch: string, cp: number): void {
        if (cp >= 0x20 && cp <= 0x2f) {
            this.intermediateBuf += ch;
            return;
        }
        if (cp >= 0x40 && cp <= 0x7e) {
            this.beginDcsPassthrough(ch);
            return;
        }
        this.state = "dcs_ignore";
    }
    private beginDcsPassthrough(final: string): void {
        this.dcsBuf = "";
        // Capture final on a one-shot stash so the dispatch on ST can carry it.
        this.dcsFinal = final;
        this.state = "dcs_passthrough";
    }
    private dcsFinal = "";
    private stepDcsPassthrough(ch: string, cp: number): void {
        if (cp === ESC) {
            this.dispatchDcs();
            this.state = "escape";
            this.paramBuf = "";
            this.intermediateBuf = "";
            return;
        }
        this.dcsBuf += ch;
    }
    private stepDcsIgnore(cp: number): void {
        if (cp === ESC) {
            this.state = "escape";
            this.paramBuf = "";
            this.intermediateBuf = "";
        }
    }
    private dispatchDcs(): void {
        const params = parseParams(this.paramBuf);
        this.handler.onDcs(this.dcsFinal, params, this.intermediateBuf, this.dcsBuf);
        this.dcsBuf = "";
        this.paramBuf = "";
        this.intermediateBuf = "";
        this.dcsFinal = "";
        this.isPrivate = false;
        this.state = "ground";
    }

    // ---------- SOS / PM / APC ----------

    private stepSosPmApcString(ch: string, cp: number): void {
        if (cp === ESC) {
            this.handler.onSosPmApc(this.sosPmApcIntroducer, this.sosPmApcBuf);
            this.sosPmApcBuf = "";
            this.sosPmApcIntroducer = "";
            this.state = "escape";
            this.paramBuf = "";
            this.intermediateBuf = "";
            return;
        }
        this.sosPmApcBuf += ch;
    }

    // ---------- text flushing ----------

    private flushText(): void {
        if (this.textBuf.length === 0) return;
        this.handler.onText(this.textBuf);
        this.textBuf = "";
    }
}

// ---------- helpers ----------

// parseParams — turn a raw CSI/DCS parameter buffer ("1;38:5:200;2") into a
// flat numeric array [1, 38, 5, 200, 2].  Both ';' and ':' separate.  Empty
// fields → 0 (matches xterm convention).
function parseParams(raw: string): number[] {
    if (raw.length === 0) return [];
    const parts = raw.split(/[;:]/);
    const out: number[] = new Array(parts.length);
    for (let i = 0; i < parts.length; i++) {
        const s = parts[i];
        if (s.length === 0) {
            out[i] = 0;
        } else {
            const n = parseInt(s, 10);
            out[i] = Number.isFinite(n) ? n : 0;
        }
    }
    return out;
}
