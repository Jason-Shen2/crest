// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { HeuristicTier1, __testing } from "./heuristic-tier1";
import { EMPTY_CONTEXT } from "./types";

describe("tokenize (warp parser.rs strict port)", () => {
    const { tokenize } = __testing;

    it("splits on whitespace", () => {
        expect(tokenize("git status")).toEqual(["git", "status"]);
    });

    it("keeps double-quoted strings as one token", () => {
        expect(tokenize('echo "hello world"')).toEqual(["echo", '"hello world"']);
    });

    it("keeps single-quoted strings as one token", () => {
        expect(tokenize("grep 'foo bar' file")).toEqual(["grep", "'foo bar'", "file"]);
    });

    it("splits on . , ! ? only when followed by whitespace or EOL", () => {
        // warp parser.rs:62-77 — separator look-ahead.
        expect(tokenize("hello, world!")).toEqual(["hello", "world"]);
        expect(tokenize("foo.txt")).toEqual(["foo.txt"]);
        expect(tokenize("a.b.c")).toEqual(["a.b.c"]);
        expect(tokenize("done.")).toEqual(["done"]);
    });
});

describe("tokenHasShellSyntax (warp natural_language_detection lib.rs strict port)", () => {
    const { tokenHasShellSyntax } = __testing;

    it("flags shell metachars", () => {
        expect(tokenHasShellSyntax("$HOME")).toBe(true);
        expect(tokenHasShellSyntax("foo|bar")).toBe(true);
        expect(tokenHasShellSyntax("./script.sh")).toBe(true);
        expect(tokenHasShellSyntax("-rf")).toBe(true);
    });

    it("does not flag plain words", () => {
        expect(tokenHasShellSyntax("hello")).toBe(false);
        expect(tokenHasShellSyntax("status")).toBe(false);
    });

    it("does not flag quoted literals", () => {
        expect(tokenHasShellSyntax('"$HOME"')).toBe(false);
        expect(tokenHasShellSyntax("'pipe|inside'")).toBe(false);
    });
});

describe("isLikelyShellCommand", () => {
    const { isLikelyShellCommand } = __testing;

    it("first-token shell keyword wins immediately", () => {
        expect(isLikelyShellCommand(["sudo", "rm", "-rf", "/"])).toBe(true);
        expect(isLikelyShellCommand(["echo", "hi"])).toBe(true);
        expect(isLikelyShellCommand(["man", "ls"])).toBe(true);
        expect(isLikelyShellCommand(["#", "comment"])).toBe(true);
    });

    it("first-token non-shell-keyword falls back to density", () => {
        // "ls" is NOT in warp's one-off shell keyword list — density
        // alone decides.  "ls" + "-la": 1 of 2 tokens has shell syntax,
        // threshold for 2 tokens is 1.0 → 1 < 2 → not shell.
        expect(isLikelyShellCommand(["ls", "-la"])).toBe(false);
        // "git status": no shell-syntax tokens, threshold 1.0 → not shell.
        expect(isLikelyShellCommand(["git", "status"])).toBe(false);
    });

    it("density crosses threshold for multi-flag commands", () => {
        // Density check uses floor() / `as usize` truncation (warp util.rs:104).
        // 4 tokens, threshold 0.7, floor(4*0.7)=2 → need 2+ shell-syntax tokens.
        // ["docker", "-it", "--rm", "ubuntu"]: 2 hits ("-it", "--rm") → ≥ 2 → shell.
        expect(isLikelyShellCommand(["docker", "-it", "--rm", "ubuntu"])).toBe(true);
        // 5 tokens, threshold 0.5, floor(5*0.5)=2 → need 2+.
        // ["docker", "-it", "--rm", "-v", "/tmp"]: 4 hits → shell.
        expect(isLikelyShellCommand(["docker", "-it", "--rm", "-v", "/tmp"])).toBe(true);
        // 3 tokens, threshold 0.7, floor(3*0.7)=2 → need 2+.
        // ["ls", "-la", "src"]: 1 hit ("-la") → 1 < 2 → not shell.
        expect(isLikelyShellCommand(["ls", "-la", "src"])).toBe(false);
    });
});

