// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
    ContextCountAccuracy,
    ContextDeliveryScope,
    ContextProjectionItemReport,
    ContextProjectionReport,
    ContextRenderedRepresentation,
    ContextRepresentation,
    ContextSourceKind,
} from "@crest/agent/harness/types";
export type {
    ContextCountAccuracy,
    ContextDeliveryScope,
    ContextProjectionItemReport,
    ContextProjectionReport,
    ContextRenderedRepresentation,
    ContextRepresentation,
    ContextSourceKind,
};

export type {
    AgentContextSnapshot,
    BuildContextSnapshotInput,
    ContextAttributionReconciliation,
    ContextSnapshotAccuracy,
    ContextSnapshotCategory,
    ContextSnapshotCategorySummary,
    ContextSnapshotIdentity,
    ContextSnapshotItem,
    ContextSnapshotItemKind,
    ContextSnapshotItemSource,
    ContextSnapshotLifecycle,
    ContextSnapshotProviderUsage,
} from "./inspector-types";

export type ContextBudgetStatus = "fits" | "references_over_budget" | "base_over_budget" | "counter_unavailable";

export interface ContextReferenceConfig {
    enabled: boolean;
    maxTokens?: number;
}

export interface ContextProvenance {
    sourceKind: ContextSourceKind;
    sourceSessionId: string;
    sourceSessionPath: string;
    sourceSessionTitle?: string;
    sourceCwd: string;
    sourceTurnId?: string;
    sourceLeafId: string | null;
    sourceMessageEntryIds: string[];
    preview: string;
    capturedAt: string;
}

export type ContextSnapshotBlock =
    | { type: "text"; text: string }
    | { type: "tool_call"; id: string; name: string; arguments: unknown }
    | { type: "image_omitted"; mimeType: string; byteLength: number };

export interface ContextSnapshotMessage {
    role: "user" | "assistant" | "tool_result";
    content: ContextSnapshotBlock[];
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
}

export interface ContextGeneratedSummary {
    text: string;
    summarySha256: string;
    modelKey: string;
    promptVersion: string;
    generatedAt: string;
}

export interface ContextArtifact {
    schemaVersion: 1;
    provenance: ContextProvenance;
    messages: ContextSnapshotMessage[];
    summary?: ContextGeneratedSummary;
    snapshotSha256: string;
    canonicalByteLength: number;
}

export interface ContextAttachmentData {
    schemaVersion: 1;
    transactionId: string;
    artifactEntryId: string;
    deliveryScope: ContextDeliveryScope;
    requestedRepresentation: ContextRepresentation;
    targetTurnId: string;
    selectionOrder: number;
}

export interface ContextTransactionalEntryBase {
    transactionId?: string;
}

export interface ContextDraftView {
    draftId: string;
    targetSessionPath: string;
    provenance: ContextProvenance;
    summaryStatus: "none" | "summarizing" | "ready" | "failed";
    expiresAt: string;
}

export interface ContextArtifactDraft {
    artifact: ContextArtifact;
}

export interface ContextBudgetItem {
    attachmentEntryId?: string;
    draftId?: string;
    representation: ContextRenderedRepresentation;
    advisoryTokens: number;
}

export interface ContextBudgetResult {
    schemaVersion: 1;
    revision: string;
    status: ContextBudgetStatus;
    accuracy?: ContextCountAccuracy;
    contextWindow?: number;
    effectiveOutputReserve?: number;
    inputLimit?: number;
    baseInputTokens?: number;
    finalInputTokens?: number;
    referenceTokens?: number;
    maxReferenceTokens?: number;
    excessTokens: number;
    items: ContextBudgetItem[];
}

export interface ContextJournalDiagnostic {
    message: string;
    entryId?: string;
}

export interface ContextJournalAttachment {
    attachmentEntryId: string;
    data: ContextAttachmentData;
    artifact?: ContextArtifact;
    summary?: ContextGeneratedSummary;
}

export interface ContextJournalState {
    artifacts: Map<string, ContextArtifact>;
    attachmentsByTurn: Map<string, ContextJournalAttachment[]>;
    attachmentsForTurn(targetTurnId: string): ContextJournalAttachment[];
    conversationAttachmentsForTurns(targetTurnIds: readonly string[]): ContextJournalAttachment[];
    projectionReports: ContextProjectionReport[];
    diagnostics: ContextJournalDiagnostic[];
}

export type ContextDecodeResult<T> = { value: T; diagnostic?: never } | { value?: never; diagnostic: string };

export class ContextReferenceError extends Error {
    budget?: ContextBudgetResult;
    code:
        | "disabled"
        | "invalid_input"
        | "draft_expired"
        | "source_not_found"
        | "source_too_large"
        | "summary_not_ready"
        | "duplicate_artifact"
        | "artifact_missing"
        | "budget_stale"
        | "budget_exceeded"
        | "counter_unavailable"
        | "projection_failed"
        | "transaction_failed";

    constructor(code: ContextReferenceError["code"], message: string, cause?: Error) {
        super(message, cause == null ? undefined : { cause });
        this.name = "ContextReferenceError";
        this.code = code;
    }
}
