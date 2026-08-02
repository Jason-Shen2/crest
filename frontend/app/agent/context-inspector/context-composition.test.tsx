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
        children: [
            {
                id: `user-${index}`,
                category: "conversation",
                kind: "user_message",
                title: `User message ${index + 1}`,
                preview: `User question ${index + 1}`,
                content: `Complete user question ${index + 1}`,
                tokens: 5,
                tokenAccuracy: "estimated",
                source: { entryIds: [`entry-${index}`] },
            },
        ],
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
        attributionDeltaTokens: 7,
        categories: [
            { category: "agent_instructions", tokens: 100, itemCount: 1 },
            { category: "tools", tokens: 200, itemCount: 1 },
            { category: "conversation", tokens: 10, itemCount: 1 },
            { category: "added_context", tokens: 0, itemCount: 0 },
        ],
        items: [
            {
                id: "base-prompt",
                category: "agent_instructions",
                kind: "base_prompt",
                title: "Base prompt source",
                preview: "Core agent behavior",
                content: "Complete base prompt",
                tokens: 100,
                tokenAccuracy: "estimated",
                source: { entryIds: ["prompt-entry"] },
            },
            {
                id: "read-file",
                category: "tools",
                kind: "tool_definition",
                title: "Read file",
                preview: "Read a file from disk",
                content: { name: "read_file", strict: true },
                tokens: 200,
                tokenAccuracy: "estimated",
                source: { toolName: "read_file" },
            },
            conversationItem(0),
        ],
        ...overrides,
    };
}

function renderedLargePayloadText(surface: HTMLElement): string {
    if (surface instanceof HTMLTextAreaElement) return surface.value;
    return surface.textContent ?? "";
}

describe("ContextComposition", () => {
    it("shows fixed groups and source rows without legacy composition chrome", () => {
        render(<ContextComposition snapshot={snapshot()} />);

        for (const label of ["Agent instructions", "Tools", "Conversation", "Added context"]) {
            expect(screen.getByRole("heading", { name: label })).toBeTruthy();
            expect(screen.queryByRole("button", { name: new RegExp(label) })).toBeNull();
        }
        expect(screen.getByRole("button", { name: "Base prompt source, Core agent behavior" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Read file, Read a file from disk" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Turn 1, User message 1, User question 1" })).toBeTruthy();
        expect(screen.getByText("No active sources.")).toBeTruthy();

        for (const legacyText of [
            "Composition",
            "Tokens",
            "Included as",
            "Why it is here",
            "Request overhead",
            "Attribution differs",
            "No additional provenance",
        ]) {
            expect(screen.queryByText(new RegExp(legacyText, "i"))).toBeNull();
        }
        expect(screen.queryByLabelText("Context composition")).toBeNull();
        expect(document.querySelector("[aria-label*='entry']")).toBeNull();
    });

    it("keeps one source open across groups, toggles it closed, and restores focus on Escape", () => {
        render(<ContextComposition snapshot={snapshot()} />);

        const instructions = screen.getByRole("button", { name: "Base prompt source, Core agent behavior" });
        const tool = screen.getByRole("button", { name: "Read file, Read a file from disk" });
        fireEvent.click(instructions);
        expect(instructions.getAttribute("aria-expanded")).toBe("true");
        const instructionPayload = screen.getByTestId("context-payload-base-prompt");
        expect(instructions.getAttribute("aria-controls")).toBe(instructionPayload.id);

        fireEvent.click(tool);
        expect(instructions.getAttribute("aria-expanded")).toBe("false");
        expect(tool.getAttribute("aria-expanded")).toBe("true");
        expect(screen.queryByTestId("context-payload-base-prompt")).toBeNull();

        fireEvent.click(tool);
        expect(tool.getAttribute("aria-expanded")).toBe("false");
        fireEvent.click(instructions);
        const payload = screen.getByTestId("context-payload-base-prompt");
        payload.focus();
        fireEvent.keyDown(payload, { key: "Escape" });

        expect(instructions.getAttribute("aria-expanded")).toBe("false");
        expect(document.activeElement).toBe(instructions);
    });

    it("labels the payload region with its disclosure button", () => {
        render(<ContextComposition snapshot={snapshot()} />);

        const disclosure = screen.getByRole("button", { name: "Base prompt source, Core agent behavior" });
        fireEvent.click(disclosure);
        const payload = screen.getByRole("region", { name: "Base prompt source, Core agent behavior" });

        expect(disclosure.id).not.toBe("");
        expect(disclosure.getAttribute("aria-controls")).toBe(payload.id);
        expect(payload.getAttribute("aria-labelledby")).toBe(disclosure.id);
    });

    it("closes an expanded payload when Escape is pressed on its focused disclosure", () => {
        render(<ContextComposition snapshot={snapshot()} />);

        const disclosure = screen.getByRole("button", { name: "Base prompt source, Core agent behavior" });
        disclosure.focus();
        fireEvent.click(disclosure);
        fireEvent.keyDown(disclosure, { key: "Escape" });

        expect(disclosure.getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByTestId("context-payload-base-prompt")).toBeNull();
        expect(document.activeElement).toBe(disclosure);
    });

    it("closes an expanded payload when Escape is pressed on its large payload scroll region", () => {
        const content = `first\r\nsecond\r${"x".repeat(1_048_576)}\r\nlast`;
        render(
            <ContextComposition
                snapshot={snapshot({
                    items: [
                        {
                            ...snapshot().items[0],
                            content,
                        },
                    ],
                })}
            />
        );

        const disclosure = screen.getByRole("button", { name: "Base prompt source, Core agent behavior" });
        fireEvent.click(disclosure);
        const payload = screen.getByTestId("context-payload-base-prompt");
        const valueSurface = screen.getByTestId("context-payload-large-value");
        expect(renderedLargePayloadText(valueSurface)).toBe(content);
        payload.focus();
        fireEvent.keyDown(payload, { key: "Escape" });

        expect(disclosure.getAttribute("aria-expanded")).toBe("false");
        expect(document.activeElement).toBe(disclosure);
    });

    it("virtualizes 1,000 conversation turns while exposing their concrete child sources", () => {
        const items = Array.from({ length: 1_000 }, (_, index) => conversationItem(index));
        render(
            <ContextComposition
                snapshot={snapshot({
                    categories: [
                        { category: "agent_instructions", tokens: 0, itemCount: 0 },
                        { category: "tools", tokens: 0, itemCount: 0 },
                        { category: "conversation", tokens: 10_000, itemCount: 1_000 },
                        { category: "added_context", tokens: 0, itemCount: 0 },
                    ],
                    items,
                })}
            />
        );

        expect(screen.getByTestId("context-conversation-items").getAttribute("data-virtualized")).toBe("conversation");
        expect(screen.getByRole("button", { name: "Turn 1, User message 1, User question 1" })).toBeTruthy();
        expect(screen.getAllByTestId("context-inventory-item").length).toBeLessThan(100);
        expect(screen.queryByRole("button", { name: /User message 999/ })).toBeNull();
    });
});
