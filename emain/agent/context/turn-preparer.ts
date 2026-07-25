// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { UserMessage } from "../../ai";
import { createTransactionManifestData, sha256CanonicalJson } from "../harness/session/entry-transaction";
import { uuidv7 } from "../harness/session/uuid";
import type { SessionAppendOptions, SessionTreeEntry } from "../harness/types";
import { SessionError } from "../harness/types";
import type { AgentMessage } from "../types";
import { ContextDraftRegistry, withContextDrafts } from "./draft-registry";
import { appendHistoricalReference, renderHistoricalReference } from "./history";
import { ContextCustomTypes } from "./journal";
import {
    validateAndProjectContext,
    type ContextFinalRequest,
    type ContextProjectionAttachment,
    type ContextProjectionInput,
    type ContextProjectionResult,
    type ContextProviderRequest,
    type ContextTokenCounter,
} from "./projector";
import { getModelVisibleMessageEntryIds } from "./snapshot";
import type {
    ContextBudgetResult,
    ContextDeliveryScope,
    ContextProjectionReport,
    ContextRepresentation,
} from "./types";
import { ContextReferenceError } from "./types";

export interface ContextTurnDraftAttachmentInput {
    draftId: string;
    deliveryScope: ContextDeliveryScope;
    requestedRepresentation: ContextRepresentation;
}

export interface ContextTurnPreparationSession {
    getBranch(): Promise<SessionTreeEntry[]>;
    appendEntries(entries: SessionTreeEntry[], options?: SessionAppendOptions): Promise<void>;
}

export interface ContextTurnPreparationInput {
    session: ContextTurnPreparationSession;
    draftRegistry: ContextDraftRegistry;
    targetSessionPath: string;
    userMessage: UserMessage;
    contextMessages?: AgentMessage[];
    attachments: ContextTurnDraftAttachmentInput[];
    provider: string;
    modelKey: string;
    contextWindow?: number;
    effectiveOutputReserve?: number;
    request: ContextProviderRequest;
    prepareFinalRequest?: ContextProjectionInput["prepareFinalRequest"];
    tokenCounter?: ContextTokenCounter;
    maxTokens?: number;
    revisionData?: unknown;
    expectedBudgetRevision?: string;
    signal?: AbortSignal;
    project?: (input: ContextProjectionInput) => Promise<ContextProjectionResult>;
    idFactory?: () => string;
    now?: () => Date;
}

export type ContextTurnPreparationResult =
    | {
          ok: true;
          userEntryId: string;
          systemPromptSuffix: string;
          projectionReport: ContextProjectionReport;
          transformedContextMessages?: AgentMessage[];
          finalRequest?: ContextFinalRequest;
      }
    | {
          ok: false;
          error: ContextReferenceError;
          budget?: ContextBudgetResult;
      };

interface ReservedDraft {
    input: ContextTurnDraftAttachmentInput;
    artifactEntryId: string;
    attachmentEntryId: string;
    selectionOrder: number;
}

function customEntry(
    id: string,
    parentId: string | null,
    timestamp: string,
    transactionId: string,
    customType: string,
    data: unknown
): SessionTreeEntry {
    return {
        type: "custom",
        id,
        parentId,
        timestamp,
        transactionId,
        customType,
        data,
    };
}

function resultFailure(projection: ContextProjectionResult): Extract<ContextProjectionResult, { ok: false }> {
    return projection as Extract<ContextProjectionResult, { ok: false }>;
}

function resultSuccess(projection: ContextProjectionResult): Extract<ContextProjectionResult, { ok: true }> {
    return projection as Extract<ContextProjectionResult, { ok: true }>;
}

function sameDrafts(left: unknown, right: unknown): boolean {
    return sha256CanonicalJson(left) === sha256CanonicalJson(right);
}

function branchFingerprint(entries: SessionTreeEntry[]): string {
    try {
        return sha256CanonicalJson(JSON.parse(JSON.stringify(entries)));
    } catch (error) {
        throw new ContextReferenceError(
            "projection_failed",
            "Active session branch could not be fingerprinted",
            error instanceof Error ? error : undefined
        );
    }
}

function cloneProjectionReport(report: ContextProjectionReport): ContextProjectionReport {
    return structuredClone(report);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    throw new Error("Context turn preparation was aborted");
}

