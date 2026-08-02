// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContextComposition } from "./context-composition";

afterEach(cleanup);

function conversationItem(index: number): AgentContextSnapshotItemView {
    return {
        id: `turn-${index}`,
        category: "conversation",
        kind: "turn",
        title: `Turn ${index + 1}`,
        preview: `User question ${index + 1}`,
        tokens: 10,
        tokenAccuracy: "estimated",
        source: { entryIds: [`entry-${index}`] },
    };
}

function snapshot(overrides: Partial<AgentContextSnapshotView> = {}): AgentContextSnapshotView {
    return {
        schemaVersion: 1,
        identity: { leafId: "leaf-1", modelKey: "openai/gpt-5", revision: 2 },
        generatedAt: "2026-08-01T00:00:00Z",
        lifecycle: "ready",
        accuracy: "estimated",
        modelLabel: "GPT-5",
        contextWindow: 128_000,
        outputReserve: 16_000,
        inputCapacity: 112_000,
        effectiveInputTokens: 1_300,
        remainingInputTokens: 110_700,
        requestOverheadTokens: 1_000,
        categories: [
            { category: "agent_instructions", tokens: 100, itemCount: 1 },
            { category: "tools", tokens: 200, itemCount: 1 },
            { category: "conversation", tokens: 0, itemCount: 0 },
            { category: "added_context", tokens: 0, itemCount: 0 },
        ],
        items: [
            {
                id: "base-prompt",
                category: "agent_instructions",
                kind: "base_prompt",
                title: "Base prompt source",
                tokens: 100,
                tokenAccuracy: "estimated",
                source: {},
            },
            {
                id: "read-file",
                category: "tools",
                kind: "tool_definition",
                title: "read_file",
                tokens: 200,
                tokenAccuracy: "estimated",
                source: {},
            },
        ],
        ...overrides,
    };
}

describe("ContextComposition", () => {
    it("expands source details inline and keeps multiple categories open", () => {
        render(<ContextComposition snapshot={snapshot()} />);

        const instructions = screen.getByRole("button", { name: /Agent instructions, 1 sources/ });
        const tools = screen.getByRole("button", { name: /Tools, 1 sources/ });
        expect(instructions.getAttribute("aria-expanded")).toBe("false");
        expect(tools.getAttribute("aria-expanded")).toBe("false");

        fireEvent.click(instructions);
        fireEvent.click(tools);

        expect(instructions.getAttribute("aria-expanded")).toBe("true");
        expect(tools.getAttribute("aria-expanded")).toBe("true");
        expect(instructions.querySelector("svg")?.classList.contains("rotate-90")).toBe(true);
        expect(tools.querySelector("svg")?.classList.contains("rotate-90")).toBe(true);
        expect(screen.getByText("Base prompt source")).toBeTruthy();
        expect(screen.getByText("read_file")).toBeTruthy();

        const addedContext = screen.getByRole("button", { name: /Added context, 0 sources/ });
        fireEvent.click(addedContext);
        expect(screen.getByText("No active sources.")).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Request overhead/ })).toBeNull();
    });

    it("virtualizes a long Conversation inventory after expansion", () => {
        const items = Array.from({ length: 1_000 }, (_, index) => conversationItem(index));
        render(
            <ContextComposition
                snapshot={snapshot({
                    effectiveInputTokens: 11_300,
                    remainingInputTokens: 100_700,
                    categories: [
                        { category: "agent_instructions", tokens: 100, itemCount: 1 },
                        { category: "tools", tokens: 200, itemCount: 1 },
                        { category: "conversation", tokens: 10_000, itemCount: 1_000 },
                        { category: "added_context", tokens: 0, itemCount: 0 },
                    ],
                    items,
                })}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: /Conversation, 1000 sources/ }));

        expect(screen.getByText(/1,000 sources/)).toBeTruthy();
        expect(screen.getByTestId("context-conversation-items").getAttribute("data-virtualized")).toBe("conversation");
        expect(screen.getAllByTestId("context-inventory-item").length).toBeLessThan(100);
    });
});
