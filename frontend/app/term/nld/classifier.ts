// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Classifier composer — runs tier-1 first, then tier-2 (the end-to-end
// fine-tuned ONNX classifier) if tier-1 didn't yield a strong opinion.
// Owns the anti-flicker margin and the abort semantics so the per-pane
// model stays small.
//
// Tier-2 is now a fine-tuned binary classifier with the classification
// head fused into the ONNX graph (same shape as warp's bert_tiny.onnx,
// just multilingual).  No external linear head; no prototype matching.

import { getClassifier } from "./embedder";
import { HeuristicTier1, tokenize } from "./heuristic-tier1";
import { classifyByWordScore } from "./heuristic-word-score";
import {
    classificationToMode,
    EMPTY_CONTEXT,
    NEUTRAL_CLASSIFICATION,
    type ClassifierContext,
    type InputClassification,
    type NldClassifier,
    type Tier1Classifier,
} from "./types";

// Tier-2 fires only after enough text exists.  Below this we fall through
// to "keep current mode" — same idea as warp's "MINIMUM_..._TOKEN_LENGTH"
// constants in heuristic_classifier/mod.rs.
const TIER2_MIN_CHAR_LENGTH = 3;

// Confidence margin below which we keep the current effective mode.
// Fine-tuned classifier outputs near-saturated probabilities (typically
// >0.99 / <0.01) so the dead zone rarely fires — it's a guard for the
// edge case where the model genuinely sees a borderline input.
const NEUTRAL_MARGIN = 0.05;

export interface ClassifierDeps {
    tier1?: Tier1Classifier;
    classifier?: NldClassifier;
}

export class Classifier {
    private readonly tier1: Tier1Classifier;
    private readonly nld: NldClassifier;

    constructor(deps: ClassifierDeps = {}) {
        this.tier1 = deps.tier1 ?? new HeuristicTier1();
        this.nld = deps.classifier ?? getClassifier();
    }

    async classify(
        text: string,
        ctx: ClassifierContext = EMPTY_CONTEXT,
        signal?: AbortSignal
    ): Promise<InputClassification> {
        const ac = signal ?? new AbortController().signal;
        const trimmed = text.trim();
        if (!trimmed) return NEUTRAL_CLASSIFICATION;

        // Tier-1 — sync, cheap.  Strong opinion wins immediately.
        const t1 = this.tier1.classify(trimmed, ctx);
        if (t1 && Math.abs(t1.pAI - t1.pShell) >= NEUTRAL_MARGIN) {
            return t1;
        }

        if (trimmed.length < TIER2_MIN_CHAR_LENGTH) {
            return t1 ?? NEUTRAL_CLASSIFICATION;
        }

        // Tier-2 ONNX is the primary heavy classifier.  When it isn't
        // ready yet (model + tokenizer still loading, or load failed),
        // fall back to warp's heuristic word-score path — a strict
        // port of HeuristicClassifier.classify_input from warp.  This
        // mirrors warp's per-classifier dispatch: when ML is
        // unavailable, the word-list-based heuristic is the canonical
        // fallback.  Always commits to a verdict (no null) so the
        // mode never just floats while ONNX is loading.
        if (!this.nld.ready) {
            const tokens = tokenize(trimmed);
            const verdict = classifyByWordScore(tokens, trimmed);
            if (verdict === "ai") {
                return { pShell: 0, pAI: 1, source: "tier2" };
            }
            return { pShell: 1, pAI: 0, source: "tier2" };
        }

        const verdict = await this.nld.classify(trimmed, ac);
        if (!verdict || ac.aborted) return t1 ?? NEUTRAL_CLASSIFICATION;

        const { pShell, pAI } = verdict;

        if (Math.abs(pAI - pShell) < NEUTRAL_MARGIN) {
            return t1 ?? { ...NEUTRAL_CLASSIFICATION, source: "tier2" };
        }

        return { pShell, pAI, source: "tier2" };
    }

    async classifyToMode(
        text: string,
        ctx: ClassifierContext = EMPTY_CONTEXT,
        signal?: AbortSignal
    ): Promise<"terminal" | "agent"> {
        const result = await this.classify(text, ctx, signal);
        return classificationToMode(result, ctx.currentMode, NEUTRAL_MARGIN);
    }
}
