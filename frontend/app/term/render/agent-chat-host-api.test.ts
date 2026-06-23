// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createAgentChatHostApi } from "./agent-chat-host";

function makeSession(): AgentSessionMeta {
    return { id: "s1", createdAt: "now", cwd: "/repo", path: "/tmp/session.jsonl" };
}

describe("createAgentChatHostApi", () => {
    it("routes tree and fork slash commands to selector requests without sending prompts", () => {
        const sendPrompt = vi.fn(() => true);
        const onSelectorRequest = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            getRuns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getPaneCwd: () => "/repo",
            onSelectorRequest,
        });

        expect(api.submit("/tree")).toBe(true);
        expect(api.submit("/fork")).toBe(true);

        expect(sendPrompt).not.toHaveBeenCalled();
        expect(onSelectorRequest).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "tree" }));
        expect(onSelectorRequest).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: "fork" }));
    });

    it("exposes session tree helpers for selector UI consumption", async () => {
        const session = makeSession();
        const tree = { entries: [], leafId: null };
        const forkPoints: AgentForkPointView[] = [{ entryId: "e1", preview: "first turn" }];
        const runtimeApi = {
            listTree: vi.fn(async () => tree),
            listForkPoints: vi.fn(async () => forkPoints),
            navigateTree: vi.fn(async () => ({ sessionMetadata: session, editorText: "restore me" })),
            forkSession: vi.fn(async () => ({ sessionMetadata: { ...session, path: "/tmp/fork.jsonl" } })),
            cloneSession: vi.fn(async () => ({ sessionMetadata: { ...session, path: "/tmp/clone.jsonl" } })),
        };
        const onSessionMinted = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getRuns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => session,
            getPaneCwd: () => "/repo",
            onSessionMinted,
        });

        await expect(api.listTree()).resolves.toBe(tree);
        await expect(api.listForkPoints()).resolves.toBe(forkPoints);
        await expect(api.navigateTree("e1")).resolves.toEqual({ sessionMetadata: session, editorText: "restore me" });
        await expect(api.forkSession("e1")).resolves.toEqual({
            sessionMetadata: { ...session, path: "/tmp/fork.jsonl" },
        });
        await expect(api.cloneSession()).resolves.toEqual({
            sessionMetadata: { ...session, path: "/tmp/clone.jsonl" },
        });

        expect(runtimeApi.listTree).toHaveBeenCalledWith(session);
        expect(runtimeApi.listForkPoints).toHaveBeenCalledWith(session);
        expect(runtimeApi.navigateTree).toHaveBeenCalledWith({ sessionMetadata: session, targetId: "e1" });
        expect(runtimeApi.forkSession).toHaveBeenCalledWith({ sessionMetadata: session, cwd: "/repo", entryId: "e1" });
        expect(runtimeApi.cloneSession).toHaveBeenCalledWith({ sessionMetadata: session, cwd: "/repo" });
        expect(onSessionMinted).toHaveBeenCalledWith({ ...session, path: "/tmp/fork.jsonl" });
        expect(onSessionMinted).toHaveBeenCalledWith({ ...session, path: "/tmp/clone.jsonl" });
    });

    it("keeps model and clone command behavior while bypassing prompt send", async () => {
        const session = makeSession();
        const sendPrompt = vi.fn(() => true);
        const onOpenModelPicker = vi.fn();
        const runtimeApi = {
            listTree: vi.fn(),
            listForkPoints: vi.fn(),
            navigateTree: vi.fn(),
            forkSession: vi.fn(),
            cloneSession: vi.fn(async () => ({ sessionMetadata: { ...session, path: "/tmp/clone.jsonl" } })),
        };
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            getRuns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => session,
            getPaneCwd: () => "/repo",
            onOpenModelPicker,
        });

        expect(api.submit("/model")).toBe(true);
        expect(api.submit("/clone")).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(onOpenModelPicker).toHaveBeenCalledOnce();
        expect(runtimeApi.cloneSession).toHaveBeenCalledWith({ sessionMetadata: session, cwd: "/repo" });
        expect(sendPrompt).not.toHaveBeenCalled();
    });

    it("surfaces clone no-op messages to the user", async () => {
        const session = makeSession();
        const sendPrompt = vi.fn(() => true);
        const onUserError = vi.fn();
        const runtimeApi = {
            listTree: vi.fn(),
            listForkPoints: vi.fn(),
            navigateTree: vi.fn(),
            forkSession: vi.fn(),
            cloneSession: vi.fn(async () => ({ message: "No session branch to clone yet." })),
        };
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            getRuns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => session,
            getPaneCwd: () => "/repo",
            onUserError,
        });

        expect(api.submit("/clone")).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(onUserError).toHaveBeenCalledWith("No session branch to clone yet.");
        expect(sendPrompt).not.toHaveBeenCalled();
    });
});
