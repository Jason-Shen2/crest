// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    filterCommittedTransactionEntries,
    SessionTransactionManifestCustomType,
} from "../harness/session/entry-transaction";
import type { SessionTreeEntry } from "../harness/types";
import type { ContextArtifact, ContextJournalAttachment, ContextJournalDiagnostic, ContextJournalState } from "./types";
import { decodeContextArtifact, decodeContextAttachmentData, decodeContextProjectionReport } from "./validation";

export const ContextCustomTypes = {
    artifact: "context_artifact",
    attach: "context_attach",
    projection: "context_projection",
    transactionManifest: SessionTransactionManifestCustomType,
} as const;

const ContextCustomTypeValues = new Set<string>(Object.values(ContextCustomTypes));
const ObsoleteContextCustomTypes = new Set(["context_update", "context_detach"]);

function customData(entry: SessionTreeEntry): unknown {
    return entry.type === "custom" ? entry.data : undefined;
}

function transactionId(entry: SessionTreeEntry): string | undefined {
    const value = (entry as { transactionId?: unknown }).transactionId;
    return typeof value === "string" ? value : undefined;
}

function diagnostic(diagnostics: ContextJournalDiagnostic[], entry: SessionTreeEntry, message: string): void {
    diagnostics.push({ entryId: entry.id, message });
}

function sortAttachments(attachments: ContextJournalAttachment[]): ContextJournalAttachment[] {
    return [...attachments].sort((left, right) => left.data.selectionOrder - right.data.selectionOrder);
}

export function isContextCustomEntry(entry: SessionTreeEntry): entry is Extract<SessionTreeEntry, { type: "custom" }> {
    return entry.type === "custom" && ContextCustomTypeValues.has(entry.customType);
}

export function foldContextJournal(entries: SessionTreeEntry[]): ContextJournalState {
    const committed = filterCommittedTransactionEntries(entries);
    const diagnostics: ContextJournalDiagnostic[] = committed.diagnostics.map((item) => ({ message: item.message }));
    const artifacts = new Map<string, ContextArtifact>();
    const attachmentsByTurn = new Map<string, ContextJournalAttachment[]>();
    const projectionReports: ContextJournalState["projectionReports"] = [];

    const transactionFor = (entry: SessionTreeEntry) => {
        const id = transactionId(entry);
        return id == null ? undefined : committed.committedTransactions.get(id);
    };

    for (const entry of committed.entries) {
        if (!isContextCustomEntry(entry) || entry.customType !== ContextCustomTypes.artifact) continue;
        if (!transactionFor(entry)) {
            diagnostic(diagnostics, entry, "context artifact is not in a committed transaction");
            continue;
        }
        const decoded = decodeContextArtifact(customData(entry));
        if (decoded.diagnostic) {
            diagnostic(diagnostics, entry, decoded.diagnostic);
            continue;
        }
        if (artifacts.has(entry.id)) {
            diagnostic(diagnostics, entry, "duplicate context artifact entry ID");
            continue;
        }
        artifacts.set(entry.id, decoded.value!);
    }

    for (const entry of committed.entries) {
        if (entry.type !== "custom") continue;
        if (ObsoleteContextCustomTypes.has(entry.customType)) {
            diagnostic(diagnostics, entry, `${entry.customType} is obsolete and ignored`);
            continue;
        }
        if (entry.customType === ContextCustomTypes.attach) {
            const transaction = transactionFor(entry);
            if (!transaction) {
                diagnostic(diagnostics, entry, "context attachment is not in a committed transaction");
                continue;
            }
            const decoded = decodeContextAttachmentData(customData(entry));
            if (decoded.diagnostic) {
                diagnostic(diagnostics, entry, decoded.diagnostic);
                continue;
            }
            if (decoded.value!.transactionId !== transaction.transactionId) {
                diagnostic(diagnostics, entry, "context attachment transactionId does not match its entry");
                continue;
            }
            if (decoded.value!.targetTurnId !== transaction.userEntryId) {
                diagnostic(diagnostics, entry, "context attachment targetTurnId does not match its transaction user");
                continue;
            }
            const artifact = artifacts.get(decoded.value!.artifactEntryId);
            if (artifact == null) diagnostic(diagnostics, entry, "context attachment references a missing artifact");
            const attachment: ContextJournalAttachment = {
                attachmentEntryId: entry.id,
                data: decoded.value!,
                artifact,
                summary: artifact?.summary,
            };
            const targetAttachments = attachmentsByTurn.get(attachment.data.targetTurnId) ?? [];
            targetAttachments.push(attachment);
            attachmentsByTurn.set(attachment.data.targetTurnId, targetAttachments);
        } else if (entry.customType === ContextCustomTypes.projection) {
            const transaction = transactionFor(entry);
            if (!transaction) {
                diagnostic(diagnostics, entry, "context projection is not in a committed transaction");
                continue;
            }
            const decoded = decodeContextProjectionReport(customData(entry));
            if (decoded.diagnostic) diagnostic(diagnostics, entry, decoded.diagnostic);
            else if (
                decoded.value!.transactionId !== transaction.transactionId ||
                decoded.value!.targetTurnId !== transaction.userEntryId
            ) {
                diagnostic(
                    diagnostics,
                    entry,
                    "context projection transactionId or targetTurnId does not match its transaction"
                );
            } else projectionReports.push(decoded.value!);
        }
    }

    const attachmentsForTurn = (targetTurnId: string): ContextJournalAttachment[] =>
        sortAttachments(attachmentsByTurn.get(targetTurnId) ?? []);
    const conversationAttachmentsForTurns = (targetTurnIds: readonly string[]): ContextJournalAttachment[] =>
        targetTurnIds.flatMap((targetTurnId) =>
            attachmentsForTurn(targetTurnId).filter((attachment) => attachment.data.deliveryScope === "conversation")
        );

    return {
        artifacts,
        attachmentsByTurn,
        attachmentsForTurn,
        conversationAttachmentsForTurns,
        projectionReports,
        diagnostics,
    };
}
