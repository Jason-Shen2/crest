// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    filterCommittedTransactionEntries,
    SessionTransactionManifestCustomType,
} from "../harness/session/entry-transaction";
import type { SessionTreeEntry } from "../harness/types";
import type {
    ContextArtifact,
    ContextAttachmentData,
    ContextJournalAttachment,
    ContextJournalDiagnostic,
    ContextJournalState,
} from "./types";
import {
    decodeContextArtifact,
    decodeContextAttachmentData,
    decodeContextDetachData,
    decodeContextProjectionReport,
    decodeContextUpdateData,
} from "./validation";

export const ContextCustomTypes = {
    artifact: "context_artifact",
    attach: "context_attach",
    update: "context_update",
    detach: "context_detach",
    projection: "context_projection",
    transactionManifest: SessionTransactionManifestCustomType,
} as const;

const ContextCustomTypeValues = new Set<string>(Object.values(ContextCustomTypes));

function customData(entry: SessionTreeEntry): unknown {
    return entry.type === "custom" ? entry.data : undefined;
}

function transactionId(entry: SessionTreeEntry): string | undefined {
    const value = (entry as unknown as { transactionId?: unknown }).transactionId;
    return typeof value === "string" ? value : undefined;
}

function diagnostic(diagnostics: ContextJournalDiagnostic[], entry: SessionTreeEntry, message: string): void {
    diagnostics.push({ entryId: entry.id, message });
}

export function isContextCustomEntry(entry: SessionTreeEntry): entry is Extract<SessionTreeEntry, { type: "custom" }> {
    return entry.type === "custom" && ContextCustomTypeValues.has(entry.customType);
}

export function foldContextJournal(entries: SessionTreeEntry[], targetTurnId?: string): ContextJournalState {
    const committed = filterCommittedTransactionEntries(entries);
    const diagnostics: ContextJournalDiagnostic[] = committed.diagnostics.map((item) => ({ message: item.message }));
    const artifacts = new Map<string, ContextArtifact>();
    const attachments = new Map<string, ContextJournalAttachment>();
    const projectionReports: ContextJournalState["projectionReports"] = [];

    const isCommittedContextEntry = (entry: SessionTreeEntry): boolean => {
        const id = transactionId(entry);
        return id != null && committed.committedTransactionIds.has(id);
    };

    for (const entry of committed.entries) {
        if (!isContextCustomEntry(entry) || entry.customType !== ContextCustomTypes.artifact) continue;
        if (!isCommittedContextEntry(entry)) {
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
        if (!isContextCustomEntry(entry) || entry.customType !== ContextCustomTypes.attach) continue;
        if (!isCommittedContextEntry(entry)) {
            diagnostic(diagnostics, entry, "context attachment is not in a committed transaction");
            continue;
        }
        const decoded = decodeContextAttachmentData(customData(entry));
        if (decoded.diagnostic) {
            diagnostic(diagnostics, entry, decoded.diagnostic);
            continue;
        }
        if (decoded.value!.transactionId !== transactionId(entry)) {
            diagnostic(diagnostics, entry, "context attachment transactionId does not match its entry");
            continue;
        }
        if (attachments.has(entry.id)) {
            diagnostic(diagnostics, entry, "duplicate context attachment entry ID");
            continue;
        }
        const artifact = artifacts.get(decoded.value!.artifactEntryId);
        if (artifact == null) {
            diagnostic(diagnostics, entry, "context attachment references a missing artifact");
            continue;
        }
        const attachment: ContextJournalAttachment = { attachmentEntryId: entry.id, data: decoded.value!, artifact, summary: artifact.summary };
        attachments.set(entry.id, attachment);
    }

    for (const entry of committed.entries) {
        if (!isContextCustomEntry(entry)) continue;
        if (entry.customType === ContextCustomTypes.update) {
            const decoded = decodeContextUpdateData(customData(entry));
            if (decoded.diagnostic) {
                diagnostic(diagnostics, entry, decoded.diagnostic);
                continue;
            }
            const existing = attachments.get(decoded.value!.attachmentEntryId);
            if (existing == null) {
                diagnostic(diagnostics, entry, "context update references an inactive attachment");
                continue;
            }
            if (existing.data.lifecycle !== "pinned") {
                diagnostic(diagnostics, entry, "context update is only valid for pinned attachments");
                continue;
            }
            const data: ContextAttachmentData = { ...existing.data, requestedRepresentation: decoded.value!.requestedRepresentation };
            const updated: ContextJournalAttachment = {
                ...existing,
                data,
                summary: decoded.value!.summary ?? existing.summary,
            };
            attachments.set(updated.attachmentEntryId, updated);
        }
        if (entry.customType === ContextCustomTypes.detach) {
            const decoded = decodeContextDetachData(customData(entry));
            if (decoded.diagnostic) {
                diagnostic(diagnostics, entry, decoded.diagnostic);
                continue;
            }
            const existing = attachments.get(decoded.value!.attachmentEntryId);
            if (existing == null) {
                diagnostic(diagnostics, entry, "context detach references an inactive attachment");
                continue;
            }
            if (existing.data.lifecycle !== "pinned") {
                diagnostic(diagnostics, entry, "context detach is only valid for pinned attachments");
                continue;
            }
            attachments.delete(existing.attachmentEntryId);
        }
        if (entry.customType === ContextCustomTypes.projection) {
            if (!isCommittedContextEntry(entry)) {
                diagnostic(diagnostics, entry, "context projection is not in a committed transaction");
                continue;
            }
            const decoded = decodeContextProjectionReport(customData(entry));
            if (decoded.diagnostic) diagnostic(diagnostics, entry, decoded.diagnostic);
            else projectionReports.push(decoded.value!);
        }
    }

    const activeAttachments = [...attachments.values()].filter((attachment) => {
        if (attachment.data.lifecycle === "pinned") return true;
        return attachment.data.targetTurnId === targetTurnId;
    });
    return { artifacts, activeAttachments, projectionReports, diagnostics };
}
