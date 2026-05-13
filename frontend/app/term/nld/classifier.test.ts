// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { Classifier } from "./classifier";
import { StubClassifier } from "./embedder";
import { EMPTY_CONTEXT, NEUTRAL_CLASSIFICATION, type NldClassifier } from "./types";

class FakeReadyClassifier implements NldClassifier {
    ready = true;
    constructor(private readonly pAI: number) {}
    async classify(): Promise<{ pShell: number; pAI: number } | null> {
        return { pShell: 1 - this.pAI, pAI: this.pAI };
    }
    dispose(): void {}
}

describe("Classifier", () => {
    it("returns neutral for empty input", async () => {
        const c = new Classifier();
        const result = await c.classify("", EMPTY_CONTEXT);
        expect(result).toEqual(NEUTRAL_CLASSIFICATION);
    });

    it("tier-1 strong shell short-circuits before tier-2", async () => {
        // sudo is in warp's 7-keyword list → tier-1 returns 1.0 shell.
        // The fake tier-2 would say full NL but must not be called.
        const c = new Classifier({ classifier: new FakeReadyClassifier(0.99) });
        const result = await c.classify("sudo apt update", EMPTY_CONTEXT);
        expect(result.pShell).toBe(1);
        expect(result.source).toBe("tier1");
    });

    it("tier-1 strong AI short-circuits before tier-2", async () => {
        const c = new Classifier({ classifier: new FakeReadyClassifier(0.0) });
        const result = await c.classify("hello", EMPTY_CONTEXT);
        expect(result.pAI).toBe(1);
        expect(result.source).toBe("tier1");
    });

    it("word-score fallback fires when ONNX classifier is not ready", async () => {
        // StubClassifier ready=false → composer routes ambiguous inputs
        // to warp's HeuristicClassifier word-score path (strict port).
        // English NL prose with recognizable vocabulary lands on AI.
        const c = new Classifier({ classifier: new StubClassifier() });
        const result = await c.classify("what does this command do", EMPTY_CONTEXT);
        expect(result.source).toBe("tier2");
        expect(result.pAI).toBe(1);
    });

    it("word-score fallback commits to shell on low NL score", async () => {
        // Mirrors warp's HeuristicClassifier behavior: when word-score
        // doesn't clear the threshold, return pure_shell (not neutral).
        const c = new Classifier({ classifier: new StubClassifier() });
        const result = await c.classify("foobar bazqux", EMPTY_CONTEXT);
        expect(result.source).toBe("tier2");
        expect(result.pShell).toBe(1);
    });

    it("tier-2 ONNX surfaces verdict when classifier is ready", async () => {
        const c = new Classifier({ classifier: new FakeReadyClassifier(0.85) });
        const result = await c.classify("xyzzy qwerty plover", EMPTY_CONTEXT);
        expect(result.source).toBe("tier2");
        expect(result.pAI).toBeCloseTo(0.85, 2);
        expect(result.pShell).toBeCloseTo(0.15, 2);
    });

    it("respects abort signal mid-flight", async () => {
        class SlowClassifier implements NldClassifier {
            ready = true;
            async classify(_text: string, signal: AbortSignal) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                if (signal.aborted) return null;
                return { pShell: 0.1, pAI: 0.9 };
            }
            dispose(): void {}
        }
        const ac = new AbortController();
        const c = new Classifier({ classifier: new SlowClassifier() });

        const p = c.classify("clean up the build", EMPTY_CONTEXT, ac.signal);
        ac.abort();
        const result = await p;
        expect(result.source).not.toBe("tier2");
    });
});
