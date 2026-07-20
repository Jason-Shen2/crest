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
            respondExtUi: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            onSelectorRequest,
        });

        expect(api.submit("/tree")).toBe(true);
        expect(api.submit("/fork")).toBe(true);

        expect(sendPrompt).not.toHaveBeenCalled();
        expect(onSelectorRequest).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "tree" }));
        expect(onSelectorRequest).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: "fork" }));
    });

    it("routes resume slash commands to selector requests without sending prompts", async () => {
        const session = makeSession();
        const detail = {
            ...session,
            modifiedAt: "later",
            messageCount: 2,
            firstMessage: "debug sqlite resume",
            previewText: "debug sqlite resume assistant reply",
        };
        const sendPrompt = vi.fn(() => true);
        const onSelectorRequest = vi.fn();
        const onSessionMinted = vi.fn();
        const runtimeApi = {
            listTree: vi.fn(),
            listForkPoints: vi.fn(),
            navigateTree: vi.fn(),
            forkSession: vi.fn(),
            cloneSession: vi.fn(),
            runCommand: vi.fn(),
            listSessionsForCwd: vi.fn(async () => [session]),
            listSessionDetailsForCwd: vi.fn(async () => [detail]),
            listAllSessionDetails: vi.fn(),
            listCommands: vi.fn(async () => []),
            runExtensionCommand: vi.fn(),
            listShortcuts: vi.fn(async () => []),
            runShortcut: vi.fn(),
            listFlags: vi.fn(async () => []),
            setFlag: vi.fn(),
        };
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            respondExtUi: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: makeSession,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            onSelectorRequest,
            onSessionMinted,
        });

        expect(api.submit("/resume")).toBe(true);

        expect(sendPrompt).not.toHaveBeenCalled();
        expect(onSelectorRequest).toHaveBeenCalledWith(expect.objectContaining({ type: "resume" }));
        const request = onSelectorRequest.mock.calls[0][0];
        await expect(request.listSessions("/repo")).resolves.toEqual([detail]);
        expect(runtimeApi.listSessionDetailsForCwd).toHaveBeenCalledWith("/repo");
        await expect(request.resumeSession(detail)).resolves.toEqual({ sessionMetadata: detail });
        expect(onSessionMinted).toHaveBeenCalledWith(detail);
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
            runCommand: vi.fn(),
            listSessionsForCwd: vi.fn(),
            listSessionDetailsForCwd: vi.fn(),
            listAllSessionDetails: vi.fn(),
            listCommands: vi.fn(async () => []),
            runExtensionCommand: vi.fn(),
            listShortcuts: vi.fn(async () => []),
            runShortcut: vi.fn(),
            listFlags: vi.fn(async () => []),
            setFlag: vi.fn(),
        };
        const onSessionMinted = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            respondExtUi: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => session,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
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
        expect(runtimeApi.navigateTree).toHaveBeenCalledWith({ sessionMetadata: session, targetId: "e1", blockId: "b_test" });
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
            runCommand: vi.fn(),
            listSessionsForCwd: vi.fn(),
            listSessionDetailsForCwd: vi.fn(),
            listAllSessionDetails: vi.fn(),
            listCommands: vi.fn(async () => []),
            runExtensionCommand: vi.fn(),
            listShortcuts: vi.fn(async () => []),
            runShortcut: vi.fn(),
            listFlags: vi.fn(async () => []),
            setFlag: vi.fn(),
        };
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            respondExtUi: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => session,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
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
            runCommand: vi.fn(),
            listSessionsForCwd: vi.fn(),
            listSessionDetailsForCwd: vi.fn(),
            listAllSessionDetails: vi.fn(),
            listCommands: vi.fn(async () => []),
            runExtensionCommand: vi.fn(),
            listShortcuts: vi.fn(async () => []),
            runShortcut: vi.fn(),
            listFlags: vi.fn(async () => []),
            setFlag: vi.fn(),
        };
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            respondExtUi: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => session,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            onUserError,
        });

        expect(api.submit("/clone")).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(onUserError).toHaveBeenCalledWith("No session branch to clone yet.");
        expect(sendPrompt).not.toHaveBeenCalled();
    });

    it.each([
        "/new",
        "/compact keep errors",
        "/session",
        "/copy",
        "/export /tmp/a.jsonl",
        "/import /tmp/a.jsonl",
        "/reload",
    ])("routes %s to inline command results without sending prompts or toast notifications", async (commandText) => {
        const sendPrompt = vi.fn(() => true);
        const runCommand = vi.fn(async () => ({ status: "success" as const, message: "ok" }));
        const onUserError = vi.fn();
        const onCommandResult = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            respondExtUi: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            onUserError,
            onCommandResult,
            runCommand,
        });

        expect(api.submit(commandText)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(sendPrompt).not.toHaveBeenCalled();
        expect(runCommand).toHaveBeenCalledOnce();
        expect(onUserError).not.toHaveBeenCalled();
        expect(onCommandResult).toHaveBeenCalledWith({
            command: commandText.slice(1).split(/\s+/)[0],
            status: "success",
            message: "ok",
        });
    });

    it("switches to a new session after /new", async () => {
        const onSessionMinted = vi.fn();
        const runCommand = vi.fn(async () => ({
            status: "success" as const,
            message: "Created a new agent session.",
            sessionMetadata: { id: "s2", createdAt: "later", cwd: "/tmp", path: "/tmp/session.jsonl" },
        }));
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            respondExtUi: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getPaneCwd: () => "/repo",
            getBlockId: () => "b_test",
            onSessionMinted,
            runCommand,
        });

        expect(api.submit("/new")).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(onSessionMinted).toHaveBeenCalledWith({
            id: "s2",
            createdAt: "later",
            cwd: "/tmp",
            path: "/tmp/session.jsonl",
        });
    });
});
