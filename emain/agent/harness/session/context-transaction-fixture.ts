// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createTransactionManifestData } from "./entry-transaction";
import type { AgentMessage } from "../../types";
import type { SessionTreeEntry } from "../types";

const Hash = "a".repeat(64);
const Timestamp = "2026-07-22T00:00:00.000Z";

function user(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

export function makeCommittedContextTransaction(options: { parentId?: string | null; prefix?: string } = {}): SessionTreeEntry[] {
    const prefix = options.prefix ?? "context";
    const transactionId = `${prefix}-transaction`;
    const artifactId = `${prefix}-artifact`;
    const attachId = `${prefix}-attach`;
    const projectionId = `${prefix}-projection`;
    const reportId = `${prefix}-report`;
    const manifestId = `${prefix}-manifest`;
    const userId = `${prefix}-user`;
    const artifact: SessionTreeEntry = {
        type: "custom",
        id: artifactId,
        parentId: options.parentId ?? null,
        timestamp: Timestamp,
        customType: "context_artifact",
        transactionId,
        data: {
            schemaVersion: 1,
            provenance: {
                sourceKind: "turn",
                sourceSessionId: "source-session",
                sourceSessionPath: "/tmp/source.db",
                sourceCwd: "/tmp/source",
                sourceTurnId: "source-turn",
                sourceLeafId: "source-leaf",
                sourceMessageEntryIds: ["source-message"],
                preview: "source preview",
                capturedAt: Timestamp,
            },
            messages: [{ role: "user", content: [{ type: "text", text: "referenced context" }] }],
            snapshotSha256: Hash,
            canonicalByteLength: 18,
        },
    };
    const attach: SessionTreeEntry = {
        type: "custom",
        id: attachId,
        parentId: artifactId,
        timestamp: Timestamp,
        customType: "context_attach",
        transactionId,
        data: {
            schemaVersion: 1,
            transactionId,
            artifactEntryId: artifactId,
            lifecycle: "pinned",
            requestedRepresentation: "full",
            selectionOrder: 0,
        },
    };
    const projection: SessionTreeEntry = {
        type: "custom",
        id: projectionId,
        parentId: attachId,
        timestamp: Timestamp,
        customType: "context_projection",
        transactionId,
        data: {
            schemaVersion: 1,
            transactionId,
            targetTurnId: userId,
            createdAt: Timestamp,
            contextWindow: 128000,
            effectiveOutputReserve: 4096,
            inputLimit: 123904,
            baseInputTokens: 10,
            finalInputTokens: 28,
            referenceTokens: 18,
            countAccuracy: "exact",
            overlaySha256: Hash,
            items: [{ attachmentEntryId: attachId, artifactEntryId: artifactId, renderedRepresentation: "full", advisoryTokens: 18, reason: "selected" }],
        },
    };
    const report: SessionTreeEntry = {
        type: "custom",
        id: reportId,
        parentId: projectionId,
        timestamp: Timestamp,
        customType: "context_report",
        transactionId,
        data: { schemaVersion: 1, transactionId },
    };
    const turn: SessionTreeEntry = {
        type: "message",
        id: userId,
        parentId: manifestId,
        timestamp: Timestamp,
        message: user("contextual question"),
        transactionId,
    };
    const manifest: SessionTreeEntry = {
        type: "custom",
        id: manifestId,
        parentId: reportId,
        timestamp: Timestamp,
        customType: "session_tx_manifest",
        transactionId,
        data: createTransactionManifestData(transactionId, [artifact, attach, projection, report, turn]),
    };
    return [artifact, attach, projection, report, manifest, turn];
}
