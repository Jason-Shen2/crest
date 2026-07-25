// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type ContextSourceKind = "turn" | "session";
export type ContextDeliveryScope = "message" | "conversation";
export type ContextRepresentation = "full" | "summary";
export type ContextRenderedRepresentation = ContextRepresentation | "attention";
export type ContextBudgetStatus = "fits" | "references_over_budget" | "base_over_budget" | "counter_unavailable";
export type ContextCountAccuracy = "exact" | "conservative_upper_bound" | "estimated";

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

export interface ContextProjectionItemReport {
    attachmentEntryId: string;
    artifactEntryId?: string;
    sourceKind?: ContextSourceKind;
    sourceSessionId?: string;
    sourceSessionTitle?: string;
    sourceTurnId?: string;
    sourcePreview?: string;
    deliveryScope: ContextDeliveryScope;
    requestedRepresentation?: ContextRepresentation;
    renderedRepresentation: ContextRenderedRepresentation;
    advisoryTokens: number;
    reason: "selected" | "already_present";
}

export interface ContextProjectionReport {
    schemaVersion: 1;
    transactionId: string;
    targetTurnId: string;
    createdAt: string;
    contextWindow: number;
    effectiveOutputReserve: number;
    inputLimit: number;
    baseInputTokens: number;
    finalInputTokens: number;
    referenceTokens: number;
    countAccuracy: ContextCountAccuracy;
    maxReferenceTokens?: number;
    overlaySha256: string;
    items: ContextProjectionItemReport[];
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
