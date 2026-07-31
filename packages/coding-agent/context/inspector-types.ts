// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type ContextSnapshotLifecycle =
    | "ready"
    | "in_use"
    | "waiting_for_tool"
    | "updating"
    | "out_of_date"
    | "unavailable";

export type ContextSnapshotAccuracy = "exact" | "estimated" | "unavailable";

export type ContextSnapshotCategory = "agent_instructions" | "tools" | "conversation" | "added_context";

export type ContextSnapshotItemKind =
    | "base_prompt"
    | "runtime_guidance"
    | "project_instruction"
    | "skill"
    | "tool_definition"
    | "turn"
    | "compaction_summary"
    | "branch_summary"
    | "context_reference";

export interface ContextSnapshotIdentity {
    sessionPath?: string;
    sessionId?: string;
    leafId: string | null;
    modelKey: string;
    revision: number;
}

export interface ContextSnapshotItemSource {
    entryIds?: string[];
    path?: string;
    skillName?: string;
    toolName?: string;
    toolCallId?: string;
    pairedResultEntryId?: string;
    coveredEntryIds?: string[];
    attachmentEntryId?: string;
    artifactEntryId?: string;
}

export interface ContextSnapshotItem {
    id: string;
    category: ContextSnapshotCategory;
    kind: ContextSnapshotItemKind;
    title: string;
    preview: string;
    tokens?: number;
    tokenAccuracy: "estimated" | "unavailable";
    source: ContextSnapshotItemSource;
    children?: ContextSnapshotItem[];
    diagnostic?: string;
}

export interface ContextSnapshotCategorySummary {
    category: ContextSnapshotCategory;
    tokens?: number;
    itemCount: number;
}

export interface AgentContextSnapshot {
    schemaVersion: 1;
    identity: ContextSnapshotIdentity;
    generatedAt: string;
    lifecycle: ContextSnapshotLifecycle;
    accuracy: ContextSnapshotAccuracy;
    modelLabel: string;
    contextWindow: number;
    outputReserve: number;
    inputCapacity: number;
    effectiveInputTokens?: number;
    remainingInputTokens?: number;
    requestOverheadTokens?: number;
    attributionDeltaTokens?: number;
    categories: ContextSnapshotCategorySummary[];
    items: ContextSnapshotItem[];
    diagnostic?: string;
}

export interface ContextSnapshotProviderUsage {
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
}

export interface BuildContextSnapshotInput {
    identity: ContextSnapshotIdentity;
    generatedAt: string;
    lifecycle: ContextSnapshotLifecycle;
    accuracy: ContextSnapshotAccuracy;
    modelLabel: string;
    contextWindow: number;
    outputReserve: number;
    providerInputTokens?: number;
    providerUsage?: ContextSnapshotProviderUsage;
    items: ContextSnapshotItem[];
    diagnostic?: string;
}

export interface ContextAttributionReconciliation {
    requestOverheadTokens: number;
    attributionDeltaTokens?: number;
}
