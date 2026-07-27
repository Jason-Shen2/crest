// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ContextReferenceDraftState } from "@/app/store/context-references";
import { ContextReferenceBar, ContextReferenceDraftChip } from "./context-reference-chips";

afterEach(cleanup);

function makeDraft(overrides: Partial<ContextReferenceDraftState> = {}): ContextReferenceDraftState {
    return {
        view: {
            draftId: "draft-one",
            targetSessionPath: "/sessions/target.jsonl",
            provenance: {
                sourceKind: "turn",
                sourceSessionId: "session-source",
                sourceSessionPath: "/sessions/source.jsonl",
                sourceSessionTitle: "Source investigation",
                sourceCwd: "/workspace",
                sourceTurnId: "turn-source",
                sourceLeafId: "leaf-source",
                sourceMessageEntryIds: ["message-source"],
                preview: "The source concluded that the cache key is stale.",
                capturedAt: "2026-07-25T00:00:00.000Z",
            },
            summaryStatus: "none",
            expiresAt: "2026-07-25T01:00:00.000Z",
        },
        deliveryScope: "message",
        requestedRepresentation: "full",
        status: "ready",
        ...overrides,
    };
}

describe("ContextReferenceDraftChip", () => {
    test("shows immutable delivery and representation choices without edit controls", () => {
        render(
            <ContextReferenceDraftChip
                draft={makeDraft({ deliveryScope: "conversation", requestedRepresentation: "summary" })}
                onSummarize={vi.fn()}
                onDiscard={vi.fn()}
            />
        );

        expect(screen.getByText("Source investigation")).toBeTruthy();
        expect(screen.getByText("Conversation")).toBeTruthy();
        expect(screen.getByText("Summary")).toBeTruthy();
        expect(screen.queryByText("Pin")).toBeNull();
        expect(screen.queryByRole("button", { name: /use once/i })).toBeNull();
    });

    test("shows summary generation in the composer", () => {
        render(
            <ContextReferenceDraftChip
                draft={makeDraft({ requestedRepresentation: "summary", status: "summarizing" })}
                onSummarize={vi.fn()}
                onDiscard={vi.fn()}
            />
        );

        expect(screen.getByText("Generating summary…")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Discard reference" }).hasAttribute("disabled")).toBe(true);
    });

    test("offers summary retry after generation fails", async () => {
        const onSummarize = vi.fn().mockResolvedValue(undefined);
        render(
            <ContextReferenceDraftChip
                draft={makeDraft({
                    requestedRepresentation: "summary",
                    status: "error",
                    errorMessage: "Summary service unavailable",
                })}
                onSummarize={onSummarize}
                onDiscard={vi.fn()}
            />
        );

        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry summary" })));
        expect(onSummarize).toHaveBeenCalledWith("draft-one");
    });

    test("discards a ready reference", async () => {
        const onDiscard = vi.fn().mockResolvedValue(undefined);
        render(
            <ContextReferenceDraftChip draft={makeDraft()} onSummarize={vi.fn()} onDiscard={onDiscard} />
        );

        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Discard reference" })));
        expect(onDiscard).toHaveBeenCalledWith("draft-one");
    });
});

describe("ContextReferenceBar", () => {
    test("renders only composer drafts and recovery", () => {
        render(
            <ContextReferenceBar
                drafts={[makeDraft()]}
                recovery={{ errorMessage: "Send failed" }}
                onSummarizeDraft={vi.fn()}
                onDiscardDraft={vi.fn()}
                onRetrySend={vi.fn()}
            />
        );

        expect(screen.getByLabelText("Context references")).toBeTruthy();
        expect(screen.getByText("Send failed")).toBeTruthy();
        expect(screen.queryByLabelText("Pinned reference")).toBeNull();
    });
});
