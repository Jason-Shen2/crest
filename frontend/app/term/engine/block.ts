// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Block — one command invocation, from prompt to exit code.  Mirrors warp's
// `terminal/model/block.rs`.  Aggregates:
//
//   - headerGrid  : HeaderGrid  (the prompt + command row)
//   - outputGrid  : BlockGrid   (stdout/stderr of the command)
//   - altScreen   : AltScreen   (vim/htop, when active)
//   - state       : BlockLifecycleState (driven by OSC 133 markers)
//   - precmdState : PrecmdState (warp's internal "output collected?" flag,
//                                independent of `state`)
//   - metadata    : exitCode, pwd, branch, three timestamps, agent session id
//
// The parser uses `activeGrid()` to decide where to send the next byte:
// either the header grid (still in prompt+command phase), the output grid
// (executing), or the alt-screen (TUI active).  All state transitions are
// triggered by explicit method calls (startPrompt / endPrompt /
// startCommand / finishCommand / enterAltScreen / exitAltScreen) — never
// inferred from byte content.

import { AltScreen } from "./alt-screen";
import { BlockGrid } from "./block-grid";
import { HeaderGrid } from "./header-grid";
import { terminalCaptureActive } from "./terminal-state";
import {
    AgentBlockRef,
    BlockId,
    BlockKind,
    BlockLifecycleState,
    ImagePlacement,
    PrecmdState,
    SessionId,
    TermMode,
} from "./types";

export const LONG_RUNNING_COMMAND_DURATION_MS = 50;

export type BlockInteractionMode =
    | "idle"
    | "input-editor"
    | "terminal-capture"
    | "long-running-command"
    | "alt-screen"
    | "cli-agent";

export interface BlockInit {
    id: BlockId;
    seq: number;
    sessionId?: SessionId;
    cols: number;
    creationTs?: number;
    // Defaults to "shell".  Agent blocks set this to "agent" via the
    // appendAgentBlock factory on Blocks; callers should not construct
    // agent blocks directly.
    kind?: BlockKind;
    agentRef?: AgentBlockRef;
}

export class Block {
    readonly id: BlockId;
    readonly seq: number;
    readonly sessionId?: SessionId;
    // Partitions block timeline into shell (PTY-driven) vs agent (LLM
    // exchange). Agent blocks bypass the ANSI parser; the assistant-ui
    // pane owns conversation rendering.
    readonly kind: BlockKind;
    // Populated only when kind === "agent". Thin reference to a pi run
    // (see usePiChat + slicePiRuns). The actual message data lives on
    // the React side; the engine just remembers which run this block
    // belongs to and when it was appended (for timeline ordering).
    agentRef?: AgentBlockRef;

    readonly headerGrid: HeaderGrid;
    readonly outputGrid: BlockGrid;
    readonly altScreen: AltScreen;

    state: BlockLifecycleState = "waiting-for-input";
    precmdState: PrecmdState = "before-precmd";

    exitCode?: number;
    pwd?: string;
    gitBranch?: string;
    gitBranchName?: string;
    // Working-tree diff stats parsed from `git diff --shortstat HEAD`,
    // emitted by shell precmd hooks.  `undefined` while outside a git repo
    // or before any precmd has fired.
    gitDiffAdded?: number;
    gitDiffRemoved?: number;
    gitDiffFiles?: number;
    virtualEnv?: string;
    nodeVersion?: string;

    // Fallback for the typed command text.  `headerGrid.commandText()`
    // parses the command out of replayed prompt bytes (via OSC 133;B/C
    // markers); for historical blocks loaded via GetCmdBlocksCommand we
    // don't replay chunks, so we cache the Go-side `cmd` field here and
    // render it when the grid scan comes up empty.
    cmd?: string;

    // Timestamps in ms since epoch.  warp uses ns but UI doesn't benefit
    // from that precision — and Date.now() is universally available.
    readonly creationTs: number;
    startTs?: number;
    completedTs?: number;
    wasLongRunning = false;
    // Set when the parser detects an inline TUI (ED 2 on a running block)
    // so we can switch the outputGrid to bounded viewport semantics.
    inlineTuiActive = false;

    agentSessionId?: string;

    // Display flags.  warp distinguishes "hide the whole block" from "hide
    // just the output grid" / "hide just the command grid" — useful for
    // in-band commands (hide everything) vs agent-run commands (might want
    // to show output but not the agent's typing).
    hidden = false;
    shouldHideOutputGrid = false;
    shouldHideCommandGrid = false;

    // Collapsed = render a truncated view (first N + last M rows) with a
    // "click to expand" affordance.  Set automatically when a finished
    // block's output grows past the collapse threshold; togglable per
    // block by the user via the toolbelt / context menu.
    collapsed = false;

    // Background = long-running daemon output not tied to a user command.
    // Static = synthesized (bootstrap, system messages).  Both render with
    // distinct visual treatment.
    isBackground = false;
    isStatic = false;

    // Image table — populated by the kitty / iTerm 1337 graphics handlers.
    // Cells reference images via CellExtra.imageId.
    readonly images: Map<string, ImagePlacement> = new Map();

    // Last interaction timestamp — bumped on every parser write so the UI
    // can show "X minutes ago" without resubscribing to every chunk.
    lastWriteTs: number;

