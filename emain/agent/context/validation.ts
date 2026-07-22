// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    ContextArtifact,
    ContextAttachmentData,
    ContextDecodeResult,
    ContextGeneratedSummary,
    ContextLifecycle,
    ContextDetachData,
    ContextProjectionItemReport,
    ContextProjectionReport,
    ContextProvenance,
    ContextReferenceConfig,
    ContextReferenceError,
    ContextRepresentation,
    ContextRenderedRepresentation,
    ContextSnapshotBlock,
    ContextSnapshotMessage,
    ContextSourceKind,
    ContextUpdateData,
} from "./types";

const Sha256Pattern = /^[a-f0-9]{64}$/;

function invalid(message: string): never {
    throw new ContextReferenceError("invalid_input", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) invalid(`${field} must be a non-empty string`);
    return value;
}

function optionalString(value: unknown, field: string): string | undefined {
    if (value == null) return undefined;
    return requiredString(value, field);
}

function parseSourceKind(value: unknown): ContextSourceKind {
    if (value === "turn" || value === "session") return value;
    return invalid("sourceKind must be turn or session");
}

export function parseContextLifecycle(value: unknown): ContextLifecycle {
    if (value === "once" || value === "pinned") return value;
    return invalid("lifecycle must be once or pinned");
}

export function parseContextRepresentation(value: unknown): ContextRepresentation {
    if (value === "full" || value === "summary" || value === "metadata") return value;
    return invalid("representation must be full, summary, or metadata");
}

export function parseContextReferenceConfig(value: unknown): ContextReferenceConfig {
    if (!isRecord(value)) invalid("AI config must be an object");
    if (!Object.hasOwn(value, "context_references")) return { enabled: true };
    const rawConfig = value.context_references;
    if (!isRecord(rawConfig)) invalid("context_references must be an object");

    const enabled = Object.hasOwn(rawConfig, "enabled") ? rawConfig.enabled : true;
    if (typeof enabled !== "boolean") invalid("context_references.enabled must be a boolean");

    if (!Object.hasOwn(rawConfig, "max_tokens")) return { enabled };
    const rawMaxTokens = rawConfig.max_tokens;
    if (typeof rawMaxTokens !== "number" || !Number.isFinite(rawMaxTokens)) {
        invalid("context_references.max_tokens must be a finite number");
    }
    return { enabled, maxTokens: Math.min(128000, Math.max(0, Math.trunc(rawMaxTokens))) };
}

function validateProvenance(value: unknown): ContextProvenance {
    if (!isRecord(value)) invalid("provenance must be an object");
    const sourceKind = parseSourceKind(value.sourceKind);
    const sourceTurnId = optionalString(value.sourceTurnId, "sourceTurnId");
    const sourceLeafId = value.sourceLeafId == null ? null : requiredString(value.sourceLeafId, "sourceLeafId");
    if (sourceKind === "turn" && sourceTurnId == null) invalid("sourceTurnId is required for turn artifacts");
    if (sourceKind === "session" && sourceLeafId == null) invalid("sourceLeafId is required for session artifacts");
    if (!Array.isArray(value.sourceMessageEntryIds) || value.sourceMessageEntryIds.length === 0) {
        invalid("sourceMessageEntryIds must contain at least one entry ID");
    }
    const sourceMessageEntryIds = value.sourceMessageEntryIds.map((entryId) => requiredString(entryId, "sourceMessageEntryIds"));

    return {
        sourceKind,
        sourceSessionId: requiredString(value.sourceSessionId, "sourceSessionId"),
        sourceSessionPath: requiredString(value.sourceSessionPath, "sourceSessionPath"),
        sourceSessionTitle: optionalString(value.sourceSessionTitle, "sourceSessionTitle"),
        sourceCwd: requiredString(value.sourceCwd, "sourceCwd"),
        sourceTurnId,
        sourceLeafId,
        sourceMessageEntryIds,
        preview: requiredString(value.preview, "preview"),
        capturedAt: requiredString(value.capturedAt, "capturedAt"),
    };
}

function validateSnapshotBlock(value: unknown): ContextSnapshotBlock {
    if (!isRecord(value)) invalid("snapshot block must be an object");
    if (value.type === "text") return { type: "text", text: requiredString(value.text, "text") };
    if (value.type === "tool_call") {
        return {
            type: "tool_call",
            id: requiredString(value.id, "tool call id"),
            name: requiredString(value.name, "tool call name"),
            arguments: value.arguments,
        };
    }
    if (value.type === "image_omitted") {
        if (typeof value.byteLength !== "number" || !Number.isFinite(value.byteLength) || value.byteLength < 0) {
            invalid("image byteLength must be a non-negative finite number");
        }
        return { type: "image_omitted", mimeType: requiredString(value.mimeType, "mimeType"), byteLength: value.byteLength };
    }
    return invalid("snapshot block type is invalid");
}