function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
    return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

export function createContextTurnPreparation(
    input: ContextTurnPreparationInput
): () => Promise<ContextTurnPreparationResult> {
    let committed: ContextTurnPreparationResult | undefined;
    let inFlight: Promise<ContextTurnPreparationResult> | undefined;

    const run = async (): Promise<ContextTurnPreparationResult> => {
        throwIfAborted(input.signal);
        const idFactory = input.idFactory ?? uuidv7;
        const now = input.now ?? (() => new Date());
        const project = input.project ?? validateAndProjectContext;
        const transactionId = idFactory();
        const userEntryId = idFactory();
        const reservedDrafts: ReservedDraft[] = input.attachments.map((attachment, selectionOrder) => ({
            input: { ...attachment },
            artifactEntryId: idFactory(),
            attachmentEntryId: idFactory(),
            selectionOrder,
        }));
        const projectionEntryId = idFactory();
        const manifestEntryId = idFactory();
        const createdAt = now().toISOString();
        const draftIds = reservedDrafts.map((draft) => draft.input.draftId);
        const drafts = input.draftRegistry.readMany(input.targetSessionPath, draftIds);
        const branch = await input.session.getBranch();
        const originalBranchLeafId = branch.at(-1)?.id ?? null;
        const projectedBranchFingerprint = branchFingerprint(branch);
        const messageAttachments: ContextProjectionAttachment[] = [];
        const conversationAttachments: ContextProjectionAttachment[] = [];

        for (let index = 0; index < reservedDrafts.length; index++) {
            const reserved = reservedDrafts[index]!;
            const draft = drafts[index]!;
            if (reserved.input.requestedRepresentation === "summary" && draft.artifact.summary == null) {
                return {
                    ok: false,
                    error: new ContextReferenceError("summary_not_ready", "The selected context summary is not ready"),
                };
            }
            const attachment: ContextProjectionAttachment = {
                attachmentEntryId: reserved.attachmentEntryId,
                artifactEntryId: reserved.artifactEntryId,
                draftId: reserved.input.draftId,
                targetSessionPath: input.targetSessionPath,
                deliveryScope: reserved.input.deliveryScope,
                targetTurnId: userEntryId,
                requestedRepresentation: reserved.input.requestedRepresentation,
                selectionOrder: reserved.selectionOrder,
                artifact: draft.artifact,
                summary: draft.artifact.summary,
            };
            if (reserved.input.deliveryScope === "message") messageAttachments.push(attachment);
            else conversationAttachments.push(attachment);
        }

        let projection: ContextProjectionResult;
        try {
            projection = await project({
                transactionId,
                targetTurnId: userEntryId,
                targetSessionPath: input.targetSessionPath,
                createdAt,
                provider: input.provider,
                modelKey: input.modelKey,
                contextWindow: input.contextWindow,
                effectiveOutputReserve: input.effectiveOutputReserve,
                request: input.request,
                prepareFinalRequest: input.prepareFinalRequest,
                tokenCounter: input.tokenCounter,
                maxTokens: input.maxTokens,
                revisionData: input.revisionData,
                signal: input.signal,
                messageAttachments,
                conversationAttachments,
                visibleMessageEntryIds: getModelVisibleMessageEntryIds(branch),
            });
        } catch (error) {
            if (isAbortFailure(error, input.signal)) throw error;
            return {
                ok: false,
                error: new ContextReferenceError(
                    "projection_failed",
                    "Context projection failed",
                    error instanceof Error ? error : undefined
                ),
            };
        }
        if (!projection.ok) {
            const failure = resultFailure(projection);
            return {
                ok: false,
                error: failure.error,
                ...(failure.budget == null ? {} : { budget: failure.budget }),
            };
        }

        const success = resultSuccess(projection);
        if (input.expectedBudgetRevision != null && input.expectedBudgetRevision !== success.budget.revision) {
            return {
                ok: false,
                error: new ContextReferenceError("budget_stale", "Context budget preview is stale"),
                budget: success.budget,
            };
        }
        const persistedProjectionReport = cloneProjectionReport(success.report);
        const returnedProjectionReport = cloneProjectionReport(success.report);

        const artifactEntries: SessionTreeEntry[] = [];
        const attachmentEntries: SessionTreeEntry[] = [];
        let parentId = branch.at(-1)?.id ?? null;
        for (let index = 0; index < reservedDrafts.length; index++) {
            const reserved = reservedDrafts[index]!;
            const artifactEntry = customEntry(
                reserved.artifactEntryId,
                parentId,
                createdAt,
                transactionId,
                ContextCustomTypes.artifact,
                drafts[index]!.artifact
            );
            artifactEntries.push(artifactEntry);
            parentId = artifactEntry.id;
        }
        for (const reserved of reservedDrafts) {
            const attachmentEntry = customEntry(
                reserved.attachmentEntryId,
                parentId,
                createdAt,
                transactionId,
                ContextCustomTypes.attach,
                {
                    schemaVersion: 1,
                    transactionId,
                    artifactEntryId: reserved.artifactEntryId,
                    deliveryScope: reserved.input.deliveryScope,
                    requestedRepresentation: reserved.input.requestedRepresentation,
                    targetTurnId: userEntryId,
                    selectionOrder: reserved.selectionOrder,
                }
            );
            attachmentEntries.push(attachmentEntry);
            parentId = attachmentEntry.id;
        }
        const projectionEntry = customEntry(
            projectionEntryId,
            parentId,
            createdAt,
            transactionId,
            ContextCustomTypes.projection,
            persistedProjectionReport
        );
        const userEntry: SessionTreeEntry = {
            type: "message",
            id: userEntryId,
            parentId: manifestEntryId,
            timestamp: createdAt,
            transactionId,
            message: input.userMessage,
        };
        const members = [...artifactEntries, ...attachmentEntries, projectionEntry, userEntry];
        const manifestEntry = customEntry(
            manifestEntryId,
            projectionEntry.id,
            createdAt,
            transactionId,
            ContextCustomTypes.transactionManifest,
            createTransactionManifestData(transactionId, members)
        );
        const entries = [...artifactEntries, ...attachmentEntries, projectionEntry, manifestEntry, userEntry];

        try {
            await withContextDrafts(input.draftRegistry, input.targetSessionPath, draftIds, async (reservedValues) => {
                throwIfAborted(input.signal);
                if (!sameDrafts(reservedValues, drafts)) {
                    throw new ContextReferenceError("budget_stale", "Context drafts changed during preparation");
                }
                const currentBranch = await input.session.getBranch();
                if (branchFingerprint(currentBranch) !== projectedBranchFingerprint) {
                    throw new ContextReferenceError("budget_stale", "Active session branch changed during preparation");
                }
                throwIfAborted(input.signal);
                try {
                    await input.session.appendEntries(entries, { expectedLeafId: originalBranchLeafId });
                } catch (error) {
                    if (error instanceof SessionError && error.code === "stale_leaf") {
                        throw new ContextReferenceError(
                            "budget_stale",
                            "Active session leaf changed before context commit",
                            error
                        );
                    }
                    throw new ContextReferenceError(
                        "transaction_failed",
                        "Context transaction append failed",
                        error instanceof Error ? error : undefined
                    );
                }
            });
        } catch (error) {
            if (error instanceof ContextReferenceError && error.code === "budget_stale") {
                return { ok: false, error };
            }
            throw error;
        }

        const historyBlocks = success.historyBlocksByTurn.get(userEntryId) ?? [];
        const contextMessages = input.contextMessages ?? [input.userMessage];
        const currentUserIndex = contextMessages.lastIndexOf(input.userMessage);
        const transformedContextMessages =
            historyBlocks.length === 0 || currentUserIndex < 0
                ? undefined
                : contextMessages.map((message, index) =>
                      index === currentUserIndex
                          ? appendHistoricalReference(message, renderHistoricalReference(historyBlocks))
                          : message
                  );

        return {
            ok: true,
            userEntryId,
            systemPromptSuffix: success.overlay,
            projectionReport: returnedProjectionReport,
            ...(transformedContextMessages == null ? {} : { transformedContextMessages }),
            ...(success.finalRequest == null ? {} : { finalRequest: success.finalRequest }),
        };
    };

    return async () => {
        if (committed?.ok) return committed;
        if (inFlight != null) return inFlight;
        inFlight = run();
        try {
            const result = await inFlight;
            if (result.ok) committed = result;
            return result;
        } finally {
            inFlight = undefined;
        }
    };
}
