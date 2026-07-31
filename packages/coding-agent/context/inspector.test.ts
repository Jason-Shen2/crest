// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
    buildContextSnapshot,
    markContextSnapshotLifecycle,
    reconcileContextAttribution,
} from "./inspector";
import type { BuildContextSnapshotInput, ContextSnapshotItem } from "./inspector-types";

const GeneratedAt = "2026-08-01T00:00:00.000Z";

function item(overrides: Partial<ContextSnapshotItem> = {}): ContextSnapshotItem {
    return {
        id: "base-prompt",
        category: "agent_instructions",
        kind: "base_prompt",
        title: "Base instructions",
        preview: "You are an expert coding assistant.",
        tokens: 120,
        tokenAccuracy: "estimated",
        source: {},
        ...overrides,
    };
}

function fixture(overrides: Partial<BuildContextSnapshotInput> = {}): BuildContextSnapshotInput {
    return {
        identity: {
            sessionPath: "/sessions/current.jsonl",
            sessionId: "session-1",
            leafId: "leaf-1",
            modelKey: "openai/gpt-5",
            revision: 1,
        },
        generatedAt: GeneratedAt,
        lifecycle: "ready",
        accuracy: "exact",
        modelLabel: "GPT-5",
        contextWindow: 200_000,
        outputReserve: 16_000,
        providerInputTokens: 25_053,
        items: [item()],
        ...overrides,
    };
}

describe("Context Inspector snapshot", () => {
    it("subtracts output reserve from usable input capacity", () => {
        const snapshot = buildContextSnapshot(fixture());

        expect(snapshot.inputCapacity).toBe(184_000);
    });

    it("uses provider input without adding cache, output, or reasoning usage", () => {
        const snapshot = buildContextSnapshot(
            fixture({
                providerInputTokens: 25_053,
                providerUsage: {
                    cachedInputTokens: 23_424,
                    outputTokens: 79,
                    reasoningTokens: 29,
                },
            })
        );

        expect(snapshot.effectiveInputTokens).toBe(25_053);
    });

    it("keeps semantic categories in product order", () => {
        const snapshot = buildContextSnapshot(
            fixture({
                items: [
                    item({ id: "reference", category: "added_context", kind: "context_reference" }),
                    item({ id: "turn", category: "conversation", kind: "turn" }),
                    item({ id: "tool", category: "tools", kind: "tool_definition" }),
                    item(),
                ],
            })
        );

        expect(snapshot.categories.map((category) => category.category)).toEqual([
            "agent_instructions",
            "tools",
            "conversation",
            "added_context",
        ]);
    });

    it("accounts for a non-negative unassigned request overhead", () => {
        expect(reconcileContextAttribution(500, 420)).toEqual({
            requestOverheadTokens: 80,
            attributionDeltaTokens: undefined,
        });
    });

    it("reports attribution overlap without rescaling semantic items", () => {
        expect(reconcileContextAttribution(400, 420)).toEqual({
            requestOverheadTokens: 0,
            attributionDeltaTokens: -20,
        });
    });

    it("falls back to estimated semantic input when provider counting is unavailable", () => {
        const snapshot = buildContextSnapshot(
            fixture({ providerInputTokens: undefined, accuracy: "estimated", items: [item({ tokens: 240 })] })
        );

        expect(snapshot).toMatchObject({
            accuracy: "estimated",
            effectiveInputTokens: 240,
            remainingInputTokens: 183_760,
        });
    });

    it("keeps inventory while token counts are unavailable", () => {
        const snapshot = buildContextSnapshot(
            fixture({
                providerInputTokens: undefined,
                accuracy: "unavailable",
                items: [item({ tokens: undefined, tokenAccuracy: "unavailable" })],
            })
        );

        expect(snapshot.effectiveInputTokens).toBeUndefined();
        expect(snapshot.remainingInputTokens).toBeUndefined();
        expect(snapshot.items).toHaveLength(1);
    });

    it("clamps remaining capacity at zero", () => {
        const snapshot = buildContextSnapshot(fixture({ providerInputTokens: 190_000 }));

        expect(snapshot.remainingInputTokens).toBe(0);
    });

    it("changes lifecycle without mutating the prior snapshot", () => {
        const snapshot = buildContextSnapshot(fixture());
        const waiting = markContextSnapshotLifecycle(snapshot, "waiting_for_tool", "Waiting for tool result");

        expect(waiting).not.toBe(snapshot);
        expect(waiting).toMatchObject({ lifecycle: "waiting_for_tool", diagnostic: "Waiting for tool result" });
        expect(snapshot).toMatchObject({ lifecycle: "ready", diagnostic: undefined });
    });
});
