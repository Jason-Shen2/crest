// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as electron from "electron";

vi.mock("electron", () => ({
    app: {
        getPath: vi.fn(() => "/tmp"),
        isPackaged: false,
        runningUnderARM64Translation: false,
        setName: vi.fn(),
    },
    dialog: { showMessageBoxSync: vi.fn() },
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
vi.mock("./agent/harness-factory", () => ({ buildPaneHarness: vi.fn() }));
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
    abortAgentSessionForIpc,
    cloneAgentSessionForIpc,
    forkAgentSessionForIpc,
    listAgentCommandsForIpc,
    listAgentForkPointsForIpc,
    listAgentTreeForIpc,
    registerAgentIpcHandlers,
    subscribeAgentSessionForIpc,
    unsubscribeAgentSessionForIpc,
} from "./agent-ipc";
import { JsonlSessionRepo } from "./agent/harness/session/jsonl-repo";
import type { AgentMessage } from "./agent/types";
import { NodeExecutionEnv } from "./agent/node";
import { _setSessionsRepoForTests, createPaneSession, defaultSessionsDir } from "./agent/sessions";

function user(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function assistant(text: string): AgentMessage {
    return { role: "assistant", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

describe("agent-ipc command helpers", () => {
    let tmpConfigHome: string;
    let previousConfigHome: string | undefined;

    beforeEach(async () => {
        vi.mocked(electron.ipcMain.handle).mockClear();
        vi.mocked(electron.ipcMain.on).mockClear();
        previousConfigHome = process.env.WAVETERM_CONFIG_HOME;
        tmpConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-ipc-test-"));
        process.env.WAVETERM_CONFIG_HOME = tmpConfigHome;
        const env = new NodeExecutionEnv({ cwd: process.cwd() });
        _setSessionsRepoForTests(new JsonlSessionRepo({ fs: env, sessionsRoot: defaultSessionsDir() }));
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
        expect((await listAgentTreeForIpc(forked.sessionMetadata)).entries.map((entry) => entry.preview)).toEqual(["keep this"]);
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
            JSON.stringify({ type: "session", version: 3, id: "evil", timestamp: new Date().toISOString(), cwd: "/tmp" }) + "\n",
        );

        await expect(listAgentTreeForIpc({ ...metadata, path: "" })).rejects.toThrow(/sessionMetadata\.path/);
        await expect(listAgentTreeForIpc({ ...metadata, cwd: "" })).rejects.toThrow(/sessionMetadata\.cwd/);
        await expect(listAgentTreeForIpc({ ...metadata, path: outside })).rejects.toThrow(/outside sessions directory/);
        await expect(forkAgentSessionForIpc({ sessionMetadata: metadata, cwd: "", entryId: "x" })).rejects.toThrow(/cwd/);
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
            forkAgentSessionForIpc({ sessionMetadata: first, cwd: "/tmp/agent-ipc-first-fork", entryId: "not-in-this-session" }),
        ).rejects.toThrow(/does not belong/);
        await expect(
            forkAgentSessionForIpc({ sessionMetadata: first, cwd: "/tmp/agent-ipc-first-fork", entryId: "" }),
        ).rejects.toThrow(/entryId/);
    });

    it("rejects malicious input through registered IPC handlers", async () => {
        const { metadata, session } = await createPaneSession("/tmp/agent-ipc-handler");
        await session.appendMessage(user("handler branch"));
        const outside = path.join(tmpConfigHome, "outside-handler.jsonl");
        await fs.writeFile(
            outside,
            JSON.stringify({ type: "session", version: 3, id: "evil", timestamp: new Date().toISOString(), cwd: "/tmp" }) + "\n",
        );
        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }

        await expect(handlers.get("agent:list-tree")?.({}, { ...metadata, path: outside })).rejects.toThrow(
            /outside sessions directory/,
        );
        await expect(
            handlers.get("agent:fork-session")?.({}, { sessionMetadata: metadata, cwd: "/tmp/fork", entryId: "" }),
        ).rejects.toThrow(/entryId/);
        await expect(
            handlers.get("agent:clone-session")?.({}, { sessionMetadata: metadata, cwd: "" }),
        ).rejects.toThrow(/cwd/);
    });

    it("rejects forged paths for send existing sessions and subscription helpers", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-old-paths");
        const outside = path.join(tmpConfigHome, "outside-old-paths.jsonl");
        await fs.writeFile(
            outside,
            JSON.stringify({ type: "session", version: 3, id: "evil", timestamp: new Date().toISOString(), cwd: "/tmp" }) + "\n",
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
                },
            ),
        ).rejects.toThrow(/outside sessions directory/);
        await expect(subscribeAgentSessionForIpc(sender, outside)).rejects.toThrow(/outside sessions directory/);
        await expect(abortAgentSessionForIpc(outside)).rejects.toThrow(/outside sessions directory/);
        await expect(unsubscribeAgentSessionForIpc(1, outside)).rejects.toThrow(/outside sessions directory/);
        onHandlers.get("agent:subscribe")?.({ sender }, outside);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(errorSpy).toHaveBeenCalledWith(
            "[agent-ipc] subscribe validation error:",
            expect.objectContaining({ message: expect.stringMatching(/outside sessions directory/) }),
        );
        errorSpy.mockRestore();
        expect(sender.send).not.toHaveBeenCalled();
    });
});
