// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTurnDiffTopTab } from "./agent-turn-diff-top-tab";
import type { TopTab } from "./workspace-content-state";

const mockRpcApi = vi.hoisted(() => ({
    GitGetDiffContentCommand: vi.fn(),
}));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: mockRpcApi,
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: { routeid: "tab" },
}));

vi.mock("@/app/monaco/monaco-react", () => ({
    MonacoDiffViewer: () => <div data-testid="monaco-diff-viewer" />,
}));

const Tab: Extract<TopTab, { kind: "agent-turn-diff" }> = {
    id: "turn-diff-1",
    kind: "agent-turn-diff",
    sessionId: "session-1",
    sessionCreatedAt: "2026-08-02T12:00:00.000Z",
    sessionCwd: "/repo",
    sessionPath: "/sessions/session-1.db",
    turnId: "turn-1",
    path: "src/app.ts",
    title: "app.ts",
};

function makeClient(result: Pick<AgentTurnFileDiffView, "isBinary" | "fallbackPatch" | "truncated">) {
    return {
        getTurnFileDiff: vi.fn(async () => ({
            turnId: "turn-1",
            path: "src/app.ts",
            operation: "write",
            additions: 1,
            deletions: 1,
            originalContent: "old\n",
            modifiedContent: "new\n",
            ...result,
        })),
    };
}

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("AgentTurnDiffTopTab integration", () => {
    it.each([
        [{ isBinary: true, fallbackPatch: "Binary checkpoint patch", truncated: false }, "Binary checkpoint patch"],
        [{ isBinary: false, fallbackPatch: "", truncated: true }, "Diff content is truncated."],
    ])("renders immutable checkpoint fallback content without loading a Git diff", async (result, expectedText) => {
        const client = makeClient(result);

        render(<AgentTurnDiffTopTab tab={Tab} client={client as any} />);

        expect(await screen.findByText(expectedText)).toBeTruthy();
        await waitFor(() => expect(client.getTurnFileDiff).toHaveBeenCalledOnce());
        expect(screen.queryByTestId("monaco-diff-viewer")).toBeNull();
        expect(mockRpcApi.GitGetDiffContentCommand).not.toHaveBeenCalled();
    });
});
