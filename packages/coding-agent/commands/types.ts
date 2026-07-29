// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata } from "@crest/agent/harness/types";
import type {
    ContextDeliveryScope,
    ContextDraftView,
    ContextProjectionReport,
    ContextRepresentation,
    ContextSourceKind,
} from "../context/types";

export type AgentCommandSource = "builtin" | "skill" | "prompt";

export type AgentBackendCommandName =
    | "tree"
    | "fork"
    | "clone"
    | "new"
    | "resume"
    | "compact"
    | "session"
    | "info"
    | "copy"
    | "export"
    | "import"
    | "reload";

export type AgentCommandAction =
    | { type: "backend"; command: AgentBackendCommandName }
    | { type: "frontend"; action: "openModelPicker" };

export interface AgentCommandInfo {
    name: string;
    description: string;
    argumentHint?: string;
    /**
     * Alternate names that resolve to this command. Used for compatibility
     * with other agents' command vocabularies (e.g. Claude Code's /clear is
     * an alias for /new). The frontend slash-command router normalizes an
     * alias to the canonical `name` before dispatch, so the backend only ever
     * sees the canonical command.
     */
    aliases?: string[];
    source: AgentCommandSource;
    action: AgentCommandAction;
}

export type AgentCommandExecutionStatus = "success" | "noop";

export interface AgentCommandExecutionResult {
    status: AgentCommandExecutionStatus;
    message: string;
    sessionMetadata?: JsonlSessionMetadata;
    managerMode?: "session";
}

export interface AgentRunCommandInput {
    sessionMetadata?: JsonlSessionMetadata;
    cwd: string;
    command: AgentBackendCommandName;
    argsText: string;
}

export interface ParsedAgentCommandInput {
    commandName: string;
    argsText: string;
}

export interface AgentTreeEntryView {
    id: string;
    parentId?: string;
    type: string;
    role?: string;
    label?: string;
    /** Assistant stopReason, used by the renderer's FilterMode (Pi parity). */
    stopReason?: string;
    preview: string;
    timestamp?: string;
    isLeaf: boolean;
    isCurrent: boolean;
    referenceable?: boolean;
    semanticAnchorId: string | null;
}

export interface AgentTreeResult {
    entries: AgentTreeEntryView[];
    semanticLeafId: string | null;
    displayLeafId: string | null;
    /** @deprecated compatibility alias for displayLeafId */
    leafId?: string | null;
}

export interface AgentNavigateTreeInput {
    sessionMetadata: JsonlSessionMetadata;
    targetId: string;
    semanticAnchorId: string | null;
    expectedSemanticLeafId: string | null;
}

export interface AgentForkPointView {
    entryId: string;
    preview: string;
    timestamp?: string;
}

export interface AgentReferencePointView {
    entryId: string;
    preview: string;
    timestamp?: string;
}

export interface AgentPrepareContextDraftInput {
    targetSessionPath: string;
    sourceSessionPath: string;
    sourceKind: ContextSourceKind;
    sourceTurnId?: string;
}

export interface AgentContextDraftAttachmentInput {
    draftId: string;
    deliveryScope: ContextDeliveryScope;
    requestedRepresentation: ContextRepresentation;
}

export interface AgentDiscardContextDraftInput {
    targetSessionPath: string;
    draftId: string;
}

export interface AgentListReferencePointsInput {
    sourceSessionPath: string;
}

export interface AgentListContextStateInput {
    targetSessionPath: string;
}

export interface AgentContextStateView {
    drafts: ContextDraftView[];
    contextReports: ContextProjectionReport[];
}
