// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
    AgentContextSnapshot,
    BuildContextSnapshotInput,
    ContextAttributionReconciliation,
    ContextSnapshotCategory,
    ContextSnapshotCategorySummary,
    ContextSnapshotItem,
    ContextSnapshotLifecycle,
} from "./inspector-types";

export const ContextSnapshotCategoryOrder: readonly ContextSnapshotCategory[] = [
    "agent_instructions",
    "tools",
    "conversation",
    "added_context",
];

function validTokenCount(value: number | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function attributedItemTokens(items: readonly ContextSnapshotItem[]): number | undefined {
    let total = 0;
    for (const item of items) {
        if (!validTokenCount(item.tokens)) return undefined;
        total += item.tokens;
    }
    return total;
}

export function summarizeContextCategories(
    items: readonly ContextSnapshotItem[]
): ContextSnapshotCategorySummary[] {
    return ContextSnapshotCategoryOrder.map((category) => {
        const categoryItems = items.filter((item) => item.category === category);
        return {
            category,
            tokens: attributedItemTokens(categoryItems),
            itemCount: categoryItems.length,
        };
    });
}

export function reconcileContextAttribution(
    effectiveInputTokens: number,
    attributedTokens: number
): ContextAttributionReconciliation {
    const difference = effectiveInputTokens - attributedTokens;
    if (difference >= 0) {
        return {
            requestOverheadTokens: difference,
            attributionDeltaTokens: undefined,
        };
    }
    return {
        requestOverheadTokens: 0,
        attributionDeltaTokens: difference,
    };
}

export function buildContextSnapshot(input: BuildContextSnapshotInput): AgentContextSnapshot {
    const contextWindow = Math.max(0, Math.trunc(input.contextWindow));
    const outputReserve = Math.max(0, Math.trunc(input.outputReserve));
    const inputCapacity = Math.max(0, contextWindow - outputReserve);
    const categories = summarizeContextCategories(input.items);
    const semanticTokens = attributedItemTokens(input.items);
    const providerInputTokens = validTokenCount(input.providerInputTokens)
        ? Math.trunc(input.providerInputTokens)
        : undefined;
    const effectiveInputTokens =
        providerInputTokens ?? (input.accuracy === "estimated" && semanticTokens != null ? semanticTokens : undefined);
    const reconciliation =
        effectiveInputTokens != null && semanticTokens != null
            ? reconcileContextAttribution(effectiveInputTokens, semanticTokens)
            : undefined;
    const attributionDiagnostic =
        reconciliation?.attributionDeltaTokens == null
            ? undefined
            : `Estimated source attribution exceeds provider input by ${Math.abs(reconciliation.attributionDeltaTokens)} tokens.`;

    return {
        schemaVersion: 1,
        identity: { ...input.identity },
        generatedAt: input.generatedAt,
        lifecycle: input.lifecycle,
        accuracy: input.accuracy,
        modelLabel: input.modelLabel,
        contextWindow,
        outputReserve,
        inputCapacity,
        effectiveInputTokens,
        remainingInputTokens:
            effectiveInputTokens == null ? undefined : Math.max(0, inputCapacity - effectiveInputTokens),
        requestOverheadTokens: reconciliation?.requestOverheadTokens,
        attributionDeltaTokens: reconciliation?.attributionDeltaTokens,
        categories,
        items: input.items.map((item) => ({ ...item, source: { ...item.source } })),
        diagnostic: input.diagnostic ?? attributionDiagnostic,
    };
}

export function markContextSnapshotLifecycle(
    snapshot: AgentContextSnapshot,
    lifecycle: ContextSnapshotLifecycle,
    diagnostic?: string
): AgentContextSnapshot {
    return {
        ...snapshot,
        lifecycle,
        diagnostic,
    };
}
