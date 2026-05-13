// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Tier-1 classifier — synchronous, cheap.  Sole purpose is to short-
// circuit the obvious cases so tier-2 (the multilingual embedder)
// doesn't fire on every keystroke.
//
// **Strict port of warp's HeuristicClassifier.detect_input_type**:
//   - tokenize:          warp crates/input_classifier/src/parser.rs
//   - one-off NL words:  warp util.rs:25
//   - one-off shell kw:  warp util.rs:23
//   - agent follow-up:   warp util.rs:29
//   - is_likely_shell_command: warp util.rs:59-111
//   - shell-syntax char: warp natural_language_detection/src/lib.rs:73
//
// Two intentional deviations from a literal port, both because crest
// lacks signals warp's binary has:
//
//   1. **No completer / `token_description`.**  Warp's parsed_tokens
//      come from its completion engine which knows whether each token is
//      a recognized binary, a path, a flag, etc.  Crest doesn't have
//      that.  The `token_description.is_some()` branch in warp's
//      is_likely_shell_command can only be approximated by the shell-
//      syntax check we keep.  Result: crest's tier-1 is *weaker* than
//      warp's tier-1 for shell detection — it defers more cases to
//      tier-2 instead of short-circuiting.  By design.
//
//   2. **No `natural_language_words_score` word-list scoring.**  Warp's
//      heuristic classifier (when used as tier-2 fallback) walks the
//      input against three ~10K-entry English word lists.  Crest skips
//      this because (a) the lists are English-only and we want
//      multilingual, and (b) crest's actual tier-2 is a multilingual
//      sentence embedder that does richer semantic scoring than any
//      word-list lookup.  Tier-1 returns null for ambiguous cases and
//      lets tier-2 weigh in.

import type { ClassifierContext, InputClassification, Tier1Classifier } from "./types";

// Mirrors warp natural_language_detection/src/lib.rs:73
// (SHELL_SYNTAX_CHARS in check_if_token_has_shell_syntax).
const SHELL_SYNTAX_CHARS = new Set([
    "$", "=", "{", "}", "[", "]", ">", "<", "*", "~", "&", "(", ")", "|", "/", "-",
]);

// Mirrors warp input_classifier/src/util.rs:23 — exactly 7 entries.
//
// `claude`, `codex`, `gemini` are kept here for the same reason warp
// keeps them: false-positive NL classifications for those words (when
// the user is invoking the CLI tools of the same name) feel like the
// terminal is trying to push them into Agent Mode against their will.
const ONE_OFF_SHELL_COMMAND_KEYWORDS = new Set([
    "#", "echo", "man", "sudo", "claude", "codex", "gemini",
]);

// Mirrors warp input_classifier/src/util.rs:25 — exactly 11 entries.
//
// "1. " (with trailing space) is in warp's set; we keep it as "1." here
// since our tokenizer strips trailing whitespace from tokens before the
// lookup runs.  Functionally identical.
const ONE_OFF_NATURAL_LANGUAGE_WORDS = new Set([
    "hello", "hi", "hey", "hola", "thanks", "explain", "yes", "no", "what", "nice", "1.",
]);

// Mirrors warp input_classifier/src/util.rs:29 — exactly 3 entries.
const AGENT_FOLLOW_UP_INPUTS = new Set(["yes", "continue", "do it"]);

// Mirrors warp input_classifier/src/util.rs:9-13 — density thresholds.
const COMMAND_THRESHOLD = 0.5;
const COMMAND_LOW_TOKEN_THRESHOLD = 0.7;

// crest extension (not in warp's tier-1): history short-circuit.  Warp
// runs this at the `BlocklistAIInputModel` layer, *before* dispatching
// to the classifier (see warp app/src/ai/blocklist/input_model.rs:661
// has_any_close_matches).  We keep it inside tier-1 because crest's
// model layer doesn't have the equivalent pre-dispatch hook yet — the
// semantics (close match to recent successful command → almost surely
// shell) are identical.
const HISTORY_MATCH_CUTOFF = 0.9;

