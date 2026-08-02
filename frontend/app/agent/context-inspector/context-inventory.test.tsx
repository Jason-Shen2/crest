// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContextCategoryItems } from "./context-inventory";

afterEach(cleanup);

function item(index: number): AgentContextSnapshotItemView {
    return {
        id: `turn-${index}`,
        category: "conversation",
        kind: "turn",
        title: `Turn ${index + 1}`,
        preview: `User question ${index + 1}`,
        tokens: 10,
        tokenAccuracy: "estimated",
        source: { entryIds: [`entry-${index}`] },
        children: [
            {
                id: `assistant-${index}`,
                category: "conversation",
                kind: "assistant_message",
                title: "Assistant",
                preview: "Answer with tool activity",
                tokens: 5,
                tokenAccuracy: "estimated",
                source: { toolCallId: `call-${index}`, pairedResultEntryId: `result-${index}` },
            },
        ],
    };
}

describe("ContextCategoryItems", () => {
    it("expands turn detail with provenance", () => {
        render(<ContextCategoryItems category="conversation" items={[item(0)]} />);

        const turn = screen.getByRole("button", { name: /Turn 1/ });
        fireEvent.click(turn);
        expect(turn.getAttribute("aria-expanded")).toBe("true");
        expect(screen.getAllByText("Assistant").length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole("button", { name: /Assistant, Assistant/ }));
        expect(screen.getByText(/call-0/)).toBeTruthy();
    });

    it("virtualizes a long Conversation inventory while retaining its complete total", () => {
        const items = Array.from({ length: 1_000 }, (_, index) => item(index));
        render(<ContextCategoryItems category="conversation" items={items} />);

        expect(screen.getByTestId("context-conversation-items").getAttribute("data-virtualized")).toBe("conversation");
        expect(screen.getAllByTestId("context-inventory-item").length).toBeLessThan(100);
    });
});