function validateSnapshotMessage(value: unknown): ContextSnapshotMessage {
    if (!isRecord(value)) invalid("snapshot message must be an object");
    if (value.role !== "user" && value.role !== "assistant" && value.role !== "tool_result") invalid("snapshot message role is invalid");
    if (!Array.isArray(value.content)) invalid("snapshot message content must be an array");
    if (value.isError != null && typeof value.isError !== "boolean") invalid("isError must be a boolean");
    return {
        role: value.role,
        content: value.content.map(validateSnapshotBlock),
        toolCallId: optionalString(value.toolCallId, "toolCallId"),
        toolName: optionalString(value.toolName, "toolName"),
        isError: value.isError as boolean | undefined,
    };
}

function validateSummary(value: unknown): ContextGeneratedSummary {
    if (!isRecord(value)) invalid("summary must be an object");
    const summarySha256 = requiredString(value.summarySha256, "summarySha256");
    if (!Sha256Pattern.test(summarySha256)) invalid("summarySha256 must be a lowercase SHA-256 hash");
    return {
        text: requiredString(value.text, "summary text"),
        summarySha256,
        modelKey: requiredString(value.modelKey, "summary modelKey"),
        promptVersion: requiredString(value.promptVersion, "summary promptVersion"),
        generatedAt: requiredString(value.generatedAt, "summary generatedAt"),
    };
}

export function validateContextArtifact(value: unknown): ContextArtifact {
    if (!isRecord(value)) invalid("artifact must be an object");
    if (value.schemaVersion !== 1) invalid("artifact schemaVersion must be 1");
    if (!Array.isArray(value.messages)) invalid("artifact messages must be an array");
    const snapshotSha256 = requiredString(value.snapshotSha256, "snapshotSha256");
    if (!Sha256Pattern.test(snapshotSha256)) invalid("snapshotSha256 must be a lowercase SHA-256 hash");
    if (typeof value.canonicalByteLength !== "number" || !Number.isFinite(value.canonicalByteLength) || value.canonicalByteLength < 0) {
        invalid("canonicalByteLength must be a non-negative finite number");
    }
    return {
        schemaVersion: 1,
        provenance: validateProvenance(value.provenance),
        messages: value.messages.map(validateSnapshotMessage),
        summary: value.summary == null ? undefined : validateSummary(value.summary),
        snapshotSha256,
        canonicalByteLength: value.canonicalByteLength,
    };
}

export function validateContextAttachmentData(value: unknown): ContextAttachmentData {
    if (!isRecord(value)) invalid("context attachment must be an object");
    if (value.schemaVersion !== 1) invalid("context attachment schemaVersion must be 1");
    const lifecycle = parseContextLifecycle(value.lifecycle);
    if (lifecycle === "pinned" && Object.hasOwn(value, "targetTurnId")) {
        invalid("targetTurnId is not allowed for pinned attachments");
    }
    if (typeof value.selectionOrder !== "number" || !Number.isInteger(value.selectionOrder) || value.selectionOrder < 0) {
        invalid("selectionOrder must be a non-negative integer");
    }
    const transactionId = requiredString(value.transactionId, "transactionId");
    const artifactEntryId = requiredString(value.artifactEntryId, "artifactEntryId");
    const requestedRepresentation = parseContextRepresentation(value.requestedRepresentation);
    if (lifecycle === "pinned") {
        return {
            schemaVersion: 1,
            transactionId,
            artifactEntryId,
            lifecycle,
            requestedRepresentation,
            selectionOrder: value.selectionOrder,
        };
    }
    const targetTurnId = requiredString(value.targetTurnId, "targetTurnId");
    return {
        schemaVersion: 1,
        transactionId,
        artifactEntryId,
        lifecycle,
        requestedRepresentation,
        targetTurnId,
        selectionOrder: value.selectionOrder,
    };
}

export function decodeContextArtifact(value: unknown): ContextDecodeResult<ContextArtifact> {
    if (isRecord(value) && value.schemaVersion !== 1) return { diagnostic: "context artifact schemaVersion is unsupported" };
    try {
        return { value: validateContextArtifact(value) };
    } catch (error) {
        return { diagnostic: error instanceof Error ? error.message : "invalid context artifact" };
    }
}

export function decodeContextAttachmentData(value: unknown): ContextDecodeResult<ContextAttachmentData> {
    if (isRecord(value) && value.schemaVersion !== 1) return { diagnostic: "context attachment schemaVersion is unsupported" };
    try {
        return { value: validateContextAttachmentData(value) };
    } catch (error) {
        return { diagnostic: error instanceof Error ? error.message : "invalid context attachment" };
    }
}

export function validateContextUpdateData(value: unknown): ContextUpdateData {
    if (!isRecord(value)) invalid("context update must be an object");
    if (value.schemaVersion !== 1) invalid("context update schemaVersion must be 1");
    return {
        schemaVersion: 1,
        attachmentEntryId: requiredString(value.attachmentEntryId, "attachmentEntryId"),
        requestedRepresentation: parseContextRepresentation(value.requestedRepresentation),
        summary: value.summary == null ? undefined : validateSummary(value.summary),
    };
}

