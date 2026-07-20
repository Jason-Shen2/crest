// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as electron from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
    app: {
        getPath: vi.fn(() => "/tmp"),
        isPackaged: false,
        runningUnderARM64Translation: false,
        setName: vi.fn(),
    },
    dialog: { showMessageBoxSync: vi.fn() },
    clipboard: { writeText: vi.fn() },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    safeStorage: {
        decryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => true),
    },
    shell: { openExternal: vi.fn() },
}));

vi.mock("./ai", () => ({ getModel: vi.fn() }));
vi.mock("./agent/change-review/change-outline", () => ({
    extractChangeOperationsFromMessages: vi.fn(() => []),
    generateChangeOutline: vi.fn(),
}));
vi.mock("./agent/harness-factory", () => ({ buildAgentHarnessHost: vi.fn() }));
vi.mock("./agent/index", () => ({}));
vi.mock("./agent/permissions", () => ({
    buildPermissionsHook: vi.fn(),
    isBenchMode: vi.fn(() => false),
}));
vi.mock("./agent/tools", () => ({ getDefaultTools: vi.fn(() => []) }));
vi.mock("./aiconfig/secrets", () => ({ getSecret: vi.fn() }));
vi.mock("../frontend/app/store/wshclientapi", () => ({
    RpcApi: {
        AppendAgentRunCommand: vi.fn(),
        GetCmdBlocksCommand: vi.fn(() => Promise.resolve([])),
    },
}));
vi.mock("./emain-wsh", () => ({ ElectronWshClient: {} }));

import {
    _resetAgentIpcForTests,
    abortAgentSessionForIpc,
    cloneAgentSessionForIpc,
    forkAgentSessionForIpc,
    listAgentCommandsForIpc,
    listAgentForkPointsForIpc,
    listAgentTreeForIpc,
    registerAgentIpcHandlers,
    runAgentCommandForIpc,
    subscribeAgentSessionForIpc,
    unsubscribeAgentSessionForIpc,
} from "./agent-ipc";
import { SqliteSessionRepo } from "./agent/harness/session/sqlite-repo";
import { AgentSessionRuntime } from "./agent/agent-session-runtime";
import { _setSessionsRepoForTests, createPaneSession, defaultSessionsDir } from "./agent/sessions";
import type { AgentMessage } from "./agent/types";
import { getModel } from "./ai";
import { buildAgentHarnessHost } from "./agent/harness-factory";
import { RpcApi } from "../frontend/app/store/wshclientapi";

