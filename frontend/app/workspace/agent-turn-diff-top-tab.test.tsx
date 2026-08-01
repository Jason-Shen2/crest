// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTurnDiffTopTab } from "./agent-turn-diff-top-tab";
import type { TopTab } from "./workspace-content-state";

const bodyProps = vi.hoisted(() => ({ latest: undefined as Record<string, unknown> | undefined }));

vi.mock("@/app/gitdiff/git-diff-pane", () => ({
    DiffContentBody: (props: Record<string, unknown>) => {
        bodyProps.latest = props;
        return (
            <div>
                {String(props.loading)}:{String(props.errorMessage ?? "")}:{JSON.stringify(props.content ?? null)}
                {props.onRetry ? (
                    <button type="button" onClick={props.onRetry as () => void}>
                        Retry
                    </button>
                ) : null}
            </div>
        );
    },
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

function makeClient(result?: Partial<AgentTurnFileDiffView>) {
    return {
        getTurnFileDiff: vi.fn(async () => ({
            turnId: "turn-1",
            path: "src/app.ts",
            operation: "write",
            additions: 1,
            deletions: 1,
            originalContent: "old\n",
            modifiedContent: "new\n",
            isBinary: false,
            fallbackPatch: "",
            truncated: false,
            ...result,
        })),
    };
}

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    bodyProps.latest = undefined;
});

describe("AgentTurnDiffTopTab", () => {
    it("loads the immutable checkpoint diff from the agent client and reuses the Monaco diff body", async () => {
        const client = makeClient();
        render(<AgentTurnDiffTopTab tab={Tab} client={client as any} />);

        await waitFor(() => expect(client.getTurnFileDiff).toHaveBeenCalledOnce());
        expect(client.getTurnFileDiff).toHaveBeenCalledWith({
            sessionMetadata: {
                id: "session-1",
                createdAt: "2026-08-02T12:00:00.000Z",
                cwd: "/repo",
                path: "/sessions/session-1.db",
            },
            expectedSemanticLeafId: null,
            turnId: "turn-1",
            path: "src/app.ts",
        });
        await waitFor(() =>
            expect(bodyProps.latest?.content).toEqual({
                originalContent: "old\n",
                modifiedContent: "new\n",
                isBinary: false,
                fallbackPatch: "",
                truncated: false,
            })
        );
        expect(bodyProps.latest?.path).toBe("src/app.ts");
    });

    it.each([
        [{ isBinary: true, fallbackPatch: "Binary checkpoint patch" }, "Binary checkpoint patch"],
        [{ truncated: true, fallbackPatch: "Truncated checkpoint patch" }, "Truncated checkpoint patch"],
    ])("passes immutable fallback content through without consulting Git", async (result, patch) => {
        const client = makeClient(result as Partial<AgentTurnFileDiffView>);
        render(<AgentTurnDiffTopTab tab={Tab} client={client as any} />);

        await waitFor(() => expect(bodyProps.latest?.content).toMatchObject(result));
        expect((bodyProps.latest?.content as { fallbackPatch: string }).fallbackPatch).toBe(patch);
        expect(client.getTurnFileDiff).toHaveBeenCalledOnce();
    });

    it.each(["workspace checkpoint is unavailable", "snapshot corrupt: object missing"])(
        "shows an explicit immutable diff error for %s and retries only the agent request",
        async (message) => {
            const client = makeClient();
            client.getTurnFileDiff.mockRejectedValueOnce(new Error(message));
            render(<AgentTurnDiffTopTab tab={Tab} client={client as any} />);

            await waitFor(() => expect(bodyProps.latest?.errorMessage).toBe(`Failed to load turn diff: ${message}`));
            fireEvent.click(screen.getByRole("button", { name: "Retry" }));
            await waitFor(() => expect(client.getTurnFileDiff).toHaveBeenCalledTimes(2));
            expect(bodyProps.latest?.errorMessage).toBeNull();
        }
    );
});