export function decodeContextUpdateData(value: unknown): ContextDecodeResult<ContextUpdateData> {
    if (isRecord(value) && value.schemaVersion !== 1) return { diagnostic: "context update schemaVersion is unsupported" };
    try {
        return { value: validateContextUpdateData(value) };
    } catch (error) {
        return { diagnostic: error instanceof Error ? error.message : "invalid context update" };
    }
}

export function validateContextDetachData(value: unknown): ContextDetachData {
    if (!isRecord(value)) invalid("context detach must be an object");
    if (value.schemaVersion !== 1) invalid("context detach schemaVersion must be 1");
    return { schemaVersion: 1, attachmentEntryId: requiredString(value.attachmentEntryId, "attachmentEntryId") };
}

export function decodeContextDetachData(value: unknown): ContextDecodeResult<ContextDetachData> {
    if (isRecord(value) && value.schemaVersion !== 1) return { diagnostic: "context detach schemaVersion is unsupported" };
    try {
        return { value: validateContextDetachData(value) };
    } catch (error) {
        return { diagnostic: error instanceof Error ? error.message : "invalid context detach" };
    }
}

function parseRenderedRepresentation(value: unknown): ContextRenderedRepresentation {
    if (value === "full" || value === "summary" || value === "metadata" || value === "attention" || value === "excluded") return value;
    return invalid("renderedRepresentation is invalid");
}

function validateProjectionItem(value: unknown): ContextProjectionItemReport {
    if (!isRecord(value)) invalid("projection item must be an object");
    const reason = value.reason;
    if (reason !== "selected" && reason !== "already_present" && reason !== "user_excluded") invalid("projection item reason is invalid");
    if (typeof value.advisoryTokens !== "number" || !Number.isFinite(value.advisoryTokens)) invalid("projection item advisoryTokens must be finite");
    return {
        attachmentEntryId: requiredString(value.attachmentEntryId, "attachmentEntryId"),
        artifactEntryId: optionalString(value.artifactEntryId, "artifactEntryId"),
        sourceKind: value.sourceKind == null ? undefined : parseSourceKind(value.sourceKind),
        sourceSessionId: optionalString(value.sourceSessionId, "sourceSessionId"),
        sourceSessionTitle: optionalString(value.sourceSessionTitle, "sourceSessionTitle"),
        sourceTurnId: optionalString(value.sourceTurnId, "sourceTurnId"),
        sourcePreview: optionalString(value.sourcePreview, "sourcePreview"),
        lifecycle: value.lifecycle == null ? undefined : parseContextLifecycle(value.lifecycle),
        requestedRepresentation: value.requestedRepresentation == null ? undefined : parseContextRepresentation(value.requestedRepresentation),
        renderedRepresentation: parseRenderedRepresentation(value.renderedRepresentation),
        advisoryTokens: value.advisoryTokens,
        reason,
    };
}

export function validateContextProjectionReport(value: unknown): ContextProjectionReport {
    if (!isRecord(value)) invalid("context projection report must be an object");
    if (value.schemaVersion !== 1) invalid("context projection report schemaVersion must be 1");
    const countAccuracy = value.countAccuracy;
    if (countAccuracy !== "exact" && countAccuracy !== "conservative_upper_bound") invalid("projection countAccuracy is invalid");
    if (!Array.isArray(value.items)) invalid("projection items must be an array");
    const number = (field: string): number => {
        const candidate = value[field];
        if (typeof candidate !== "number" || !Number.isFinite(candidate)) invalid(`projection ${field} must be finite`);
        return candidate;
    };
    return {
        schemaVersion: 1,
        transactionId: requiredString(value.transactionId, "projection transactionId"),
        targetTurnId: requiredString(value.targetTurnId, "projection targetTurnId"),
        createdAt: requiredString(value.createdAt, "projection createdAt"),
        contextWindow: number("contextWindow"),
        effectiveOutputReserve: number("effectiveOutputReserve"),
        inputLimit: number("inputLimit"),
        baseInputTokens: number("baseInputTokens"),
        finalInputTokens: number("finalInputTokens"),
        referenceTokens: number("referenceTokens"),
        countAccuracy,
        maxReferenceTokens: value.maxReferenceTokens == null ? undefined : number("maxReferenceTokens"),
        overlaySha256: requiredString(value.overlaySha256, "overlaySha256"),
        items: value.items.map(validateProjectionItem),
    };
}

export function decodeContextProjectionReport(value: unknown): ContextDecodeResult<ContextProjectionReport> {
    if (isRecord(value) && value.schemaVersion !== 1) return { diagnostic: "context projection report schemaVersion is unsupported" };
    try {
        return { value: validateContextProjectionReport(value) };
    } catch (error) {
        return { diagnostic: error instanceof Error ? error.message : "invalid context projection report" };
    }
}
