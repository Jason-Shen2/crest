// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    cloneAgentSessionForIpc,
    forkAgentSessionForIpc,
    listAgentCommandsForIpc,
    listAgentForkPointsForIpc,
    listAgentTreeForIpc,
} from "./agent-ipc";
import { JsonlSessionRepo } from "./agent/harness/session/jsonl-repo";
import type { AgentMessage } from "./agent/types";
import { NodeExecutionEnv } from "./agent/node";
import { _setSessionsRepoForTests, createPaneSession } from "./agent/sessions";

function user(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function assistant(text: string): AgentMessage {
    return { role: "assistant", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

describe("agent-ipc command helpers", () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crest-agent-ipc-test-"));
        const env = new NodeExecutionEnv({ cwd: process.cwd() });
        _setSessionsRepoForTests(new JsonlSessionRepo({ fs: env, sessionsRoot: tmpRoot }));
    });

    afterEach(async () => {
        _setSessionsRepoForTests(undefined);
        await fs.rm(tmpRoot, { recursive: true, force: true });
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

        expect(forked.sessionMetadata.parentSessionPath).toBe(metadata.path);
        expect(forked.sessionMetadata.cwd).toBe("/tmp/agent-ipc-fork-alt");
        expect(forked.selectedText).toBe("fork target");
        expect(cloned.sessionMetadata?.parentSessionPath).toBe(metadata.path);
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
});
