// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// NLDModel — per-pane Jotai model owning the input-type lock state and
// the debounced classification loop.  Mirrors warp's BlocklistAIInputModel
// (app/src/ai/blocklist/input_model.rs) but scaled down to crest's
// "terminal | agent | auto" mode tri-state.
//
// State machine:
//   - User explicit override (segmented control click, `!` / `#` prefix
//     handled by caller) → locked = true, autodetectionMode irrelevant.
//   - Mode "auto" + classifier verdict → autodetectionMode tracks the
//     verdict; the effective mode (what would run on submit) is
//     autodetectionMode.  Locked = false.
//   - 250 ms cool-down after every explicit override suppresses
//     autodetection so the user's click doesn't bounce back.

import { globalStore } from "@/app/store/jotaiStore";
import type { InputMode } from "@/app/view/cmdblock/cmdblock-input";
import * as jotai from "jotai";

import { Classifier } from "./classifier";
import type { ClassifierContext, InputClassification } from "./types";
import { NEUTRAL_CLASSIFICATION } from "./types";

// Time window after an explicit lock/unlock during which autodetection
// stays silent.  Reference: warp input_model.rs:48
// AUTODETECTION_DISABLE_DURATION_MS = 250.
const COOLDOWN_MS = 250;

// Debounce period between buffer edits and the classification run.
// Matches warp's DEBOUNCE_INPUT_DECORATION_PERIOD = 10 ms — long enough
// to coalesce a burst of keystrokes, short enough that the user never
// notices.
const DEBOUNCE_MS = 10;

// How many recent commands tier-1 examines for the "user is retyping a
// known command" short-circuit.  100 mirrors warp's history cap behaviour.
const RECENT_COMMAND_WINDOW = 100;

export type DetectionStatus = "idle" | "running";

export class NLDModel {
    readonly outerBlockId: string;

    // The user's intent.  `auto` means "let the classifier choose".
    // Locked-vs-unlocked maps onto modeAtom !== "auto".  Default is
    // `agent`: ↵ sends to the agent, and a leading `!` is the explicit
    // escape hatch back to shell (handled in cmdblock-input).
    readonly modeAtom = jotai.atom<InputMode>("agent") as jotai.PrimitiveAtom<InputMode>;

    // What the classifier *would* run if the user hit enter right now.
    // Only meaningful when modeAtom === "auto".  Other times this stays
    // pinned to whatever the locked mode is.
    readonly effectiveModeAtom = jotai.atom<"terminal" | "agent">("agent") as jotai.PrimitiveAtom<
        "terminal" | "agent"
    >;

    readonly statusAtom = jotai.atom<DetectionStatus>("idle") as jotai.PrimitiveAtom<DetectionStatus>;
    readonly lastVerdictAtom = jotai.atom<InputClassification>(NEUTRAL_CLASSIFICATION) as jotai.PrimitiveAtom<InputClassification>;

    private readonly classifier: Classifier;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private inflight: AbortController | null = null;
    private lastExplicitAt: number = 0;
    private disposed = false;

    constructor(outerBlockId: string, classifier: Classifier = new Classifier()) {
        this.outerBlockId = outerBlockId;
        this.classifier = classifier;
    }