function user(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function assistant(text: string): AgentMessage {
    return { role: "assistant", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function makeHarnessHostMock() {
    const model = { provider: "p", id: "m", api: "openai" };
    return {
        harness: {
            subscribe: vi.fn(() => () => {}),
            isIdle: vi.fn(() => true),
            abort: vi.fn(async () => {}),
            getModel: vi.fn(() => model),
            setModel: vi.fn(async () => {}),
            getThinkingLevel: vi.fn(() => "off"),
            setThinkingLevel: vi.fn(async () => {}),
        },
        session: {
            buildContext: vi.fn(async () => ({ messages: [] })),
            getBranch: vi.fn(async () => []),
        },
        update: vi.fn(),
        setAuthResolver: vi.fn(),
        setToolCallHook: vi.fn(),
        resolveAuth: vi.fn(),
        runToolCallHook: vi.fn(),
    };
}

describe("agent-ipc command helpers", () => {
    let tmpConfigHome: string;
    let previousConfigHome: string | undefined;

    beforeEach(async () => {
        vi.mocked(electron.ipcMain.handle).mockClear();
        vi.mocked(electron.ipcMain.on).mockClear();
        _resetAgentIpcForTests();
        previousConfigHome = process.env.WAVETERM_CONFIG_HOME;
        tmpConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-ipc-test-"));
        process.env.WAVETERM_CONFIG_HOME = tmpConfigHome;
        _setSessionsRepoForTests(new SqliteSessionRepo({ sessionsRoot: defaultSessionsDir() }));
    });

    afterEach(async () => {
        _setSessionsRepoForTests(undefined);
        if (previousConfigHome === undefined) {
            delete process.env.WAVETERM_CONFIG_HOME;
        } else {
            process.env.WAVETERM_CONFIG_HOME = previousConfigHome;
        }
        await fs.rm(tmpConfigHome, { recursive: true, force: true });
    });

    it("lists built-in command metadata", () => {
        const names = listAgentCommandsForIpc().map((command) => command.name);

        expect(names).toContain("tree");
        expect(names).toContain("fork");
        expect(names).toContain("clone");
    });

    it("lists persisted tree entries and fork points", async () => {
        const { metadata, session } = await createPaneSession("/tmp/agent-ipc-tree");
        const firstId = await session.appendMessage(user("first question"));
        await session.appendMessage(assistant("first answer"));

        const tree = await listAgentTreeForIpc(metadata);
        const forkPoints = await listAgentForkPointsForIpc(metadata);

        expect(tree.leafId).not.toBeNull();
        expect(tree.entries).toEqual([
            expect.objectContaining({ id: firstId, preview: "first question", role: "user", isCurrent: false }),
            expect.objectContaining({ preview: "first answer", role: "assistant", isCurrent: true }),
        ]);
        expect(forkPoints).toEqual([expect.objectContaining({ entryId: firstId, preview: "first question" })]);
    });

    it("forks before a user message and clones the current branch", async () => {
        const { metadata, session } = await createPaneSession("/tmp/agent-ipc-fork");
        await session.appendMessage(user("keep this"));
        const forkPointId = await session.appendMessage(user("fork target"));

        const forked = await forkAgentSessionForIpc({
            sessionMetadata: metadata,
            cwd: "/tmp/agent-ipc-fork-alt",
            entryId: forkPointId,
        });
        const cloned = await cloneAgentSessionForIpc({ sessionMetadata: metadata, cwd: "/tmp/agent-ipc-clone-alt" });
        const canonicalSourcePath = await fs.realpath(metadata.path);

        expect(forked.sessionMetadata.parentSessionPath).toBe(canonicalSourcePath);
        expect(forked.sessionMetadata.cwd).toBe("/tmp/agent-ipc-fork-alt");
        expect(forked.selectedText).toBe("fork target");
        expect(cloned.sessionMetadata?.parentSessionPath).toBe(canonicalSourcePath);
        expect(cloned.sessionMetadata?.cwd).toBe("/tmp/agent-ipc-clone-alt");
        expect((await listAgentTreeForIpc(forked.sessionMetadata)).entries.map((entry) => entry.preview)).toEqual([
            "keep this",
        ]);
        expect((await listAgentTreeForIpc(cloned.sessionMetadata!)).entries.map((entry) => entry.preview)).toEqual([
            "keep this",
            "fork target",
        ]);
    });

    it("clone is a no-op when the source session has no leaf", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-empty");

        const cloned = await cloneAgentSessionForIpc({ sessionMetadata: metadata, cwd: "/tmp/agent-ipc-empty-clone" });

        expect(cloned.sessionMetadata).toBeUndefined();
        expect(cloned.message).toContain("No session branch");
        await expect((await listAgentTreeForIpc(metadata)).entries).toEqual([]);
    });

    it("rejects malformed metadata and paths outside the sessions directory", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-valid");
        const outside = path.join(tmpConfigHome, "outside.jsonl");
        await fs.writeFile(
            outside,
            JSON.stringify({
                type: "session",
                version: 3,
                id: "evil",
                timestamp: new Date().toISOString(),
                cwd: "/tmp",
            }) + "\n"
        );

        await expect(listAgentTreeForIpc({ ...metadata, path: "" })).rejects.toThrow(/sessionMetadata\.path/);
        await expect(listAgentTreeForIpc({ ...metadata, cwd: "" })).rejects.toThrow(/sessionMetadata\.cwd/);
        await expect(listAgentTreeForIpc({ ...metadata, path: outside })).rejects.toThrow(/outside sessions directory/);
        await expect(forkAgentSessionForIpc({ sessionMetadata: metadata, cwd: "", entryId: "x" })).rejects.toThrow(
            /cwd/
        );
    });

    it("opens disk metadata instead of trusting spoofed metadata", async () => {
        const { metadata, session } = await createPaneSession("/tmp/agent-ipc-real");
        await session.appendMessage(user("real branch"));
        const forked = await cloneAgentSessionForIpc({
            sessionMetadata: { ...metadata, cwd: "/tmp/spoofed-source-cwd", id: "spoofed" },
            cwd: "/tmp/agent-ipc-cloned-from-real",
        });

        expect(forked.sessionMetadata?.parentSessionPath).toBe(await fs.realpath(metadata.path));
        expect((await listAgentTreeForIpc(forked.sessionMetadata!)).entries.map((entry) => entry.preview)).toEqual([
            "real branch",
        ]);
    });

    it("rejects fork targets that do not belong to the source session", async () => {
        const { metadata: first, session: firstSession } = await createPaneSession("/tmp/agent-ipc-first");
        await firstSession.appendMessage(user("first"));

        await expect(
            forkAgentSessionForIpc({
                sessionMetadata: first,
                cwd: "/tmp/agent-ipc-first-fork",
                entryId: "not-in-this-session",
            })
        ).rejects.toThrow(/does not belong/);
        await expect(
            forkAgentSessionForIpc({ sessionMetadata: first, cwd: "/tmp/agent-ipc-first-fork", entryId: "" })
        ).rejects.toThrow(/entryId/);
    });

    it("rejects malicious input through registered IPC handlers", async () => {
        const { metadata, session } = await createPaneSession("/tmp/agent-ipc-handler");
        await session.appendMessage(user("handler branch"));
        const outside = path.join(tmpConfigHome, "outside-handler.jsonl");
        await fs.writeFile(
            outside,
            JSON.stringify({
                type: "session",
                version: 3,
                id: "evil",
                timestamp: new Date().toISOString(),
                cwd: "/tmp",
            }) + "\n"
        );
        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }

        await expect(handlers.get("agent:list-tree")?.({}, { ...metadata, path: outside })).rejects.toThrow(
            /outside sessions directory/
        );
        await expect(
            handlers.get("agent:fork-session")?.({}, { sessionMetadata: metadata, cwd: "/tmp/fork", entryId: "" })
        ).rejects.toThrow(/entryId/);
        await expect(handlers.get("agent:clone-session")?.({}, { sessionMetadata: metadata, cwd: "" })).rejects.toThrow(
            /cwd/
        );
    });

    it("registers and runs generic agent commands", async () => {
        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }

        await expect(runAgentCommandForIpc({ command: "reload", cwd: "/tmp", argsText: "" })).resolves.toEqual({
            status: "success",
            message: "Reloaded keybindings, extensions, skills, prompts, themes",
        });
        await expect(
            handlers.get("agent:run-command")?.({}, { command: "compact", cwd: "/tmp", argsText: "keep errors" })
        ).resolves.toEqual({
            status: "noop",
            message: "No active agent session to compact.",
        });
    });

    it("signals a new agent session from /new without minting one (lazy creation)", async () => {
        const result = await runAgentCommandForIpc({ command: "new", cwd: "/tmp/agent-ipc-new", argsText: "" });

        // /new only resets the pane; the session is lazily created on the
        // next prompt, so no sessionMetadata is returned by design.
        expect(result).toEqual({
            status: "success",
            message: "New session started",
        });
    });

    it("shows current session information from /session", async () => {
        const { metadata, session } = await createPaneSession("/tmp/agent-ipc-session-info");
        await session.appendMessage(user("session question"));
        await session.appendMessage(assistant("session answer"));

        const result = await runAgentCommandForIpc({
            command: "session",
            cwd: metadata.cwd,
            sessionMetadata: metadata,
            argsText: "",
        });

        expect(result.message).toContain("Session Info");
        expect(result.message).toContain(path.basename(metadata.path));
        expect(result.message).toContain(`ID: ${metadata.id}`);
        expect(result.message).toContain("User: 1");
        expect(result.message).toContain("Assistant: 1");
    });

    it("copies the latest assistant message from /copy", async () => {
        const { metadata, session } = await createPaneSession("/tmp/agent-ipc-copy");
        await session.appendMessage(user("copy question"));
        await session.appendMessage(assistant("copy this answer"));

        const result = await runAgentCommandForIpc({
            command: "copy",
            cwd: metadata.cwd,
            sessionMetadata: metadata,
            argsText: "",
        });

        expect(result).toEqual({ status: "success", message: "Copied last agent message to clipboard" });
        expect(electron.clipboard.writeText).toHaveBeenCalledWith("copy this answer");
    });

    it("returns a friendly no-op when /copy has no assistant message", async () => {
        const { metadata, session } = await createPaneSession("/tmp/agent-ipc-copy-empty");
        await session.appendMessage(user("copy question"));

        await expect(
            runAgentCommandForIpc({ command: "copy", cwd: metadata.cwd, sessionMetadata: metadata, argsText: "" })
        ).resolves.toEqual({
            status: "noop",
            message: "No agent messages to copy yet.",
        });
    });

    it("exports the current session branch as a Pi-compatible JSONL file", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-export-cwd-"));
        const { metadata, session } = await createPaneSession(cwd);
        await session.appendMessage(user("export question"));
        const leafId = await session.appendMessage(assistant("export answer"));
        await session.appendMessage(user("side branch"));
        await session.moveTo(leafId);
        const outputPath = path.join(cwd, "quoted export.jsonl");

        const result = await runAgentCommandForIpc({
            command: "export",
            cwd,
            sessionMetadata: metadata,
            argsText: `"${outputPath}"`,
        });
        const exported = await fs.readFile(outputPath, "utf8");
        const lines = exported
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));

        expect(result).toEqual({ status: "success", message: `Session exported to: ${outputPath}` });
        expect(lines[0]).toMatchObject({ type: "session", version: 3, id: metadata.id, cwd });
        expect(lines.slice(1).map((line) => line.message?.content?.[0]?.text)).toEqual([
            "export question",
            "export answer",
        ]);
        expect(lines[1].parentId).toBeNull();
        expect(lines[2].parentId).toBe(lines[1].id);
    });

    it("exports to a default JSONL path when /export has no argument", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-export-default-cwd-"));
        const { metadata, session } = await createPaneSession(cwd);
        await session.appendMessage(user("default export"));

        const result = await runAgentCommandForIpc({ command: "export", cwd, sessionMetadata: metadata, argsText: "" });

        expect(result.status).toBe("success");
        expect(result.message).toMatch(
            new RegExp(`^Session exported to: ${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/session-.*\\.jsonl$`)
        );
    });

    it("requires an import path", async () => {
        await expect(runAgentCommandForIpc({ command: "import", cwd: "/tmp", argsText: "" })).rejects.toThrow(
            "Usage: /import <path.jsonl>"
        );
    });

    it("imports a quoted JSONL path and returns imported session metadata", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-import-cwd-"));
        const sourcePath = path.join(cwd, "session with spaces.jsonl");
        await fs.writeFile(
            sourcePath,
            [
                JSON.stringify({
                    type: "session",
                    version: 3,
                    id: "imported-id",
                    timestamp: new Date().toISOString(),
                    cwd,
                }),
                JSON.stringify({
                    type: "message",
                    id: "entry-1",
                    parentId: null,
                    timestamp: new Date().toISOString(),
                    message: user("imported question"),
                }),
                "",
            ].join("\n")
        );

        const result = await runAgentCommandForIpc({ command: "import", cwd, argsText: `"${sourcePath}"` });

        expect(result).toMatchObject({
            status: "success",
            message: `Session imported from: ${sourcePath}`,
            sessionMetadata: expect.objectContaining({ id: "imported-id", cwd }),
        });
        expect(result.sessionMetadata?.path).not.toBe(sourcePath);
        await expect(listAgentTreeForIpc(result.sessionMetadata)).resolves.toMatchObject({
            entries: [expect.objectContaining({ preview: "imported question" })],
        });
    });

    it("sends persisted session_state using the renderer subscription path", async () => {
        const { metadata, session } = await createPaneSession("/tmp/agent-ipc-subscribe-alias");
        await session.appendMessage(user("restore after refresh"));
        const dir = path.dirname(metadata.path);
        const aliasPath = `${dir}${path.sep}..${path.sep}${path.basename(dir)}${path.sep}${path.basename(metadata.path)}`;
        expect(await fs.realpath(aliasPath)).toBe(await fs.realpath(metadata.path));
        expect(aliasPath).not.toBe(metadata.path);
        const sender = {
            id: 2,
            isDestroyed: vi.fn(() => false),
            once: vi.fn(),
            send: vi.fn(),
        } as unknown as electron.WebContents;

        await subscribeAgentSessionForIpc(sender, aliasPath);

        expect(sender.send).toHaveBeenCalledWith(
            "agent:event",
            expect.objectContaining({
                sessionPath: aliasPath,
                event: expect.objectContaining({
                    type: "session_state",
                    messages: expect.arrayContaining([
                        expect.objectContaining({
                            role: "user",
                            content: [expect.objectContaining({ text: "restore after refresh" })],
                        }),
                    ]),
                    turns: expect.arrayContaining([expect.objectContaining({ turnId: expect.any(String) })]),
                }),
            })
        );
    });

    it("rejects forged paths for send existing sessions and subscription helpers", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-old-paths");
        const outside = path.join(tmpConfigHome, "outside-old-paths.jsonl");
        await fs.writeFile(
            outside,
            JSON.stringify({
                type: "session",
                version: 3,
                id: "evil",
                timestamp: new Date().toISOString(),
                cwd: "/tmp",
            }) + "\n"
        );
        const sender = {
            id: 1,
            isDestroyed: vi.fn(() => false),
            once: vi.fn(),
            send: vi.fn(),
        } as unknown as electron.WebContents;

        registerAgentIpcHandlers();
        const handleHandlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handleHandlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const onHandlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.on).mock.calls) {
            onHandlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        await expect(
            handleHandlers.get("agent:send")?.(
                {},
                {
                    sessionMetadata: { ...metadata, path: outside },
                    blockId: "block-1",
                    cwd: "/tmp/agent-ipc-old-paths",
                    text: "hello",
                    provider: "provider",
                    model: "model",
                }
            )
        ).rejects.toThrow(/outside sessions directory/);
        await expect(subscribeAgentSessionForIpc(sender, outside)).rejects.toThrow(/outside sessions directory/);
        await expect(abortAgentSessionForIpc(outside)).rejects.toThrow(/outside sessions directory/);
        await expect(unsubscribeAgentSessionForIpc(1, outside)).rejects.toThrow(/outside sessions directory/);
        onHandlers.get("agent:subscribe")?.({ sender }, outside);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(errorSpy).toHaveBeenCalledWith(
            "[agent-ipc] subscribe validation error:",
            expect.objectContaining({ message: expect.stringMatching(/outside sessions directory/) })
        );
        errorSpy.mockRestore();
        expect(sender.send).not.toHaveBeenCalled();
    });

    it("agent:send returns the committed turn id without writing a legacy marker", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-send");
        // Stub the harness build so ensureAgentRuntime constructs a real
        // AgentSessionRuntime without a live model/provider.
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-xyz");

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }

        const result = (await handlers.get("agent:send")?.(
            {},
            {
                sessionMetadata: metadata,
                blockId: "block-1",
                cwd: "/tmp/agent-ipc-send",
                text: "hello",
                provider: "p",
                model: "m",
            }
        )) as { sessionMetadata: unknown; turnId: string };

        expect(sendConfiguredSpy).toHaveBeenCalledWith(
            "hello",
            expect.objectContaining({
                model: expect.objectContaining({ id: "m" }),
                thinkingLevel: "off",
            })
        );
        expect(result.turnId).toBe("entry-xyz");
        expect(vi.mocked(RpcApi.AppendAgentRunCommand)).not.toHaveBeenCalled();
        sendConfiguredSpy.mockRestore();
    });

    it("reuses one runtime and applies current execution config", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-config");
        vi.mocked(buildAgentHarnessHost).mockClear();
        vi.mocked(getModel)
            .mockReturnValueOnce({
                provider: "p",
                id: "m1",
                api: "openai",
                baseUrl: "http://one",
            } as never)
            .mockReturnValueOnce({
                provider: "p",
                id: "m2",
                api: "openai",
                baseUrl: "http://two",
            } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValueOnce("entry-1")
            .mockResolvedValueOnce("entry-2");

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const sendHandler = handlers.get("agent:send");
        const base = {
            sessionMetadata: metadata,
            blockId: "block-1",
            cwd: "/tmp/agent-ipc-config",
            provider: "p",
        };

        try {
            await sendHandler?.({}, { ...base, text: "first", model: "m1", reasoning: "low" });
            await sendHandler?.({}, { ...base, text: "second", model: "m2", reasoning: "high" });

            expect(buildAgentHarnessHost).toHaveBeenCalledTimes(1);
            expect(sendConfiguredSpy).toHaveBeenNthCalledWith(
                2,
                "second",
                expect.objectContaining({
                    model: expect.objectContaining({ id: "m2" }),
                    thinkingLevel: "high",
                    promptInputs: expect.objectContaining({ cwd: "/tmp/agent-ipc-config" }),
                })
            );
        } finally {
            sendConfiguredSpy.mockRestore();
        }
    });

    it("keeps a subscribed runtime alive until release and the idle TTL expires", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-subscribed-runtime");
        vi.useFakeTimers();
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const disposeSpy = vi.spyOn(AgentSessionRuntime.prototype, "dispose");
        const sender = {
            id: 11,
            isDestroyed: vi.fn(() => false),
            once: vi.fn(),
            send: vi.fn(),
        } as unknown as electron.WebContents;

        try {
            registerAgentIpcHandlers();
            const handlers = new Map<string, (...args: unknown[]) => unknown>();
            for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
                handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
            }
            await handlers.get("agent:send")?.(
                {},
                {
                    sessionMetadata: metadata,
                    blockId: "block-1",
                    cwd: metadata.cwd,
                    text: "first",
                    provider: "p",
                    model: "m",
                }
            );
            await subscribeAgentSessionForIpc(sender, metadata.path);

            await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
            expect(disposeSpy).not.toHaveBeenCalled();

            await unsubscribeAgentSessionForIpc(sender.id, metadata.path);
            await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
            expect(disposeSpy).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(60 * 1000);
            expect(disposeSpy).toHaveBeenCalledOnce();
        } finally {
            _resetAgentIpcForTests();
            vi.useRealTimers();
            sendConfiguredSpy.mockRestore();
            disposeSpy.mockRestore();
        }
    });

    it("releases a runtime subscription when its sender is destroyed", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-destroyed-sender");
        vi.useFakeTimers();
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const disposeSpy = vi.spyOn(AgentSessionRuntime.prototype, "dispose");
        let onDestroyed: (() => void) | undefined;
        const sender = {
            id: 12,
            isDestroyed: vi.fn(() => false),
            once: vi.fn((_eventName: string, listener: () => void) => {
                onDestroyed = listener;
            }),
            send: vi.fn(),
        } as unknown as electron.WebContents;

        try {
            registerAgentIpcHandlers();
            const handlers = new Map<string, (...args: unknown[]) => unknown>();
            for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
                handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
            }
            await handlers.get("agent:send")?.(
                {},
                {
                    sessionMetadata: metadata,
                    blockId: "block-1",
                    cwd: metadata.cwd,
                    text: "first",
                    provider: "p",
                    model: "m",
                }
            );
            await subscribeAgentSessionForIpc(sender, metadata.path);

            onDestroyed?.();
            await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

            expect(disposeSpy).toHaveBeenCalledOnce();
        } finally {
            _resetAgentIpcForTests();
            vi.useRealTimers();
            sendConfiguredSpy.mockRestore();
            disposeSpy.mockRestore();
        }
    });

    it("does not retain a runtime for a sender destroyed before subscription attaches", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-pre-destroyed-sender");
        vi.useFakeTimers();
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const disposeSpy = vi.spyOn(AgentSessionRuntime.prototype, "dispose");
        const sender = {
            id: 13,
            isDestroyed: vi.fn(() => true),
            once: vi.fn(),
            send: vi.fn(),
        } as unknown as electron.WebContents;

        try {
            registerAgentIpcHandlers();
            const handlers = new Map<string, (...args: unknown[]) => unknown>();
            for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
                handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
            }
            await handlers.get("agent:send")?.(
                {},
                {
                    sessionMetadata: metadata,
                    blockId: "block-1",
                    cwd: metadata.cwd,
                    text: "first",
                    provider: "p",
                    model: "m",
                }
            );

            await subscribeAgentSessionForIpc(sender, metadata.path);
            await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

            expect(sender.once).not.toHaveBeenCalled();
            expect(disposeSpy).toHaveBeenCalledOnce();
        } finally {
            _resetAgentIpcForTests();
            vi.useRealTimers();
            sendConfiguredSpy.mockRestore();
            disposeSpy.mockRestore();
        }
    });

    it("starts only one runtime sweep timer", () => {
        vi.useFakeTimers();
        try {
            registerAgentIpcHandlers();
            registerAgentIpcHandlers();

            expect(vi.getTimerCount()).toBe(1);
        } finally {
            _resetAgentIpcForTests();
            vi.useRealTimers();
        }
    });
});
