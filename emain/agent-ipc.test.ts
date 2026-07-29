// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as electron from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        const wrapped = async (...args: unknown[]) => {
            const result = await handler(...args);
            if (!result || typeof result !== "object" || !Object.hasOwn(result, "ok")) {
                return result;
            }
            const envelope = result as { ok: true; value: unknown } | { ok: false; error: { message: string } };
            if (envelope.ok) return envelope.value;
            throw new Error("error" in envelope ? envelope.error.message : "Agent IPC failed");
        };
        const call = handle.mock.calls.at(-1);
        if (call?.[0] === channel) {
            call[1] = wrapped;
        }
    });
    return {
        app: {
            getPath: vi.fn(() => "/tmp"),
            isPackaged: false,
            runningUnderARM64Translation: false,
            setName: vi.fn(),
        },
        dialog: { showMessageBoxSync: vi.fn() },
        clipboard: { writeText: vi.fn() },
        ipcMain: { handle, on: vi.fn() },
        safeStorage: {
            decryptString: vi.fn(),
            isEncryptionAvailable: vi.fn(() => true),
        },
        shell: { openExternal: vi.fn() },
    };
});

vi.mock("@crest/ai", () => ({ getModel: vi.fn() }));
vi.mock("@crest/coding-agent/change-review/change-outline", () => ({
    extractChangeOperationsFromMessages: vi.fn(() => []),
    generateChangeOutline: vi.fn(),
}));
vi.mock("@crest/coding-agent/harness-factory", () => ({ buildAgentHarnessHost: vi.fn() }));
vi.mock("@crest/agent", () => ({}));
vi.mock("@crest/coding-agent/permissions", () => ({
    buildPermissionsHook: vi.fn(),
    isBenchMode: vi.fn(() => false),
}));
vi.mock("@crest/coding-agent/skills-loader", () => ({ loadAgentSkills: vi.fn(async () => []) }));
vi.mock("@crest/coding-agent/tools", () => ({ getDefaultTools: vi.fn(() => []) }));
vi.mock("./agent-tools/spawn-cli-agent", () => ({
    createSpawnCliAgentTool: vi.fn(() => ({
        name: "spawn_cli_agent",
        label: "spawn cli agent",
        description: "delegate",
        parameters: {},
        execute: vi.fn(),
    })),
}));
vi.mock("./aiconfig/secrets", () => ({ getSecret: vi.fn() }));
vi.mock("../frontend/app/store/wshclientapi", () => ({
    RpcApi: {
        GetCmdBlocksCommand: vi.fn(() => Promise.resolve([])),
    },
}));
vi.mock("./emain-wsh", () => ({ ElectronWshClient: {} }));
vi.mock("./agent-rewind-feature", () => ({
    isAgentRewindFeatureEnabled: vi.fn(() => false),
    openAgentRewindFeature: vi.fn(),
}));
vi.mock("@crest/coding-agent/workspace-rewind/checkpoint-manager", () => ({
    makeDisabledWorkspaceCheckpointManager: vi.fn(() => ({
        isBusy: () => false,
        recover: vi.fn(),
        dispose: vi.fn(),
    })),
    registerWorkspaceCheckpointManager: vi.fn(),
}));

import { Session } from "@crest/agent/harness/session/session";
import { SqliteSessionRepo } from "@crest/agent/harness/session/sqlite-repo";
import { SqliteSessionStorage } from "@crest/agent/harness/session/sqlite-storage";
import type { JsonlSessionMetadata } from "@crest/agent/harness/types";
import type { AgentMessage } from "@crest/agent/types";
import { getModel } from "@crest/ai";
import { AgentRuntimeRegistry } from "@crest/coding-agent/agent-runtime-registry";
import { AgentSessionRuntime } from "@crest/coding-agent/agent-session-runtime";
import { buildAgentHarnessHost } from "@crest/coding-agent/harness-factory";
import { _setSessionsRepoForTests, createPaneSession, defaultSessionsDir } from "@crest/coding-agent/sessions";
import { loadAgentSkills } from "@crest/coding-agent/skills-loader";
import { registerWorkspaceCheckpointManager } from "@crest/coding-agent/workspace-rewind/checkpoint-manager";
import {
    _resetAgentIpcForTests,
    abortAgentSessionForIpc,
    archiveAgentSessionForIpc,
    cloneAgentSessionForIpc,
    deleteAgentSessionForIpc,
    forkAgentSessionForIpc,
    listAgentCommandsForIpc,
    listAgentForkPointsForIpc,
    listAgentTreeForIpc,
    registerAgentIpcHandlers as registerAgentIpcHandlersImpl,
    runAgentCommandForIpc,
    subscribeAgentSessionForIpc,
    unsubscribeAgentSessionForIpc,
} from "./agent-ipc";
import { isAgentRewindFeatureEnabled, openAgentRewindFeature } from "./agent-rewind-feature";
import { AgentPtyHost } from "./agent-tools/agent-pty-host";

const TrustedRequestContext = { workspaceId: "workspace-test", generation: 1 };

function getTrustedCwd(channel: string, args: unknown[]): string {
    const input = args[0] as Record<string, unknown> | undefined;
    const metadata =
        channel === "agent:send"
            ? (input?.sessionMetadata as JsonlSessionMetadata | undefined)
            : channel === "agent:list-tree" ||
                channel === "agent:get-session-state" ||
                channel === "agent:list-fork-points"
              ? (input as unknown as JsonlSessionMetadata)
              : (input?.sessionMetadata as JsonlSessionMetadata | undefined);
    return metadata?.cwd || (typeof input?.cwd === "string" ? input.cwd : "/tmp");
}

function registerAgentIpcHandlers(): void {
    let trustedWorkspaceDir = "/tmp";
    const start = vi.mocked(electron.ipcMain.handle).mock.calls.length;
    registerAgentIpcHandlersImpl({
        loadWorkspace: async (workspaceId) => workspaceWithAgentState(workspaceId, 0, {}),
        saveWorkspaceAgentState: async (data) => ({
            workspaceid: data.workspaceid,
            revision: data.expectedrevision + 1,
            state: data.state,
        }),
        resolveWorkspaceSender: async () => ({
            ...TrustedRequestContext,
            windowId: "window-test",
            workspaceDir: trustedWorkspaceDir,
        }),
    });
    const calls = vi.mocked(electron.ipcMain.handle).mock.calls;
    for (let index = start; index < calls.length; index += 1) {
        const [channel, handler] = calls[index] as [string, (...args: unknown[]) => unknown];
        calls[index][1] = (async (_event: unknown, ...args: unknown[]) => {
            trustedWorkspaceDir = getTrustedCwd(channel, args);
            await fs.mkdir(trustedWorkspaceDir, { recursive: true });
            trustedWorkspaceDir = await fs.realpath(trustedWorkspaceDir);
            const event = {
                sender: {
                    id: 1,
                    isDestroyed: () => false,
                    once: vi.fn(),
                    send: vi.fn(),
                },
            };
            if (channel === "agent:send") {
                const input = args[0] as Record<string, unknown>;
                const context = {
                    workspaceId: TrustedRequestContext.workspaceId,
                    workspaceDir: trustedWorkspaceDir,
                    environment: {},
                };
                return await handler(event, TrustedRequestContext, { ...input, context });
            }
            return await handler(event, TrustedRequestContext, ...args);
        }) as never;
    }
}

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
            close: vi.fn(),
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

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function registeredHandlers(): Map<string, (...args: unknown[]) => unknown> {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
        handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
    }
    return handlers;
}

function workspaceWithAgentState(workspaceId: string, revision: number, state: WorkspaceAgentState): Workspace {
    return {
        oid: workspaceId,
        otype: "workspace",
        version: 1,
        meta: {},
        tabids: [],
        activetabid: "",
        contentstate: { activecontent: { kind: "empty" }, toptabs: [] },
        navigationrevision: 0,
        agentstate: state,
        agentrevision: revision,
    };
}

const DefaultAgentIpcRegistrationDependencies = {
    loadWorkspace: async (workspaceId: string) => workspaceWithAgentState(workspaceId, 0, {}),
    saveWorkspaceAgentState: async (data: SaveWorkspaceAgentStateData) => ({
        workspaceid: data.workspaceid,
        revision: data.expectedrevision + 1,
        state: data.state,
    }),
};

