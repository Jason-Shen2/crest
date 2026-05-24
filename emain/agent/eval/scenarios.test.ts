// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Offline tests for the regression-harness assertion logic. The live
// runner (run-regression.ts) needs API keys and a network, so it can't
// run in CI — but the *check* functions in scenarios.ts are pure over a
// RunCapture and must be correct, since a buggy check silently passes a
// broken agent. These tests pin that logic.

import { describe, expect, it } from "vitest";

import { SCENARIOS, type RunCapture } from "./scenarios";

function baseCapture(over: Partial<RunCapture> = {}): RunCapture {
    return {
        toolCalls: [],
        toolResults: [],
        finalText: "",
        stopReason: "stop",
        turnCount: 1,
        ...over,
    };
}

function scenario(id: string) {
    const s = SCENARIOS.find((x) => x.id === id);
    if (!s) throw new Error(`no scenario "${id}"`);
    return s;
}

describe("regression scenario checks", () => {
    describe("text-only", () => {
        const s = scenario("text-only");
        it("passes on a clean OK with no tools", () => {
            expect(s.check(baseCapture({ finalText: "OK" }))).toEqual([]);
        });
        it("fails if any tool was called", () => {
            const fails = s.check(
                baseCapture({ finalText: "OK", toolCalls: [{ name: "ls", args: {} }] }),
            );
            expect(fails.length).toBeGreaterThan(0);
        });
        it("fails if the text doesn't contain OK", () => {
            expect(s.check(baseCapture({ finalText: "sure thing" })).length).toBeGreaterThan(0);
        });
        it("fails on an errored stop reason", () => {
            const fails = s.check(
                baseCapture({ finalText: "OK", stopReason: "error", errorMessage: "boom" }),
            );
            expect(fails.some((f) => f.includes("boom"))).toBe(true);
        });
    });

    describe("list-dir", () => {
        const s = scenario("list-dir");
        it("passes when ls was called without error", () => {
            expect(
                s.check(baseCapture({ toolCalls: [{ name: "ls", args: {} }], toolResults: [{ name: "ls", isError: false }] })),
            ).toEqual([]);
        });
        it("fails when ls was never called", () => {
            expect(s.check(baseCapture()).length).toBeGreaterThan(0);
        });
        it("fails when the tool returned an error result", () => {
            const fails = s.check(
                baseCapture({ toolCalls: [{ name: "ls", args: {} }], toolResults: [{ name: "ls", isError: true }] }),
            );
            expect(fails.some((f) => f.includes("error result"))).toBe(true);
        });
    });

    describe("read-file", () => {
        const s = scenario("read-file");
        it("passes when read ran and text mentions crest", () => {
            expect(
                s.check(baseCapture({ toolCalls: [{ name: "read", args: {} }], finalText: 'the name is "crest"' })),
            ).toEqual([]);
        });
        it("fails when read ran but name not mentioned", () => {
            const fails = s.check(
                baseCapture({ toolCalls: [{ name: "read", args: {} }], finalText: "it is a package" }),
            );
            expect(fails.length).toBeGreaterThan(0);
        });
    });

    describe("shell-exec", () => {
        const s = scenario("shell-exec");
        it("passes when shell_exec ran and marker echoed", () => {
            expect(
                s.check(baseCapture({ toolCalls: [{ name: "shell_exec", args: {} }], finalText: "output was regression-marker-42" })),
            ).toEqual([]);
        });
        it("fails when marker is missing", () => {
            expect(
                s.check(baseCapture({ toolCalls: [{ name: "shell_exec", args: {} }], finalText: "done" })).length,
            ).toBeGreaterThan(0);
        });
    });

    describe("multi-step", () => {
        const s = scenario("multi-step");
        it("passes with >=2 tool calls including read", () => {
            expect(
                s.check(
                    baseCapture({
                        toolCalls: [
                            { name: "ls", args: {} },
                            { name: "read", args: {} },
                        ],
                    }),
                ),
            ).toEqual([]);
        });
        it("fails with a single tool call", () => {
            expect(
                s.check(baseCapture({ toolCalls: [{ name: "ls", args: {} }] })).length,
            ).toBeGreaterThan(0);
        });
    });
});