// =========================================================================
// Tokenizer — strict port of warp's SentenceParser
// (input_classifier/src/parser.rs).  Splits on whitespace.  Treats
// `,.!?` as *soft* separators that only split a token when the next
// character is whitespace or end-of-input — so `foo.txt`, `a.b.c`, and
// `hello, world` all yield the tokens warp would.  Keeps quoted strings
// intact.
// =========================================================================

type Delim = "ws" | "sep" | "dq" | "sq" | "bt";

function classifyChar(ch: string): Delim | null {
    if (ch === "'") return "sq";
    if (ch === '"') return "dq";
    if (ch === "`") return "bt";
    if (ch === "," || ch === "." || ch === "!" || ch === "?") return "sep";
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return "ws";
    return null;
}

function tokenize(text: string): string[] {
    const tokens: string[] = [];
    let buf = "";
    let quote: '"' | "'" | "`" | null = null;
    const chars = [...text]; // Unicode codepoint-safe iteration

    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];

        if (quote) {
            buf += ch;
            if (ch === quote) {
                if (buf !== `${quote}${quote}`) tokens.push(buf);
                buf = "";
                quote = null;
            }
            continue;
        }

        const kind = classifyChar(ch);

        if (kind === "ws") {
            if (buf) {
                tokens.push(buf);
                buf = "";
            }
            continue;
        }

        if (kind === "sep") {
            // Look-ahead — only split if the next char is whitespace or
            // end-of-input.  Otherwise the separator is mid-word
            // (`foo.txt`, `a.b.c`) and kept as plain text.
            const next = i + 1 < chars.length ? chars[i + 1] : null;
            const nextKind = next != null ? classifyChar(next) : null;
            if (next == null || nextKind === "ws") {
                if (buf) {
                    tokens.push(buf);
                    buf = "";
                }
            } else {
                buf += ch;
            }
            continue;
        }

        if (kind === "dq" || kind === "sq" || kind === "bt") {
            if (buf) {
                tokens.push(buf);
                buf = "";
            }
            quote = ch as '"' | "'" | "`";
            buf = ch;
            continue;
        }

        buf += ch;
    }

    if (buf) tokens.push(buf);
    return tokens;
}

// =========================================================================
// Shell-syntax detection — strict port of warp
// natural_language_detection/src/lib.rs:73 check_if_token_has_shell_syntax.
// =========================================================================
function tokenHasShellSyntax(token: string): boolean {
    // Quoted literals are excluded.
    if (token.length >= 2) {
        const first = token[0];
        const last = token[token.length - 1];
        if ((first === '"' || first === "'" || first === "`") && first === last) return false;
    }
    if (token.includes(" ")) return false; // matches warp's `!word.contains(' ')` guard
    for (const ch of token) {
        if (SHELL_SYNTAX_CHARS.has(ch)) return true;
    }
    return false;
}

// =========================================================================
// One-off NL prefix — warp util.rs:52 is_prefix_of_natural_language_word.
// Suppresses mode flipping while the user is mid-typing a known NL kickoff
// (e.g. "hel" is a prefix of "hello").
// =========================================================================
function isPrefixOfNaturalLanguageWord(input: string): boolean {
    for (const w of ONE_OFF_NATURAL_LANGUAGE_WORDS) {
        if (w.startsWith(input)) return true;
    }
    return false;
}