describe("agent-ipc command helpers", () => {
    let tmpConfigHome: string;
    let previousConfigHome: string | undefined;

    beforeEach(async () => {
        vi.mocked(electron.ipcMain.handle).mockClear();
        vi.mocked(electron.ipcMain.on).mockClear();
        vi.mocked(loadAgentSkills).mockClear();
        vi.mocked(loadAgentSkills).mockResolvedValue([]);
        await _resetAgentIpcForTests();
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

    it("maps a cold hidden workspace control leaf to the visible public leafId", async () => {
        const { metadata, session } = await createPaneSession("/tmp/agent-ipc-workspace-control");
        const userId = await session.appendMessage(user("first question"));
        await session.appendCustomEntry("workspace_checkpoint", {});
        await session.appendCustomEntry("workspace_state", {});

        const tree = await listAgentTreeForIpc(metadata);

        expect(tree.entries.map((entry) => entry.id)).toEqual([userId]);
        expect(tree.leafId).toBe(userId);
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
        await expect(
            handlers.get("agent:clone-session")?.({}, { sessionMetadata: metadata, cwd: "" })
        ).resolves.toMatchObject({
            sessionMetadata: expect.objectContaining({ cwd: await fs.realpath(metadata.cwd) }),
        });
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

    it("routes /session to the renderer-owned session manager", async () => {
        const { metadata, session } = await createPaneSession("/tmp/agent-ipc-session-info");
        await session.appendMessage(user("session question"));
        await session.appendMessage(assistant("session answer"));

        const result = await runAgentCommandForIpc({
            command: "session",
            cwd: metadata.cwd,
            sessionMetadata: metadata,
            argsText: "",
        });

        expect(result).toEqual({
            status: "success",
            message: "Open session manager",
            managerMode: "session",
        });
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
        await expect(handleHandlers.get("agent:subscribe")?.({}, outside)).rejects.toThrow(
            /outside sessions directory/
        );
        expect(sender.send).not.toHaveBeenCalled();
    });

    it("agent:send returns the turn id committed by the configured runtime", async () => {
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
            }),
            expect.objectContaining({
                activatePreparation: expect.any(Function),
            })
        );
        expect(result.turnId).toBe("entry-xyz");
        sendConfiguredSpy.mockRestore();
    });

    it("registers authenticated hosted command IPC endpoints", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-command-endpoints");
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const commandRead = vi.spyOn(AgentSessionRuntime.prototype as any, "readHostedCommand").mockReturnValue({
            commandId: "cmd1",
            command: "npm run dev",
            cwd: metadata.cwd,
            tail: "ready",
            screen: {
                rows: [],
                cursor: { row: 0, col: 0, visible: true, shape: "block", blink: false },
                isAltScreenActive: false,
            },
            running: true,
            cols: 80,
            rows: 24,
            needsUserInput: false,
        });
        const commandWrite = vi
            .spyOn(AgentSessionRuntime.prototype as any, "writeHostedCommand")
            .mockResolvedValue(undefined);
        const commandResize = vi
            .spyOn(AgentSessionRuntime.prototype as any, "resizeHostedCommand")
            .mockImplementation(() => {});
        const commandStop = vi
            .spyOn(AgentSessionRuntime.prototype as any, "stopHostedCommand")
            .mockResolvedValue(undefined);

        try {
            registerAgentIpcHandlers();
            const handlers = new Map<string, (...args: unknown[]) => unknown>();
            for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
                handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
            }
            expect([...handlers.keys()]).toEqual(
                expect.arrayContaining([
                    "agent:command-read",
                    "agent:command-write",
                    "agent:command-resize",
                    "agent:command-stop",
                ])
            );

            await handlers.get("agent:send")?.(
                {},
                {
                    sessionMetadata: metadata,
                    blockId: "legacy-block",
                    cwd: metadata.cwd,
                    text: "first",
                    provider: "p",
                    model: "m",
                }
            );
            await expect(
                handlers.get("agent:command-read")?.({}, metadata, { commandId: "cmd1" })
            ).resolves.toMatchObject({ commandId: "cmd1" });
            await handlers.get("agent:command-write")?.({}, metadata, { commandId: "cmd1", input: "yes\n" });
            await handlers.get("agent:command-resize")?.({}, metadata, { commandId: "cmd1", cols: 100, rows: 30 });
            await expect(
                handlers.get("agent:command-resize")?.({}, metadata, { commandId: "cmd1", cols: 100000, rows: 30 })
            ).rejects.toThrow(/invalid hosted command size/);
            await handlers.get("agent:command-stop")?.({}, metadata, { commandId: "cmd1" });

            expect(commandRead).toHaveBeenCalledWith("cmd1");
            expect(commandWrite).toHaveBeenCalledWith("cmd1", "yes\n");
            expect(commandResize).toHaveBeenCalledWith("cmd1", 100, 30);
            expect(commandStop).toHaveBeenCalledWith("cmd1");

            await expect(
                handlers.get("agent:command-read")?.({}, { ...metadata, cwd: "/tmp/other" }, { commandId: "cmd1" })
            ).rejects.toThrow(/Workspace/);
        } finally {
            sendConfiguredSpy.mockRestore();
            commandRead.mockRestore();
            commandWrite.mockRestore();
            commandResize.mockRestore();
            commandStop.mockRestore();
        }
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
            expect((vi.mocked(buildAgentHarnessHost).mock.calls[0][0].tools ?? []).map((tool) => tool.name)).toContain(
                "spawn_cli_agent"
            );
            expect(sendConfiguredSpy).toHaveBeenNthCalledWith(
                2,
                "second",
                expect.objectContaining({
                    model: expect.objectContaining({ id: "m2" }),
                    thinkingLevel: "high",
                    promptInputs: expect.objectContaining({ cwd: await fs.realpath("/tmp/agent-ipc-config") }),
                }),
                expect.objectContaining({
                    activatePreparation: expect.any(Function),
                })
            );
        } finally {
            sendConfiguredSpy.mockRestore();
        }
    });

    it("constructs and recovers the enabled checkpoint manager before the runtime sends", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-rewind-order");
        const order: string[] = [];
        const processOwner = { pid: 42, processStartToken: "start-a", nonce: "nonce-a" };
        const store = {
            identity: {
                canonicalRoot: "/tmp/agent-ipc-rewind-order",
                workspaceIdentity: "workspace-a",
                workspaceIncarnation: "incarnation-a",
            },
        };
        const manager = {
            isBusy: () => false,
            recover: vi.fn(async () => {
                order.push("recover");
            }),
            dispose: vi.fn(),
        };
        vi.mocked(isAgentRewindFeatureEnabled).mockReturnValueOnce(true);
        vi.mocked(openAgentRewindFeature).mockResolvedValueOnce({
            state: "enabled",
            processOwner,
            store,
        } as never);
        vi.mocked(registerWorkspaceCheckpointManager).mockReturnValueOnce(manager);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockImplementation(async () => {
                order.push("send");
                return "entry-1";
            });

        registerAgentIpcHandlers();
        const handlers = registeredHandlers();
        try {
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

            expect(order).toEqual(["recover", "send"]);
            expect(registerWorkspaceCheckpointManager).toHaveBeenCalledWith(
                expect.objectContaining({
                    processOwner,
                    store,
                    hasRunningHostedCommands: expect.any(Function),
                    onCheckpointCommitted: expect.any(Function),
                })
            );
        } finally {
            sendConfiguredSpy.mockRestore();
        }
    });

    it.each(["recover", "post-recover"] as const)(
        "cleans checkpoint and PTY ownership when runtime construction fails at $stage",
        async (stage) => {
            const { metadata } = await createPaneSession(`/tmp/agent-ipc-rewind-cleanup-${stage}`);
            const failure = new Error(`${stage} failed`);
            const host = makeHarnessHostMock();
            let harnessSubscribers = 0;
            host.harness.subscribe.mockImplementation(() => {
                harnessSubscribers++;
                return () => {
                    harnessSubscribers--;
                };
            });
            vi.mocked(buildAgentHarnessHost).mockReturnValue(host as never);
            vi.mocked(isAgentRewindFeatureEnabled).mockReturnValueOnce(true);
            vi.mocked(openAgentRewindFeature).mockResolvedValueOnce({
                state: "enabled",
                processOwner: { pid: 42, processStartToken: "start-a", nonce: "nonce-a" },
                store: {
                    identity: {
                        canonicalRoot: metadata.cwd,
                        workspaceIdentity: "workspace-a",
                        workspaceIncarnation: "incarnation-a",
                    },
                },
            } as never);
            const managerDispose = vi.fn(async () => undefined);
            vi.mocked(registerWorkspaceCheckpointManager).mockImplementationOnce((input) => {
                const unsubscribe = input.harness.subscribe(() => undefined);
                managerDispose.mockImplementationOnce(async () => {
                    unsubscribe();
                });
                return {
                    isBusy: () => false,
                    recover: stage === "recover" ? vi.fn(async () => Promise.reject(failure)) : vi.fn(),
                    dispose: managerDispose,
                };
            });
            const ptyDispose = vi.spyOn(AgentPtyHost.prototype, "dispose").mockResolvedValue(undefined);
            const buildContext =
                stage === "post-recover"
                    ? vi.spyOn(Session.prototype, "buildContext").mockRejectedValueOnce(failure)
                    : undefined;
            vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);

            registerAgentIpcHandlers();
            try {
                await expect(
                    registeredHandlers().get("agent:send")?.(
                        {},
                        {
                            sessionMetadata: metadata,
                            blockId: "block-1",
                            cwd: metadata.cwd,
                            text: "first",
                            provider: "p",
                            model: "m",
                        }
                    )
                ).rejects.toThrow(failure.message);
                expect(managerDispose).toHaveBeenCalledOnce();
                expect(ptyDispose).toHaveBeenCalledOnce();
                expect(harnessSubscribers).toBe(0);
            } finally {
                buildContext?.mockRestore();
                ptyDispose.mockRestore();
            }
        }
    );

    it.each([
        { channel: "agent:archive-session", operation: "archive", senderId: 81 },
        { channel: "agent:delete-session", operation: "delete", senderId: 82 },
    ] as const)(
        "rejects $operation while checkpoint finalization owns the session barrier",
        async ({ channel, operation, senderId }) => {
            const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `crest-agent-${operation}-finalizer-busy-`));
            const { metadata } = await createPaneSession(cwd);
            const host = makeHarnessHostMock();
            vi.mocked(buildAgentHarnessHost).mockImplementation((options) => {
                host.session = options.session as never;
                return host as never;
            });
            vi.mocked(isAgentRewindFeatureEnabled).mockReturnValueOnce(true);
            vi.mocked(openAgentRewindFeature).mockResolvedValueOnce({
                state: "enabled",
                processOwner: { pid: 42, processStartToken: "start-a", nonce: "nonce-a" },
                store: {
                    identity: {
                        canonicalRoot: await fs.realpath(cwd),
                        workspaceIdentity: "workspace-a",
                        workspaceIncarnation: "incarnation-a",
                    },
                },
            } as never);
            let runFinalizer!: <T>(operation: () => Promise<T>) => Promise<T>;
            vi.mocked(registerWorkspaceCheckpointManager).mockImplementationOnce((input) => {
                runFinalizer = (operation) => input.mutationBarrier.run(operation);
                return {
                    isBusy: () => input.mutationBarrier.isBusy(),
                    recover: vi.fn(),
                    dispose: vi.fn(),
                };
            });
            vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
            const sendConfiguredSpy = vi
                .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
                .mockResolvedValue("entry-1");
            const moveTo = vi.spyOn(Session.prototype, "moveTo");
            const identity = {
                ...TrustedRequestContext,
                windowId: `window-${operation}-finalizer-busy`,
                workspaceDir: await fs.realpath(cwd),
                validatePreferredTerminal: async () => true,
            };
            registerAgentIpcHandlersImpl({
                resolveWorkspaceSender: async () => identity,
                ...DefaultAgentIpcRegistrationDependencies,
            });
            const handlers = registeredHandlers();
            const event = { sender: { id: senderId, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };
            let releaseFinalizer!: () => void;
            const finalizerGate = new Promise<void>((resolve) => {
                releaseFinalizer = resolve;
            });

            try {
                await handlers.get("agent:send")?.(event, TrustedRequestContext, {
                    sessionMetadata: metadata,
                    context: {
                        workspaceId: identity.workspaceId,
                        workspaceDir: identity.workspaceDir,
                        sessionPath: metadata.path,
                        connection: "",
                        environment: {},
                        recentCmds: [],
                    },
                    text: "first",
                    provider: "p",
                    model: "m",
                });
                const finalization = runFinalizer(async () => finalizerGate);

                await expect(handlers.get(channel)?.(event, TrustedRequestContext, metadata)).rejects.toThrow(
                    /running/i
                );
                await expect(
                    handlers.get("agent:send")?.(event, TrustedRequestContext, {
                        sessionMetadata: metadata,
                        context: {
                            workspaceId: identity.workspaceId,
                            workspaceDir: identity.workspaceDir,
                            sessionPath: metadata.path,
                            connection: "",
                            environment: {},
                            recentCmds: [],
                        },
                        text: "blocked",
                        provider: "p",
                        model: "m",
                    })
                ).rejects.toThrow(/running/i);
                await expect(handlers.get("agent:list-tree")?.(event, TrustedRequestContext, metadata)).rejects.toThrow(
                    /running/i
                );
                expect(moveTo).not.toHaveBeenCalled();
                expect(sendConfiguredSpy).toHaveBeenCalledOnce();
                await expect(fs.stat(metadata.path)).resolves.toBeDefined();

                releaseFinalizer();
                await finalization;
            } finally {
                releaseFinalizer();
                moveTo.mockRestore();
                sendConfiguredSpy.mockRestore();
            }
        }
    );

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
            await _resetAgentIpcForTests();
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
            await _resetAgentIpcForTests();
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
            await _resetAgentIpcForTests();
            vi.useRealTimers();
            sendConfiguredSpy.mockRestore();
            disposeSpy.mockRestore();
        }
    });

    it("waits for pending runtime creation before test reset completes", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-pending-reset");
        const skills = deferred<[]>();
        const host = makeHarnessHostMock();
        vi.mocked(loadAgentSkills).mockReturnValue(skills.promise);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(host as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const sending = handlers.get("agent:send")?.(
            {},
            {
                sessionMetadata: metadata,
                blockId: "block-1",
                cwd: metadata.cwd,
                text: "first",
                provider: "p",
                model: "m",
            }
        ) as Promise<unknown>;
        let resetResult: void | Promise<void>;

        try {
            await vi.waitFor(() => expect(loadAgentSkills).toHaveBeenCalledOnce());
            resetResult = _resetAgentIpcForTests();
            expect(resetResult).toBeInstanceOf(Promise);
            let settled = false;
            const resetPromise = Promise.resolve(resetResult).then(() => {
                settled = true;
            });
            await Promise.resolve();
            expect(settled).toBe(false);

            skills.resolve([]);
            await expect(sending).rejects.toThrow(/disposed during creation/);
            await resetPromise;
            expect(settled).toBe(true);
        } finally {
            skills.resolve([]);
            await sending?.catch(() => {});
            await Promise.resolve(resetResult);
            sendConfiguredSpy.mockRestore();
        }
    });

    it("contains idle sweep disposal rejection after every selected runtime finishes cleanup", async () => {
        const firstSession = await createPaneSession("/tmp/agent-ipc-rejected-sweep");
        const secondSession = await createPaneSession("/tmp/agent-ipc-pending-sweep");
        const secondDisposal = deferred<void>();
        const unhandledRejection = vi.fn();
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        process.on("unhandledRejection", unhandledRejection);
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockImplementation(() => makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const disposeSpy = vi.spyOn(AgentSessionRuntime.prototype, "dispose").mockImplementation(function (
            this: AgentSessionRuntime
        ) {
            if (path.basename(this.path) === path.basename(firstSession.metadata.path)) {
                throw new Error("dispose failed");
            }
            if (path.basename(this.path) === path.basename(secondSession.metadata.path)) {
                return secondDisposal.promise;
            }
        });

        try {
            registerAgentIpcHandlers();
            const handlers = new Map<string, (...args: unknown[]) => unknown>();
            for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
                handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
            }
            const send = async (metadata: JsonlSessionMetadata) =>
                handlers.get("agent:send")?.(
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

            await send(firstSession.metadata);
            await send(secondSession.metadata);
            await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
            vi.advanceTimersByTime(60 * 1000);
            await Promise.resolve();
            expect(disposeSpy).toHaveBeenCalledTimes(2);
            expect(consoleError).not.toHaveBeenCalledWith(
                expect.stringMatching(/runtime eviction/i),
                expect.any(AggregateError)
            );

            secondDisposal.resolve();
            await vi.waitFor(() =>
                expect(consoleError).toHaveBeenCalledWith(
                    expect.stringMatching(/runtime eviction/i),
                    expect.any(AggregateError)
                )
            );
            expect(unhandledRejection).not.toHaveBeenCalled();
        } finally {
            secondDisposal.resolve();
            process.off("unhandledRejection", unhandledRejection);
            await _resetAgentIpcForTests();
            vi.useRealTimers();
            sendConfiguredSpy.mockRestore();
            disposeSpy.mockRestore();
            consoleError.mockRestore();
        }
    });

    it("serializes idle sweeps while async runtime disposal is pending", async () => {
        const firstSession = await createPaneSession("/tmp/agent-ipc-first-sweep");
        const secondSession = await createPaneSession("/tmp/agent-ipc-second-sweep");
        const firstDisposal = deferred<void>();
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockImplementation(() => makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const disposedPaths: string[] = [];
        const disposeSpy = vi.spyOn(AgentSessionRuntime.prototype, "dispose").mockImplementation(function (
            this: AgentSessionRuntime
        ) {
            disposedPaths.push(this.path);
            if (path.basename(this.path) === path.basename(firstSession.metadata.path)) {
                return firstDisposal.promise;
            }
        });

        try {
            registerAgentIpcHandlers();
            const handlers = new Map<string, (...args: unknown[]) => unknown>();
            for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
                handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
            }
            const send = async (metadata: JsonlSessionMetadata) =>
                handlers.get("agent:send")?.(
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

            await send(firstSession.metadata);
            await vi.advanceTimersByTimeAsync(60 * 1000);
            await send(secondSession.metadata);
            await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
            vi.advanceTimersByTime(60 * 1000);
            await Promise.resolve();
            expect(disposeSpy).toHaveBeenCalledTimes(1);
            expect(path.basename(disposedPaths[0])).toBe(path.basename(firstSession.metadata.path));

            vi.advanceTimersByTime(60 * 1000);
            await Promise.resolve();
            expect(disposeSpy).toHaveBeenCalledTimes(1);

            firstDisposal.resolve();
            await firstDisposal.promise;
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(60 * 1000);
            expect(disposeSpy).toHaveBeenCalledTimes(2);
            expect(path.basename(disposedPaths[1])).toBe(path.basename(secondSession.metadata.path));
        } finally {
            firstDisposal.resolve();
            await _resetAgentIpcForTests();
            vi.useRealTimers();
            sendConfiguredSpy.mockRestore();
            disposeSpy.mockRestore();
        }
    });

    it("starts only one runtime sweep timer", async () => {
        vi.useFakeTimers();
        try {
            registerAgentIpcHandlers();
            registerAgentIpcHandlers();

            expect(vi.getTimerCount()).toBe(1);
        } finally {
            await _resetAgentIpcForTests();
            vi.useRealTimers();
        }
    });

    it("rejects every Agent entry point for non-Workspace senders", async () => {
        registerAgentIpcHandlersImpl({
            ...DefaultAgentIpcRegistrationDependencies,
            resolveWorkspaceSender: async () => undefined,
        });
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const event = { sender: { id: 99 } };
        const context = { workspaceId: "workspace-1", generation: 1 };
        const calls: Array<[string, unknown[]]> = [
            ["agent:create-session", []],
            ["agent:list-sessions", []],
            ["agent:list-session-details", []],
            ["agent:list-commands", []],
            ["agent:get-session-state", [{}]],
            ["agent:send", [{}]],
            ["agent:abort", ["/tmp/session"]],
            ["agent:subscribe", ["/tmp/session"]],
            ["agent:unsubscribe", ["/tmp/session"]],
            ["agent:list-tree", [{}]],
            ["agent:list-fork-points", [{}]],
            ["agent:navigate-tree", [{}]],
            ["agent:fork-session", [{}]],
            ["agent:clone-session", [{}]],
            ["agent:run-command", [{}]],
        ];

        for (const [channel, args] of calls) {
            await expect(handlers.get(channel)?.(event, context, ...args), channel).rejects.toThrow(
                /current Workspace renderer/
            );
        }
    });

    it("rejects every Agent entry point when the request context does not match the sender", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-context-mismatch-"));
        const { metadata, session } = await createPaneSession(cwd);
        const entryId = await session.appendMessage(user("fork point"));
        const identity = {
            workspaceId: "workspace-1",
            generation: 2,
            windowId: "window-1",
            workspaceDir: await fs.realpath(cwd),
        };
        registerAgentIpcHandlersImpl({
            ...DefaultAgentIpcRegistrationDependencies,
            resolveWorkspaceSender: async () => identity,
        });
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const event = { sender: { id: 16, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };
        const badContext = { workspaceId: "workspace-other", generation: 2 };
        const calls: Array<[string, unknown[]]> = [
            ["agent:create-session", []],
            ["agent:list-sessions", []],
            ["agent:list-session-details", []],
            ["agent:list-commands", []],
            ["agent:get-session-state", [metadata]],
            [
                "agent:send",
                [
                    {
                        sessionMetadata: metadata,
                        context: {
                            workspaceId: "workspace-other",
                            workspaceDir: identity.workspaceDir,
                            sessionPath: metadata.path,
                            environment: {},
                        },
                        text: "hello",
                        provider: "p",
                        model: "m",
                    },
                ],
            ],
            ["agent:abort", [metadata.path]],
            ["agent:subscribe", [metadata.path]],
            ["agent:unsubscribe", [metadata.path]],
            ["agent:list-tree", [metadata]],
            ["agent:list-fork-points", [metadata]],
            ["agent:navigate-tree", [{ sessionMetadata: metadata, targetId: entryId }]],
            ["agent:fork-session", [{ sessionMetadata: metadata, cwd, entryId }]],
            ["agent:clone-session", [{ sessionMetadata: metadata, cwd }]],
            ["agent:run-command", [{ command: "session", cwd, sessionMetadata: metadata, argsText: "" }]],
        ];

        for (const [channel, args] of calls) {
            await expect(handlers.get(channel)?.(event, badContext, ...args), channel).rejects.toThrow(
                /current Workspace renderer/
            );
        }
    });

    it("rejects every Agent entry point when the sender goes stale after authentication", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-stale-matrix-"));
        const { metadata, session } = await createPaneSession(cwd);
        const entryId = await session.appendMessage(user("fork point"));
        const emptySession = await createPaneSession(cwd);
        const noAssistantSession = await createPaneSession(cwd);
        await noAssistantSession.session.appendMessage(user("no assistant yet"));
        const identity = {
            workspaceId: "workspace-1",
            generation: 6,
            windowId: "window-1",
            workspaceDir: await fs.realpath(cwd),
        };
        let current = true;
        registerAgentIpcHandlersImpl({
            ...DefaultAgentIpcRegistrationDependencies,
            resolveWorkspaceSender: async () => {
                if (!current) return undefined;
                current = false;
                return identity;
            },
        });
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const event = { sender: { id: 17, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };
        const context = { workspaceId: "workspace-1", generation: 6 };
        const calls: Array<[string, unknown[]]> = [
            ["agent:create-session", []],
            ["agent:list-sessions", []],
            ["agent:list-session-details", []],
            ["agent:list-commands", []],
            ["agent:get-session-state", [metadata]],
            [
                "agent:send",
                [
                    {
                        sessionMetadata: metadata,
                        context: {
                            workspaceId: "workspace-1",
                            workspaceDir: identity.workspaceDir,
                            sessionPath: metadata.path,
                            environment: {},
                        },
                        text: "hello",
                        provider: "p",
                        model: "m",
                    },
                ],
            ],
            ["agent:abort", [metadata.path]],
            ["agent:subscribe", [metadata.path]],
            ["agent:unsubscribe", [metadata.path]],
            ["agent:list-tree", [metadata]],
            ["agent:list-fork-points", [metadata]],
            ["agent:navigate-tree", [{ sessionMetadata: metadata, targetId: entryId }]],
            ["agent:fork-session", [{ sessionMetadata: metadata, cwd, entryId }]],
            ["agent:clone-session", [{ sessionMetadata: metadata, cwd }]],
            ["agent:run-command", [{ command: "session", cwd, sessionMetadata: metadata, argsText: "" }]],
            ["agent:clone-session", [{ sessionMetadata: emptySession.metadata, cwd }]],
            [
                "agent:run-command",
                [{ command: "copy", cwd, sessionMetadata: noAssistantSession.metadata, argsText: "" }],
            ],
        ];

        for (const [channel, args] of calls) {
            current = true;
            await expect(handlers.get(channel)?.(event, context, ...args), channel).rejects.toThrow(
                /changed during request/
            );
        }
    });

    it("cross-checks workspace identity and invalidates a sender switched during an async request", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-auth-"));
        const { metadata } = await createPaneSession(cwd);
        let current = true;
        const identity = {
            workspaceId: "workspace-1",
            generation: 4,
            windowId: "window-1",
            workspaceDir: await fs.realpath(cwd),
        };
        registerAgentIpcHandlersImpl({
            ...DefaultAgentIpcRegistrationDependencies,
            resolveWorkspaceSender: async () => {
                if (!current) return undefined;
                current = false;
                return identity;
            },
        });
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const event = { sender: { id: 7 } };

        vi.mocked(getModel).mockClear();
        await expect(
            handlers.get("agent:send")?.(
                event,
                { workspaceId: "workspace-1", generation: 4 },
                {
                    sessionMetadata: metadata,
                    context: {
                        workspaceId: "workspace-1",
                        workspaceDir: identity.workspaceDir,
                        sessionPath: metadata.path,
                        environment: {},
                    },
                    text: "must not run",
                    provider: "p",
                    model: "m",
                }
            )
        ).rejects.toThrow(/changed during request/);
        expect(getModel).not.toHaveBeenCalled();

        current = true;
        await expect(
            handlers.get("agent:list-commands")?.(event, { workspaceId: "workspace-other", generation: 4 })
        ).rejects.toThrow(/current Workspace renderer/);
    });

    it.each([
        ["preferredTerminalTabId", "terminal-1"],
        ["connection", "ssh://host"],
        ["recentCmds", ["git status"]],
    ])("rejects removed Terminal-derived send context field %s before runtime mutation", async (field, value) => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-terminal-context-"));
        const { metadata } = await createPaneSession(cwd);
        const identity = {
            workspaceId: "workspace-1",
            generation: 1,
            windowId: "window-1",
            workspaceDir: await fs.realpath(cwd),
        };
        registerAgentIpcHandlersImpl({
            ...DefaultAgentIpcRegistrationDependencies,
            resolveWorkspaceSender: async () => identity,
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 17, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };

        vi.mocked(getModel).mockClear();
        await expect(
            handlers.get("agent:send")?.(
                event,
                { workspaceId: "workspace-1", generation: 1 },
                {
                    sessionMetadata: metadata,
                    context: {
                        workspaceId: "workspace-1",
                        workspaceDir: identity.workspaceDir,
                        sessionPath: metadata.path,
                        environment: {},
                        [field]: value,
                    },
                    text: "must not run",
                    provider: "p",
                    model: "m",
                }
            )
        ).rejects.toThrow(/unexpected key/);
        expect(getModel).not.toHaveBeenCalled();
    });

    it("revalidates sender identity before reading a live runtime", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-runtime-read-"));
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const listTreeSpy = vi.spyOn(AgentSessionRuntime.prototype, "listTreeEntries");
        const identity = {
            workspaceId: "workspace-1",
            generation: 3,
            windowId: "window-1",
            workspaceDir: await fs.realpath(cwd),
        };
        let resolveCount = 0;
        let failOnThirdResolve = false;
        registerAgentIpcHandlersImpl({
            ...DefaultAgentIpcRegistrationDependencies,
            resolveWorkspaceSender: async () => {
                resolveCount += 1;
                if (failOnThirdResolve && resolveCount >= 3) {
                    return { ...identity, workspaceId: "workspace-2" };
                }
                return identity;
            },
        });
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const event = { sender: { id: 8, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };

        try {
            await handlers.get("agent:send")?.(
                event,
                { workspaceId: "workspace-1", generation: 3 },
                {
                    sessionMetadata: metadata,
                    context: {
                        workspaceId: "workspace-1",
                        workspaceDir: identity.workspaceDir,
                        sessionPath: metadata.path,
                        environment: {},
                    },
                    text: "first",
                    provider: "p",
                    model: "m",
                }
            );

            resolveCount = 0;
            failOnThirdResolve = true;
            await expect(
                handlers.get("agent:list-tree")?.(event, { workspaceId: "workspace-1", generation: 3 }, metadata)
            ).rejects.toThrow(/changed during request/);
            expect(listTreeSpy).not.toHaveBeenCalled();
        } finally {
            sendConfiguredSpy.mockRestore();
            listTreeSpy.mockRestore();
        }
    });

    it("does not attach pending subscriptions from a stale workspace generation", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-stale-sub-"));
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const runtimeSubscribeSpy = vi.spyOn(AgentSessionRuntime.prototype, "subscribe");
        const baseIdentity = {
            workspaceId: "workspace-1",
            windowId: "window-1",
            workspaceDir: await fs.realpath(cwd),
        };
        let generation = 1;
        registerAgentIpcHandlersImpl({
            ...DefaultAgentIpcRegistrationDependencies,
            resolveWorkspaceSender: async () => ({ ...baseIdentity, generation }),
        });
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const sender = { id: 14, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
        const event = { sender };

        try {
            await handlers.get("agent:subscribe")?.(
                event,
                { workspaceId: "workspace-1", generation: 1 },
                metadata.path
            );
            expect(sender.send).toHaveBeenCalledWith(
                "agent:event",
                expect.objectContaining({ workspaceId: "workspace-1", generation: 1 })
            );
            sender.send.mockClear();

            generation = 2;
            await handlers.get("agent:send")?.(
                event,
                { workspaceId: "workspace-1", generation: 2 },
                {
                    sessionMetadata: metadata,
                    context: {
                        workspaceId: "workspace-1",
                        workspaceDir: baseIdentity.workspaceDir,
                        sessionPath: metadata.path,
                        environment: {},
                    },
                    text: "first",
                    provider: "p",
                    model: "m",
                }
            );

            expect(runtimeSubscribeSpy).not.toHaveBeenCalled();
            expect(sender.send).not.toHaveBeenCalled();
        } finally {
            sendConfiguredSpy.mockRestore();
            runtimeSubscribeSpy.mockRestore();
        }
    });

    it("releases a live subscription when its post-acquire authorization guard fails", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-live-sub-guard-failure-"));
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-live-sub-guard-failure",
            workspaceDir: await fs.realpath(cwd),
        };
        let currentIdentity = identity;
        registerAgentIpcHandlersImpl({
            ...DefaultAgentIpcRegistrationDependencies,
            resolveWorkspaceSender: async () => currentIdentity,
        });
        const handlers = registeredHandlers();
        const ownerEvent = {
            sender: { id: 46, isDestroyed: () => false, once: vi.fn(), send: vi.fn() },
        };
        const unsubscribe = vi.fn();

        try {
            await handlers.get("agent:send")?.(ownerEvent, TrustedRequestContext, {
                sessionMetadata: metadata,
                context: {
                    workspaceId: identity.workspaceId,
                    workspaceDir: identity.workspaceDir,
                    sessionPath: metadata.path,
                    environment: {},
                },
                text: "first",
                provider: "p",
                model: "m",
            });
            const runtimeSubscribeSpy = vi.spyOn(AgentSessionRuntime.prototype, "subscribe").mockImplementation(() => {
                currentIdentity = { ...identity, windowId: "window-replaced" };
                return unsubscribe;
            });

            try {
                await expect(
                    handlers.get("agent:subscribe")?.(
                        { sender: { id: 47, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } },
                        TrustedRequestContext,
                        metadata.path
                    )
                ).rejects.toThrow(/changed during request/);
                expect(unsubscribe).toHaveBeenCalledOnce();
            } finally {
                runtimeSubscribeSpy.mockRestore();
            }
        } finally {
            sendConfiguredSpy.mockRestore();
        }
    });

    it("releases a live subscription when its initial session state delivery throws", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-live-sub-send-failure-"));
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const unsubscribe = vi.fn();
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-live-sub-send-failure",
            workspaceDir: await fs.realpath(cwd),
        };
        registerAgentIpcHandlersImpl({
            ...DefaultAgentIpcRegistrationDependencies,
            resolveWorkspaceSender: async () => identity,
        });
        const handlers = registeredHandlers();
        const ownerEvent = {
            sender: { id: 48, isDestroyed: () => false, once: vi.fn(), send: vi.fn() },
        };

        try {
            await handlers.get("agent:send")?.(ownerEvent, TrustedRequestContext, {
                sessionMetadata: metadata,
                context: {
                    workspaceId: identity.workspaceId,
                    workspaceDir: identity.workspaceDir,
                    sessionPath: metadata.path,
                    environment: {},
                },
                text: "first",
                provider: "p",
                model: "m",
            });
            const runtimeSubscribeSpy = vi
                .spyOn(AgentSessionRuntime.prototype, "subscribe")
                .mockReturnValue(unsubscribe);

            try {
                await expect(
                    handlers.get("agent:subscribe")?.(
                        {
                            sender: {
                                id: 49,
                                isDestroyed: () => false,
                                once: vi.fn(),
                                send: vi.fn(() => {
                                    throw new Error("session state delivery failed");
                                }),
                            },
                        },
                        TrustedRequestContext,
                        metadata.path
                    )
                ).rejects.toThrow(/session state delivery failed/);
                expect(unsubscribe).toHaveBeenCalledOnce();
            } finally {
                runtimeSubscribeSpy.mockRestore();
            }
        } finally {
            sendConfiguredSpy.mockRestore();
        }
    });

    it("cleans a live subscription when the registered subscribe handler final guard fails", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-live-sub-final-guard-"));
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const unsubscribe = vi.fn();
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-live-sub-final-guard",
            workspaceDir: await fs.realpath(cwd),
        };
        let currentIdentity = identity;
        registerAgentIpcHandlersImpl({
            ...DefaultAgentIpcRegistrationDependencies,
            resolveWorkspaceSender: async () => currentIdentity,
        });
        const handlers = registeredHandlers();
        const ownerEvent = {
            sender: { id: 50, isDestroyed: () => false, once: vi.fn(), send: vi.fn() },
        };

        try {
            await handlers.get("agent:send")?.(ownerEvent, TrustedRequestContext, {
                sessionMetadata: metadata,
                context: {
                    workspaceId: identity.workspaceId,
                    workspaceDir: identity.workspaceDir,
                    sessionPath: metadata.path,
                    environment: {},
                },
                text: "first",
                provider: "p",
                model: "m",
            });
            const runtimeSubscribeSpy = vi
                .spyOn(AgentSessionRuntime.prototype, "subscribe")
                .mockReturnValue(unsubscribe);
            const sender = {
                id: 51,
                isDestroyed: () => false,
                once: vi.fn(),
                send: vi.fn(() => {
                    currentIdentity = { ...identity, workspaceDir: path.dirname(identity.workspaceDir) };
                }),
            };

            try {
                await expect(
                    handlers.get("agent:subscribe")?.({ sender }, TrustedRequestContext, metadata.path)
                ).rejects.toThrow(/changed during request/);
                expect(unsubscribe).toHaveBeenCalledOnce();
            } finally {
                runtimeSubscribeSpy.mockRestore();
            }
        } finally {
            sendConfiguredSpy.mockRestore();
        }
    });

    it("cleans a pending subscription when the registered subscribe handler final guard fails", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-pending-sub-final-guard-"));
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-pending-sub-final-guard",
            workspaceDir: await fs.realpath(cwd),
        };
        let currentIdentity = identity;
        registerAgentIpcHandlersImpl({
            ...DefaultAgentIpcRegistrationDependencies,
            resolveWorkspaceSender: async () => currentIdentity,
        });
        const handlers = registeredHandlers();
        const pendingSender = {
            id: 52,
            isDestroyed: () => false,
            once: vi.fn(),
            send: vi.fn(() => {
                currentIdentity = { ...identity, windowId: "window-replaced" };
            }),
        };

        try {
            await expect(
                handlers.get("agent:subscribe")?.({ sender: pendingSender }, TrustedRequestContext, metadata.path)
            ).rejects.toThrow(/changed during request/);
            currentIdentity = identity;
            pendingSender.send.mockClear();
            pendingSender.send.mockImplementation(() => {});

            await handlers.get("agent:send")?.(
                {
                    sender: { id: 53, isDestroyed: () => false, once: vi.fn(), send: vi.fn() },
                },
                TrustedRequestContext,
                {
                    sessionMetadata: metadata,
                    context: {
                        workspaceId: identity.workspaceId,
                        workspaceDir: identity.workspaceDir,
                        sessionPath: metadata.path,
                        environment: {},
                    },
                    text: "first",
                    provider: "p",
                    model: "m",
                }
            );

            expect(pendingSender.send).not.toHaveBeenCalled();
        } finally {
            sendConfiguredSpy.mockRestore();
        }
    });

    it("revalidates live runtime ownership before disk-backed command side effects", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-command-guard-"));
        const { metadata, session } = await createPaneSession(cwd);
        await session.appendMessage(user("question"));
        await session.appendMessage(assistant("copy guarded answer"));
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const identity = {
            workspaceId: "workspace-1",
            generation: 5,
            windowId: "window-1",
            workspaceDir: await fs.realpath(cwd),
        };
        let resolveCount = 0;
        let failOnThirdResolve = false;
        registerAgentIpcHandlersImpl({
            ...DefaultAgentIpcRegistrationDependencies,
            resolveWorkspaceSender: async () => {
                resolveCount += 1;
                if (failOnThirdResolve && resolveCount >= 3) {
                    return { ...identity, workspaceId: "workspace-2" };
                }
                return identity;
            },
        });
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const event = { sender: { id: 15, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };

        try {
            await handlers.get("agent:send")?.(
                event,
                { workspaceId: "workspace-1", generation: 5 },
                {
                    sessionMetadata: metadata,
                    context: {
                        workspaceId: "workspace-1",
                        workspaceDir: identity.workspaceDir,
                        sessionPath: metadata.path,
                        environment: {},
                    },
                    text: "first",
                    provider: "p",
                    model: "m",
                }
            );

            resolveCount = 0;
            failOnThirdResolve = true;
            await expect(
                handlers.get("agent:run-command")?.(
                    event,
                    { workspaceId: "workspace-1", generation: 5 },
                    { command: "copy", cwd: cwd, sessionMetadata: metadata, argsText: "" }
                )
            ).rejects.toThrow(/changed during request/);
            expect(electron.clipboard.writeText).not.toHaveBeenCalledWith("copy guarded answer");
        } finally {
            sendConfiguredSpy.mockRestore();
        }
    });

    it("does not allow another Workspace to rebind the same canonical live session", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-live-workspace-bind-"));
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const workspaceDir = await fs.realpath(cwd);
        let activeWorkspaceId = "workspace-1";
        registerAgentIpcHandlersImpl({
            ...DefaultAgentIpcRegistrationDependencies,
            resolveWorkspaceSender: async () => ({
                workspaceId: activeWorkspaceId,
                generation: 1,
                windowId: `window-${activeWorkspaceId}`,
                workspaceDir,
            }),
        });
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const event = { sender: { id: 18, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };
        const makeSendInput = (workspaceId: string) => ({
            sessionMetadata: metadata,
            context: {
                workspaceId,
                workspaceDir,
                sessionPath: metadata.path,
                environment: {},
            },
            text: "hello",
            provider: "p",
            model: "m",
        });

        try {
            await handlers.get("agent:send")?.(
                event,
                { workspaceId: "workspace-1", generation: 1 },
                makeSendInput("workspace-1")
            );

            activeWorkspaceId = "workspace-2";

            await expect(
                handlers.get("agent:send")?.(
                    event,
                    { workspaceId: "workspace-2", generation: 1 },
                    makeSendInput("workspace-2")
                )
            ).rejects.toThrow(/live runtime belongs to another Workspace/);
            await expect(
                handlers.get("agent:get-session-state")?.(
                    event,
                    { workspaceId: "workspace-2", generation: 1 },
                    metadata
                )
            ).rejects.toThrow(/live runtime belongs to another Workspace/);
            await expect(
                handlers.get("agent:subscribe")?.(event, { workspaceId: "workspace-2", generation: 1 }, metadata.path)
            ).rejects.toThrow(/live runtime belongs to another Workspace/);
        } finally {
            sendConfiguredSpy.mockRestore();
        }
    });

    it("holds an IPC session access lease for a disk tree read and rejects new access behind archive", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-read-lease-"));
        const { metadata, session } = await createPaneSession(cwd);
        await session.appendMessage(user("held read"));
        const readGate = deferred<void>();
        const originalGetEntries = Session.prototype.getEntries;
        const getEntriesSpy = vi.spyOn(Session.prototype, "getEntries").mockImplementation(async function () {
            await readGate.promise;
            return await originalGetEntries.call(this);
        });
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-read-lease",
            workspaceDir: await fs.realpath(cwd),
        };
        const loadWorkspace = vi.fn(async () =>
            workspaceWithAgentState(identity.workspaceId, 0, { activesession: metadata })
        );
        const saveWorkspaceAgentState = vi.fn(async (data: SaveWorkspaceAgentStateData) => ({
            workspaceid: data.workspaceid,
            revision: data.expectedrevision + 1,
            state: data.state,
        }));
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace,
            saveWorkspaceAgentState,
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 30, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };
        const reading = handlers.get("agent:list-tree")?.(event, TrustedRequestContext, metadata) as Promise<unknown>;
        let archiveSettled = false;

        try {
            await vi.waitFor(() => expect(getEntriesSpy).toHaveBeenCalled());
            const archiving = (
                handlers.get("agent:archive-session")?.(event, TrustedRequestContext, metadata) as Promise<unknown>
            ).finally(() => {
                archiveSettled = true;
            });
            await Promise.resolve();
            await Promise.resolve();

            expect(archiveSettled).toBe(false);
            await expect(fs.stat(metadata.path)).resolves.toBeDefined();
            await expect(
                handlers.get("agent:get-session-state")?.(event, TrustedRequestContext, metadata)
            ).rejects.toThrow(/exclusive session mutation is active/);

            readGate.resolve();
            await reading;
            await archiving;
        } finally {
            readGate.resolve();
            await reading.catch(() => {});
            getEntriesSpy.mockRestore();
        }
    });

    it("holds an IPC session access lease for disk navigation until delete can mutate the file", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-write-lease-"));
        const { metadata, session } = await createPaneSession(cwd);
        const targetId = await session.appendMessage(user("navigate target"));
        await session.appendMessage(assistant("current leaf"));
        const moveGate = deferred<void>();
        const originalMoveTo = Session.prototype.moveTo;
        const moveToSpy = vi.spyOn(Session.prototype, "moveTo").mockImplementation(async function (...args) {
            await moveGate.promise;
            return await originalMoveTo.apply(this, args);
        });
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-write-lease",
            workspaceDir: await fs.realpath(cwd),
        };
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace: async () => workspaceWithAgentState(identity.workspaceId, 0, { activesession: metadata }),
            saveWorkspaceAgentState: async (data) => ({
                workspaceid: data.workspaceid,
                revision: data.expectedrevision + 1,
                state: data.state,
            }),
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 31, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };
        const navigating = handlers.get("agent:navigate-tree")?.(event, TrustedRequestContext, {
            sessionMetadata: metadata,
            targetId,
        }) as Promise<unknown>;
        let deleteSettled = false;

        try {
            await vi.waitFor(() => expect(moveToSpy).toHaveBeenCalled());
            const deleting = (
                handlers.get("agent:delete-session")?.(event, TrustedRequestContext, metadata) as Promise<unknown>
            ).finally(() => {
                deleteSettled = true;
            });
            await Promise.resolve();
            await Promise.resolve();

            expect(deleteSettled).toBe(false);
            await expect(fs.stat(metadata.path)).resolves.toBeDefined();
            await expect(
                handlers.get("agent:get-session-state")?.(event, TrustedRequestContext, metadata)
            ).rejects.toThrow(/exclusive session mutation is active/);

            moveGate.resolve();
            await navigating;
            await deleting;
        } finally {
            moveGate.resolve();
            await navigating.catch(() => {});
            moveToSpy.mockRestore();
        }
    });

    it.each([
        { kind: "pending", liveRuntime: false, senderId: 62 },
        { kind: "live-runtime", liveRuntime: true, senderId: 63 },
    ])(
        "removes a late $kind subscription captured after the initial archive snapshot",
        async ({ liveRuntime, senderId }) => {
            const cwd = await fs.mkdtemp(
                path.join(os.tmpdir(), `crest-agent-late-${liveRuntime ? "live" : "pending"}-`)
            );
            const created = await createPaneSession(cwd);
            const metadata = created.metadata;
            created.session.close();
            vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
            vi.mocked(buildAgentHarnessHost).mockImplementation((options) => {
                const host = makeHarnessHostMock();
                host.session = options.session as never;
                return host as never;
            });
            const sendConfiguredSpy = vi
                .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
                .mockResolvedValue("entry-1");
            const lateUnsubscribe = vi.fn();
            const runtimeSubscribeSpy = vi
                .spyOn(AgentSessionRuntime.prototype, "subscribe")
                .mockReturnValue(lateUnsubscribe);
            const exclusiveSpy = vi.spyOn(AgentRuntimeRegistry.prototype, "withExclusiveSessionMutation");
            const identity = {
                ...TrustedRequestContext,
                windowId: `window-late-${liveRuntime ? "live" : "pending"}`,
                workspaceDir: await fs.realpath(cwd),
                validatePreferredTerminal: async () => true,
            };
            registerAgentIpcHandlersImpl({
                resolveWorkspaceSender: async () => identity,
                ...DefaultAgentIpcRegistrationDependencies,
            });
            const handlers = registeredHandlers();
            const runtimeSender = { id: 64, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
            const oldSender = { id: senderId, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
            const authorizationStarted = deferred<void>();
            const releaseAuthorization = deferred<void>();
            let validationCount = 0;
            const authorization = {
                workspaceId: identity.workspaceId,
                generation: identity.generation,
                validateCurrent: vi.fn(async () => {
                    if (validationCount++ === 0) {
                        authorizationStarted.resolve();
                        await releaseAuthorization.promise;
                    }
                }),
                guardRuntime: vi.fn(async () => {}),
            };
            const sendInput = {
                sessionMetadata: metadata,
                context: {
                    workspaceId: identity.workspaceId,
                    workspaceDir: identity.workspaceDir,
                    sessionPath: metadata.path,
                    connection: "",
                    environment: {},
                    recentCmds: [],
                },
                text: "create runtime",
                provider: "p",
                model: "m",
            };

            try {
                if (liveRuntime) {
                    await handlers.get("agent:send")?.({ sender: runtimeSender }, TrustedRequestContext, sendInput);
                }
                const subscribing = subscribeAgentSessionForIpc(
                    oldSender as unknown as electron.WebContents,
                    metadata.path,
                    authorization as never
                );
                await authorizationStarted.promise;

                const archiving = archiveAgentSessionForIpc(metadata);
                await vi.waitFor(() => expect(exclusiveSpy).toHaveBeenCalledOnce());
                releaseAuthorization.resolve();
                await subscribing;
                oldSender.send.mockClear();
                const archived = await archiving;
                await fs.copyFile(archived.path, metadata.path);

                await handlers.get("agent:send")?.({ sender: runtimeSender }, TrustedRequestContext, sendInput);

                expect(runtimeSubscribeSpy).toHaveBeenCalledTimes(liveRuntime ? 1 : 0);
                expect(lateUnsubscribe).toHaveBeenCalledTimes(liveRuntime ? 1 : 0);
                expect(oldSender.send).not.toHaveBeenCalled();
            } finally {
                releaseAuthorization.resolve();
                exclusiveSpy.mockRestore();
                runtimeSubscribeSpy.mockRestore();
                sendConfiguredSpy.mockRestore();
            }
        }
    );

    it.each([
        { kind: "pending", liveRuntime: false, senderId: 67 },
        { kind: "live-runtime", liveRuntime: true, senderId: 68 },
    ])("serializes failed $kind restoration before a concurrent archive reuses the path", async ({
        liveRuntime,
        senderId,
    }) => {
        const cwd = await fs.mkdtemp(
            path.join(os.tmpdir(), `crest-agent-restore-serialization-${liveRuntime ? "live" : "pending"}-`)
        );
        const created = await createPaneSession(cwd);
        const metadata = created.metadata;
        created.session.close();
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockImplementation((options) => {
            const host = makeHarnessHostMock();
            host.session = options.session as never;
            return host as never;
        });
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const runtimeSubscribeSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "subscribe")
            .mockReturnValue(vi.fn());
        const identity = {
            ...TrustedRequestContext,
            windowId: `window-restore-serialization-${liveRuntime ? "live" : "pending"}`,
            workspaceDir: await fs.realpath(cwd),
            validatePreferredTerminal: async () => true,
        };
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            ...DefaultAgentIpcRegistrationDependencies,
        });
        const handlers = registeredHandlers();
        const runtimeSender = { id: 69, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
        const oldSender = { id: senderId, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
        const restorationStarted = deferred<void>();
        const releaseRestoration = deferred<void>();
        let gateRestoration = false;
        let restorationGated = false;
        const authorization = {
            workspaceId: identity.workspaceId,
            generation: identity.generation,
            validateCurrent: vi.fn(async () => {
                if (gateRestoration && !restorationGated) {
                    restorationGated = true;
                    restorationStarted.resolve();
                    await releaseRestoration.promise;
                }
            }),
            guardRuntime: vi.fn(async () => {}),
        };
        const sendInput = {
            sessionMetadata: metadata,
            context: {
                workspaceId: identity.workspaceId,
                workspaceDir: identity.workspaceDir,
                sessionPath: metadata.path,
                connection: "",
                environment: {},
                recentCmds: [],
            },
            text: "create runtime",
            provider: "p",
            model: "m",
        };
        const firstFailure = new Error("first archive preflight failed");
        let firstGuardCalls = 0;
        const failFirstPreflight = vi.fn(async () => {
            if (++firstGuardCalls === 2) throw firstFailure;
        });
        const secondInitialGuard = deferred<void>();
        let secondGuardCalls = 0;
        const secondGuard = vi.fn(async () => {
            if (++secondGuardCalls === 1) secondInitialGuard.resolve();
        });
        let first: Promise<JsonlSessionMetadata> | undefined;
        let second: Promise<JsonlSessionMetadata> | undefined;

        try {
            if (liveRuntime) {
                await handlers.get("agent:send")?.({ sender: runtimeSender }, TrustedRequestContext, sendInput);
            }
            await subscribeAgentSessionForIpc(
                oldSender as unknown as electron.WebContents,
                metadata.path,
                authorization as never
            );

            oldSender.send.mockClear();
            gateRestoration = true;

            first = archiveAgentSessionForIpc(metadata, failFirstPreflight);
            await restorationStarted.promise;
            second = archiveAgentSessionForIpc(metadata, secondGuard);
            await secondInitialGuard.promise;
            await new Promise<void>((resolve) => setImmediate(resolve));

            expect(secondGuard).toHaveBeenCalledOnce();
            releaseRestoration.resolve();
            await expect(first).rejects.toBe(firstFailure);
            const archived = await second;
            expect(secondGuard).toHaveBeenCalledTimes(3);

            oldSender.send.mockClear();
            await fs.copyFile(archived.path, metadata.path);
            await handlers.get("agent:send")?.({ sender: runtimeSender }, TrustedRequestContext, sendInput);

            expect(runtimeSubscribeSpy).toHaveBeenCalledTimes(liveRuntime ? 2 : 0);
            expect(oldSender.send).not.toHaveBeenCalled();
        } finally {
            releaseRestoration.resolve();
            await first?.catch(() => {});
            await second?.catch(() => {});
            runtimeSubscribeSpy.mockRestore();
            sendConfiguredSpy.mockRestore();
        }
    });

    it("releases a live runtime subscription before archiving its session", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-live-sub-archive-"));
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const unsubscribe = vi.fn();
        const runtimeSubscribeSpy = vi.spyOn(AgentSessionRuntime.prototype, "subscribe").mockReturnValue(unsubscribe);
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-live-sub-archive",
            workspaceDir: await fs.realpath(cwd),
        };
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace: async () => workspaceWithAgentState(identity.workspaceId, 0, {}),
            saveWorkspaceAgentState: async (data) => ({
                workspaceid: data.workspaceid,
                revision: data.expectedrevision + 1,
                state: data.state,
            }),
        });
        const handlers = registeredHandlers();
        const sender = { id: 37, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
        const event = { sender };

        try {
            await handlers.get("agent:send")?.(event, TrustedRequestContext, {
                sessionMetadata: metadata,
                context: {
                    workspaceId: identity.workspaceId,
                    workspaceDir: identity.workspaceDir,
                    sessionPath: metadata.path,
                    environment: {},
                },
                text: "first",
                provider: "p",
                model: "m",
            });
            await handlers.get("agent:subscribe")?.(event, TrustedRequestContext, metadata.path);

            await handlers.get("agent:archive-session")?.(event, TrustedRequestContext, metadata);

            expect(unsubscribe).toHaveBeenCalledOnce();
        } finally {
            sendConfiguredSpy.mockRestore();
            runtimeSubscribeSpy.mockRestore();
        }
    });

    it.each([
        { channel: "agent:archive-session", operation: "archive", senderId: 65 },
        { channel: "agent:delete-session", operation: "delete", senderId: 66 },
    ] as const)(
        "$operation aborts before moving or checkpointing when runtime session close fails",
        async ({ channel, operation, senderId }) => {
            const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `crest-agent-${operation}-close-failure-`));
            const created = await createPaneSession(cwd);
            const metadata = created.metadata;
            created.session.close();
            vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
            vi.mocked(buildAgentHarnessHost).mockImplementation((options) => {
                const host = makeHarnessHostMock();
                host.session = options.session as never;
                return host as never;
            });
            const sendConfiguredSpy = vi
                .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
                .mockResolvedValue("entry-1");
            const unsubscribe = vi.fn();
            const runtimeSubscribeSpy = vi
                .spyOn(AgentSessionRuntime.prototype, "subscribe")
                .mockReturnValue(unsubscribe);
            const archiveSpy = vi.spyOn(SqliteSessionRepo.prototype, "archive");
            const stageDeleteSpy = vi.spyOn(SqliteSessionRepo.prototype, "stageDelete");
            const mutationSpy = operation === "archive" ? archiveSpy : stageDeleteSpy;
            const identity = {
                ...TrustedRequestContext,
                windowId: `window-${operation}-close-failure`,
                workspaceDir: await fs.realpath(cwd),
            };
            const workspace = workspaceWithAgentState(identity.workspaceId, 3, { activesession: metadata });
            const saveWorkspaceAgentState = vi.fn(async (data: SaveWorkspaceAgentStateData) => ({
                workspaceid: data.workspaceid,
                revision: data.expectedrevision + 1,
                state: data.state,
            }));
            registerAgentIpcHandlersImpl({
                resolveWorkspaceSender: async () => identity,
                loadWorkspace: async () => workspace,
                saveWorkspaceAgentState,
            });
            const handlers = registeredHandlers();
            const sender = { id: senderId, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
            const event = { sender };
            const sendInput = {
                sessionMetadata: metadata,
                context: {
                    workspaceId: identity.workspaceId,
                    workspaceDir: identity.workspaceDir,
                    sessionPath: metadata.path,
                    environment: {},
                },
                text: "create runtime",
                provider: "p",
                model: "m",
            };

            try {
                await handlers.get("agent:send")?.(event, TrustedRequestContext, sendInput);
                await handlers.get("agent:subscribe")?.(event, TrustedRequestContext, metadata.path);
                const host = vi.mocked(buildAgentHarnessHost).mock.results.at(-1)?.value as unknown as {
                    session: Session;
                };
                const storage = host.session.getStorage() as SqliteSessionStorage;
                const closeStorage = storage.close.bind(storage);
                const closeFailure = new Error(`${operation} runtime session close failed`);
                const closeSpy = vi
                    .spyOn(storage, "close")
                    .mockImplementationOnce(() => {
                        throw closeFailure;
                    })
                    .mockImplementation(closeStorage);

                await expect(handlers.get(channel)?.(event, TrustedRequestContext, metadata)).rejects.toBe(
                    closeFailure
                );

                expect(mutationSpy).not.toHaveBeenCalled();
                expect(saveWorkspaceAgentState).not.toHaveBeenCalled();
                expect(workspace.agentstate?.activesession?.path).toBe(metadata.path);
                await expect(fs.access(metadata.path)).resolves.toBeUndefined();
                expect(unsubscribe).toHaveBeenCalledOnce();
                expect(runtimeSubscribeSpy).toHaveBeenCalledOnce();

                await handlers.get(channel)?.(event, TrustedRequestContext, metadata);

                expect(closeSpy).toHaveBeenCalledTimes(2);
                expect(mutationSpy).toHaveBeenCalledOnce();
                expect(saveWorkspaceAgentState).toHaveBeenCalledOnce();
                expect(closeSpy.mock.invocationCallOrder[1]).toBeLessThan(mutationSpy.mock.invocationCallOrder[0]);
            } finally {
                archiveSpy.mockRestore();
                stageDeleteSpy.mockRestore();
                runtimeSubscribeSpy.mockRestore();
                sendConfiguredSpy.mockRestore();
            }
        }
    );

    it("removes a pending persisted subscription before an archived path can be reused", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-pending-sub-archive-"));
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-pending-sub-archive",
            workspaceDir: await fs.realpath(cwd),
        };
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace: async () => workspaceWithAgentState(identity.workspaceId, 0, {}),
            saveWorkspaceAgentState: async (data) => ({
                workspaceid: data.workspaceid,
                revision: data.expectedrevision + 1,
                state: data.state,
            }),
        });
        const handlers = registeredHandlers();
        const pendingSender = { id: 38, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
        const archiveSender = { id: 39, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };

        try {
            await handlers.get("agent:subscribe")?.({ sender: pendingSender }, TrustedRequestContext, metadata.path);
            pendingSender.send.mockClear();
            const archived = (await handlers.get("agent:archive-session")?.(
                { sender: archiveSender },
                TrustedRequestContext,
                metadata
            )) as JsonlSessionMetadata;
            await fs.copyFile(archived.path, metadata.path);

            await handlers.get("agent:send")?.({ sender: archiveSender }, TrustedRequestContext, {
                sessionMetadata: metadata,
                context: {
                    workspaceId: identity.workspaceId,
                    workspaceDir: identity.workspaceDir,
                    sessionPath: metadata.path,
                    environment: {},
                },
                text: "reuse path",
                provider: "p",
                model: "m",
            });

            expect(pendingSender.send).not.toHaveBeenCalled();
        } finally {
            sendConfiguredSpy.mockRestore();
        }
    });

    it("archives before durably clearing only activeSession and waits for the checkpoint save", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-archive-checkpoint-"));
        const { metadata } = await createPaneSession(cwd);
        const selection = { provider: "provider", model: "model", reasoning: "high" as const };
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-archive-checkpoint",
            workspaceDir: await fs.realpath(cwd),
        };
        const saveGate = deferred<WorkspaceAgentStateCheckpoint>();
        const saveWorkspaceAgentState = vi.fn(() => saveGate.promise);
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace: async () =>
                workspaceWithAgentState(identity.workspaceId, 4, {
                    activesession: metadata,
                    selection,
                    preferredterminaltabid: "terminal-1",
                }),
            saveWorkspaceAgentState,
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 32, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };
        let archiveSettled = false;
        const archiving = (
            handlers.get("agent:archive-session")?.(event, TrustedRequestContext, metadata) as Promise<unknown>
        ).finally(() => {
            archiveSettled = true;
        });

        try {
            await vi.waitFor(() => expect(saveWorkspaceAgentState).toHaveBeenCalledOnce());
            expect(archiveSettled).toBe(false);
            await expect(fs.stat(metadata.path)).rejects.toThrow();
            expect(saveWorkspaceAgentState).toHaveBeenCalledWith({
                workspaceid: identity.workspaceId,
                expectedrevision: 4,
                state: {
                    selection,
                    preferredterminaltabid: "terminal-1",
                },
            });

            saveGate.resolve({
                workspaceid: identity.workspaceId,
                revision: 5,
                state: { selection, preferredterminaltabid: "terminal-1" },
            });
            await archiving;
        } finally {
            saveGate.resolve({
                workspaceid: identity.workspaceId,
                revision: 5,
                state: { selection, preferredterminaltabid: "terminal-1" },
            });
            await archiving.catch(() => {});
        }
    });

    it("does not dispose a runtime and restores its subscription when archive checkpoint loading fails", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-archive-load-failure-"));
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const disposeSpy = vi.spyOn(AgentSessionRuntime.prototype, "dispose");
        const unsubscribe = vi.fn();
        const runtimeSubscribeSpy = vi.spyOn(AgentSessionRuntime.prototype, "subscribe").mockReturnValue(unsubscribe);
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-archive-load-failure",
            workspaceDir: await fs.realpath(cwd),
        };
        const loadFailure = new Error("workspace checkpoint load failed");
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace: async () => {
                throw loadFailure;
            },
            saveWorkspaceAgentState: async (data) => ({
                workspaceid: data.workspaceid,
                revision: data.expectedrevision + 1,
                state: data.state,
            }),
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 40, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };

        try {
            await handlers.get("agent:send")?.(event, TrustedRequestContext, {
                sessionMetadata: metadata,
                context: {
                    workspaceId: identity.workspaceId,
                    workspaceDir: identity.workspaceDir,
                    sessionPath: metadata.path,
                    environment: {},
                },
                text: "first",
                provider: "p",
                model: "m",
            });
            await handlers.get("agent:subscribe")?.(event, TrustedRequestContext, metadata.path);

            await expect(handlers.get("agent:archive-session")?.(event, TrustedRequestContext, metadata)).rejects.toBe(
                loadFailure
            );
            await expect(fs.access(metadata.path)).resolves.toBeUndefined();
            expect(disposeSpy).not.toHaveBeenCalled();
            expect(unsubscribe).toHaveBeenCalledOnce();
            expect(runtimeSubscribeSpy).toHaveBeenCalledTimes(2);
        } finally {
            sendConfiguredSpy.mockRestore();
            disposeSpy.mockRestore();
            runtimeSubscribeSpy.mockRestore();
        }
    });

    it("restores a subscription when an event races a failing archive preflight", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-sub-preflight-race-"));
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const listeners: Array<(event: { type: string; status: string }) => void> = [];
        const unsubscribes: ReturnType<typeof vi.fn>[] = [];
        const runtimeSubscribeSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "subscribe")
            .mockImplementation((listener) => {
                listeners.push(listener as (event: { type: string; status: string }) => void);
                const unsubscribe = vi.fn();
                unsubscribes.push(unsubscribe);
                return unsubscribe;
            });
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-sub-preflight-race",
            workspaceDir: await fs.realpath(cwd),
        };
        const loadGate = deferred<Workspace>();
        const loadWorkspace = vi.fn(() => loadGate.promise);
        const preflightFailure = new Error("workspace preflight failed");
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace,
            saveWorkspaceAgentState: DefaultAgentIpcRegistrationDependencies.saveWorkspaceAgentState,
        });
        const handlers = registeredHandlers();
        const sender = { id: 58, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
        const event = { sender };

        try {
            await handlers.get("agent:send")?.(event, TrustedRequestContext, {
                sessionMetadata: metadata,
                context: {
                    workspaceId: identity.workspaceId,
                    workspaceDir: identity.workspaceDir,
                    sessionPath: metadata.path,
                    environment: {},
                },
                text: "first",
                provider: "p",
                model: "m",
            });
            await handlers.get("agent:subscribe")?.(event, TrustedRequestContext, metadata.path);
            const archiving = handlers.get("agent:archive-session")?.(
                event,
                TrustedRequestContext,
                metadata
            ) as Promise<unknown>;
            await vi.waitFor(() => expect(loadWorkspace).toHaveBeenCalledOnce());

            listeners[0]({ type: "status", status: "idle" });
            await vi.waitFor(() => expect(unsubscribes[0]).toHaveBeenCalledOnce());
            loadGate.reject(preflightFailure);

            await expect(archiving).rejects.toBe(preflightFailure);
            expect(runtimeSubscribeSpy).toHaveBeenCalledTimes(2);

            sender.send.mockClear();
            listeners[1]({ type: "status", status: "idle" });
            await vi.waitFor(() => expect(sender.send).toHaveBeenCalledOnce());
        } finally {
            loadGate.reject(preflightFailure);
            sendConfiguredSpy.mockRestore();
            runtimeSubscribeSpy.mockRestore();
        }
    });

    it.each([
        { operation: "archive", runningFailure: false, senderId: 70 },
        { operation: "delete", runningFailure: true, senderId: 71 },
    ] as const)(
        "keeps a restored live subscription when an event races a failing $operation",
        async ({ operation, runningFailure, senderId }) => {
            const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `crest-agent-${operation}-restore-event-race-`));
            const created = await createPaneSession(cwd);
            const metadata = created.metadata;
            created.session.close();
            vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
            const host = makeHarnessHostMock();
            const harnessListeners: Array<(event: { type: "status"; status: "idle" }) => void> = [];
            host.harness.subscribe.mockImplementation(((
                listener: (event: { type: "status"; status: "idle" }) => void
            ) => {
                harnessListeners.push(listener);
                return vi.fn();
            }) as never);
            vi.mocked(buildAgentHarnessHost).mockImplementation((options) => {
                host.session = options.session as never;
                return host as never;
            });
            const sendConfiguredSpy = vi
                .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
                .mockResolvedValue("entry-1");
            const originalSubscribe = AgentSessionRuntime.prototype.subscribe;
            const unsubscribes: ReturnType<typeof vi.fn>[] = [];
            const runtimeSubscribeSpy = vi
                .spyOn(AgentSessionRuntime.prototype, "subscribe")
                .mockImplementation(function (this: AgentSessionRuntime, listener) {
                    const unsubscribe = vi.fn(originalSubscribe.call(this, listener));
                    unsubscribes.push(unsubscribe);
                    return unsubscribe;
                });
            const identity = {
                ...TrustedRequestContext,
                windowId: `window-${operation}-restore-event-race`,
                workspaceDir: await fs.realpath(cwd),
            };
            registerAgentIpcHandlersImpl({
                resolveWorkspaceSender: async () => identity,
                ...DefaultAgentIpcRegistrationDependencies,
            });
            const handlers = registeredHandlers();
            const runtimeSender = { id: 72, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
            const sender = { id: senderId, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
            const restorationListenerReady = deferred<void>();
            const releaseRestorationGuard = deferred<void>();
            let gateRestoration = false;
            let restorationValidationCalls = 0;
            const authorization = {
                workspaceId: identity.workspaceId,
                generation: identity.generation,
                validateCurrent: vi.fn(async () => {
                    if (!gateRestoration) return;
                    if (++restorationValidationCalls === 2) {
                        restorationListenerReady.resolve();
                        await releaseRestorationGuard.promise;
                    }
                }),
                guardRuntime: vi.fn(async () => {}),
            };
            const sendInput = {
                sessionMetadata: metadata,
                context: {
                    workspaceId: identity.workspaceId,
                    workspaceDir: identity.workspaceDir,
                    sessionPath: metadata.path,
                    environment: {},
                },
                text: "create runtime",
                provider: "p",
                model: "m",
            };
            const preflightFailure = new Error("archive preflight failed");
            let preflightChecks = 0;
            const beforeMutation = vi.fn(async () => {
                if (!runningFailure && ++preflightChecks === 2) throw preflightFailure;
            });
            let removalResult: Promise<unknown> | undefined;

            try {
                await handlers.get("agent:send")?.({ sender: runtimeSender }, TrustedRequestContext, sendInput);
                await subscribeAgentSessionForIpc(
                    sender as unknown as electron.WebContents,
                    metadata.path,
                    authorization as never
                );
                sender.send.mockClear();
                if (runningFailure) {
                    host.harness.isIdle.mockReturnValue(false);
                }
                gateRestoration = true;

                const removal =
                    operation === "archive"
                        ? archiveAgentSessionForIpc(metadata, beforeMutation)
                        : deleteAgentSessionForIpc(metadata, beforeMutation);
                removalResult = removal.catch((error) => error);
                await restorationListenerReady.promise;
                expect(runtimeSubscribeSpy).toHaveBeenCalledTimes(2);

                harnessListeners[0]({ type: "status", status: "idle" });
                await new Promise<void>((resolve) => setImmediate(resolve));
                expect(unsubscribes[0]).toHaveBeenCalledOnce();
                expect(unsubscribes[1]).not.toHaveBeenCalled();

                releaseRestorationGuard.resolve();
                const removalError = await removalResult;
                if (runningFailure) {
                    expect(removalError).toEqual(
                        expect.objectContaining({ message: expect.stringMatching(/running/i) })
                    );
                } else {
                    expect(removalError).toBe(preflightFailure);
                }

                sender.send.mockClear();
                harnessListeners[0]({ type: "status", status: "idle" });
                await vi.waitFor(() => expect(sender.send).toHaveBeenCalledOnce());
                expect(unsubscribes[1]).not.toHaveBeenCalled();
            } finally {
                releaseRestorationGuard.resolve();
                await removalResult;
                runtimeSubscribeSpy.mockRestore();
                sendConfiguredSpy.mockRestore();
            }
        }
    );

    it("closes validation and runtime SQLite handles before archive rename", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-archive-handle-order-"));
        const created = await createPaneSession(cwd);
        const metadata = created.metadata;
        (created.session.getStorage() as SqliteSessionStorage).close();
        const openHandles = new Set<SqliteSessionStorage>();
        const originalOpen = SqliteSessionStorage.open.bind(SqliteSessionStorage);
        const openSpy = vi.spyOn(SqliteSessionStorage, "open").mockImplementation((sessionPath) => {
            const storage = originalOpen(sessionPath);
            openHandles.add(storage);
            const close = storage.close.bind(storage);
            vi.spyOn(storage, "close").mockImplementation(() => {
                openHandles.delete(storage);
                close();
            });
            return storage;
        });
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockImplementation((options) => {
            const host = makeHarnessHostMock();
            host.session = options.session as never;
            return host as never;
        });
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const originalArchive = SqliteSessionRepo.prototype.archive;
        const archiveSpy = vi.spyOn(SqliteSessionRepo.prototype, "archive").mockImplementation(async function (input) {
            expect(openHandles.size).toBe(0);
            return await originalArchive.call(this, input);
        });
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-archive-handle-order",
            workspaceDir: await fs.realpath(cwd),
        };
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace: async () => workspaceWithAgentState(identity.workspaceId, 0, {}),
            saveWorkspaceAgentState: DefaultAgentIpcRegistrationDependencies.saveWorkspaceAgentState,
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 59, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };

        try {
            await handlers.get("agent:send")?.(event, TrustedRequestContext, {
                sessionMetadata: metadata,
                context: {
                    workspaceId: identity.workspaceId,
                    workspaceDir: identity.workspaceDir,
                    sessionPath: metadata.path,
                    environment: {},
                },
                text: "first",
                provider: "p",
                model: "m",
            });

            await handlers.get("agent:archive-session")?.(event, TrustedRequestContext, metadata);
            expect(archiveSpy).toHaveBeenCalledOnce();
        } finally {
            for (const storage of [...openHandles]) {
                storage.close();
            }
            sendConfiguredSpy.mockRestore();
            archiveSpy.mockRestore();
            openSpy.mockRestore();
        }
    });

    it("closes every opened SQLite handle when runtime construction fails", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-runtime-create-failure-"));
        const created = await createPaneSession(cwd);
        const metadata = created.metadata;
        created.session.close();
        const opened: SqliteSessionStorage[] = [];
        const closed = new Set<SqliteSessionStorage>();
        const originalOpen = SqliteSessionStorage.open.bind(SqliteSessionStorage);
        const openSpy = vi.spyOn(SqliteSessionStorage, "open").mockImplementation((sessionPath) => {
            const storage = originalOpen(sessionPath);
            opened.push(storage);
            const close = storage.close.bind(storage);
            vi.spyOn(storage, "close").mockImplementation(() => {
                closed.add(storage);
                close();
            });
            return storage;
        });
        const failure = new Error("runtime host construction failed");
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockImplementation(() => {
            throw failure;
        });
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-runtime-create-failure",
            workspaceDir: await fs.realpath(cwd),
        };
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            ...DefaultAgentIpcRegistrationDependencies,
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 61, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };

        try {
            await expect(
                handlers.get("agent:send")?.(event, TrustedRequestContext, {
                    sessionMetadata: metadata,
                    context: {
                        workspaceId: identity.workspaceId,
                        workspaceDir: identity.workspaceDir,
                        sessionPath: metadata.path,
                        environment: {},
                    },
                    text: "first",
                    provider: "p",
                    model: "m",
                })
            ).rejects.toThrow(failure.message);

            expect(opened.length).toBeGreaterThan(0);
            expect(closed).toEqual(new Set(opened));
        } finally {
            for (const storage of opened) {
                if (!closed.has(storage)) storage.close();
            }
            openSpy.mockRestore();
        }
    });

    it("closes a temporary SQLite handle when a disk tree guard fails", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-tree-handle-failure-"));
        const created = await createPaneSession(cwd);
        const metadata = created.metadata;
        (created.session.getStorage() as SqliteSessionStorage).close();
        const originalOpen = SqliteSessionStorage.open.bind(SqliteSessionStorage);
        let opened: SqliteSessionStorage | undefined;
        const openSpy = vi.spyOn(SqliteSessionStorage, "open").mockImplementation((sessionPath) => {
            opened = originalOpen(sessionPath);
            return opened;
        });
        const close = vi.spyOn(SqliteSessionStorage.prototype, "close");
        const failure = new Error("tree guard failed");

        try {
            await expect(
                listAgentTreeForIpc(metadata, undefined, async () => {
                    throw failure;
                })
            ).rejects.toBe(failure);
            expect(close).toHaveBeenCalledOnce();
        } finally {
            if (opened && close.mock.calls.length === 0) {
                opened.close();
            }
            close.mockRestore();
            openSpy.mockRestore();
        }
    });

    it("restores an archived session when its checkpoint save fails", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-archive-rollback-"));
        const { metadata } = await createPaneSession(cwd);
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-archive-rollback",
            workspaceDir: await fs.realpath(cwd),
        };
        const failure = new Error("archive checkpoint unavailable");
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace: async () => workspaceWithAgentState(identity.workspaceId, 1, { activesession: metadata }),
            saveWorkspaceAgentState: async () => {
                throw failure;
            },
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 41, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };
        const archiveRoot = path.join(path.dirname(metadata.path), ".archive");

        await expect(handlers.get("agent:archive-session")?.(event, TrustedRequestContext, metadata)).rejects.toBe(
            failure
        );
        await expect(fs.access(metadata.path)).resolves.toBeUndefined();
        await expect(fs.readdir(archiveRoot)).resolves.toEqual([]);
    });

    it.each(["agent:archive-session", "agent:delete-session"] as const)(
        "restores a live subscription after %s rolls back",
        async (channel) => {
            const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-live-sub-rollback-"));
            const { metadata } = await createPaneSession(cwd);
            const canonicalPath = await fs.realpath(metadata.path);
            vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
            vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
            const sendConfiguredSpy = vi
                .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
                .mockResolvedValue("entry-1");
            const firstUnsubscribe = vi.fn();
            const restoredUnsubscribe = vi.fn();
            const runtimeSubscribeSpy = vi
                .spyOn(AgentSessionRuntime.prototype, "subscribe")
                .mockReturnValueOnce(firstUnsubscribe)
                .mockReturnValueOnce(restoredUnsubscribe);
            const identity = {
                ...TrustedRequestContext,
                windowId: `window-live-sub-rollback-${channel}`,
                workspaceDir: await fs.realpath(cwd),
            };
            const checkpointFailure = new Error(`${channel} checkpoint unavailable`);
            registerAgentIpcHandlersImpl({
                resolveWorkspaceSender: async () => identity,
                loadWorkspace: async () =>
                    workspaceWithAgentState(identity.workspaceId, 1, { activesession: metadata }),
                saveWorkspaceAgentState: async () => {
                    throw checkpointFailure;
                },
            });
            const handlers = registeredHandlers();
            const sender = {
                id: channel === "agent:archive-session" ? 54 : 55,
                isDestroyed: () => false,
                once: vi.fn(),
                send: vi.fn(),
            };
            const event = { sender };
            const sendInput = {
                sessionMetadata: metadata,
                context: {
                    workspaceId: identity.workspaceId,
                    workspaceDir: identity.workspaceDir,
                    sessionPath: metadata.path,
                    environment: {},
                },
                text: "resume",
                provider: "p",
                model: "m",
            };

            try {
                await handlers.get("agent:send")?.(event, TrustedRequestContext, sendInput);
                await handlers.get("agent:subscribe")?.(event, TrustedRequestContext, metadata.path);
                sender.send.mockClear();

                await expect(handlers.get(channel)?.(event, TrustedRequestContext, metadata)).rejects.toBe(
                    checkpointFailure
                );
                expect(firstUnsubscribe).toHaveBeenCalledOnce();

                await handlers.get("agent:send")?.(event, TrustedRequestContext, sendInput);

                expect(runtimeSubscribeSpy).toHaveBeenCalledTimes(2);
                expect(sender.send).toHaveBeenCalledWith(
                    "agent:event",
                    expect.objectContaining({
                        sessionPath: canonicalPath,
                        event: expect.objectContaining({ type: "session_state" }),
                    })
                );

                await handlers.get("agent:unsubscribe")?.(event, TrustedRequestContext, metadata.path);
                expect(restoredUnsubscribe).toHaveBeenCalledOnce();
            } finally {
                sendConfiguredSpy.mockRestore();
                runtimeSubscribeSpy.mockRestore();
            }
        }
    );

    it("restores a pending subscription after an archive rollback", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-pending-sub-rollback-"));
        const { metadata } = await createPaneSession(cwd);
        const canonicalPath = await fs.realpath(metadata.path);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue(makeHarnessHostMock() as never);
        const sendConfiguredSpy = vi
            .spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig")
            .mockResolvedValue("entry-1");
        const unsubscribe = vi.fn();
        const runtimeSubscribeSpy = vi.spyOn(AgentSessionRuntime.prototype, "subscribe").mockReturnValue(unsubscribe);
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-pending-sub-rollback",
            workspaceDir: await fs.realpath(cwd),
        };
        const checkpointFailure = new Error("archive checkpoint unavailable");
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace: async () => workspaceWithAgentState(identity.workspaceId, 1, { activesession: metadata }),
            saveWorkspaceAgentState: async () => {
                throw checkpointFailure;
            },
        });
        const handlers = registeredHandlers();
        const pendingSender = { id: 56, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
        const mutationSender = { id: 57, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };

        try {
            await handlers.get("agent:subscribe")?.({ sender: pendingSender }, TrustedRequestContext, metadata.path);
            pendingSender.send.mockClear();

            await expect(
                handlers.get("agent:archive-session")?.({ sender: mutationSender }, TrustedRequestContext, metadata)
            ).rejects.toBe(checkpointFailure);

            await handlers.get("agent:send")?.({ sender: mutationSender }, TrustedRequestContext, {
                sessionMetadata: metadata,
                context: {
                    workspaceId: identity.workspaceId,
                    workspaceDir: identity.workspaceDir,
                    sessionPath: metadata.path,
                    environment: {},
                },
                text: "resume",
                provider: "p",
                model: "m",
            });

            expect(runtimeSubscribeSpy).toHaveBeenCalledOnce();
            expect(pendingSender.send).toHaveBeenCalledWith(
                "agent:event",
                expect.objectContaining({
                    sessionPath: canonicalPath,
                    event: expect.objectContaining({ type: "session_state" }),
                })
            );
        } finally {
            sendConfiguredSpy.mockRestore();
            runtimeSubscribeSpy.mockRestore();
        }
    });

    it("reports both checkpoint and rollback failures after an archive collision", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-archive-partial-"));
        const { metadata } = await createPaneSession(cwd);
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-archive-partial",
            workspaceDir: await fs.realpath(cwd),
        };
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace: async () => workspaceWithAgentState(identity.workspaceId, 1, { activesession: metadata }),
            saveWorkspaceAgentState: async () => {
                await fs.writeFile(metadata.path, "rollback collision");
                throw new Error("archive checkpoint unavailable");
            },
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 42, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };

        await expect(handlers.get("agent:archive-session")?.(event, TrustedRequestContext, metadata)).rejects.toThrow(
            /partial failure.*archive checkpoint unavailable.*restore target already exists/i
        );
    });

    it("keeps a successful delete recoverable under .trash and out of normal session lists", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-delete-staged-"));
        const { metadata } = await createPaneSession(cwd);
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-delete-staged",
            workspaceDir: await fs.realpath(cwd),
        };
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace: async () => workspaceWithAgentState(identity.workspaceId, 0, {}),
            saveWorkspaceAgentState: async (data) => ({
                workspaceid: data.workspaceid,
                revision: data.expectedrevision + 1,
                state: data.state,
            }),
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 43, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };
        const trashRoot = path.join(path.dirname(metadata.path), ".trash");

        await handlers.get("agent:delete-session")?.(event, TrustedRequestContext, metadata);

        const [uniqueDir] = await fs.readdir(trashRoot);
        const deletedPath = path.join(trashRoot, uniqueDir, path.basename(metadata.path));
        await expect(fs.access(metadata.path)).rejects.toThrow();
        await expect(fs.access(deletedPath)).resolves.toBeUndefined();
        await expect(handlers.get("agent:list-sessions")?.(event, TrustedRequestContext)).resolves.toEqual([]);
    });

    it("retries a stale delete checkpoint only while the authoritative active path still matches", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-delete-cas-"));
        const { metadata } = await createPaneSession(cwd);
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-delete-cas",
            workspaceDir: await fs.realpath(cwd),
        };
        const stale = new Error("stale workspace checkpoint: expected Agent revision 1");
        const loadWorkspace = vi
            .fn()
            .mockResolvedValueOnce(workspaceWithAgentState(identity.workspaceId, 1, { activesession: metadata }))
            .mockResolvedValueOnce(workspaceWithAgentState(identity.workspaceId, 2, { activesession: metadata }));
        const saveWorkspaceAgentState = vi
            .fn()
            .mockRejectedValueOnce(stale)
            .mockImplementationOnce(async (data: SaveWorkspaceAgentStateData) => ({
                workspaceid: data.workspaceid,
                revision: data.expectedrevision + 1,
                state: data.state,
            }));
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace,
            saveWorkspaceAgentState,
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 33, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };

        await handlers.get("agent:delete-session")?.(event, TrustedRequestContext, metadata);

        expect(loadWorkspace).toHaveBeenCalledTimes(2);
        expect(saveWorkspaceAgentState).toHaveBeenCalledTimes(2);
        expect(saveWorkspaceAgentState).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ expectedrevision: 2, state: {} })
        );
    });

    it("does not clear a replacement active session after a stale delete checkpoint", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-delete-replacement-"));
        const { metadata } = await createPaneSession(cwd);
        const replacement = {
            ...metadata,
            id: "replacement",
            path: path.join(path.dirname(metadata.path), "replacement.db"),
        };
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-delete-replacement",
            workspaceDir: await fs.realpath(cwd),
        };
        const loadWorkspace = vi
            .fn()
            .mockResolvedValueOnce(workspaceWithAgentState(identity.workspaceId, 1, { activesession: metadata }))
            .mockResolvedValueOnce(workspaceWithAgentState(identity.workspaceId, 2, { activesession: replacement }));
        const saveWorkspaceAgentState = vi
            .fn()
            .mockRejectedValueOnce(new Error("stale workspace checkpoint: expected Agent revision 1"));
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace,
            saveWorkspaceAgentState,
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 34, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };

        await handlers.get("agent:delete-session")?.(event, TrustedRequestContext, metadata);

        expect(loadWorkspace).toHaveBeenCalledTimes(2);
        expect(saveWorkspaceAgentState).toHaveBeenCalledOnce();
    });

    it("does not clear a replacement with the same path but different stable session identity", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-delete-same-path-replacement-"));
        const { metadata } = await createPaneSession(cwd);
        const replacement = {
            ...metadata,
            id: "replacement-id",
            createdAt: new Date(Date.parse(metadata.createdAt) + 1000).toISOString(),
        };
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-delete-same-path-replacement",
            workspaceDir: await fs.realpath(cwd),
        };
        const loadWorkspace = vi
            .fn()
            .mockResolvedValueOnce(workspaceWithAgentState(identity.workspaceId, 1, { activesession: metadata }))
            .mockResolvedValueOnce(workspaceWithAgentState(identity.workspaceId, 2, { activesession: replacement }));
        const saveWorkspaceAgentState = vi
            .fn()
            .mockRejectedValueOnce(new Error("stale workspace checkpoint: expected Agent revision 1"));
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace,
            saveWorkspaceAgentState,
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 44, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };

        await handlers.get("agent:delete-session")?.(event, TrustedRequestContext, metadata);

        expect(loadWorkspace).toHaveBeenCalledTimes(2);
        expect(saveWorkspaceAgentState).toHaveBeenCalledOnce();
    });

    it("does not let a symlink path bypass stable session identity matching", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-archive-symlink-identity-"));
        const { metadata } = await createPaneSession(cwd);
        const aliasPath = path.join(path.dirname(metadata.path), "active-alias.db");
        await fs.symlink(metadata.path, aliasPath);
        const forgedActive = {
            ...metadata,
            id: "forged-id",
            createdAt: new Date(Date.parse(metadata.createdAt) + 1000).toISOString(),
            path: aliasPath,
        };
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-archive-symlink-identity",
            workspaceDir: await fs.realpath(cwd),
        };
        const saveWorkspaceAgentState = vi.fn();
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace: async () =>
                workspaceWithAgentState(identity.workspaceId, 1, { activesession: forgedActive }),
            saveWorkspaceAgentState,
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 45, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };

        await handlers.get("agent:archive-session")?.(event, TrustedRequestContext, metadata);

        expect(saveWorkspaceAgentState).not.toHaveBeenCalled();
    });

    it("propagates a non-stale delete checkpoint failure after restoring the session file", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-delete-save-failure-"));
        const { metadata } = await createPaneSession(cwd);
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-delete-save-failure",
            workspaceDir: await fs.realpath(cwd),
        };
        const failure = new Error("checkpoint unavailable");
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => identity,
            loadWorkspace: async () => workspaceWithAgentState(identity.workspaceId, 1, { activesession: metadata }),
            saveWorkspaceAgentState: async () => {
                throw failure;
            },
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 35, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };

        await expect(handlers.get("agent:delete-session")?.(event, TrustedRequestContext, metadata)).rejects.toBe(
            failure
        );
        await expect(fs.access(metadata.path)).resolves.toBeUndefined();
        await expect(fs.readdir(path.join(path.dirname(metadata.path), ".trash"))).resolves.toEqual([]);
    });

    it("finishes the authorized durable clear before rejecting a sender that goes stale after deletion", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-delete-stale-sender-"));
        const { metadata } = await createPaneSession(cwd);
        const identity = {
            ...TrustedRequestContext,
            windowId: "window-delete-stale-sender",
            workspaceDir: await fs.realpath(cwd),
        };
        const saveWorkspaceAgentState = vi.fn(async (data: SaveWorkspaceAgentStateData) => ({
            workspaceid: data.workspaceid,
            revision: data.expectedrevision + 1,
            state: data.state,
        }));
        registerAgentIpcHandlersImpl({
            resolveWorkspaceSender: async () => {
                try {
                    await fs.access(metadata.path);
                    return identity;
                } catch {
                    return undefined;
                }
            },
            loadWorkspace: async () => workspaceWithAgentState(identity.workspaceId, 1, { activesession: metadata }),
            saveWorkspaceAgentState,
        });
        const handlers = registeredHandlers();
        const event = { sender: { id: 36, isDestroyed: () => false, once: vi.fn(), send: vi.fn() } };

        await expect(handlers.get("agent:delete-session")?.(event, TrustedRequestContext, metadata)).rejects.toThrow(
            /changed during request/
        );
        expect(saveWorkspaceAgentState).toHaveBeenCalledOnce();
    });
});
