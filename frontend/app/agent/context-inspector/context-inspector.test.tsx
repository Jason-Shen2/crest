// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContextInspector } from "./context-inspector";

afterEach(cleanup);

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
        effectiveInputTokens: 28_000,
        remainingInputTokens: 84_000,
        requestOverheadTokens: 1_000,
        attributionDeltaTokens: -12,
        categories: [
            { category: "agent_instructions", tokens: 4_000, itemCount: 2 },
            { category: "tools", tokens: 8_000, itemCount: 4 },
            { category: "conversation", tokens: 15_000, itemCount: 3 },
            { category: "added_context", tokens: 0, itemCount: 0 },
        ],
        items: [],
        ...overrides,
    };
}

describe("ContextInspector", () => {
    it("starts with capacity and omits the context metadata header", () => {
        render(
            <ContextInspector
                state={{
                    identity: { workspaceGeneration: 1, sessionGeneration: 0, modelKey: "openai/gpt-5" },
                    status: "ready",
                    snapshot: snapshot(),
                }}
            />
        );

        expect(screen.queryByRole("heading", { name: "Current context" })).toBeNull();
        expect(screen.queryByText("GPT-5")).toBeNull();
        expect(screen.queryByText("Ready")).toBeNull();
        expect(screen.queryByText("Estimated")).toBeNull();
        expect(screen.queryByText(/Updated/)).toBeNull();
        expect(screen.getByText("28.0k / 112.0k")).toBeTruthy();
        expect(screen.getByText("Full window").parentElement?.textContent).toContain("128.0k");
        expect(screen.getByText("Output reserve").parentElement?.textContent).toContain("16.0k");
        expect(screen.getByText("Remaining input").parentElement?.textContent).toContain("84.0k");
        for (const label of ["Agent instructions", "Tools", "Conversation", "Added context"]) {
            expect(screen.getByText(label)).toBeTruthy();
        }
        expect(screen.getByRole("heading", { name: "Context breakdown" })).toBeTruthy();
        expect(screen.queryByRole("heading", { name: "Composition" })).toBeNull();
        expect(screen.queryByText("Request overhead")).toBeNull();
        expect(screen.queryByText(/Attribution differs/)).toBeNull();
        expect(screen.getByLabelText("Context composition")).toBeTruthy();
    });

    it("keeps known inventory visible when token counting is unavailable", () => {
        render(
            <ContextInspector
                state={{
                    identity: { workspaceGeneration: 1, sessionGeneration: 0, modelKey: "openai/gpt-5" },
                    status: "ready",
                    snapshot: snapshot({
                        accuracy: "unavailable",
                        effectiveInputTokens: undefined,
                        remainingInputTokens: undefined,
                    }),
                }}
            />
        );

        expect(screen.queryByText("Token count unavailable")).toBeNull();
        expect(screen.getByText("Unavailable / 112.0k")).toBeTruthy();
        expect(screen.getByText("Conversation")).toBeTruthy();
    });

    it("shows explicit loading and unavailable states without stale inventory", () => {
        const { rerender } = render(
            <ContextInspector
                state={{
                    identity: { workspaceGeneration: 1, sessionGeneration: 0, modelKey: "openai/gpt-5" },
                    status: "loading",
                }}
            />
        );
        expect(screen.getByText("Building effective context…")).toBeTruthy();

        rerender(
            <ContextInspector
                state={{
                    identity: { workspaceGeneration: 1, sessionGeneration: 0, modelKey: "openai/gpt-5" },
                    status: "error",
                    errorMessage: "counter unavailable",
                }}
            />
        );
        expect(screen.getByText("Context unavailable")).toBeTruthy();
        expect(screen.getByText("counter unavailable")).toBeTruthy();
    });
});