// =========================================================================
// History matcher — normalized Levenshtein ratio, kept simple.  Matches
// the *intent* of warp's difflib::SequenceMatcher::ratio at the cutoff
// of 0.9 (see warp app/src/ai/blocklist/input_model.rs:HISTORY_ENTRY_MATCH_CUTOFF).
// Not bit-identical but close enough for the "user is retyping a known
// command" short-circuit.
// =========================================================================
function similarityRatio(a: string, b: string): number {
    const x = a.slice(0, 64);
    const y = b.slice(0, 64);
    if (x === y) return 1;
    if (!x.length || !y.length) return 0;

    const m = x.length;
    const n = y.length;
    let prev = new Array<number>(n + 1);
    let curr = new Array<number>(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = x[i - 1] === y[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    const distance = prev[n];
    return 1 - distance / Math.max(m, n);
}

// =========================================================================
// is_likely_shell_command — strict port of warp util.rs:59-111, with the
// completer signal omitted (see header comment).  Returns true when the
// shell-syntax density meets warp's threshold *or* the first token is
// one of the seven one-off shell keywords.
// =========================================================================
function isLikelyShellCommand(tokens: string[]): boolean {
    if (tokens.length === 0) return false;

    let likelyCommandTokenCount = 0;
    const firstTokenLower = tokens[0].toLowerCase();

    // warp util.rs:74-78 — early return on first-token shell keyword.
    if (ONE_OFF_SHELL_COMMAND_KEYWORDS.has(firstTokenLower)) {
        return true;
    }

    // warp util.rs:80-84 — density signal.  Without `token_description`
    // we can only count shell-syntax tokens, not "recognized binary"
    // tokens.  Crest's tier-1 therefore under-counts shell signal
    // relative to warp; the gap is covered by tier-2.
    for (const token of tokens) {
        if (tokenHasShellSyntax(token)) {
            likelyCommandTokenCount++;
        }
    }

    const total = tokens.length;
    const threshold =
        total <= 2 ? 1.0 : total <= 4 ? COMMAND_LOW_TOKEN_THRESHOLD : COMMAND_THRESHOLD;

    if (likelyCommandTokenCount >= Math.floor(total * threshold)) {
        return true;
    }

    return false;
}

function pureShell(): InputClassification {
    return { pShell: 1, pAI: 0, source: "tier1" };
}

function pureAI(): InputClassification {
    return { pShell: 0, pAI: 1, source: "tier1" };
}

export class HeuristicTier1 implements Tier1Classifier {
    classify(text: string, ctx: ClassifierContext): InputClassification | null {
        const trimmed = text.trim();
        if (!trimmed) return null;

        const lower = trimmed.toLowerCase();

        // warp input_model.rs:706-711 — agent follow-up.  Lives at the
        // model layer in warp, before classifier dispatch; we hoist it
        // here so the "yes/continue/do it" affirmatives bypass every
        // other check.  Only applies when the prior block was AI.
        if (ctx.isAgentFollowUp && AGENT_FOLLOW_UP_INPUTS.has(lower)) {
            return pureAI();
        }

        const tokens = tokenize(trimmed);
        if (tokens.length === 0) return null;

        // warp heuristic_classifier/mod.rs:46-50 — single-token one-off
        // NL word (or prefix of one) wins immediately.  Runs before the
        // shell short-circuit so "hi", "hey", "tha[nks]" etc. never get
        // misclassified as commands.
        if (
            tokens.length === 1 &&
            (ONE_OFF_NATURAL_LANGUAGE_WORDS.has(lower) || isPrefixOfNaturalLanguageWord(lower))
        ) {
            return pureAI();
        }

        // crest extension (see header comment) — history match.  Warp
        // runs this in BlocklistAIInputModel; we keep it inline because
        // crest's model layer doesn't have the equivalent pre-dispatch
        // hook yet.
        for (const cmd of ctx.recentCommands) {
            if (similarityRatio(trimmed, cmd) >= HISTORY_MATCH_CUTOFF) {
                return pureShell();
            }
        }

        // warp heuristic_classifier/mod.rs:52-54 + util.rs:59-111.
        // Covers single-token shell keywords (echo/sudo/man/...) AND
        // multi-token shell-syntax density.
        if (isLikelyShellCommand(tokens)) {
            return pureShell();
        }

        // Ambiguous.  Tier-1 has no opinion; defer to the composer
        // which will route to tier-2 (ONNX) when ready, or to
        // word-score (warp's heuristic fallback) when it isn't.
        return null;
    }
}

// `tokenize` is also consumed by heuristic-word-score and the composer
// for ambiguous-path word-score fallback.  Exported because warp's
// parser.rs lives in a separate module too.
export { tokenize };

// Test-only escape hatch.
export const __testing = {
    tokenize,
    tokenHasShellSyntax,
    similarityRatio,
    isLikelyShellCommand,
    isPrefixOfNaturalLanguageWord,
};