    constructor(init: BlockInit) {
        this.id = init.id;
        this.seq = init.seq;
        this.sessionId = init.sessionId;
        this.kind = init.kind ?? "shell";
        this.agentRef = init.agentRef;
        const ts = init.creationTs ?? Date.now();
        this.creationTs = ts;
        this.lastWriteTs = ts;
        this.headerGrid = new HeaderGrid(init.cols);
        this.outputGrid = new BlockGrid(init.cols);
        this.altScreen = new AltScreen(init.cols);
    }

    // ---------- routing ----------

    // activeGrid — the parser writes here.  Resolution order:
    //
    //   1. AltScreen if entered: vim/htop bytes route to it regardless of
    //      block state.
    //   2. outputGrid if state is running / done-with-execution / background
    //      / static.  Once the command starts, all bytes are output.
    //   3. headerGrid otherwise — we're still in the prompt/command phase.
    //
    // The header grid further routes between its two internal grids based on
    // its own receivingMode (set by OSC 133;B).
    activeGrid(): BlockGrid {
        if (this.altScreen.active) {
            // AltScreen exposes a plain Grid; wrap-as-BlockGrid is awkward,
            // so the parser handles alt-screen routing directly (see
            // ansi-parser dispatcher).  This method is just for non-alt
            // routing.
            return this.outputGrid;
        }
        if (this.state === "running" || this.state === "done-with-execution" || this.isBackground || this.isStatic) {
            return this.outputGrid;
        }
        // Header phase — route to the active sub-grid of HeaderGrid.
        return this.headerGrid.getReceivingMode() === "prompt"
            ? this.headerGrid.promptGrid
            : this.headerGrid.promptAndCommandGrid;
    }

    // ---------- lifecycle ----------

    // OSC 133;A — prompt start
    startPrompt(): void {
        this.headerGrid.onStartPrompt();
    }

    // OSC 133;B — prompt end / command region start
    endPrompt(): void {
        this.headerGrid.onEndPrompt();
    }

    // OSC 133;C — command execution begins.  Flip state to running.
    // Behavior reference: warp app/src/terminal/model/block.rs:1186 (`start`).
    startCommand(): void {
        // Mark the end of the user-input region in the header.
        this.headerGrid.onEndCommand();
        // Bracket: start the output grid so the parser starts writing there.
        this.outputGrid.start();
        this.state = "running";
        // Idempotent — first set wins.  Matches warp's behavior where the
        // earlier of (preexec, 133;C) sets the timestamp and later events
        // don't overwrite it.
        if (this.startTs == null) {
            this.startTs = Date.now();
        }
    }

    // OSC 133;D — command finished.  Records exit code; flips state.
    // Behavior reference: warp app/src/terminal/model/block.rs:1576 (`finish`).
    finishCommand(exitCode?: number): void {
        this.exitCode = exitCode;
        this.outputGrid.finish();
        this.headerGrid.finish();
        this.state = "done-with-execution";
        this.precmdState = "after-precmd";
        if (this.inlineTuiActive) {
            this.inlineTuiActive = false;
            this.outputGrid.raw().resetScrollRegion();
        }
        // Idempotent — guards against duplicate 133;D events.
        if (this.completedTs == null) {
            this.completedTs = Date.now();
        }
    }

    // ---------- alt-screen ----------

    enterAltScreen(clear: boolean = true): void {
        this.altScreen.enter(clear);
    }
    exitAltScreen(): void {
        this.altScreen.exit();
    }

    // ---------- write tracking ----------

    // Called by the parser after dispatching any byte.  Lets the
    // TerminalModel show liveness ("active 200ms ago") without subscribing
    // to every individual write event.
    noteWrite(): void {
        this.lastWriteTs = Date.now();
    }

    // ---------- queries ----------

    isRunning(): boolean {
        return this.state === "running";
    }

    isActiveAndLongRunning(now: number = Date.now()): boolean {
        if (!this.isRunning()) return false;
        if (this.wasLongRunning) return true;
        if (this.startTs == null) return false;
        if (now - this.startTs > LONG_RUNNING_COMMAND_DURATION_MS) {
            this.wasLongRunning = true;
            return true;
        }
        return false;
    }

    interactionMode(mode: TermMode, now: number = Date.now()): BlockInteractionMode {
        if (this.altScreen.active) return "alt-screen";
        if (!this.isRunning()) return "idle";
        if (terminalCaptureActive(mode)) return "terminal-capture";
        if (this.isActiveAndLongRunning(now)) return "long-running-command";
        return "input-editor";
    }

    // commandText — the user's typed input.  Tries the headerGrid scan
    // first (parsed from replayed OSC 133;B/C markers), falls back to the
    // Go-side `cmd` field for historical blocks where chunks weren't
    // replayed.
    commandText(): string {
        const fromGrid = this.headerGrid.commandText();
        if (fromGrid) return fromGrid;
        return this.cmd ?? "";
    }

    // durationMs — wall-clock from startTs to completedTs.  Undefined while
    // running (caller should use Date.now() - startTs for live readouts).
    durationMs(): number | undefined {
        if (this.startTs == null) return undefined;
        const end = this.completedTs ?? Date.now();
        return end - this.startTs;
    }

    // visible — true if this block should appear in the block list.  Filters
    // applied by Blocks collection.
    isVisible(): boolean {
        return !this.hidden;
    }
}
