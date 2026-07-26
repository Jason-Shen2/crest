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
    contextBridge: { exposeInMainWorld: vi.fn() },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    ipcRenderer: {
        invoke: vi.fn(),
        on: vi.fn(),
        send: vi.fn(),
        sendSync: vi.fn(),
    },
    safeStorage: {
        decryptString: vi.fn(),
        isEncryptionAvailable: vi.fn(() => true),
    },
    shell: { openExternal: vi.fn() },
    webUtils: { getPathForFile: vi.fn() },
}));

vi.mock("@crest/ai", () => ({ getModel: vi.fn() }));
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

import { RpcApi } from "../frontend/app/store/wshclientapi";
import {
    _resetAgentIpcForTests,
    _setContextProviderAdapterFactoryForTests,
    _setContextSummaryCompletionForTests,
    abortAgentSessionForIpc,
    cloneAgentSessionForIpc,
    discardContextDraftForIpc,
    forkAgentSessionForIpc,
    listAgentCommandsForIpc,
    listAgentForkPointsForIpc,
    listAgentReferencePointsForIpc,
    listAgentTreeForIpc,
    listContextStateForIpc,
    prepareContextDraftForIpc,
    registerAgentIpcHandlers,
    runAgentCommandForIpc,
    subscribeAgentSessionForIpc,
    summarizeContextDraftForIpc,
    unsubscribeAgentSessionForIpc,
} from "./agent-ipc";
import { AgentSessionRuntime } from "./agent/agent-session-runtime";
import { foldContextJournal } from "./agent/context/journal";
import { ContextReferenceError } from "./agent/context/types";
import { buildAgentHarnessHost } from "./agent/harness-factory";
import { makeCommittedContextTransaction } from "./agent/harness/session/context-transaction-fixture";
import { Session } from "./agent/harness/session/session";
import { SqliteSessionRepo } from "./agent/harness/session/sqlite-repo";
import { _setSessionsRepoForTests, createPaneSession, defaultSessionsDir, openPaneSession } from "./agent/sessions";
import type { AgentMessage } from "./agent/types";
import { getModel } from "@crest/ai";

