import { describe, expect, test } from "vitest";

import {
    contextAttachmentsForSend,
    contextSendDisabledReason,
    contextTargetIdentity,
    createContextReferenceState,
    reduceContextReferenceState,
    resolveContextReferenceUiConfig,
} from "./context-references";

function targeted<T extends { type: string }>(
    state: ReturnType<typeof createContextReferenceState>,
    action: T
): T & ReturnType<typeof contextTargetIdentity> {
    return { ...action, ...contextTargetIdentity(state) };
}

function makeDraft(id: string, summaryStatus: AgentContextDraftView["summaryStatus"] = "none") {
    return {
        draftId: id,
        targetSessionPath: "/sessions/target.jsonl",
        provenance: {
            sourceKind: "turn",
            sourceSessionId: `session-${id}`,
            sourceSessionPath: `/sessions/${id}.jsonl`,
            sourceCwd: "/workspace",
            sourceTurnId: `turn-${id}`,
            sourceLeafId: `leaf-${id}`,
            sourceMessageEntryIds: [`message-${id}`],
            preview: `preview ${id}`,
            capturedAt: "2026-07-25T00:00:00.000Z",
        },
        summaryStatus,
        expiresAt: "2026-07-25T01:00:00.000Z",
    } satisfies AgentContextDraftView;
}

function makeReport(targetTurnId: string) {
    return {
        schemaVersion: 1,
        transactionId: `transaction-${targetTurnId}`,
        targetTurnId,
        createdAt: "2026-07-25T00:00:00.000Z",
        contextWindow: 1000,
        effectiveOutputReserve: 100,
        inputLimit: 900,
        baseInputTokens: 200,
        finalInputTokens: 300,
        referenceTokens: 100,
        countAccuracy: "exact",
        overlaySha256: `sha-${targetTurnId}`,
        items: [],
    } satisfies AgentContextProjectionReportView;
}

describe("context reference renderer state", () => {
    test("resolves enabled-by-default references without inventing an operator cap", () => {
        const config = {
            providers: {},
            default: { provider: "openai", model: "gpt-test" },
        };

        expect(resolveContextReferenceUiConfig({ status: "ok", config })).toEqual({ enabled: true });
        expect(
            resolveContextReferenceUiConfig({
                status: "ok",
                config: { ...config, context_references: { enabled: false } },
            })
        ).toEqual({ enabled: false });
    });

    test("adds drafts as message/full by default and preserves selection order", () => {
        let state = createContextReferenceState("/sessions/target.jsonl");
        state = reduceContextReferenceState(state, targeted(state, { type: "draft_prepared", view: makeDraft("one") }));
        state = reduceContextReferenceState(state, targeted(state, { type: "draft_prepared", view: makeDraft("two") }));

        expect(contextAttachmentsForSend(state.drafts)).toEqual([
            { draftId: "one", deliveryScope: "message", requestedRepresentation: "full" },
            { draftId: "two", deliveryScope: "message", requestedRepresentation: "full" },
        ]);
    });

    test("supports conversation delivery without pin state", () => {
        let state = createContextReferenceState("/sessions/target.jsonl");
        state = reduceContextReferenceState(state, targeted(state, { type: "draft_prepared", view: makeDraft("one") }));
        state = reduceContextReferenceState(state, {
            type: "draft_choice_changed",
            draftId: "one",
            deliveryScope: "conversation",
        });

        expect(contextAttachmentsForSend(state.drafts)[0]).toEqual({
            draftId: "one",
            deliveryScope: "conversation",
            requestedRepresentation: "full",
        });
        expect(state).not.toHaveProperty("pins");
        expect(state).not.toHaveProperty("budget");
    });

    test("only commits Summary after summary generation succeeds", () => {
        let state = createContextReferenceState("/sessions/target.jsonl");
        state = reduceContextReferenceState(
            state,
            targeted(state, {
                type: "draft_prepared",
                view: makeDraft("one"),
                requestedRepresentation: "summary",
            })
        );

        expect(state.drafts[0]).toMatchObject({ requestedRepresentation: "summary", status: "summarizing" });
        expect(contextSendDisabledReason(state)).toBe("summary_not_ready");

        state = reduceContextReferenceState(
            state,
            targeted(state, {
                type: "summary_succeeded",
                draftId: "one",
                view: makeDraft("one", "ready"),
            })
        );
        expect(state.drafts[0]).toMatchObject({ requestedRepresentation: "summary", status: "ready" });
        expect(contextSendDisabledReason(state)).toBeUndefined();
    });

    test("captures a send atomically and removes successful drafts", () => {
        let state = createContextReferenceState("/sessions/target.jsonl");
        state = reduceContextReferenceState(state, targeted(state, { type: "draft_prepared", view: makeDraft("one") }));
        state = reduceContextReferenceState(
            state,
            targeted(state, { type: "send_began", captureId: "capture", draftIds: ["one"] })
        );

        expect(state.sendCapturesById.capture.attachments).toEqual([
            { draftId: "one", deliveryScope: "message", requestedRepresentation: "full" },
        ]);
        expect(state.drafts[0].status).toBe("sending");

        state = reduceContextReferenceState(
            state,
            targeted(state, { type: "send_succeeded", captureId: "capture" })
        );
        expect(state.drafts).toEqual([]);
    });

    test("restores failed drafts for retry", () => {
        let state = createContextReferenceState("/sessions/target.jsonl");
        state = reduceContextReferenceState(state, targeted(state, { type: "draft_prepared", view: makeDraft("one") }));
        state = reduceContextReferenceState(
            state,
            targeted(state, { type: "send_began", captureId: "capture", draftIds: ["one"] })
        );
        state = reduceContextReferenceState(
            state,
            targeted(state, { type: "send_failed", captureId: "capture", errorMessage: "retry" })
        );

        expect(state.drafts[0]).toMatchObject({ status: "error", errorMessage: "retry" });
    });

    test("hydrates and upserts reports without replacing composer drafts", () => {
        let state = createContextReferenceState("/sessions/target.jsonl");
        state = reduceContextReferenceState(state, targeted(state, { type: "draft_prepared", view: makeDraft("one") }));
        state = reduceContextReferenceState(
            state,
            targeted(state, { type: "authoritative_state_received", reports: [makeReport("turn-one")] })
        );
        const replacement = makeReport("turn-one");
        replacement.overlaySha256 = "replacement";
        state = reduceContextReferenceState(
            state,
            targeted(state, { type: "projection_received", report: replacement })
        );

        expect(state.drafts).toHaveLength(1);
        expect(state.reportsByTurn["turn-one"].overlaySha256).toBe("replacement");
    });

    test("target changes clear drafts, reports, and in-flight captures", () => {
        let state = createContextReferenceState("/sessions/target.jsonl");
        state = reduceContextReferenceState(state, targeted(state, { type: "draft_prepared", view: makeDraft("one") }));
        state = reduceContextReferenceState(
            state,
            targeted(state, { type: "send_began", captureId: "capture", draftIds: ["one"] })
        );
        state = reduceContextReferenceState(state, {
            type: "target_changed",
            targetSessionPath: "/sessions/other.jsonl",
        });

        expect(state).toMatchObject({
            targetSessionPath: "/sessions/other.jsonl",
            drafts: [],
            reportsByTurn: {},
            sendCapturesById: {},
        });
    });
});
