// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Heuristic word-score classifier — port of warp's
// `natural_language_words_score` (crates/natural_language_detection/src/lib.rs)
// plus the `natural_language_detection_heuristic` threshold logic
// (crates/input_classifier/src/heuristic_classifier/mod.rs).
//
// Architecturally this is tier-1.5: it sits between the cheap tier-1
// short-circuits (one-off keyword lookups, history match, density) and
// the expensive tier-2 fine-tuned ONNX classifier.  When the input has
// enough recognizable English NL vocabulary to clear the threshold,
// returning "ai" here saves a worker round-trip.  When the score is
// ambiguous we return null and let tier-2 decide — different from
// warp's HeuristicClassifier which always commits to one of the two
// classes, but appropriate for our composer architecture.

import porter2 from "wink-porter2-stemmer";
import englishStemsRaw from "./word-lists/english-stems.txt?raw";
import knownCommandsRaw from "./word-lists/known-commands.txt?raw";

const ENGLISH_STEMS = new Set(
    englishStemsRaw
        .trim()
        .split("\n")
        .filter((s) => s.length > 0)
);
const KNOWN_COMMANDS = new Set(
    knownCommandsRaw
        .trim()
        .split("\n")
        .filter((s) => s.length > 0)
);

// warp natural_language_detection/lib.rs:16
//
// "what" is a tricky case because it's a valid English question word
// AND it can show up at position 0 of an input.  Without RESERVED_KEYWORDS,
// the first-token-command bypass would skip "what" when the completer
// reports it as a known command (it's not, but `what` is in some PATHs);
// the bypass is gated on this exclusion to keep "what does X do" working.
const RESERVED_KEYWORDS = new Set(["what"]);

// warp natural_language_detection/lib.rs:11-13
// Strip common English contractions so "he's"/"mustn't" map to "he"/"must"
// before the dictionary lookup runs.
const CONTRACTION_REGEX = /('s|'re|n't|'t|'m|'ve|'ll)$/;

// warp natural_language_detection/lib.rs:73 — same SHELL_SYNTAX_CHARS as
// tier-1's tokenHasShellSyntax.  Duplicated here to avoid circular
// imports with heuristic-tier1.ts.
const SHELL_SYNTAX_CHARS = new Set([
    "$", "=", "{", "}", "[", "]", ">", "<", "*", "~", "&", "(", ")", "|", "/", "-",
]);

// warp natural_language_detection/lib.rs:91-109
function tokenPreprocessing(token: string): string {
    let t = token.toLowerCase();
    // "can't" is a special case in the contraction matching logic.
    if (t === "can't") return "can";
    return t.replace(CONTRACTION_REGEX, "");
}

function isWrappedInQuotes(token: string): boolean {
    if (token.length < 2) return false;
    const first = token[0];
    const last = token[token.length - 1];
    return (first === '"' && last === '"') || (first === "'" && last === "'");
}

function hasShellSyntax(token: string): boolean {
    if (isWrappedInQuotes(token)) return false;
    if (token.includes(" ")) return false;
    for (const c of token) {
        if (SHELL_SYNTAX_CHARS.has(c)) return true;
    }
    return false;
}

// warp natural_language_detection/lib.rs:36-71
//
// Score a sequence of word-tokens for NL likelihood.  Positive
// signals: English-stem hits and known-command hits.  Negative signals:
// shell-syntax tokens (unquoted).  First token is given a free pass if
// it's a recognized command, so a user typing "ls is what mean" gets
// "is/what/mean" evaluated for NL-ness instead of being penalized for
// starting with `ls`.
export function naturalLanguageWordsScore(
    tokens: readonly string[],
    isFirstTokenCommand: boolean = false
): number {
    let count = 0;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokenPreprocessing(tokens[i]);
        if (!t) continue;

        // First-token-command bypass.  Either the word list confirms it
        // OR the caller (with a completer signal we don't have in crest)
        // confirms it — but in either case, "what" is excluded so that
        // "what does X do" still scores correctly.
        if (
            i === 0 &&
            (KNOWN_COMMANDS.has(t) ||
                (isFirstTokenCommand && !RESERVED_KEYWORDS.has(t)))
        ) {
            continue;
        }

        // Direct command hit — counts as NL because "the user mentioned
        // a tool" usually appears in a question context.
        if (KNOWN_COMMANDS.has(t)) {
            count += 1;
            continue;
        }

        // Stem and look up against English vocab + commands.
        const stemmed = porter2(t);
        if (ENGLISH_STEMS.has(stemmed) || KNOWN_COMMANDS.has(stemmed)) {
            count += 1;
        } else if (!isWrappedInQuotes(t) && hasShellSyntax(t)) {
            // saturating_sub: don't go below zero.
            count = Math.max(0, count - 1);
        }
    }
    return count;
}

// warp heuristic_classifier/mod.rs:96-143 — `natural_language_detection_heuristic`.
//
// Strict port: returns "ai" or "shell" — never null.  Warp's
// HeuristicClassifier uses this as the FINAL decision when no ML is
// available, so it must commit.  We use it the same way (composer
// calls it only when the ONNX classifier reports not-ready); the
// commit-to-shell branch matches warp's behavior even though it can
// be wrong on ambiguous inputs — the assumption is that real
// classification responsibility lives in tier-2, and word-score is
// the offline-degraded fallback.
const DETECT_AS_NL_THRESHOLD = 0.6;
const DETECT_AS_NL_LOW_TOKEN_THRESHOLD = 0.8;
const MINIMUM_NL_DETECTION_TOKEN_LENGTH = 2;

// warp heuristic_classifier/mod.rs:34 — exact character set.
// Single space, ?, !, ., ", , — no \s superset (would also match
// tab/newline which warp doesn't treat as word boundary).
const END_TOKEN_COMPLETE_CHARS = new Set([" ", "?", "!", ".", '"', ","]);

export function classifyByWordScore(
    tokens: readonly string[],
    bufferText: string,
    isFirstTokenCommand: boolean = false
): "ai" | "shell" {
    // warp mod.rs:106-108 — pure_shell when too few tokens to score.
    if (tokens.length < MINIMUM_NL_DETECTION_TOKEN_LENGTH) return "shell";

    let working = tokens;
    const lastChar = bufferText.length > 0 ? bufferText[bufferText.length - 1] : "";
    const lastTokenComplete = END_TOKEN_COMPLETE_CHARS.has(lastChar);
    if (!lastTokenComplete && working.length > 2) {
        working = working.slice(0, -1);
    }

    const nlCount = naturalLanguageWordsScore(working, isFirstTokenCommand);
    const n = working.length;

    const threshold =
        n <= 3 ? 1.0 : n <= 4 ? DETECT_AS_NL_LOW_TOKEN_THRESHOLD : DETECT_AS_NL_THRESHOLD;

    if (nlCount >= Math.floor(n * threshold)) {
        return "ai";
    }
    return "shell";
}

// Re-exported for the test file.
export const __testing = {
    tokenPreprocessing,
    hasShellSyntax,
    isWrappedInQuotes,
    KNOWN_COMMANDS,
    ENGLISH_STEMS,
};