    // Caller (cmdblock-input parent) wires this to the editor's onChange.
    // Each keystroke schedules one classification run that supersedes
    // any in-flight or pending run.
    onTextChange(text: string, recentCommands: readonly string[], isAgentFollowUp: boolean): void {
        if (this.disposed) return;

        // Empty buffer — no work, just clear stale verdict.  We do not
        // reset effectiveMode here because flipping it on every backspace
        // would jitter the UI; the user submitted nothing, so leave the
        // last verdict visible.

        // Don't run autodetection when the user has explicitly locked
        // the mode.  Same gate as warp's should_run_input_autodetection.
        if (globalStore.get(this.modeAtom) !== "auto") {
            this.cancelInflight();
            return;
        }

        // Cool-down — recent explicit overrides win.
        if (Date.now() - this.lastExplicitAt < COOLDOWN_MS) {
            return;
        }

        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.runDetection(text, recentCommands, isAgentFollowUp);
        }, DEBOUNCE_MS);
    }

    private async runDetection(
        text: string,
        recentCommands: readonly string[],
        isAgentFollowUp: boolean
    ): Promise<void> {
        // Abort any in-flight run from the previous keystroke.
        this.cancelInflight();
        const ac = new AbortController();
        this.inflight = ac;

        globalStore.set(this.statusAtom, "running");

        const currentEffective = globalStore.get(this.effectiveModeAtom);
        const ctx: ClassifierContext = {
            currentMode: currentEffective,
            isAgentFollowUp,
            recentCommands: recentCommands.slice(-RECENT_COMMAND_WINDOW),
        };

        try {
            const verdict = await this.classifier.classify(text, ctx, ac.signal);
            if (ac.signal.aborted || this.disposed) return;
            if (globalStore.get(this.modeAtom) !== "auto") return;

            globalStore.set(this.lastVerdictAtom, verdict);

            // Diagnostic — filter DevTools console by "[NLD]" to inspect
            // tier-1 / tier-2 firing.  `source: "none"` means the embedder
            // wasn't ready (or both pools were empty), so the verdict is
            // neutral and the effective mode stays at whatever it was.
            // eslint-disable-next-line no-console
            console.log(
                "[NLD]",
                JSON.stringify(text),
                `pShell=${verdict.pShell.toFixed(3)}`,
                `pAI=${verdict.pAI.toFixed(3)}`,
                `source=${verdict.source}`
            );

            const next = verdict.pAI > verdict.pShell ? "agent" : "terminal";
            if (next !== currentEffective) {
                globalStore.set(this.effectiveModeAtom, next);
            }
        } finally {
            if (this.inflight === ac) {
                this.inflight = null;
                if (!this.disposed) globalStore.set(this.statusAtom, "idle");
            }
        }
    }

    // User explicitly picked a mode (auto toggle, `!`/`#` prefix handler,
    // /agent | /terminal slash commands).  Locking a mode also pins
    // effectiveMode; un-locking (to "auto") leaves effectiveMode at its
    // previous value until the next classifier run rewrites it.
    setMode(next: InputMode): void {
        this.lastExplicitAt = Date.now();
        this.cancelInflight();
        globalStore.set(this.modeAtom, next);
        if (next === "terminal" || next === "agent") {
            globalStore.set(this.effectiveModeAtom, next);
        }
    }

    // Force an immediate classifier run on the supplied buffer text,
    // bypassing the debounce *and* the post-explicit cooldown.  Intended
    // for one-shot triggers like "user just turned Auto on" — without
    // this, the auto-toggle would have to wait for the next keystroke
    // before NLD could overwrite the (now stale) effective mode.
    triggerDetectionImmediate(
        text: string,
        recentCommands: readonly string[],
        isAgentFollowUp: boolean
    ): void {
        if (this.disposed) return;
        if (globalStore.get(this.modeAtom) !== "auto") return;
        // Clear the cooldown that setMode("auto") just set — this run *is*
        // the side-effect the user asked for, so it must not be suppressed.
        this.lastExplicitAt = 0;
        if (text.trim().length === 0) return;
        void this.runDetection(text, recentCommands.slice(-RECENT_COMMAND_WINDOW), isAgentFollowUp);
    }

    // After a submit, surface the actually-used mode as a learning signal.
    // Splits two cases:
    //   - Mode was locked → user already taught us their preference, no
    //     need to add a prototype.
    //   - Mode was "auto" → the verdict drove the choice; if the user
    //     didn't flip the mode before submitting, treat it as implicit
    //     confirmation but DO NOT add to the prototype pool (too noisy —
    //     warp's design rationale; we agreed earlier).
    onSubmit(_text: string, _resolved: "terminal" | "agent"): void {
        // Hook reserved for future telemetry / prototype-learning policy.
        // Intentionally a no-op until the explicit-correction signal is
        // wired in (segmented control switch immediately after a wrong
        // verdict → learn(text, correct, "user-corrected")).
    }

    // Explicit user correction — append the (text, label) pair to
    // `corrections.jsonl` in the training/ folder so the next
    // `train_classifier.py` run can absorb it.  No in-process update of
    // the linear head: per-keystroke gradient updates aren't worth the
    // complexity given how cheap offline retraining is (one minute, one
    // command).  Today this is a console.info stub — the IndexedDB
    // persistence + an export-corrections UI come in a follow-up.
    async learnCorrection(text: string, klass: "shell" | "ai"): Promise<void> {
        // eslint-disable-next-line no-console
        console.info("[NLD] correction:", JSON.stringify({ text, label: klass }));
    }

    // Explicit prefix-based intent (`!` for shell, `#` for AI when those
    // get wired in cmdblock-input).  Same persistence story as
    // learnCorrection above.
    async learnExplicit(text: string, klass: "shell" | "ai"): Promise<void> {
        // eslint-disable-next-line no-console
        console.info("[NLD] explicit:", JSON.stringify({ text, label: klass }));
    }

    private cancelInflight(): void {
        if (this.inflight) {
            this.inflight.abort();
            this.inflight = null;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    dispose(): void {
        this.disposed = true;
        this.cancelInflight();
    }
}
