// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, waitFor } from "@testing-library/react";
import { createElement, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { AgentChatHost, type AgentChatHostApi, createAgentChatHostApi } from "./agent-chat-host";

function makeSession(): AgentSessionMeta {
    return { id: "s1", createdAt: "now", cwd: "/repo", path: "/tmp/session.jsonl" };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("createAgentChatHostApi", () => {
    it("routes tree and fork slash commands to selector requests without sending prompts", () => {
        const sendPrompt = vi.fn(() => true);
        const onSelectorRequest = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getWorkspaceDir: () => "/repo",
            onSelectorRequest,
        });

        expect(api.submit("/tree")).toBe(true);
        expect(api.submit("/fork")).toBe(true);

        expect(sendPrompt).not.toHaveBeenCalled();
        expect(onSelectorRequest).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "tree" }));
        expect(onSelectorRequest).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: "fork" }));
    });

    it.each(["tree", "fork"] as const)(
        "handles /%s without an active session by reporting one visible error",
        (command) => {
            const onUserError = vi.fn();
            const onSelectorRequest = vi.fn();
            const api = createAgentChatHostApi({
                sendPrompt: vi.fn(() => true),
                abort: vi.fn(),
                getTurns: () => [],
                getRuntimeApi: vi.fn(),
                getSessionMetadata: () => undefined,
                getWorkspaceDir: () => "/repo",
                onUserError,
                onSelectorRequest,
            });

            let handled = false;
            expect(() => {
                handled = api.submit(`/${command}`);
            }).not.toThrow();
            expect(handled).toBe(true);

            expect(onUserError).toHaveBeenCalledTimes(1);
            expect(onUserError).toHaveBeenCalledWith(
                "No agent session yet. Send a prompt before using session commands."
            );
            expect(onSelectorRequest).not.toHaveBeenCalled();
        }
    );

    it("binds selector requests to the session snapshot and generation that opened them", async () => {
        const sessionA = makeSession();
        const sessionB = { ...sessionA, id: "s2", path: "/tmp/session-b.jsonl" };
        let currentSession = sessionA;
        let currentGeneration = 0;
        const onSelectorRequest = vi.fn();
        const runtimeApi = {
            listTree: vi.fn(async () => ({ entries: [], leafId: null })),
            listForkPoints: vi.fn(async () => []),
            navigateTree: vi.fn(async () => ({ sessionMetadata: sessionA })),
            forkSession: vi.fn(async () => ({ sessionMetadata: sessionA })),
            cloneSession: vi.fn(),
            runCommand: vi.fn(),
        };
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => currentSession,
            getSessionRevision: () => currentGeneration,
            getWorkspaceDir: () => "/repo",
            onSelectorRequest,
        });

        api.submit("/tree");
        const request = onSelectorRequest.mock.calls[0][0];
        const pendingList = request.listTree();
        currentSession = sessionB;
        currentGeneration = 1;
        currentSession = sessionA;
        currentGeneration = 2;

        await pendingList;
        expect(runtimeApi.listTree).toHaveBeenCalledWith(sessionA);
        expect(request.isCurrent()).toBe(false);
    });

    it("passes images through when submitting a normal prompt", () => {
        const sendPrompt = vi.fn(() => true);
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getWorkspaceDir: () => "/repo",
        });

        expect(api.submit("describe this", ["data:image/png;base64,abc123"])).toBe(true);

        expect(sendPrompt).toHaveBeenCalledWith("describe this", ["data:image/png;base64,abc123"]);
    });

    it("routes the resume compatibility alias to the session manager", async () => {
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
        const onSessionChange = vi.fn();
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
        };
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: makeSession,
            getWorkspaceDir: () => "/repo",
            onSelectorRequest,
            onSessionChange,
        });

        expect(api.submit("/resume")).toBe(true);

        expect(sendPrompt).not.toHaveBeenCalled();
        expect(onSelectorRequest).toHaveBeenCalledWith(expect.objectContaining({ type: "session" }));
        const request = onSelectorRequest.mock.calls[0][0];
        await expect(request.listSessions("/repo")).resolves.toEqual([detail]);
        expect(runtimeApi.listSessionDetailsForCwd).toHaveBeenCalledWith("/repo");
        await expect(request.resumeSession(detail)).resolves.toEqual({ sessionMetadata: detail });
        expect(onSessionChange).toHaveBeenCalledWith(detail);
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
        };
        const onSessionChange = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => session,
            getWorkspaceDir: () => "/repo",
            onSessionChange,
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
        expect(runtimeApi.forkSession).toHaveBeenCalledWith({ sessionMetadata: session, entryId: "e1" });
        expect(runtimeApi.cloneSession).toHaveBeenCalledWith({ sessionMetadata: session });
        expect(onSessionChange).toHaveBeenCalledWith({ ...session, path: "/tmp/fork.jsonl" });
        expect(onSessionChange).toHaveBeenCalledWith({ ...session, path: "/tmp/clone.jsonl" });
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
        };
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => session,
            getWorkspaceDir: () => "/repo",
            onOpenModelPicker,
        });

        expect(api.submit("/model")).toBe(true);
        expect(api.submit("/clone")).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(onOpenModelPicker).toHaveBeenCalledOnce();
        expect(runtimeApi.cloneSession).toHaveBeenCalledWith({ sessionMetadata: session });
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
        };
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => session,
            getWorkspaceDir: () => "/repo",
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
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getWorkspaceDir: () => "/repo",
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

    it("routes /session to the session manager without running an immediate command", () => {
        const onSelectorRequest = vi.fn();
        const runCommand = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getWorkspaceDir: () => "/repo",
            onSelectorRequest,
            runCommand,
        });

        expect(api.submit("/session")).toBe(true);
        expect(onSelectorRequest).toHaveBeenCalledWith(expect.objectContaining({ type: "session" }));
        expect(runCommand).not.toHaveBeenCalled();
    });

    it("clears the current session after a successful lazy-mint /new result", async () => {
        const onSessionChange = vi.fn();
        const runCommand = vi.fn(async () => ({
            status: "success" as const,
            message: "Created a new agent session.",
        }));
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getWorkspaceDir: () => "/repo",
            onSessionChange,
            runCommand,
        });

        expect(api.submit("/new")).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(onSessionChange).toHaveBeenCalledWith(undefined);
    });

    it("runs immediate commands without block-scoped payload fields", async () => {
        const runCommand = vi.fn(async () => ({ status: "success" as const, message: "ok" }));
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: makeSession,
            getWorkspaceDir: () => "/repo",
            runCommand,
        });

        expect(api.submit("/compact now")).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(runCommand).toHaveBeenCalledWith("compact", "now");
    });

    it("does not apply a stale async command session change after the controlled session changes", async () => {
        const sessionA = makeSession();
        const sessionB = { ...sessionA, id: "s2", path: "/tmp/session-b.jsonl" };
        const commandResult = deferred<AgentCommandExecutionResult>();
        let currentSession = sessionA;
        let currentRevision = 0;
        const onSessionChange = vi.fn();
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: () => currentSession,
            getSessionRevision: () => currentRevision,
            getWorkspaceDir: () => "/repo",
            onSessionChange,
            runCommand: vi.fn(() => commandResult.promise),
        });

        expect(api.submit("/new")).toBe(true);
        currentSession = sessionB;
        currentRevision = 1;
        commandResult.resolve({
            status: "success",
            message: "Created a new agent session.",
        });
        await commandResult.promise;
        await Promise.resolve();

        expect(onSessionChange).not.toHaveBeenCalled();
    });

    it("drops stale immediate command resolve and reject side effects after the controlled session changes", async () => {
        const sessionA = makeSession();
        const sessionB = { ...sessionA, id: "s2", path: "/tmp/session-b.jsonl" };
        const resolvedCommand = deferred<AgentCommandExecutionResult>();
        const rejectedCommand = deferred<AgentCommandExecutionResult>();
        let currentSession = sessionA;
        let currentRevision = 0;
        const onSessionChange = vi.fn();
        const onCommandResult = vi.fn();
        const onUserError = vi.fn();
        const runCommand = vi
            .fn()
            .mockImplementationOnce(() => resolvedCommand.promise)
            .mockImplementationOnce(() => rejectedCommand.promise);
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: () => currentSession,
            getSessionRevision: () => currentRevision,
            getWorkspaceDir: () => "/repo",
            onSessionChange,
            onCommandResult,
            onUserError,
            runCommand,
        });

        expect(api.submit("/compact old")).toBe(true);
        expect(api.submit("/new")).toBe(true);
        currentSession = sessionB;
        currentRevision = 1;
        resolvedCommand.resolve({
            status: "success",
            message: "Compacted old session.",
            sessionMetadata: { ...sessionA, path: "/tmp/compacted-a.jsonl" },
        });
        rejectedCommand.reject(new Error("old command failed"));
        await Promise.allSettled([resolvedCommand.promise, rejectedCommand.promise]);
        await Promise.resolve();

        expect(onSessionChange).not.toHaveBeenCalled();
        expect(onCommandResult).not.toHaveBeenCalled();
        expect(onUserError).not.toHaveBeenCalled();
    });

    it("keeps immediate command resolve and reject side effects for the current controlled session", async () => {
        const session = makeSession();
        const resolvedCommand = deferred<AgentCommandExecutionResult>();
        const rejectedCommand = deferred<AgentCommandExecutionResult>();
        const onSessionChange = vi.fn();
        const onCommandResult = vi.fn();
        const onUserError = vi.fn();
        const runCommand = vi
            .fn()
            .mockImplementationOnce(() => resolvedCommand.promise)
            .mockImplementationOnce(() => rejectedCommand.promise);
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: () => session,
            getSessionRevision: () => 3,
            getWorkspaceDir: () => "/repo",
            onSessionChange,
            onCommandResult,
            onUserError,
            runCommand,
        });

        expect(api.submit("/compact current")).toBe(true);
        resolvedCommand.resolve({
            status: "success",
            message: "Compacted current session.",
            sessionMetadata: { ...session, path: "/tmp/compacted-current.jsonl" },
        });
        await resolvedCommand.promise;
        await Promise.resolve();

        expect(onSessionChange).toHaveBeenCalledWith({
            ...session,
            path: "/tmp/compacted-current.jsonl",
        });
        expect(onCommandResult).toHaveBeenCalledWith({
            command: "compact",
            status: "success",
            message: "Compacted current session.",
            sessionMetadata: { ...session, path: "/tmp/compacted-current.jsonl" },
        });

        expect(api.submit("/reload")).toBe(true);
        rejectedCommand.reject(new Error("current command failed"));
        await Promise.allSettled([rejectedCommand.promise]);
        await Promise.resolve();

        expect(onUserError).toHaveBeenCalledWith("current command failed");
    });

    it("rejects ABA-stale command side effects while allowing new commands after returning to session A", async () => {
        const sessionA = makeSession();
        const sessionB = { ...sessionA, id: "s2", path: "/tmp/session-b.jsonl" };
        const oldResolve = deferred<AgentCommandExecutionResult>();
        const oldReject = deferred<AgentCommandExecutionResult>();
        const freshResolve = deferred<AgentCommandExecutionResult>();
        const freshReject = deferred<AgentCommandExecutionResult>();
        let currentSession = sessionA;
        let currentGeneration = 0;
        const onSessionChange = vi.fn();
        const onCommandResult = vi.fn();
        const onUserError = vi.fn();
        const runCommand = vi
            .fn()
            .mockImplementationOnce(() => oldResolve.promise)
            .mockImplementationOnce(() => oldReject.promise)
            .mockImplementationOnce(() => freshResolve.promise)
            .mockImplementationOnce(() => freshReject.promise);
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: vi.fn(),
            getSessionMetadata: () => currentSession,
            getSessionRevision: () => currentGeneration,
            getWorkspaceDir: () => "/repo",
            onSessionChange,
            onCommandResult,
            onUserError,
            runCommand,
        });

        api.submit("/compact old");
        api.submit("/reload");
        currentSession = sessionB;
        currentGeneration = 1;
        currentSession = sessionA;
        currentGeneration = 2;
        oldResolve.resolve({ status: "success", message: "old result", sessionMetadata: sessionA });
        oldReject.reject(new Error("old error"));
        await Promise.allSettled([oldResolve.promise, oldReject.promise]);
        await Promise.resolve();

        expect(onSessionChange).not.toHaveBeenCalled();
        expect(onCommandResult).not.toHaveBeenCalled();
        expect(onUserError).not.toHaveBeenCalled();

        api.submit("/compact fresh");
        freshResolve.resolve({ status: "success", message: "fresh result", sessionMetadata: sessionA });
        await freshResolve.promise;
        await Promise.resolve();
        expect(onSessionChange).toHaveBeenCalledWith(sessionA);
        expect(onCommandResult).toHaveBeenCalledWith(
            expect.objectContaining({ command: "compact", message: "fresh result" })
        );

        api.submit("/reload");
        freshReject.reject(new Error("fresh error"));
        await Promise.allSettled([freshReject.promise]);
        await Promise.resolve();
        expect(onUserError).toHaveBeenCalledWith("fresh error");
    });

    it("does not apply stale fork or clone session changes after the controlled session changes", async () => {
        const sessionA = makeSession();
        const sessionB = { ...sessionA, id: "s2", path: "/tmp/session-b.jsonl" };
        const forkResult = deferred<AgentForkSessionResult>();
        const cloneResult = deferred<AgentCloneSessionResult>();
        let currentSession = sessionA;
        let currentRevision = 0;
        const onSessionChange = vi.fn();
        const runtimeApi = {
            listTree: vi.fn(),
            listForkPoints: vi.fn(),
            navigateTree: vi.fn(),
            forkSession: vi.fn(() => forkResult.promise),
            cloneSession: vi.fn(() => cloneResult.promise),
            runCommand: vi.fn(),
            listSessionsForCwd: vi.fn(),
            listSessionDetailsForCwd: vi.fn(),
            listAllSessionDetails: vi.fn(),
        };
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => currentSession,
            getSessionRevision: () => currentRevision,
            getWorkspaceDir: () => "/repo",
            onSessionChange,
        });

        const pendingFork = api.forkSession("e1");
        const pendingClone = api.cloneSession();
        currentSession = sessionB;
        currentRevision = 1;
        forkResult.resolve({ sessionMetadata: { ...sessionA, path: "/tmp/fork.jsonl" } });
        cloneResult.resolve({ sessionMetadata: { ...sessionA, path: "/tmp/clone.jsonl" } });
        await Promise.all([pendingFork, pendingClone]);

        expect(onSessionChange).not.toHaveBeenCalled();
    });

    it("drops stale clone resolve and reject side effects after the controlled session changes", async () => {
        const sessionA = makeSession();
        const sessionB = { ...sessionA, id: "s2", path: "/tmp/session-b.jsonl" };
        const resolvedClone = deferred<AgentCloneSessionResult>();
        const rejectedClone = deferred<AgentCloneSessionResult>();
        let currentSession = sessionA;
        let currentRevision = 0;
        const onSessionChange = vi.fn();
        const onUserError = vi.fn();
        const runtimeApi = {
            listTree: vi.fn(),
            listForkPoints: vi.fn(),
            navigateTree: vi.fn(),
            forkSession: vi.fn(),
            cloneSession: vi
                .fn()
                .mockImplementationOnce(() => resolvedClone.promise)
                .mockImplementationOnce(() => rejectedClone.promise),
            runCommand: vi.fn(),
        };
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => currentSession,
            getSessionRevision: () => currentRevision,
            getWorkspaceDir: () => "/repo",
            onSessionChange,
            onUserError,
        });

        expect(api.submit("/clone")).toBe(true);
        expect(api.submit("/clone")).toBe(true);
        currentSession = sessionB;
        currentRevision = 1;
        resolvedClone.resolve({
            sessionMetadata: { ...sessionA, path: "/tmp/clone-a.jsonl" },
            message: "old clone warning",
        });
        rejectedClone.reject(new Error("old clone failed"));
        await Promise.allSettled([resolvedClone.promise, rejectedClone.promise]);
        await Promise.resolve();

        expect(onSessionChange).not.toHaveBeenCalled();
        expect(onUserError).not.toHaveBeenCalled();
    });

    it("keeps clone resolve and reject side effects for the current controlled session", async () => {
        const session = makeSession();
        const resolvedClone = deferred<AgentCloneSessionResult>();
        const rejectedClone = deferred<AgentCloneSessionResult>();
        const onSessionChange = vi.fn();
        const onUserError = vi.fn();
        const runtimeApi = {
            listTree: vi.fn(),
            listForkPoints: vi.fn(),
            navigateTree: vi.fn(),
            forkSession: vi.fn(),
            cloneSession: vi
                .fn()
                .mockImplementationOnce(() => resolvedClone.promise)
                .mockImplementationOnce(() => rejectedClone.promise),
            runCommand: vi.fn(),
        };
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => session,
            getSessionRevision: () => 4,
            getWorkspaceDir: () => "/repo",
            onSessionChange,
            onUserError,
        });

        expect(api.submit("/clone")).toBe(true);
        resolvedClone.resolve({
            sessionMetadata: { ...session, path: "/tmp/clone-current.jsonl" },
            message: "current clone warning",
        });
        await resolvedClone.promise;
        await Promise.resolve();

        expect(onSessionChange).toHaveBeenCalledWith({
            ...session,
            path: "/tmp/clone-current.jsonl",
        });
        expect(onUserError).toHaveBeenCalledWith("current clone warning");

        expect(api.submit("/clone")).toBe(true);
        rejectedClone.reject(new Error("current clone failed"));
        await Promise.allSettled([rejectedClone.promise]);
        await Promise.resolve();

        expect(onUserError).toHaveBeenCalledWith("current clone failed");
    });

    it("rejects ABA-stale clone side effects while allowing new clones after returning to session A", async () => {
        const sessionA = makeSession();
        const sessionB = { ...sessionA, id: "s2", path: "/tmp/session-b.jsonl" };
        const oldResolve = deferred<AgentCloneSessionResult>();
        const oldReject = deferred<AgentCloneSessionResult>();
        const freshResolve = deferred<AgentCloneSessionResult>();
        const freshReject = deferred<AgentCloneSessionResult>();
        let currentSession = sessionA;
        let currentGeneration = 0;
        const onSessionChange = vi.fn();
        const onUserError = vi.fn();
        const runtimeApi = {
            listTree: vi.fn(),
            listForkPoints: vi.fn(),
            navigateTree: vi.fn(),
            forkSession: vi.fn(),
            cloneSession: vi
                .fn()
                .mockImplementationOnce(() => oldResolve.promise)
                .mockImplementationOnce(() => oldReject.promise)
                .mockImplementationOnce(() => freshResolve.promise)
                .mockImplementationOnce(() => freshReject.promise),
            runCommand: vi.fn(),
        };
        const api = createAgentChatHostApi({
            sendPrompt: vi.fn(() => true),
            abort: vi.fn(),
            getTurns: () => [],
            getRuntimeApi: () => runtimeApi,
            getSessionMetadata: () => currentSession,
            getSessionRevision: () => currentGeneration,
            getWorkspaceDir: () => "/repo",
            onSessionChange,
            onUserError,
        });

        api.submit("/clone");
        api.submit("/clone");
        currentSession = sessionB;
        currentGeneration = 1;
        currentSession = sessionA;
        currentGeneration = 2;
        oldResolve.resolve({ sessionMetadata: sessionA, message: "old clone result" });
        oldReject.reject(new Error("old clone error"));
        await Promise.allSettled([oldResolve.promise, oldReject.promise]);
        await Promise.resolve();

        expect(onSessionChange).not.toHaveBeenCalled();
        expect(onUserError).not.toHaveBeenCalled();

        api.submit("/clone");
        freshResolve.resolve({ sessionMetadata: sessionA, message: "fresh clone result" });
        await freshResolve.promise;
        await Promise.resolve();
        expect(onSessionChange).toHaveBeenCalledWith(sessionA);
        expect(onUserError).toHaveBeenCalledWith("fresh clone result");

        api.submit("/clone");
        freshReject.reject(new Error("fresh clone error"));
        await Promise.allSettled([freshReject.promise]);
        await Promise.resolve();
        expect(onUserError).toHaveBeenCalledWith("fresh clone error");
    });

    it("fences a pending command result when a controlled clear commits before passive effects", async () => {
        const sessionA = makeSession();
        const commandResult = deferred<AgentCommandExecutionResult>();
        const freshCommandResult = deferred<AgentCommandExecutionResult>();
        const onSessionChange = vi.fn();
        let hostApi: AgentChatHostApi | undefined;
        const runtimeClient = {
            createSession: vi.fn(),
            getSessionState: vi.fn(),
            send: vi.fn(),
            abort: vi.fn(),
            subscribe: vi.fn(() => () => {}),
            listTree: vi.fn(),
            listForkPoints: vi.fn(),
            navigateTree: vi.fn(),
            forkSession: vi.fn(),
            cloneSession: vi.fn(),
            runCommand: vi
                .fn()
                .mockImplementationOnce(() => commandResult.promise)
                .mockImplementationOnce(() => freshCommandResult.promise),
            listSessionsForCwd: vi.fn(),
            listSessionDetailsForCwd: vi.fn(),
            listAllSessionDetails: vi.fn(),
        };
        const Harness = ({
            sessionMetadata,
            sessionRevision,
            resolveStale,
        }: {
            sessionMetadata: AgentSessionMeta | undefined;
            sessionRevision: number;
            resolveStale: boolean;
        }) => {
            useLayoutEffect(() => {
                if (resolveStale) {
                    hostApi?.submit("/new");
                    commandResult.resolve({
                        status: "success",
                        message: "Created a new agent session.",
                    });
                }
            }, [resolveStale]);
            return createElement(AgentChatHost, {
                runtimeClient: runtimeClient as any,
                executionContext: {
                    workspaceId: "workspace-1",
                    workspaceDir: "/repo",
                    environment: {},
                },
                sessionMetadata,
                sessionRevision,
                modelSelection: { provider: "openai", model: "gpt-test" },
                onSessionChange,
                onReady: (api) => {
                    hostApi = api;
                },
            });
        };
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        await act(async () => {
            root.render(
                createElement(Harness, {
                    sessionMetadata: sessionA,
                    sessionRevision: 0,
                    resolveStale: false,
                })
            );
        });
        await waitFor(() => expect(hostApi).toBeDefined());

        expect(hostApi?.submit("/new")).toBe(true);
        expect(runtimeClient.runCommand).toHaveBeenCalledOnce();

        flushSync(() => {
            root.render(
                createElement(Harness, {
                    sessionMetadata: undefined,
                    sessionRevision: 1,
                    resolveStale: true,
                })
            );
        });
        await commandResult.promise;
        await Promise.resolve();

        expect(runtimeClient.runCommand).toHaveBeenCalledTimes(2);
        expect(runtimeClient.runCommand).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ sessionMetadata: undefined })
        );
        expect(onSessionChange).not.toHaveBeenCalled();

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });
});
