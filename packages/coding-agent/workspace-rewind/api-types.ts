// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata } from "@crest/agent/harness/types";

export type AgentRewindConflictClass = "none" | "forceable-drift" | "hard-blocker";
export type AgentRewindFileOperation = "create" | "write" | "delete";

export interface AgentRewindPointView {
    turnId: string;
    preview: string;
    timestamp?: string;
    eligible: boolean;
    reason?: string;
}

export interface AgentListRewindPointsInput {
    sessionMetadata: JsonlSessionMetadata;
}

export interface AgentListRewindPointsResult {
    points: AgentRewindPointView[];
    semanticLeafId: string | null;
    displayLeafId: string | null;
}

export interface AgentRewindFileRowView {
    path: string;
    operation: AgentRewindFileOperation;
    additions?: number;
    deletions?: number;
    diff?: string;
    previewUnavailableReason?: string;
    coverage: "covered" | "excluded" | "unavailable";
    conflict: AgentRewindConflictClass;
    reason?: string;
}

export interface AgentTurnFileDiffView {
    turnId: string;
    path: string;
    operation: "create" | "write" | "delete";
    additions: number;
    deletions: number;
    originalContent: string;
    modifiedContent: string;
    isBinary: boolean;
    fallbackPatch: string;
    truncated: boolean;
    previewUnavailableReason?: string;
}

export interface AgentRewindPreviewResult {
    confirmationToken?: string;
    target: { kind: "rewind"; targetTurnId: string } | { kind: "redo" };
    targetPrompt?: string;
    semanticLeafId: string | null;
    displayLeafId: string | null;
    expectedSemanticLeafId: string | null;
    messageCount: number;
    fileCount: number;
    files: AgentRewindFileRowView[];
    coverageWarnings: string[];
    forceRequired: boolean;
    hardBlocked: boolean;
}

export interface AgentPreviewRewindInput {
    sessionMetadata: JsonlSessionMetadata;
    expectedSemanticLeafId: string | null;
    target: { kind: "rewind"; targetTurnId: string } | { kind: "redo" };
}

export interface AgentRewindTreeInput {
    sessionMetadata: JsonlSessionMetadata;
    expectedSemanticLeafId: string | null;
    targetTurnId: string;
    mode: "normal" | "force-drift";
    confirmationToken: string;
}

export interface AgentRedoRewindInput {
    sessionMetadata: JsonlSessionMetadata;
    expectedSemanticLeafId: string | null;
    confirmationToken: string;
}

export interface AgentRewindMutationResult {
    sessionMetadata: JsonlSessionMetadata;
    semanticLeafId: string | null;
    displayLeafId: string | null;
    editorText?: string;
}

export interface AgentWorkspaceRecoveryView {
    operationId: string;
    phase?: "prepared" | "applying_files" | "files_verified" | "committing_session" | "completed";
    corrupt: boolean;
    message: string;
    paths: Array<{ path: string; classification?: "pre" | "target" | "unknown" }>;
    allowedActions: Array<"retry" | "abandon-current" | "quarantine-corrupt">;
}

export interface AgentGetWorkspaceRecoveryInput {
    sessionMetadata: JsonlSessionMetadata;
}

export interface AgentResolveWorkspaceRecoveryInput {
    sessionMetadata: JsonlSessionMetadata;
    operationId: string;
    action: "retry" | "abandon-current" | "quarantine-corrupt";
}

export interface AgentCheckpointQuotaView {
    status: "ok" | "soft-quota-exceeded" | "referenced-over-quota";
    usedBytes: number;
    softQuotaBytes: number;
    cleanupAvailable: boolean;
    message?: string;
}

export interface AgentCleanupWorkspaceCheckpointsInput {
    sessionMetadata: JsonlSessionMetadata;
}

export interface AgentCleanupWorkspaceCheckpointsResult {
    removedUnownedBytes: number;
    quota: AgentCheckpointQuotaView;
}

export interface AgentListCheckpointStorageOwnersInput {
    sessionMetadata: JsonlSessionMetadata;
}

export interface AgentCheckpointTrashOwnerView {
    sessionId: string;
    title?: string;
    referencedBytes: number;
    confirmationToken: string;
}

export interface AgentListCheckpointStorageOwnersResult {
    trashOwners: AgentCheckpointTrashOwnerView[];
}

export interface AgentPurgeTrashedSessionInput {
    sessionMetadata: JsonlSessionMetadata;
    trashedSessionId: string;
    confirmationToken: string;
}

export interface AgentPurgeTrashedSessionResult {
    purgedSessionId: string;
    quota: AgentCheckpointQuotaView;
}

export interface AgentRedoView {
    operationId: string;
    targetPrompt: string;
    messageCount: number;
    fileCount: number;
    files: AgentRewindFileRowView[];
}

export interface AgentRewindSessionStateView {
    enabled: boolean;
    semanticLeafId: string | null;
    displayLeafId: string | null;
    eligibleTurnIds: string[];
    busy: boolean;
    frozen: boolean;
    quota: AgentCheckpointQuotaView;
    redo?: AgentRedoView;
}
