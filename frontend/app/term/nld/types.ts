// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// NLD (Natural Language Detection) — public types shared across tiers,
// the embedder, the prototype store, and the per-pane model.
//
// Reference: warp crates/input_classifier/src/{lib,input_type}.rs.

import type { InputMode } from "@/app/view/cmdblock/cmdblock-input";

// The classifier verdict on a piece of input.  Mirrors warp's
// ClassificationResult { p_shell, p_ai }.
export interface InputClassification {
    pShell: number;
    pAI: number;
    // Which tier produced the verdict; "none" means we kept the prior mode
    // because no tier had enough confidence to call it.
    source: "tier1" | "tier2" | "none";
}

export const NEUTRAL_CLASSIFICATION: InputClassification = {
    pShell: 0.5,
    pAI: 0.5,
    source: "none",
};

// Reduce a classification to a definitive shell/agent decision.  Above the
// neutral threshold we trust the winner; below it we stay with the caller's
// fallback (typically the current effective mode).
export function classificationToMode(
    c: InputClassification,
    fallback: "terminal" | "agent" = "terminal",
    margin: number = 0.05
): "terminal" | "agent" {
    const delta = c.pAI - c.pShell;
    if (Math.abs(delta) < margin) return fallback;
    return delta > 0 ? "agent" : "terminal";
}

// Context the classifier reads while deciding.
export interface ClassifierContext {
    // The current effective mode (what we'd run if user hit enter now).
    // Used so tier-1 can keep the existing mode when input is too ambiguous.
    currentMode: "terminal" | "agent";
    // True when the previous block was an AI block, so short follow-ups
    // ("yes", "continue", "do it") bias toward AI.  Reference: warp
    // input_model.rs:706.
    isAgentFollowUp: boolean;
    // Past commands the user successfully executed in this pane.  Used by
    // tier-1 history short-circuit: a near-exact match to a prior command
    // is strong evidence the user is re-running shell.  Reference: warp
    // input_model.rs:661 has_any_close_matches.
    recentCommands: readonly string[];
}

export const EMPTY_CONTEXT: ClassifierContext = {
    currentMode: "terminal",
    isAgentFollowUp: false,
    recentCommands: [],
};

// A tier-1 classifier is synchronous and cheap (≤ 1 ms).  Returns `null`
// when it has no opinion — the composer should then defer to tier-2.
export interface Tier1Classifier {
    classify(text: string, ctx: ClassifierContext): InputClassification | null;
}

// A tier-2 classifier is async (embedder inference + cosine match).  Must
// honor `signal.aborted` between awaits so per-keystroke firing can cancel
// stale runs.  Returns `null` if the embedder is not ready yet (e.g. while
// the model is still downloading or when running with a stub).
export interface Tier2Classifier {
    classify(
        text: string,
        ctx: ClassifierContext,
        signal: AbortSignal
    ): Promise<InputClassification | null>;
}

// NldClassifier — wraps whatever inference engine produces a binary
// shell-vs-NL verdict.  Replaced the previous frozen-embedder + linear-
// head approach with an end-to-end fine-tuned binary classifier (same
// architecture warp uses for bert_tiny.onnx, just multilingual).
//
// `classify` returns probabilities directly; `null` means "not ready
// yet" so callers should treat it as neutral and not throw.
export interface NldClassifier {
    classify(
        text: string,
        signal: AbortSignal
    ): Promise<{ pShell: number; pAI: number } | null>;
    readonly ready: boolean;
    dispose(): void;
}

// Re-export crest's InputMode so consumers of this module don't have to
// reach into cmdblock-input.
export type { InputMode };