function user(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function assistant(text: string): AgentMessage {
    return { role: "assistant", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

async function writeAiConfig(config: Record<string, unknown> = {}): Promise<void> {
    await fs.writeFile(
        path.join(process.env.WAVETERM_CONFIG_HOME!, "ai.json"),
        JSON.stringify({
            providers: { p: { token: "test" } },
            default: { provider: "p", model: "m" },
            ...config,
        })
    );
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
            createTurnPreparationSnapshot: vi.fn(async (text: string) => ({
                userMessage: user(text) as never,
                systemPrompt: "base",
                messages: [user(text)],
                model,
                activeTools: [],
                transformProviderRequest: async () => ({}),
                transformContextMessages: async (messages: AgentMessage[]) => messages,
                transformProviderPayload: async (payload: unknown) => payload,
            })),
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

function installContextTestAdapter(): void {
    _setContextProviderAdapterFactoryForTests(() => ({
        preparePayload: vi.fn(async ({ request, maxOutputTokens }) => ({ ...request, maxOutputTokens })),
        tokenCounter: {
            countFinalRequest: vi.fn(async ({ payload }) => ({
                inputTokens: JSON.stringify(payload).length,
                accuracy: "exact" as const,
            })),
            countContextOverlay: vi.fn(async ({ overlay }) => ({
                inputTokens: overlay.length,
                accuracy: "exact" as const,
            })),
        },
    }));
}

function unwrapIpcHandler(handler: (...args: unknown[]) => unknown): (...args: unknown[]) => Promise<unknown> {
    return async (...args: unknown[]) => {
        const result = await handler(...args);
        if (result != null && typeof result === "object" && "ok" in result) {
            const envelope = result as
                | { ok: true; value: unknown }
                | {
                      ok: false;
                      error:
                          | { kind: "context"; code: string; message: string; budget?: unknown }
                          | { kind: "generic"; message: string };
                  };
            if ("value" in envelope) return envelope.value;
            const error = new Error(envelope.error.message);
            if (envelope.error.kind === "context") Object.assign(error, envelope.error);
            throw error;
        }
        return result;
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

    it("opens the session manager from /session and the hidden /resume alias", async () => {
        await expect(
            runAgentCommandForIpc({ command: "session", cwd: "/tmp/agent-ipc-session-manager", argsText: "" })
        ).resolves.toEqual({
            status: "success",
            message: "Open session manager",
            managerMode: "session",
        });
        await expect(
            runAgentCommandForIpc({ command: "resume", cwd: "/tmp/agent-ipc-session-manager", argsText: "" })
        ).resolves.toEqual({
            status: "success",
            message: "Open session manager",
            managerMode: "session",
        });
    });

    it("shows current session information from /info", async () => {
        const { metadata, session } = await createPaneSession("/tmp/agent-ipc-session-info");
        await session.appendMessage(user("session question"));
        await session.appendMessage(assistant("session answer"));

        const result = await runAgentCommandForIpc({
            command: "info",
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

    it("preserves committed context transactions through /export and /import", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-context-roundtrip-"));
        const { metadata, session } = await createPaneSession(cwd);
        const transaction = makeCommittedContextTransaction();
        await session.appendEntries(transaction);
        const outputPath = path.join(cwd, "context.jsonl");

        await runAgentCommandForIpc({ command: "export", cwd, sessionMetadata: metadata, argsText: `"${outputPath}"` });
        const result = await runAgentCommandForIpc({ command: "import", cwd, argsText: `"${outputPath}"` });

        const exportedEntries = (await fs.readFile(outputPath, "utf8"))
            .trim()
            .split("\n")
            .slice(1)
            .map((line) => JSON.parse(line));
        const imported = await openPaneSession(result.sessionMetadata!);
        const tree = await listAgentTreeForIpc(result.sessionMetadata);

        expect(exportedEntries).toEqual(transaction);
        expect(await imported.getEntries()).toEqual(transaction);
        expect(
            foldContextJournal(await imported.getEntries())
                .attachmentsForTurn("context-user")
                .map((attachment) => attachment.attachmentEntryId)
        ).toEqual([transaction[1]!.id]);
        expect(tree.entries.map((entry) => ({ id: entry.id, preview: entry.preview, role: entry.role }))).toEqual([
            { id: transaction.at(-1)!.id, preview: "contextual question", role: "user" },
        ]);
    });

    it("keeps incomplete context transactions out of pane import, tree, and export", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-incomplete-context-"));
        const inputPath = path.join(cwd, "incomplete.jsonl");
        const incomplete = makeCommittedContextTransaction().filter((entry) => entry.id !== "context-manifest");
        await fs.writeFile(
            inputPath,
            `${JSON.stringify({ type: "session", version: 3, id: "incomplete", timestamp: new Date().toISOString(), cwd })}\n${incomplete.map((entry) => JSON.stringify(entry)).join("\n")}\n`
        );

        const result = await runAgentCommandForIpc({ command: "import", cwd, argsText: `"${inputPath}"` });
        const outputPath = path.join(cwd, "re-export.jsonl");
        await runAgentCommandForIpc({
            command: "export",
            cwd,
            sessionMetadata: result.sessionMetadata,
            argsText: `"${outputPath}"`,
        });

        expect(await listAgentTreeForIpc(result.sessionMetadata)).toEqual({ entries: [], leafId: null });
        await expect((await openPaneSession(result.sessionMetadata!)).getEntries()).resolves.toEqual([]);
        expect((await fs.readFile(outputPath, "utf8")).trim().split("\n")).toHaveLength(1);
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
                    contextReports: [],
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
            handleHandlers.set(call[0], unwrapIpcHandler(call[1] as (...args: unknown[]) => unknown));
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
        await vi.waitFor(() => {
            expect(errorSpy).toHaveBeenCalledWith(
                "[agent-ipc] subscribe validation error:",
                expect.objectContaining({ message: expect.stringMatching(/outside sessions directory/) })
            );
        });
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
            handlers.set(call[0], unwrapIpcHandler(call[1] as (...args: unknown[]) => unknown));
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
            }),
            expect.objectContaining({ activatePreparation: expect.any(Function) })
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
            handlers.set(call[0], unwrapIpcHandler(call[1] as (...args: unknown[]) => unknown));
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
            expect(buildAgentHarnessHost).toHaveBeenCalledWith(
                expect.objectContaining({ transformSessionContext: expect.any(Function) })
            );
            expect(sendConfiguredSpy).toHaveBeenNthCalledWith(
                2,
                "second",
                expect.objectContaining({
                    model: expect.objectContaining({ id: "m2" }),
                    thinkingLevel: "high",
                    promptInputs: expect.objectContaining({ cwd: "/tmp/agent-ipc-config" }),
                }),
                expect.objectContaining({ activatePreparation: expect.any(Function) })
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
                handlers.set(call[0], unwrapIpcHandler(call[1] as (...args: unknown[]) => unknown));
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
                handlers.set(call[0], unwrapIpcHandler(call[1] as (...args: unknown[]) => unknown));
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
                handlers.set(call[0], unwrapIpcHandler(call[1] as (...args: unknown[]) => unknown));
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

    it("registers the complete context-reference IPC surface", () => {
        registerAgentIpcHandlers();
        const names = vi.mocked(electron.ipcMain.handle).mock.calls.map(([name]) => name);

        expect(names).toEqual(
            expect.arrayContaining([
                "agent:prepare-context-draft",
                "agent:summarize-context-draft",
                "agent:discard-context-draft",
                "agent:list-reference-points",
                "agent:list-context-state",
            ])
        );
        expect(names).not.toEqual(
            expect.arrayContaining([
                "agent:summarize-context-pin",
                "agent:preview-context-budget",
                "agent:update-context-pin",
                "agent:detach-context-pin",
            ])
        );
    });

    it("keeps the preload context surface in lockstep with registered main handlers", async () => {
        registerAgentIpcHandlers();
        await import("./preload");
        const exposeCall = vi
            .mocked(electron.contextBridge.exposeInMainWorld)
            .mock.calls.find(([name]) => name === "api");
        const agent = (exposeCall?.[1] as { agent?: Record<string, (input: unknown) => Promise<unknown>> })?.agent;
        expect(agent).toBeDefined();
        const inputs = {
            prepareContextDraft: {
                targetSessionPath: "/managed/target.db",
                sourceSessionPath: "/managed/source.db",
                sourceKind: "turn",
                sourceTurnId: "turn",
            },
            summarizeContextDraft: { targetSessionPath: "/managed/target.db", draftId: "draft" },
            discardContextDraft: { targetSessionPath: "/managed/target.db", draftId: "draft" },
            listReferencePoints: { sourceSessionPath: "/managed/source.db" },
            listContextState: { targetSessionPath: "/managed/target.db" },
        };
        const channelByMethod = {
            prepareContextDraft: "agent:prepare-context-draft",
            summarizeContextDraft: "agent:summarize-context-draft",
            discardContextDraft: "agent:discard-context-draft",
            listReferencePoints: "agent:list-reference-points",
            listContextState: "agent:list-context-state",
        } as const;
        vi.mocked(electron.ipcRenderer.invoke).mockResolvedValue({ ok: true, value: undefined });
        for (const [method, channel] of Object.entries(channelByMethod)) {
            const input = inputs[method as keyof typeof inputs];
            await agent![method]!(input);
            expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(channel, input);
            expect(vi.mocked(electron.ipcMain.handle).mock.calls.some(([registered]) => registered === channel)).toBe(
                true
            );
        }

        expect(agent).not.toHaveProperty("summarizeContextPin");
        expect(agent).not.toHaveProperty("previewContextBudget");
        expect(agent).not.toHaveProperty("updateContextPin");
        expect(agent).not.toHaveProperty("detachContextPin");
        vi.mocked(electron.ipcRenderer.invoke).mockResolvedValueOnce({
            ok: false,
            error: { kind: "generic", message: "storage exploded" },
        });
        const genericError = await agent!.listContextState!(inputs.listContextState).catch((error) => error);
        expect(genericError).toBeInstanceOf(Error);
        expect(genericError).toMatchObject({ name: "Error", message: "storage exploded" });
        expect(genericError).not.toHaveProperty("code");

        const prepareHandler = vi
            .mocked(electron.ipcMain.handle)
            .mock.calls.find(([registered]) => registered === "agent:prepare-context-draft")![1];
        await expect(prepareHandler({} as never, {})).resolves.toMatchObject({
            ok: false,
            error: { kind: "context", code: "disabled", message: expect.any(String) },
        });
    });

    it("captures only active-branch user roots and returns lightweight draft state", async () => {
        await writeAiConfig();
        const { metadata: source, session: sourceSession } = await createPaneSession("/tmp/context-source");
        await sourceSession.appendSessionName("Source investigation");
        const rootId = await sourceSession.appendMessage(user("source root"));
        await sourceSession.appendMessage(assistant("source answer"));
        const abandonedId = await sourceSession.appendMessage(user("abandoned turn"));
        await sourceSession.moveTo(rootId);
        const activeId = await sourceSession.appendMessage(user("active turn"));
        const { metadata: target } = await createPaneSession("/tmp/context-target");
        const sourcePath = await fs.realpath(source.path);
        const targetPath = await fs.realpath(target.path);

        const points = await listAgentReferencePointsForIpc({ sourceSessionPath: sourcePath });
        registerAgentIpcHandlers();
        const referencePointsHandler = vi
            .mocked(electron.ipcMain.handle)
            .mock.calls.find(([channel]) => channel === "agent:list-reference-points")![1];
        const referencePointsEnvelope = await referencePointsHandler({} as never, { sourceSessionPath: sourcePath });
        const draft = await prepareContextDraftForIpc({
            targetSessionPath: targetPath,
            sourceSessionPath: sourcePath,
            sourceKind: "turn",
            sourceTurnId: activeId,
        });
        const state = await listContextStateForIpc({ targetSessionPath: targetPath });

        expect(points.map((point) => point.entryId)).toEqual([rootId, activeId]);
        expect(points.some((point) => point.entryId === abandonedId)).toBe(false);
        expect(referencePointsEnvelope).toEqual({ ok: true, value: points });
        expect(draft).toMatchObject({
            targetSessionPath: await fs.realpath(target.path),
            provenance: {
                sourceSessionTitle: "Source investigation",
                sourceTurnId: activeId,
                preview: "active turn",
            },
            summaryStatus: "none",
        });
        expect(draft).not.toHaveProperty("artifact");
        expect(state.drafts).toEqual([
            expect.objectContaining({ draftId: draft.draftId, provenance: draft.provenance }),
        ]);
        expect(state.contextReports).toEqual([]);
        expect(JSON.stringify(state)).not.toContain("messages");
    });

    it("rejects renderer artifacts, disabled mutations, and cross-target discard while keeping read state", async () => {
        await writeAiConfig();
        const { metadata: source, session: sourceSession } = await createPaneSession("/tmp/context-source-ownership");
        const sourceTurnId = await sourceSession.appendMessage(user("source"));
        const { metadata: firstTarget } = await createPaneSession("/tmp/context-target-one");
        const { metadata: secondTarget } = await createPaneSession("/tmp/context-target-two");
        const sourcePath = await fs.realpath(source.path);
        const firstTargetPath = await fs.realpath(firstTarget.path);
        const secondTargetPath = await fs.realpath(secondTarget.path);
        const outsideContextPath = path.join(tmpConfigHome, "outside-context.db");
        await fs.writeFile(outsideContextPath, "");
        await expect(
            listContextStateForIpc({ targetSessionPath: path.join(path.dirname(firstTargetPath), "missing.db") })
        ).rejects.toMatchObject({ code: "source_not_found" });
        await expect(listContextStateForIpc({ targetSessionPath: outsideContextPath })).rejects.toMatchObject({
            code: "invalid_input",
        });
        await expect(
            prepareContextDraftForIpc({
                targetSessionPath: firstTargetPath,
                sourceSessionPath: sourcePath,
                sourceKind: "turn",
                sourceTurnId,
                artifact: { messages: [{ role: "user", content: "injected" }] },
            })
        ).rejects.toMatchObject({ code: "invalid_input" });
        const draft = await prepareContextDraftForIpc({
            targetSessionPath: firstTargetPath,
            sourceSessionPath: sourcePath,
            sourceKind: "turn",
            sourceTurnId,
        });

        await expect(
            discardContextDraftForIpc({ targetSessionPath: secondTargetPath, draftId: draft.draftId })
        ).rejects.toMatchObject({ code: "invalid_input" });
        await writeAiConfig({ context_references: { enabled: false } });
        await expect(
            prepareContextDraftForIpc({
                targetSessionPath: firstTargetPath,
                sourceSessionPath: sourcePath,
                sourceKind: "turn",
                sourceTurnId,
            })
        ).rejects.toEqual(expect.objectContaining<Partial<ContextReferenceError>>({ code: "disabled" }));
        await expect(listContextStateForIpc({ targetSessionPath: firstTargetPath })).resolves.toMatchObject({
            drafts: [expect.objectContaining({ draftId: draft.draftId })],
        });
        await expect(
            discardContextDraftForIpc({ targetSessionPath: firstTargetPath, draftId: draft.draftId })
        ).resolves.toEqual({ discarded: true });
        await expect(
            discardContextDraftForIpc({ targetSessionPath: firstTargetPath, draftId: draft.draftId })
        ).resolves.toEqual({ discarded: false });
    });

    it("stores draft summaries only after success and preserves the previous summary on failure", async () => {
        await writeAiConfig();
        vi.mocked(getModel).mockReturnValue({
            provider: "p",
            id: "m",
            api: "openai",
            contextWindow: 128_000,
        } as never);
        const { metadata: source, session: sourceSession } = await createPaneSession("/tmp/context-summary-source");
        const sourceTurnId = await sourceSession.appendMessage(user("summarize this"));
        const { metadata: target } = await createPaneSession("/tmp/context-summary-target");
        const sourcePath = await fs.realpath(source.path);
        const targetPath = await fs.realpath(target.path);
        const draft = await prepareContextDraftForIpc({
            targetSessionPath: targetPath,
            sourceSessionPath: sourcePath,
            sourceKind: "turn",
            sourceTurnId,
        });
        _setContextSummaryCompletionForTests(
            async (model) =>
                ({
                    ...assistant("ready summary"),
                    api: model.api,
                    provider: model.provider,
                    model: model.id,
                    stopReason: "stop",
                    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
                }) as never
        );

        await expect(
            summarizeContextDraftForIpc({ targetSessionPath: targetPath, draftId: draft.draftId })
        ).resolves.toMatchObject({ summaryStatus: "ready" });
        _setContextSummaryCompletionForTests(async () => {
            throw new Error("provider down");
        });
        await expect(
            summarizeContextDraftForIpc({ targetSessionPath: targetPath, draftId: draft.draftId })
        ).rejects.toMatchObject({ code: "provider_error" });
        await expect(listContextStateForIpc({ targetSessionPath: targetPath })).resolves.toMatchObject({
            drafts: [expect.objectContaining({ draftId: draft.draftId, summaryStatus: "ready" })],
        });
    });

    it("allows unverified referenced sends while still rejecting disabled references", async () => {
        await writeAiConfig();
        vi.mocked(getModel).mockReturnValue({
            provider: "p",
            id: "m",
            api: "openai",
            contextWindow: 128_000,
            maxTokens: 4_096,
        } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockImplementation(async (text, config, options) => {
                const prepare = options?.prepare ?? (await options?.activatePreparation?.());
                expect(prepare).toEqual(expect.any(Function));
                const prepared = await prepare!({
                    userMessage: user(text) as never,
                    systemPrompt: "base",
                    messages: [user(text)],
                    model: config.model,
                    activeTools: [],
                    transformProviderRequest: async () => ({}),
                    transformContextMessages: async (messages) => messages,
                    transformProviderPayload: async (payload) => payload,
                });
                return prepared.userEntryId;
            });
        const { metadata: source, session: sourceSession } = await createPaneSession("/tmp/context-reject-source");
        const sourceTurnId = await sourceSession.appendMessage(user("source"));
        const { metadata: target, session: targetSession } = await createPaneSession("/tmp/context-reject-target");
        const sourcePath = await fs.realpath(source.path);
        const targetPath = await fs.realpath(target.path);
        const draft = await prepareContextDraftForIpc({
            targetSessionPath: targetPath,
            sourceSessionPath: sourcePath,
            sourceKind: "turn",
            sourceTurnId,
        });
        registerAgentIpcHandlers();
        const send = unwrapIpcHandler(
            vi.mocked(electron.ipcMain.handle).mock.calls.find(([name]) => name === "agent:send")![1] as (
                event: unknown,
                input: unknown
            ) => Promise<unknown>
        );
        const input = {
            sessionMetadata: target,
            blockId: "block",
            cwd: target.cwd,
            text: "referenced",
            provider: "p",
            model: "m",
            contextAttachments: [{ draftId: draft.draftId, deliveryScope: "message", requestedRepresentation: "full" }],
        };

        await expect(send({}, input)).resolves.toMatchObject({ turnId: expect.any(String) });
        expect(foldContextJournal(await targetSession.getBranch()).projectionReports).toMatchObject([
            { countAccuracy: "estimated" },
        ]);
        expect((await listContextStateForIpc({ targetSessionPath: targetPath })).drafts).toHaveLength(0);

        await writeAiConfig({ context_references: { enabled: false } });
        await expect(send({}, input)).rejects.toMatchObject({ code: "disabled" });
        expect(sendSpy).toHaveBeenCalledTimes(2);
        expect((await listContextStateForIpc({ targetSessionPath: targetPath })).drafts).toHaveLength(0);
    });

    it("re-reads context configuration when a queued send is activated", async () => {
        await writeAiConfig();
        installContextTestAdapter();
        vi.mocked(getModel).mockReturnValue({
            provider: "p",
            id: "m",
            api: "openai",
            contextWindow: 128_000,
            maxTokens: 4_096,
        } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        vi.spyOn(AgentSessionRuntime.prototype, "isRunning").mockReturnValue(true);
        let releaseActivation!: () => void;
        const activationGate = new Promise<void>((resolve) => {
            releaseActivation = resolve;
        });
        let activationQueued!: () => void;
        const queued = new Promise<void>((resolve) => {
            activationQueued = resolve;
        });
        vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockImplementation(
            async (_text, _config, options) => {
                activationQueued();
                await activationGate;
                await options!.activatePreparation!();
                return "queued-user";
            }
        );
        const { metadata: source, session: sourceSession } = await createPaneSession("/tmp/context-queued-source");
        const sourceTurnId = await sourceSession.appendMessage(user("queued source"));
        const { metadata: target } = await createPaneSession("/tmp/context-queued-target");
        const targetPath = await fs.realpath(target.path);
        const draft = await prepareContextDraftForIpc({
            targetSessionPath: targetPath,
            sourceSessionPath: await fs.realpath(source.path),
            sourceKind: "turn",
            sourceTurnId,
        });
        registerAgentIpcHandlers();
        const send = unwrapIpcHandler(
            vi.mocked(electron.ipcMain.handle).mock.calls.find(([name]) => name === "agent:send")![1] as (
                event: unknown,
                input: unknown
            ) => Promise<unknown>
        );
        const pending = send(
            {},
            {
                sessionMetadata: target,
                blockId: "block",
                cwd: target.cwd,
                text: "queued",
                provider: "p",
                model: "m",
                contextAttachments: [
                    { draftId: draft.draftId, deliveryScope: "message", requestedRepresentation: "full" },
                ],
            }
        );
        await queued;
        await writeAiConfig({ context_references: { enabled: false } });
        releaseActivation();

        await expect(pending).rejects.toMatchObject({ code: "disabled" });
        expect((await listContextStateForIpc({ targetSessionPath: targetPath })).drafts).toHaveLength(1);
    });

    it("does not block another session behind a delayed send preflight", async () => {
        await writeAiConfig();
        vi.mocked(getModel).mockReturnValue({
            provider: "p",
            id: "m",
            api: "openai",
            contextWindow: 128_000,
            maxTokens: 4_096,
        } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const { metadata: firstTarget } = await createPaneSession("/tmp/context-ingress-first-target");
        const { metadata: secondTarget } = await createPaneSession("/tmp/context-ingress-second-target");
        let releaseFirstPreflight!: () => void;
        const firstPreflightGate = new Promise<void>((resolve) => {
            releaseFirstPreflight = resolve;
        });
        let firstPreflightEntered!: () => void;
        const firstPreflightBlocked = new Promise<void>((resolve) => {
            firstPreflightEntered = resolve;
        });
        const originalRealpath = fs.realpath.bind(fs);
        const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (input, options) => {
            if (String(input) === firstTarget.path) {
                firstPreflightEntered();
                await firstPreflightGate;
            }
            return await originalRealpath(input, options as never);
        });
        const runtimeCalls: Array<{ text: string; resolve: (turnId: string) => void }> = [];
        vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockImplementation(
            async (text) => await new Promise<string>((resolve) => runtimeCalls.push({ text, resolve }))
        );
        registerAgentIpcHandlers();
        const send = unwrapIpcHandler(
            vi.mocked(electron.ipcMain.handle).mock.calls.find(([name]) => name === "agent:send")![1] as (
                event: unknown,
                input: Record<string, unknown>
            ) => Promise<unknown>
        );
        const input = (sessionMetadata: typeof firstTarget, text: string) => ({
            sessionMetadata,
            blockId: "block",
            cwd: sessionMetadata.cwd,
            provider: "p",
            model: "m",
            text,
        });

        try {
            const first = send({}, input(firstTarget, "delayed first session"));
            await firstPreflightBlocked;
            const second = send({}, input(secondTarget, "fast second session"));
            await vi.waitFor(() => expect(runtimeCalls.map((call) => call.text)).toContain("fast second session"));
            runtimeCalls.find((call) => call.text === "fast second session")!.resolve("second-turn");
            releaseFirstPreflight();
            await vi.waitFor(() => expect(runtimeCalls.map((call) => call.text)).toContain("delayed first session"));
            runtimeCalls.find((call) => call.text === "delayed first session")!.resolve("first-turn");
            await expect(Promise.all([first, second])).resolves.toHaveLength(2);
        } finally {
            releaseFirstPreflight();
            realpathSpy.mockRestore();
        }
    });

    it("maps duplicate, summary, renderer-content, and ownership failures before commit", async () => {
        await writeAiConfig();
        installContextTestAdapter();
        vi.mocked(getModel).mockReturnValue({
            provider: "p",
            id: "m",
            api: "openai",
            contextWindow: 128_000,
            maxTokens: 4_096,
        } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockImplementation(async (text, config, options) => {
                const prepare = options?.prepare ?? (await options?.activatePreparation?.());
                expect(prepare).toEqual(expect.any(Function));
                const prepared = await prepare!({
                    userMessage: user(text) as never,
                    systemPrompt: "base",
                    messages: [user(text)],
                    model: config.model,
                    activeTools: [],
                    transformProviderRequest: async () => ({}),
                    transformContextMessages: async (messages) => messages,
                    transformProviderPayload: async (payload) => payload,
                });
                return prepared.userEntryId;
            });
        const { metadata: source, session: sourceSession } = await createPaneSession("/tmp/context-matrix-source");
        const sourceTurnId = await sourceSession.appendMessage(user("same snapshot"));
        const { metadata: target, session: targetSession } = await createPaneSession("/tmp/context-matrix-target");
        const { metadata: otherTarget } = await createPaneSession("/tmp/context-matrix-other");
        const sourcePath = await fs.realpath(source.path);
        const targetPath = await fs.realpath(target.path);
        const first = await prepareContextDraftForIpc({
            targetSessionPath: targetPath,
            sourceSessionPath: sourcePath,
            sourceKind: "turn",
            sourceTurnId,
        });
        const duplicate = await prepareContextDraftForIpc({
            targetSessionPath: targetPath,
            sourceSessionPath: sourcePath,
            sourceKind: "turn",
            sourceTurnId,
        });
        registerAgentIpcHandlers();
        const send = unwrapIpcHandler(
            vi.mocked(electron.ipcMain.handle).mock.calls.find(([name]) => name === "agent:send")![1] as (
                event: unknown,
                input: Record<string, unknown>
            ) => Promise<unknown>
        );
        const base = {
            sessionMetadata: target,
            blockId: "block",
            cwd: target.cwd,
            text: "matrix",
            provider: "p",
            model: "m",
        };

        await expect(
            send(
                {},
                {
                    ...base,
                    contextAttachments: [
                        {
                            draftId: first.draftId,
                            deliveryScope: "message",
                            requestedRepresentation: "full",
                            artifact: { messages: ["renderer injected"] },
                        },
                    ],
                }
            )
        ).rejects.toMatchObject({ code: "invalid_input" });
        await expect(
            send(
                {},
                {
                    ...base,
                    contextAttachments: [
                        { draftId: first.draftId, deliveryScope: "message", requestedRepresentation: "summary" },
                    ],
                }
            )
        ).rejects.toMatchObject({ code: "summary_not_ready" });
        await expect(
            send(
                {},
                {
                    ...base,
                    contextAttachments: [
                        { draftId: first.draftId, deliveryScope: "message", requestedRepresentation: "full" },
                        { draftId: duplicate.draftId, deliveryScope: "message", requestedRepresentation: "full" },
                    ],
                }
            )
        ).rejects.toMatchObject({ code: "duplicate_artifact" });
        await expect(
            send(
                {},
                {
                    ...base,
                    sessionMetadata: otherTarget,
                    cwd: otherTarget.cwd,
                    contextAttachments: [
                        { draftId: first.draftId, deliveryScope: "message", requestedRepresentation: "full" },
                    ],
                }
            )
        ).rejects.toMatchObject({ code: "invalid_input" });

        expect(await targetSession.getBranch()).toEqual([]);
        expect((await listContextStateForIpc({ targetSessionPath: targetPath })).drafts).toHaveLength(2);
        expect(sendSpy).toHaveBeenCalledTimes(3);
    });

    it("returns typed transaction failures without a provider request or draft loss", async () => {
        await writeAiConfig();
        installContextTestAdapter();
        vi.mocked(getModel).mockReturnValue({
            provider: "p",
            id: "m",
            api: "openai",
            contextWindow: 128_000,
            maxTokens: 4_096,
        } as never);
        const providerRequests = vi.fn();
        const sendSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockImplementation(async (text, config, options) => {
                const prepare = options?.prepare ?? (await options?.activatePreparation?.());
                expect(prepare).toEqual(expect.any(Function));
                const prepared = await prepare!({
                    userMessage: user(text) as never,
                    systemPrompt: "base",
                    messages: [user(text)],
                    model: config.model,
                    activeTools: [],
                    transformProviderRequest: async () => ({}),
                    transformContextMessages: async (messages) => messages,
                    transformProviderPayload: async (payload) => payload,
                });
                providerRequests();
                return prepared.userEntryId;
            });
        registerAgentIpcHandlers();
        const send = unwrapIpcHandler(
            vi.mocked(electron.ipcMain.handle).mock.calls.find(([name]) => name === "agent:send")![1] as (
                event: unknown,
                input: Record<string, unknown>
            ) => Promise<unknown>
        );

        const { metadata: source, session: sourceSession } = await createPaneSession("/tmp/context-storage-source");
        const sourceTurnId = await sourceSession.appendMessage(user("storage source"));
        const { metadata: target, session: targetSession } = await createPaneSession("/tmp/context-storage-target");
        const targetPath = await fs.realpath(target.path);
        const draft = await prepareContextDraftForIpc({
            targetSessionPath: targetPath,
            sourceSessionPath: await fs.realpath(source.path),
            sourceKind: "turn",
            sourceTurnId,
        });
        const appendSpy = vi
            .spyOn(Session.prototype, "appendEntries")
            .mockRejectedValueOnce(new Error("storage failed"));
        await expect(
            send(
                {},
                {
                    sessionMetadata: target,
                    blockId: "block",
                    cwd: target.cwd,
                    text: "storage failure",
                    provider: "p",
                    model: "m",
                    contextAttachments: [
                        { draftId: draft.draftId, deliveryScope: "message", requestedRepresentation: "full" },
                    ],
                }
            )
        ).rejects.toMatchObject({ code: "transaction_failed" });

        expect(await targetSession.getBranch()).toEqual([]);
        expect((await listContextStateForIpc({ targetSessionPath: targetPath })).drafts).toHaveLength(1);
        expect(providerRequests).not.toHaveBeenCalled();
        expect(sendSpy).toHaveBeenCalledTimes(1);
        appendSpy.mockRestore();
    });
});