describe("HeuristicTier1 — strict warp port", () => {
    const tier1 = new HeuristicTier1();

    it("returns null for empty input", () => {
        expect(tier1.classify("", EMPTY_CONTEXT)).toBeNull();
        expect(tier1.classify("   ", EMPTY_CONTEXT)).toBeNull();
    });

    it("single-token one-off NL → AI (warp util.rs:25)", () => {
        expect(tier1.classify("hello", EMPTY_CONTEXT)?.pAI).toBe(1);
        expect(tier1.classify("hi", EMPTY_CONTEXT)?.pAI).toBe(1);
        expect(tier1.classify("hey", EMPTY_CONTEXT)?.pAI).toBe(1);
        expect(tier1.classify("hola", EMPTY_CONTEXT)?.pAI).toBe(1);
        expect(tier1.classify("thanks", EMPTY_CONTEXT)?.pAI).toBe(1);
        expect(tier1.classify("explain", EMPTY_CONTEXT)?.pAI).toBe(1);
        expect(tier1.classify("yes", EMPTY_CONTEXT)?.pAI).toBe(1);
        expect(tier1.classify("no", EMPTY_CONTEXT)?.pAI).toBe(1);
        expect(tier1.classify("what", EMPTY_CONTEXT)?.pAI).toBe(1);
        expect(tier1.classify("nice", EMPTY_CONTEXT)?.pAI).toBe(1);
    });

    it("prefix-of-NL kickoff → AI (warp util.rs:52)", () => {
        // "hel" is a prefix of "hello", "hey".  Mid-typing should bias AI.
        expect(tier1.classify("hel", EMPTY_CONTEXT)?.pAI).toBe(1);
        expect(tier1.classify("tha", EMPTY_CONTEXT)?.pAI).toBe(1);
    });

    it("single-token shell keyword (warp's 7) → shell", () => {
        expect(tier1.classify("sudo", EMPTY_CONTEXT)?.pShell).toBe(1);
        expect(tier1.classify("echo", EMPTY_CONTEXT)?.pShell).toBe(1);
        expect(tier1.classify("man", EMPTY_CONTEXT)?.pShell).toBe(1);
        expect(tier1.classify("claude", EMPTY_CONTEXT)?.pShell).toBe(1);
        expect(tier1.classify("codex", EMPTY_CONTEXT)?.pShell).toBe(1);
        expect(tier1.classify("gemini", EMPTY_CONTEXT)?.pShell).toBe(1);
    });

    it("multi-token starting with shell keyword → shell", () => {
        expect(tier1.classify("sudo rm -rf /", EMPTY_CONTEXT)?.pShell).toBe(1);
        expect(tier1.classify("echo hello world", EMPTY_CONTEXT)?.pShell).toBe(1);
        expect(tier1.classify("man git", EMPTY_CONTEXT)?.pShell).toBe(1);
    });

    it("commands NOT in warp's tiny list defer to tier-2 (the design choice)", () => {
        // The user's regression case: `ls -la 是什么意思` used to short-circuit
        // to shell because we'd extended the keyword list with `ls`.  Strict
        // warp port has only 7 keywords; `ls/git/cd/npm/...` are not among
        // them.  Tier-1 now returns null and defers to the multilingual
        // tier-2 embedder.
        expect(tier1.classify("ls -la 是什么意思", EMPTY_CONTEXT)).toBeNull();
        expect(tier1.classify("git status 怎么用", EMPTY_CONTEXT)).toBeNull();
        expect(tier1.classify("git status", EMPTY_CONTEXT)).toBeNull();
        expect(tier1.classify("ls -la", EMPTY_CONTEXT)).toBeNull();
        expect(tier1.classify("cd ~/projects", EMPTY_CONTEXT)).toBeNull();
    });

    it("agent follow-up: short affirmative after AI block → AI", () => {
        const followUp = { ...EMPTY_CONTEXT, isAgentFollowUp: true };
        expect(tier1.classify("yes", followUp)?.pAI).toBe(1);
        expect(tier1.classify("continue", followUp)?.pAI).toBe(1);
        expect(tier1.classify("do it", followUp)?.pAI).toBe(1);
    });

    it("history short-circuit triggers shell for repeat commands", () => {
        // Cutoff is 0.9 (matches warp HISTORY_ENTRY_MATCH_CUTOFF in
        // input_model.rs:45).  Exact retypes pass; longer commands with
        // a single-char typo cross the threshold too.
        const ctx = {
            ...EMPTY_CONTEXT,
            recentCommands: ["yarn dev", "git push origin feature-branch"],
        };
        expect(tier1.classify("yarn dev", ctx)?.pShell).toBe(1);
        expect(tier1.classify("git push origin feature-branchh", ctx)?.pShell).toBe(1);
    });

    it("dense shell-syntax input → shell", () => {
        // Enough metachars to clear the density threshold without a
        // recognized first-token keyword.
        const result = tier1.classify("$VAR=foo ./script.sh --flag -v /etc/file", EMPTY_CONTEXT);
        expect(result?.pShell).toBe(1);
    });

    it("ambiguous English NL prose defers to tier-2", () => {
        // No shell syntax, no first-token keyword, no history match.
        // Tier-1 has no English word-list scoring (intentional), so
        // these defer to the embedder.
        expect(tier1.classify("please write a function for me", EMPTY_CONTEXT)).toBeNull();
        expect(tier1.classify("how do I list files", EMPTY_CONTEXT)).toBeNull();
        expect(tier1.classify("ls -la 是什么意思", EMPTY_CONTEXT)).toBeNull();
    });
});
