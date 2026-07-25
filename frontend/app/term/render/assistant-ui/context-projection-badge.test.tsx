// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ContextProjectionBadge, projectionCounts } from "./context-projection-badge";

function report(): AgentContextProjectionReportView {
    return {
        schemaVersion: 1,
        transactionId: "transaction-1",
        targetTurnId: "turn-1",
        createdAt: "2026-07-25T00:00:00.000Z",
        contextWindow: 128_000,
        effectiveOutputReserve: 8_000,
        inputLimit: 120_000,
        baseInputTokens: 2_000,
        finalInputTokens: 2_120,
        referenceTokens: 120,
        countAccuracy: "exact",
        overlaySha256: "abc123",
        items: [
            {
                attachmentEntryId: "full",
                sourceSessionTitle: "Architecture",
                sourcePreview: "The reference design",
                deliveryScope: "message",
                requestedRepresentation: "full",
                renderedRepresentation: "full",
                advisoryTokens: 100,
                reason: "selected",
            },
            {
                attachmentEntryId: "summary",
                deliveryScope: "conversation",
                requestedRepresentation: "summary",
                renderedRepresentation: "summary",
                advisoryTokens: 20,
                reason: "already_present",
            },
            {
                attachmentEntryId: "attention",
                deliveryScope: "conversation",
                requestedRepresentation: "summary",
                renderedRepresentation: "attention",
                advisoryTokens: 0,
                reason: "selected",
            },
        ],
    };
}

describe("ContextProjectionBadge", () => {
    it("counts included and attention outcomes", () => {
        expect(projectionCounts(report())).toEqual({ included: 2, attention: 1 });
    });

    it("shows representation, delivery scope, provenance, and digest", () => {
        const html = renderToStaticMarkup(<ContextProjectionBadge report={report()} />);

        expect(html).toContain("Included 2");
        expect(html).toContain("Attention 1");
        expect(html).toContain("Architecture");
        expect(html).toContain("This message");
        expect(html).toContain("Conversation");
        expect(html).not.toContain("Lifecycle");
        expect(html).not.toContain("Excluded");
        expect(html).toContain('aria-label="Overlay SHA-256"');
        expect(html).toContain('value="abc123"');
    });
});
