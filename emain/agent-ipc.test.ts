// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as electron from "electron";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

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
    listAgentFlagsForIpc,
    listAgentForkPointsForIpc,
    listAgentTreeForIpc,
    navigateAgentTreeForIpc,
    registerAgentIpcHandlers,
    respondWidgetEventForIpc,
    runAgentCommandForIpc,
    runAgentExtensionCommandForIpc,
    runAgentShortcutForIpc,
    setAgentFlagForIpc,
    subscribeAgentSessionForIpc,
    unsubscribeAgentSessionForIpc,
} from "./agent-ipc";
import { Session } from "./agent/harness/session/session";
import { SqliteSessionRepo } from "./agent/harness/session/sqlite-repo";
import { AgentSessionRuntime } from "./agent/agent-session-runtime";
import { _setSessionsRepoForTests, createPaneSession, defaultSessionsDir } from "./agent/sessions";
import type { AgentMessage } from "./agent/types";
import { getModel } from "./ai";
import { buildAgentHarnessHost } from "./agent/harness-factory";
import { createExtensionRuntime } from "./agent/extensions";
import type { ExtensionUiBridge } from "./agent/extensions/bridge";
import { createExtensionLifecycleHost, getExtensionGraphForLifecycleRuntime } from "./agent/extensions/lifecycle";
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
        extensions: [],
        ctx: {},
        appendCustomEntry: vi.fn(async () => {}),
        promptWithCustomEntry: vi.fn(async () => undefined),
        update: vi.fn(),
        setAuthResolver: vi.fn(),
        setToolCallHook: vi.fn(),
        resolveAuth: vi.fn(),
        runToolCallHook: vi.fn(),
    };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

async function createAliasedExtensionOwner(): Promise<{
    cwd: string;
    aliasMetadata: { id: string; createdAt: string; path: string; cwd: string; parentSessionPath?: string };
    owner: AgentSessionRuntime;
}> {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-owner-alias-cwd-"));
    await fs.mkdir(path.join(cwd, ".crest", "extensions"), { recursive: true });
    await fs.writeFile(
        path.join(cwd, ".crest", "extensions", "owner-alias.ts"),
        `export default (pi) => {
            pi.registerFlag("alias.enabled", { type: "boolean", default: false });
            pi.registerShortcut("ctrl+alias", { handler: async () => {} });
            pi.registerCommand("alias-command", { handler: async () => {} });
        };`
    );
    const { metadata } = await createPaneSession(cwd);
    const aliasPath = `${metadata.path}.alias`;
    await fs.symlink(metadata.path, aliasPath);
    vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
    let extensionUiBridge: ExtensionUiBridge | undefined;
    vi.mocked(buildAgentHarnessHost).mockImplementation((opts) => {
        extensionUiBridge = opts.extensionUiBridge;
        return {
            ...makeHarnessHostMock(),
            session: opts.session,
            extensions: opts.extensions,
            ctx: {},
            extensionRuntime: opts.extensionRuntime,
            appendCustomEntry: async () => {},
            promptWithCustomEntry: async () => undefined,
            update: () => {},
            setAuthResolver: () => {},
            setToolCallHook: () => {},
            resolveAuth: async () => undefined,
            runToolCallHook: async () => undefined,
            extensionLifecycleOwnerId: opts.extensionLifecycleOwnerId,
            extensionLifecycleHost: opts.extensionLifecycleHost,
        } as never;
    });
    vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-owner-alias");
    registerAgentIpcHandlers();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
        handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
    }
    await handlers.get("agent:send")?.(
        { sender: { id: 1 } },
        {
            sessionMetadata: metadata,
            blockId: "block-1",
            cwd,
            text: "hello",
            provider: "p",
            model: "m",
        }
    );
    const owner = extensionUiBridge?.host;
    if (!(owner instanceof AgentSessionRuntime)) {
        throw new Error("Expected alias fixture to create a AgentSessionRuntime owner");
    }
    return { cwd, aliasMetadata: { ...metadata, path: aliasPath }, owner };
}

describe("agent-ipc command helpers", () => {
    let tmpConfigHome: string;
    let previousConfigHome: string | undefined;

    beforeEach(async () => {
        vi.mocked(electron.ipcMain.handle).mockClear();
        vi.mocked(electron.ipcMain.on).mockClear();
        vi.mocked(buildAgentHarnessHost).mockReset();
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

    it("lists built-in command metadata", async () => {
        const names = (await listAgentCommandsForIpc()).map((command) => command.name);

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

        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-reload-cwd-"));
        await fs.mkdir(path.join(cwd, ".crest", "extensions"), { recursive: true });
        await fs.writeFile(
            path.join(cwd, ".crest", "extensions", "reloadable.ts"),
            `export default (pi) => { pi.registerFlag("ipc.reload", { type: "boolean", default: true }); };`
        );

        await expect(runAgentCommandForIpc({ command: "reload", cwd, argsText: "" })).resolves.toEqual({
            status: "success",
            message: "Reloaded 1 extension.",
        });
        await expect(
            handlers.get("agent:run-command")?.({}, { command: "compact", cwd: "/tmp", argsText: "keep errors" })
        ).resolves.toEqual({
            status: "noop",
            message: "No active agent session to compact.",
        });
    });

    it("registers a read-only extensions graph IPC handler", async () => {
        const runtime = createExtensionRuntime();
        const lifecycleHost = createExtensionLifecycleHost(runtime);
        const dispose = vi.fn();
        lifecycleHost.setNodes([
            {
                id: "ipc.ext",
                name: "ipc.ext",
                version: "1.0.0",
                path: "/tmp/ipc.ext.ts",
                scope: "workspace",
                status: "active",
                commands: ["ipc-command"],
                tools: [],
                hooks: [],
                flags: [],
                errors: [],
            },
        ]);
        lifecycleHost.registerDispose("ipc-owner", dispose);
        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }

        const graph = await handlers.get("agent:extensions-graph")?.({});
        (graph as { nodes: Array<{ status: string }> }).nodes[0].status = "failed";

        await expect(handlers.get("agent:extensions-graph")?.({})).resolves.toEqual({
            generation: expect.any(Number),
            nodes: expect.arrayContaining([
                expect.objectContaining({
                    id: "ipc.ext",
                    status: "active",
                    commands: ["ipc-command"],
                }),
            ]),
        });
        expect(dispose).not.toHaveBeenCalled();
        expect(() => runtime.assertActive()).not.toThrow();
    });

    it("keeps the extensions graph stable across discovery-only list handlers", async () => {
        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-graph-list-cwd-"));
        await fs.mkdir(path.join(cwd, ".crest", "extensions"), { recursive: true });
        await fs.writeFile(
            path.join(cwd, ".crest", "extensions", "listable.ts"),
            `export default (pi) => {
                pi.registerCommand("graph-list", { handler: () => {} });
                pi.registerShortcut("ctrl+g", { handler: () => {} });
                pi.registerFlag("graph.enabled", { type: "boolean", default: true });
            };`
        );
        const before = await handlers.get("agent:extensions-graph")?.({});

        await handlers.get("agent:list-commands")?.({}, cwd);
        await handlers.get("agent:list-shortcuts")?.({}, cwd);
        await handlers.get("agent:list-flags")?.({}, cwd);
        await handlers.get("agent:list-commands")?.({}, cwd);
        await handlers.get("agent:list-shortcuts")?.({}, cwd);
        await handlers.get("agent:list-flags")?.({}, cwd);

        await expect(handlers.get("agent:extensions-graph")?.({})).resolves.toEqual(before);
    });

    it("keeps the extensions graph stable across headless shortcut and command execution", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-headless-graph-cwd-"));
        await fs.mkdir(path.join(cwd, ".crest", "extensions"), { recursive: true });
        await fs.writeFile(
            path.join(cwd, ".crest", "extensions", "headless.ts"),
            `export default (pi) => {
                pi.registerCommand("headless-command", { handler: () => {} });
                pi.registerShortcut("ctrl+h", { handler: () => {} });
            };`
        );
        const before = getExtensionGraphForLifecycleRuntime();

        await runAgentExtensionCommandForIpc({ cwd, name: "headless-command", argsText: "" });
        await runAgentShortcutForIpc({ cwd, shortcut: "ctrl+h" });

        expect(getExtensionGraphForLifecycleRuntime()).toEqual(before);
    });

    it("keeps the extensions graph stable when persisted get-session-state renders extension entries", async () => {
        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-graph-state-cwd-"));
        await fs.mkdir(path.join(cwd, ".crest", "extensions"), { recursive: true });
        await fs.writeFile(
            path.join(cwd, ".crest", "extensions", "state-renderer.ts"),
            `import { Text } from "@earendil-works/pi-tui";
             export default (pi) => { pi.registerEntryRenderer("state-entry", () => new Text("rendered", 0, 0)); };`
        );
        const { metadata, session } = await createPaneSession(cwd);
        await session.appendMessage(user("persisted question"));
        await session.appendCustomEntry("state-entry", { label: "persisted" });
        const before = await handlers.get("agent:extensions-graph")?.({});

        const state = (await handlers.get("agent:get-session-state")?.({}, metadata)) as {
            renderedEntries?: Array<{ customtype: string }>;
            extensionUi?: unknown;
        };

        expect(state.renderedEntries).toEqual([expect.objectContaining({ customtype: "state-entry" })]);
        expect(state.extensionUi).toEqual({ statuses: {}, widgets: {}, widgetnodes: {} });
        await expect(handlers.get("agent:extensions-graph")?.({})).resolves.toEqual(before);
    });

    it("lists live flag values through an alias path without rebuilding the owner", async () => {
        const { cwd, aliasMetadata, owner } = await createAliasedExtensionOwner();
        owner.setFlagValue("alias.enabled", true);
        await expect(listAgentFlagsForIpc(cwd, aliasMetadata)).resolves.toEqual([
            expect.objectContaining({ name: "alias.enabled", value: true }),
        ]);
        expect(vi.mocked(buildAgentHarnessHost)).toHaveBeenCalledOnce();
    });

    it("sets live flag values through an alias path without rebuilding the owner", async () => {
        const { aliasMetadata, owner } = await createAliasedExtensionOwner();
        const setFlagSpy = vi.spyOn(owner, "setFlagValue");

        await expect(
            setAgentFlagForIpc({ sessionMetadata: aliasMetadata, name: "alias.enabled", value: false })
        ).resolves.toEqual({ status: "success", message: "Set flag alias.enabled" });
        expect(setFlagSpy).toHaveBeenCalledWith("alias.enabled", false);
        expect(vi.mocked(buildAgentHarnessHost)).toHaveBeenCalledOnce();
    });

    it("rejects unknown and type-incompatible live flag writes", async () => {
        const { aliasMetadata, owner } = await createAliasedExtensionOwner();

        await expect(
            setAgentFlagForIpc({ sessionMetadata: aliasMetadata, name: "missing.flag", value: true })
        ).resolves.toEqual({ status: "noop", message: "Flag missing.flag is not available." });
        await expect(
            setAgentFlagForIpc({ sessionMetadata: aliasMetadata, name: "alias.enabled", value: "wrong" })
        ).resolves.toEqual({ status: "noop", message: "Flag alias.enabled does not accept this value." });

        expect(owner.getFlagValue("missing.flag")).toBeUndefined();
        expect(owner.getFlagValue("alias.enabled")).toBe(false);
    });

    it("runs live shortcuts through an alias path without rebuilding the owner", async () => {
        const { cwd, aliasMetadata, owner } = await createAliasedExtensionOwner();
        const shortcutSpy = vi.spyOn(owner, "runShortcut");

        await expect(
            runAgentShortcutForIpc({ sessionMetadata: aliasMetadata, cwd, shortcut: "ctrl+alias" })
        ).resolves.toEqual({ status: "success", message: "Ran extension shortcut ctrl+alias" });
        expect(shortcutSpy).toHaveBeenCalledWith("ctrl+alias");
        expect(vi.mocked(buildAgentHarnessHost)).toHaveBeenCalledOnce();
    });

    it("runs live extension commands through an alias path without rebuilding the owner", async () => {
        const { cwd, aliasMetadata, owner } = await createAliasedExtensionOwner();
        const commandSpy = vi.spyOn(owner, "runExtensionCommand");

        await expect(
            runAgentExtensionCommandForIpc({
                sessionMetadata: aliasMetadata,
                cwd,
                name: "alias-command",
                argsText: "",
            })
        ).resolves.toEqual({ status: "success", message: "Ran extension command /alias-command" });
        expect(commandSpy).toHaveBeenCalledWith("alias-command", "");
        expect(vi.mocked(buildAgentHarnessHost)).toHaveBeenCalledOnce();
    });

    it("reloads an alias path through the canonical owner", async () => {
        const { cwd, aliasMetadata, owner } = await createAliasedExtensionOwner();
        const disposeSpy = vi.spyOn(owner, "dispose");

        await expect(
            runAgentCommandForIpc({ command: "reload", cwd, sessionMetadata: aliasMetadata })
        ).resolves.toEqual({
            status: "success",
            message: "Reloaded 1 extension.",
        });

        expect(disposeSpy).toHaveBeenCalledOnce();
        expect(vi.mocked(buildAgentHarnessHost)).toHaveBeenCalledOnce();
        disposeSpy.mockRestore();
    });

    it("detaches and removes the old owner before awaiting extension reload", async () => {
        const { cwd, aliasMetadata, owner } = await createAliasedExtensionOwner();
        owner.setFlagValue("alias.enabled", true);
        const requestPromise = owner.requestUi({ kind: "confirm", title: "Continue?" });
        let terminationReason: string | undefined;
        void requestPromise.catch((error) => {
            terminationReason = (error as { reason?: string }).reason;
        });
        const sender = {
            id: 9,
            isDestroyed: vi.fn(() => false),
            once: vi.fn(),
            send: vi.fn(),
        } as unknown as electron.WebContents;
        await subscribeAgentSessionForIpc(sender, aliasMetadata.path);
        vi.mocked(sender.send).mockClear();
        const lifecycleHost = owner.host.extensionLifecycleHost;
        if (!lifecycleHost) throw new Error("expected lifecycle host");
        const reloadGate = deferred<void>();
        const reloadStartSpy = vi.spyOn(lifecycleHost, "reloadStart").mockImplementation(() => reloadGate.promise);
        const disposeSpy = vi.spyOn(owner, "dispose");

        const reloadPromise = runAgentCommandForIpc({
            command: "reload",
            cwd,
            sessionMetadata: aliasMetadata,
        });
        await vi.waitFor(() => expect(reloadStartSpy).toHaveBeenCalledOnce());
        await Promise.resolve();
        const flagsWhileReloadWaits = await listAgentFlagsForIpc(cwd, aliasMetadata);
        owner.setStatus("late", "stale");
        const disposeCallsBeforeReload = disposeSpy.mock.calls.map((call) => call[0]);
        const terminationReasonBeforeReload = terminationReason;
        const sendsBeforeReload = vi.mocked(sender.send).mock.calls.length;

        reloadGate.resolve();
        await reloadPromise;

        expect(disposeCallsBeforeReload).toEqual(["reload"]);
        expect(terminationReasonBeforeReload).toBe("reload");
        expect(flagsWhileReloadWaits).toEqual([expect.objectContaining({ name: "alias.enabled", value: false })]);
        expect(sendsBeforeReload).toBe(0);
        reloadStartSpy.mockRestore();
        disposeSpy.mockRestore();
    });

    it("serializes send behind reload and waits for delayed lifecycle disposal", async () => {
        const { cwd, aliasMetadata, owner } = await createAliasedExtensionOwner();
        const lifecycleHost = owner.host.extensionLifecycleHost;
        if (!lifecycleHost) throw new Error("expected lifecycle host");
        const disposeGate = deferred<void>();
        const disposerStarted = vi.fn();
        lifecycleHost.registerDispose(owner.path, async () => {
            disposerStarted();
            await disposeGate.promise;
        });
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const sendInput = {
            sessionMetadata: aliasMetadata,
            blockId: "block-1",
            cwd,
            text: "after reload",
            provider: "p",
            model: "m",
        };
        let reloadSettled = false;
        let sendSettled = false;

        const reloadPromise = runAgentCommandForIpc({
            command: "reload",
            cwd,
            sessionMetadata: aliasMetadata,
        }).then((result) => {
            reloadSettled = true;
            return result;
        });
        await vi.waitFor(() => expect(disposerStarted).toHaveBeenCalledOnce());
        const sendPromise = Promise.resolve(handlers.get("agent:send")?.({ sender: { id: 2 } }, sendInput)).then(
            (result) => {
                sendSettled = true;
                return result;
            }
        );
        await Promise.resolve();
        await Promise.resolve();

        expect(reloadSettled).toBe(false);
        expect(sendSettled).toBe(false);
        expect(vi.mocked(buildAgentHarnessHost)).toHaveBeenCalledTimes(1);

        disposeGate.resolve();
        await expect(reloadPromise).resolves.toMatchObject({ status: "success" });
        await expect(sendPromise).resolves.toMatchObject({ turnId: "entry-owner-alias" });
        expect(vi.mocked(buildAgentHarnessHost)).toHaveBeenCalledTimes(2);
    });

    it("serializes flag writes behind reload and rejects writes to the disposed owner", async () => {
        const { cwd, aliasMetadata, owner } = await createAliasedExtensionOwner();
        const lifecycleHost = owner.host.extensionLifecycleHost;
        if (!lifecycleHost) throw new Error("expected lifecycle host");
        const disposeGate = deferred<void>();
        const disposerStarted = vi.fn();
        lifecycleHost.registerDispose(owner.path, async () => {
            disposerStarted();
            await disposeGate.promise;
        });
        let flagSettled = false;

        const reloadPromise = runAgentCommandForIpc({
            command: "reload",
            cwd,
            sessionMetadata: aliasMetadata,
        });
        await vi.waitFor(() => expect(disposerStarted).toHaveBeenCalledOnce());
        const flagPromise = setAgentFlagForIpc({
            sessionMetadata: aliasMetadata,
            name: "alias.enabled",
            value: true,
        }).then((result) => {
            flagSettled = true;
            return result;
        });
        await Promise.resolve();

        expect(flagSettled).toBe(false);
        disposeGate.resolve();
        await expect(reloadPromise).resolves.toMatchObject({ status: "success" });
        await expect(flagPromise).resolves.toEqual({
            status: "noop",
            message: "No active agent session to set flag alias.enabled.",
        });
    });

    it("does not retain raw session cache fallback in reload owner lookup", async () => {
        const source = await fs.readFile(path.join(process.cwd(), "emain", "agent-ipc.ts"), "utf8");
        const reloadHelpers = source.slice(
            source.indexOf("async function getCachedSessionOwnerForReload"),
            source.indexOf("function moveActiveSubscriptionsToPending")
        );

        expect(reloadHelpers).not.toContain("sessionCache.get(sessionMetadata.path)");
        expect(reloadHelpers).not.toContain("sessionCache.delete(sessionMetadata.path)");
    });

    it("disposes the cached pane owner after a successful reload so the next send rebuilds it", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-reload-owner");
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue({
            harness: { subscribe: () => () => {}, abort: async () => {} },
            session: { buildContext: async () => ({ messages: [] }), getBranch: async () => [] },
            extensions: [],
            ctx: {},
            appendCustomEntry: async () => {},
            promptWithCustomEntry: async () => undefined,
            update: () => {},
        } as never);
        const sendSpy = vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-reload");
        const disposeSpy = vi.spyOn(AgentSessionRuntime.prototype, "dispose");

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const sendInput = {
            sessionMetadata: metadata,
            blockId: "block-1",
            cwd: metadata.cwd,
            text: "hello",
            provider: "p",
            model: "m",
        };

        await handlers.get("agent:send")?.({ sender: { id: 1 } }, sendInput);
        await expect(runAgentCommandForIpc({ command: "reload", cwd: metadata.cwd, sessionMetadata: metadata })).resolves.toEqual({
            status: "success",
            message: "Reloaded 0 extensions.",
        });
        await handlers.get("agent:send")?.({ sender: { id: 1 } }, sendInput);

        expect(disposeSpy).toHaveBeenCalledTimes(1);
        expect(vi.mocked(buildAgentHarnessHost)).toHaveBeenCalledTimes(2);
        sendSpy.mockRestore();
        disposeSpy.mockRestore();
    });

    it("hands recoverable UI and compatible flags through one canonical reload rebuild", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-reload-handoff-cwd-"));
        const extensionPath = path.join(cwd, ".crest", "extensions", "reload-handoff.ts");
        await fs.mkdir(path.dirname(extensionPath), { recursive: true });
        await fs.writeFile(
            extensionPath,
            `export default (pi) => {
                pi.registerFlag("keep", { type: "boolean", default: true });
                pi.registerFlag("changed", { type: "string", default: "old" });
                pi.registerFlag("removed", { type: "boolean", default: true });
            };`
        );
        const { metadata } = await createPaneSession(cwd);
        const aliasPath = `${metadata.path}.alias`;
        await fs.symlink(metadata.path, aliasPath);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        const bridges: ExtensionUiBridge[] = [];
        vi.mocked(buildAgentHarnessHost).mockImplementation((opts) => {
            if (opts.extensionUiBridge) bridges.push(opts.extensionUiBridge);
            return {
                harness: { subscribe: () => () => {}, abort: async () => {}, isIdle: () => true },
                session: opts.session,
                extensions: opts.extensions,
                ctx: {},
                extensionRuntime: opts.extensionRuntime,
                extensionLifecycleOwnerId: opts.extensionLifecycleOwnerId,
                extensionLifecycleHost: opts.extensionLifecycleHost,
                appendCustomEntry: async () => {},
                promptWithCustomEntry: async () => undefined,
                update: () => {},
                getCwd: () => cwd,
            } as never;
        });
        const sendSpy = vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-reload-handoff");
        const sender = {
            id: 8,
            isDestroyed: vi.fn(() => false),
            once: vi.fn(),
            send: vi.fn(),
        } as unknown as electron.WebContents;

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const sendInput = {
            sessionMetadata: metadata,
            blockId: "block-1",
            cwd,
            text: "hello",
            provider: "p",
            model: "m",
        };
        await handlers.get("agent:send")?.({ sender }, sendInput);
        expect(bridges).toHaveLength(1);
        const oldOwner = bridges[0].host;
        if (!(oldOwner instanceof AgentSessionRuntime)) throw new Error("expected initial pane owner");
        const widget = { kind: "terminal" as const, id: "result", lines: ["done"] };
        oldOwner.setStatus("build", "Running");
        oldOwner.setWidget("result", widget);
        oldOwner.setFlagValue("keep", false);
        oldOwner.setFlagValue("changed", "old");
        oldOwner.setFlagValue("removed", false);
        oldOwner.host.extensionLifecycleHost?.registerDispose(metadata.path, () => {
            oldOwner.setFlagValue("keep", true);
        });
        const requestPromise = oldOwner.requestUi({ kind: "confirm", title: "Continue?" });
        const requestRejection = expect(requestPromise).rejects.toMatchObject({
            name: "ExtensionUiRequestTerminatedError",
            code: "EXT_UI_REQUEST_TERMINATED",
            reason: "reload",
        });
        await subscribeAgentSessionForIpc(sender, aliasPath);
        vi.mocked(sender.send).mockClear();

        await fs.writeFile(
            extensionPath,
            `export default (pi) => {
                pi.registerFlag("keep", { type: "boolean", default: true });
                pi.registerFlag("changed", { type: "boolean", default: false });
            };`
        );
        await expect(
            runAgentCommandForIpc({
                command: "reload",
                cwd,
                sessionMetadata: { ...metadata, path: aliasPath },
            })
        ).resolves.toEqual({
            status: "success",
            message: "Reloaded 1 extension.",
        });
        await requestRejection;
        await handlers.get("agent:send")?.({ sender }, sendInput);
        expect(bridges).toHaveLength(2);

        const newOwner = bridges[1].host;
        if (!(newOwner instanceof AgentSessionRuntime)) throw new Error("expected reloaded pane owner");
        expect(newOwner.getFlagValue("keep")).toBe(false);
        expect(newOwner.getFlagValue("changed")).toBe(false);
        expect(newOwner.getFlagValue("removed")).toBeUndefined();
        await vi.waitFor(() =>
            expect(
                vi
                    .mocked(sender.send)
                    .mock.calls.some((call) => (call[1] as { event?: { type?: string } }).event?.type === "session_state")
            ).toBe(true)
        );
        const replayed = vi
            .mocked(sender.send)
            .mock.calls.map((call) => (call[1] as { event?: { type?: string; extensionUi?: unknown } }).event)
            .filter((event) => event?.type === "session_state")
            .at(-1);
        expect(replayed).toEqual(
            expect.objectContaining({
                extensionUi: {
                    statuses: { build: "Running" },
                    widgets: {},
                    widgetnodes: { result: widget },
                },
            })
        );
        expect(replayed?.extensionUi).not.toHaveProperty("request");

        await unsubscribeAgentSessionForIpc(sender.id, aliasPath);
        await _resetAgentIpcForTests({ preservePendingReloadStates: true });
        registerAgentIpcHandlers();
        const rebuiltHandlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            rebuiltHandlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        await rebuiltHandlers.get("agent:send")?.({ sender }, sendInput);
        expect(bridges).toHaveLength(3);
        const rebuiltOwner = bridges[2].host;
        if (!(rebuiltOwner instanceof AgentSessionRuntime)) throw new Error("expected rebuilt pane owner");
        expect(rebuiltOwner.getSessionState().extensionUi).toEqual({
            statuses: {},
            widgets: {},
            widgetnodes: {},
        });
        expect(rebuiltOwner.getFlagValue("keep")).toBe(true);
        sendSpy.mockRestore();
    });

    it("builds one owner for concurrent sends to the same uncached session", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-single-flight");
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockImplementation((opts) => ({
            harness: { subscribe: () => () => {}, abort: async () => {} },
            session: opts.session,
            extensions: opts.extensions,
            ctx: {},
            extensionRuntime: opts.extensionRuntime,
            extensionLifecycleOwnerId: opts.extensionLifecycleOwnerId,
            extensionLifecycleHost: opts.extensionLifecycleHost,
            appendCustomEntry: async () => {},
            promptWithCustomEntry: async () => undefined,
            update: () => {},
        }) as never);
        const sendSpy = vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-single-flight");
        const buildGate = deferred<void>();
        const originalBuildContext = Session.prototype.buildContext;
        const buildContextSpy = vi.spyOn(Session.prototype, "buildContext").mockImplementation(async function () {
            await buildGate.promise;
            return await originalBuildContext.call(this);
        });

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const sendInput = {
            sessionMetadata: metadata,
            blockId: "block-1",
            cwd: metadata.cwd,
            text: "hello",
            provider: "p",
            model: "m",
        };

        const first = handlers.get("agent:send")?.({ sender: { id: 1 } }, sendInput);
        const second = handlers.get("agent:send")?.({ sender: { id: 2 } }, sendInput);
        await vi.waitFor(() => expect(buildContextSpy).toHaveBeenCalled());
        buildGate.resolve();
        await Promise.all([first, second]);

        expect(vi.mocked(buildAgentHarnessHost)).toHaveBeenCalledTimes(1);
        expect(sendSpy).toHaveBeenCalledTimes(2);
        buildContextSpy.mockRestore();
        sendSpy.mockRestore();
    });

    it("serializes extension builds across sessions in the same cwd", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-cwd-build-barrier-"));
        const firstSession = await createPaneSession(cwd);
        const secondSession = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockImplementation((opts) => ({
            harness: { subscribe: () => () => {}, abort: async () => {} },
            session: opts.session,
            extensions: opts.extensions,
            ctx: {},
            extensionRuntime: opts.extensionRuntime,
            extensionLifecycleOwnerId: opts.extensionLifecycleOwnerId,
            extensionLifecycleHost: opts.extensionLifecycleHost,
            appendCustomEntry: async () => {},
            promptWithCustomEntry: async () => undefined,
            update: () => {},
        }) as never);
        const sendSpy = vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-cwd-barrier");
        const buildGate = deferred<void>();
        const firstBuildStarted = deferred<void>();
        const originalBuildContext = Session.prototype.buildContext;
        let buildContextCalls = 0;
        const buildContextSpy = vi.spyOn(Session.prototype, "buildContext").mockImplementation(async function () {
            buildContextCalls += 1;
            if (buildContextCalls === 1) {
                firstBuildStarted.resolve();
                await buildGate.promise;
            }
            return await originalBuildContext.call(this);
        });

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const inputFor = (metadata: typeof firstSession.metadata) => ({
            sessionMetadata: metadata,
            blockId: "block-1",
            cwd,
            text: "hello",
            provider: "p",
            model: "m",
        });

        const firstSend = handlers.get("agent:send")?.({ sender: { id: 1 } }, inputFor(firstSession.metadata));
        await firstBuildStarted.promise;
        const secondSend = handlers.get("agent:send")?.({ sender: { id: 2 } }, inputFor(secondSession.metadata));
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(vi.mocked(buildAgentHarnessHost)).toHaveBeenCalledTimes(1);
        buildGate.resolve();
        await Promise.all([firstSend, secondSend]);
        expect(vi.mocked(buildAgentHarnessHost)).toHaveBeenCalledTimes(2);
        buildContextSpy.mockRestore();
        sendSpy.mockRestore();
    });

    it("blocks a sessionless global reload behind an active extension build and rebuilds cached runtimes", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-global-reload-barrier-"));
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockImplementation((opts) => {
            return {
                harness: { subscribe: () => () => {}, abort: async () => {}, isIdle: () => true },
                session: opts.session,
                extensions: opts.extensions,
                ctx: {},
                extensionRuntime: opts.extensionRuntime,
                extensionLifecycleOwnerId: opts.extensionLifecycleOwnerId,
                extensionLifecycleHost: opts.extensionLifecycleHost,
                appendCustomEntry: async () => {},
                promptWithCustomEntry: async () => undefined,
                update: () => {},
                getCwd: () => cwd,
            } as never;
        });
        const sendSpy = vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-global-barrier");
        const disposeSpy = vi.spyOn(AgentSessionRuntime.prototype, "dispose");
        const buildGate = deferred<void>();
        const buildStarted = deferred<void>();
        const originalBuildContext = Session.prototype.buildContext;
        const buildContextSpy = vi.spyOn(Session.prototype, "buildContext").mockImplementationOnce(async function () {
            buildStarted.resolve();
            await buildGate.promise;
            return await originalBuildContext.call(this);
        });

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const sendPromise = handlers.get("agent:send")?.(
            { sender: { id: 1 } },
            {
                sessionMetadata: metadata,
                blockId: "block-1",
                cwd,
                text: "hello",
                provider: "p",
                model: "m",
            }
        );
        await buildStarted.promise;
        let reloadSettled = false;
        const reloadPromise = runAgentCommandForIpc({ command: "reload", cwd }).then((result) => {
            reloadSettled = true;
            return result;
        });
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(reloadSettled).toBe(false);
        buildGate.resolve();
        await sendPromise;
        await expect(reloadPromise).resolves.toMatchObject({ status: "success" });
        expect(disposeSpy).toHaveBeenCalledWith("reload");
        await handlers.get("agent:send")?.(
            { sender: { id: 2 } },
            {
                sessionMetadata: metadata,
                blockId: "block-1",
                cwd,
                text: "after reload",
                provider: "p",
                model: "m",
            }
        );
        expect(vi.mocked(buildAgentHarnessHost)).toHaveBeenCalledTimes(2);
        buildContextSpy.mockRestore();
        sendSpy.mockRestore();
        disposeSpy.mockRestore();
    });

    it("does not interrupt a runtime from another workspace during sessionless reload", async () => {
        const firstCwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-global-reload-first-"));
        const secondCwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-global-reload-second-"));
        const { metadata } = await createPaneSession(firstCwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockImplementation((opts) => ({
            ...makeHarnessHostMock(),
            session: opts.session,
            extensions: opts.extensions,
            extensionRuntime: opts.extensionRuntime,
            extensionLifecycleOwnerId: opts.extensionLifecycleOwnerId,
            extensionLifecycleHost: opts.extensionLifecycleHost,
            getCwd: () => firstCwd,
        }) as never);
        vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-other-workspace");
        const runningSpy = vi.spyOn(AgentSessionRuntime.prototype, "isRunning").mockReturnValue(true);
        const disposeSpy = vi.spyOn(AgentSessionRuntime.prototype, "dispose");
        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        await handlers.get("agent:send")?.(
            { sender: { id: 1 } },
            {
                sessionMetadata: metadata,
                blockId: "block-1",
                cwd: firstCwd,
                text: "hello",
                provider: "p",
                model: "m",
            }
        );

        await expect(runAgentCommandForIpc({ command: "reload", cwd: secondCwd })).resolves.toMatchObject({
            status: "success",
        });

        expect(disposeSpy).not.toHaveBeenCalled();
        runningSpy.mockRestore();
        disposeSpy.mockRestore();
    });

    it("refuses sessionless reload while the target workspace runtime is running", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-global-reload-running-"));
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockImplementation((opts) => ({
            ...makeHarnessHostMock(),
            session: opts.session,
            extensions: opts.extensions,
            extensionRuntime: opts.extensionRuntime,
            extensionLifecycleOwnerId: opts.extensionLifecycleOwnerId,
            extensionLifecycleHost: opts.extensionLifecycleHost,
            getCwd: () => cwd,
        }) as never);
        vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-running-workspace");
        const runningSpy = vi.spyOn(AgentSessionRuntime.prototype, "isRunning").mockReturnValue(true);
        const disposeSpy = vi.spyOn(AgentSessionRuntime.prototype, "dispose");
        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        await handlers.get("agent:send")?.(
            { sender: { id: 1 } },
            {
                sessionMetadata: metadata,
                blockId: "block-1",
                cwd,
                text: "hello",
                provider: "p",
                model: "m",
            }
        );

        await expect(runAgentCommandForIpc({ command: "reload", cwd })).resolves.toEqual({
            status: "noop",
            message: "Reload failed: cannot reload extensions while an agent session in this workspace is running",
        });
        expect(disposeSpy).not.toHaveBeenCalled();
        runningSpy.mockRestore();
        disposeSpy.mockRestore();
    });

    it("retains reload handoff when owner construction fails and consumes it on retry", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-reload-retry-cwd-"));
        await fs.mkdir(path.join(cwd, ".crest", "extensions"), { recursive: true });
        await fs.writeFile(
            path.join(cwd, ".crest", "extensions", "retry.ts"),
            `export default (pi) => { pi.registerFlag("retry.keep", { type: "boolean", default: true }); };`
        );
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        const bridges: ExtensionUiBridge[] = [];
        let failNextBuild = false;
        vi.mocked(buildAgentHarnessHost).mockImplementation((opts) => {
            if (failNextBuild) {
                failNextBuild = false;
                throw new Error("rebuild failed once");
            }
            if (opts.extensionUiBridge) bridges.push(opts.extensionUiBridge);
            return {
                harness: { subscribe: () => () => {}, abort: async () => {} },
                session: opts.session,
                extensions: opts.extensions,
                ctx: {},
                extensionRuntime: opts.extensionRuntime,
                extensionLifecycleOwnerId: opts.extensionLifecycleOwnerId,
                extensionLifecycleHost: opts.extensionLifecycleHost,
                appendCustomEntry: async () => {},
                promptWithCustomEntry: async () => undefined,
                update: () => {},
            } as never;
        });
        const sendSpy = vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-reload-retry");

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const sendInput = {
            sessionMetadata: metadata,
            blockId: "block-1",
            cwd,
            text: "hello",
            provider: "p",
            model: "m",
        };
        await handlers.get("agent:send")?.({ sender: { id: 1 } }, sendInput);
        const oldOwner = bridges[0].host;
        if (!(oldOwner instanceof AgentSessionRuntime)) throw new Error("expected initial retry owner");
        oldOwner.setStatus("retry", "Pending");
        oldOwner.setFlagValue("retry.keep", false);
        await runAgentCommandForIpc({ command: "reload", cwd, sessionMetadata: metadata });

        failNextBuild = true;
        await expect(handlers.get("agent:send")?.({ sender: { id: 1 } }, sendInput)).rejects.toThrow(
            "rebuild failed once"
        );
        await handlers.get("agent:send")?.({ sender: { id: 1 } }, sendInput);

        expect(bridges).toHaveLength(2);
        const retriedOwner = bridges[1].host;
        if (!(retriedOwner instanceof AgentSessionRuntime)) throw new Error("expected retried pane owner");
        expect(retriedOwner.getSessionState().extensionUi.statuses).toEqual({ retry: "Pending" });
        expect(retriedOwner.getFlagValue("retry.keep")).toBe(false);
        sendSpy.mockRestore();
    });

    it("cleans bridge runtime and lifecycle host when owner construction fails", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-build-cleanup-cwd-"));
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        let bridgeDispose: MockInstance<() => void> | undefined;
        let runtimeInvalidate: MockInstance<(message?: string) => void> | undefined;
        const leakedNodeId = "build-cleanup.ext";
        vi.mocked(buildAgentHarnessHost).mockImplementation((opts) => {
            bridgeDispose = vi.spyOn(opts.extensionUiBridge!, "dispose");
            runtimeInvalidate = vi.spyOn(opts.extensionRuntime!, "invalidate");
            opts.extensionLifecycleHost!.setNodes([
                {
                    id: leakedNodeId,
                    name: leakedNodeId,
                    version: "1.0.0",
                    path: "/tmp/build-cleanup.ext.ts",
                    scope: "session",
                    status: "active",
                    commands: [],
                    tools: [],
                    hooks: [],
                    flags: [],
                    errors: [],
                },
            ]);
            throw new Error("owner construction failed");
        });

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }

        await expect(
            handlers.get("agent:send")?.(
                { sender: { id: 1 } },
                {
                    sessionMetadata: metadata,
                    blockId: "block-1",
                    cwd,
                    text: "hello",
                    provider: "p",
                    model: "m",
                }
            )
        ).rejects.toThrow("owner construction failed");

        expect(bridgeDispose).toHaveBeenCalledOnce();
        expect(runtimeInvalidate).toHaveBeenCalledOnce();
        expect(getExtensionGraphForLifecycleRuntime().nodes.map((node) => node.id)).not.toContain(leakedNodeId);
    });

    it("keeps the extensions graph unique across /reload and the next send", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-reload-graph-cwd-"));
        const extensionPath = path.join(cwd, ".crest", "extensions", "reload-graph.ts");
        await fs.mkdir(path.dirname(extensionPath), { recursive: true });
        await fs.writeFile(
            extensionPath,
            `export default (pi) => { pi.registerFlag("reload.graph", { type: "boolean", default: true }); };`
        );
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockImplementation((opts) => ({
            harness: { subscribe: () => () => {}, abort: async () => {} },
            session: { buildContext: async () => ({ messages: [] }), getBranch: async () => [] },
            extensions: opts.extensions ?? [],
            ctx: {},
            extensionRuntime: opts.extensionRuntime,
            extensionLifecycleOwnerId: opts.extensionLifecycleOwnerId,
            extensionLifecycleHost: opts.extensionLifecycleHost,
            appendCustomEntry: async () => {},
            promptWithCustomEntry: async () => undefined,
            update: () => {},
        }) as never);
        const sendSpy = vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-reload-graph");

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const sendInput = {
            sessionMetadata: metadata,
            blockId: "block-1",
            cwd,
            text: "hello",
            provider: "p",
            model: "m",
        };

        await handlers.get("agent:send")?.({ sender: { id: 1 } }, sendInput);
        await expect(runAgentCommandForIpc({ command: "reload", cwd, sessionMetadata: metadata })).resolves.toEqual({
            status: "success",
            message: "Reloaded 1 extension.",
        });
        await handlers.get("agent:send")?.({ sender: { id: 1 } }, sendInput);

        const graph = (await handlers.get("agent:extensions-graph")?.({})) as {
            nodes: Array<{ id: string; status: string; flags: string[] }>;
        };
        const nodes = graph.nodes.filter((node) => node.id === extensionPath);
        expect(nodes).toEqual([
            expect.objectContaining({
                status: "active",
                flags: ["reload.graph"],
            }),
        ]);
        sendSpy.mockRestore();
    });

    it("keeps active renderer subscriptions attached across a reload rebuild", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-reload-subscribe");
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue({
            harness: { subscribe: () => () => {}, abort: async () => {} },
            session: { buildContext: async () => ({ messages: [] }), getBranch: async () => [] },
            extensions: [],
            ctx: {},
            appendCustomEntry: async () => {},
            promptWithCustomEntry: async () => undefined,
            update: () => {},
        } as never);
        const sendSpy = vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-reload-subscribe");
        const sender = {
            id: 7,
            isDestroyed: vi.fn(() => false),
            once: vi.fn(),
            send: vi.fn(),
        } as unknown as electron.WebContents;

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const sendInput = {
            sessionMetadata: metadata,
            blockId: "block-1",
            cwd: metadata.cwd,
            text: "hello",
            provider: "p",
            model: "m",
        };

        await handlers.get("agent:send")?.({ sender: { id: 1 } }, sendInput);
        await subscribeAgentSessionForIpc(sender, metadata.path);
        expect(sender.send).toHaveBeenCalledWith(
            "agent:event",
            expect.objectContaining({
                sessionPath: metadata.path,
                event: expect.objectContaining({ type: "session_state" }),
            })
        );
        vi.mocked(sender.send).mockClear();

        await runAgentCommandForIpc({ command: "reload", cwd: metadata.cwd, sessionMetadata: metadata });
        await handlers.get("agent:send")?.({ sender: { id: 1 } }, sendInput);

        expect(sender.send).toHaveBeenCalledWith(
            "agent:event",
            expect.objectContaining({
                sessionPath: metadata.path,
                event: expect.objectContaining({ type: "session_state" }),
            })
        );
        sendSpy.mockRestore();
    });

    it("returns a noop command result when reload disposal fails", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-reload-error");
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockImplementation((opts: any) => {
            opts.extensionLifecycleHost.registerDispose(metadata.path, () => {
                throw new Error("dispose exploded");
            });
            return {
                harness: { subscribe: () => () => {}, abort: async () => {} },
                session: { buildContext: async () => ({ messages: [] }), getBranch: async () => [] },
                extensions: [],
                ctx: {},
                extensionRuntime: opts.extensionRuntime,
                extensionLifecycleOwnerId: opts.extensionLifecycleOwnerId,
                extensionLifecycleHost: opts.extensionLifecycleHost,
                appendCustomEntry: async () => {},
                promptWithCustomEntry: async () => undefined,
                update: () => {},
            } as never;
        });
        const sendSpy = vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-reload-error");

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        await handlers.get("agent:send")?.(
            { sender: { id: 1 } },
            {
                sessionMetadata: metadata,
                blockId: "block-1",
                cwd: metadata.cwd,
                text: "hello",
                provider: "p",
                model: "m",
            }
        );

        await expect(runAgentCommandForIpc({ command: "reload", cwd: metadata.cwd, sessionMetadata: metadata })).resolves.toEqual({
            status: "noop",
            message: "Reload failed: dispose exploded",
        });
        sendSpy.mockRestore();
    });

    it("returns a noop command result when reload owner cleanup fails", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-reload-cleanup-error");
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReturnValue({
            harness: { subscribe: () => () => {}, abort: async () => {} },
            session: { buildContext: async () => ({ messages: [] }), getBranch: async () => [] },
            extensions: [],
            ctx: {},
            appendCustomEntry: async () => {},
            promptWithCustomEntry: async () => undefined,
            update: () => {},
        } as never);
        const sendSpy = vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-cleanup-error");
        const disposeSpy = vi.spyOn(AgentSessionRuntime.prototype, "dispose").mockImplementation(() => {
            throw new Error("owner cleanup exploded");
        });

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        await handlers.get("agent:send")?.(
            { sender: { id: 1 } },
            {
                sessionMetadata: metadata,
                blockId: "block-1",
                cwd: metadata.cwd,
                text: "hello",
                provider: "p",
                model: "m",
            }
        );

        await expect(runAgentCommandForIpc({ command: "reload", cwd: metadata.cwd, sessionMetadata: metadata })).resolves.toEqual({
            status: "noop",
            message: "Reload failed: owner cleanup exploded",
        });
        sendSpy.mockRestore();
        disposeSpy.mockRestore();
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

        const payload = vi.mocked(sender.send).mock.calls[0][1] as { sessionPath: string };
        expect(payload.sessionPath).toBe(aliasPath);
        expect(payload.sessionPath).not.toBe(await fs.realpath(metadata.path));
        expect(sender.send).toHaveBeenCalledWith(
            "agent:event",
            expect.objectContaining({
                sessionPath: aliasPath,
                event: expect.objectContaining({
                    type: "session_state",
                    extensionUi: { statuses: {}, widgets: {}, widgetnodes: {} },
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

    it("does not send a delayed empty persisted snapshot after a canonical owner becomes live", async () => {
        const cwd = "/tmp/agent-ipc-persisted-race";
        const { metadata } = await createPaneSession(cwd);
        const metadataGate = deferred<typeof metadata>();
        const originalOpenPath = SqliteSessionRepo.prototype.openPath;
        const openPathSpy = vi.spyOn(SqliteSessionRepo.prototype, "openPath");
        openPathSpy.mockImplementationOnce(async function (filePath) {
            const opened = await originalOpenPath.call(this, filePath);
            vi.spyOn(opened, "getMetadata").mockReturnValueOnce(metadataGate.promise);
            return opened;
        });
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        let extensionUiBridge: { host?: AgentSessionRuntime };
        vi.mocked(buildAgentHarnessHost).mockImplementation((opts: any) => {
            extensionUiBridge = opts.extensionUiBridge;
            return {
                harness: { subscribe: () => () => {}, abort: async () => {} },
                session: opts.session,
                extensions: [],
                ctx: {},
                appendCustomEntry: async () => {},
                promptWithCustomEntry: async () => undefined,
                update: () => {},
                extensionLifecycleOwnerId: opts.extensionLifecycleOwnerId,
                extensionLifecycleHost: opts.extensionLifecycleHost,
            } as never;
        });
        vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-persisted-race");
        const sender = {
            id: 5,
            isDestroyed: vi.fn(() => false),
            once: vi.fn(),
            send: vi.fn(),
        } as unknown as electron.WebContents;
        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }

        const subscribePromise = subscribeAgentSessionForIpc(sender, metadata.path);
        await vi.waitFor(() => expect(openPathSpy).toHaveBeenCalledOnce());
        await handlers.get("agent:send")?.(
            { sender },
            {
                sessionMetadata: metadata,
                blockId: "block-1",
                cwd,
                text: "hello",
                provider: "p",
                model: "m",
            }
        );
        extensionUiBridge!.host!.setStatus("build", "Running");
        const sendsBeforePersistedReplayCompletes = vi.mocked(sender.send).mock.calls.length;

        metadataGate.resolve(metadata);
        await subscribePromise;
        expect(vi.mocked(sender.send).mock.calls).toHaveLength(sendsBeforePersistedReplayCompletes);
        expect(vi.mocked(sender.send).mock.calls.at(-1)?.[1]).toEqual(
            expect.objectContaining({
                event: expect.objectContaining({ type: "ext_ui_status", key: "build", text: "Running" }),
            })
        );
    });

    it("replays canonical owner extension UI when subscribing through an alias path", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-live-rendered-cwd-"));
        await fs.mkdir(path.join(cwd, ".crest", "extensions"), { recursive: true });
        await fs.writeFile(
            path.join(cwd, ".crest", "extensions", "live-renderer.ts"),
            `import { Text } from "@earendil-works/pi-tui";
             export default (pi) => { pi.registerEntryRenderer("live-entry", () => new Text("live rendered", 0, 0)); };`
        );
        const { metadata, session } = await createPaneSession(cwd);
        await session.appendCustomEntry("live-entry", { label: "live" });
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        let extensionUiBridge: { host?: AgentSessionRuntime };
        vi.mocked(buildAgentHarnessHost).mockImplementation((opts: any) => {
            extensionUiBridge = opts.extensionUiBridge;
            return {
                harness: { subscribe: () => () => {}, abort: async () => {} },
                session: opts.session,
                extensions: opts.extensions,
                ctx: {},
                appendCustomEntry: async () => {},
                promptWithCustomEntry: async () => undefined,
                update: () => {},
                extensionLifecycleOwnerId: opts.extensionLifecycleOwnerId,
                extensionLifecycleHost: opts.extensionLifecycleHost,
            } as never;
        });
        vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-live-rendered");
        const sender = {
            id: 3,
            isDestroyed: vi.fn(() => false),
            once: vi.fn(),
            send: vi.fn(),
        } as unknown as electron.WebContents;

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        await handlers.get("agent:send")?.(
            { sender },
            {
                sessionMetadata: metadata,
                blockId: "block-1",
                cwd,
                text: "hello",
                provider: "p",
                model: "m",
            }
        );

        const widget = { kind: "text" as const, id: "result", text: "Done", paddingx: 0, paddingy: 0 };
        const header = { kind: "text" as const, id: "header", text: "Header", paddingx: 0, paddingy: 0 };
        const footer = { kind: "text" as const, id: "footer", text: "Footer", paddingx: 0, paddingy: 0 };
        const owner = extensionUiBridge!.host!;
        owner.setStatus("build", "Running");
        owner.setWidget("result", widget);
        owner.setHeader(header);
        owner.setFooter(footer);
        const dir = path.dirname(metadata.path);
        const aliasPath = `${dir}${path.sep}..${path.sep}${path.basename(dir)}${path.sep}${path.basename(metadata.path)}`;
        const ownerBuildCount = vi.mocked(buildAgentHarnessHost).mock.calls.length;

        const state = (await handlers.get("agent:get-session-state")?.({}, { ...metadata, path: aliasPath })) as {
            extensionUi?: unknown;
        };
        const branchEntries = await owner.host.session.getBranch();
        const branchGate = deferred<typeof branchEntries>();
        const getBranchSpy = vi.spyOn(owner.host.session, "getBranch").mockReturnValueOnce(branchGate.promise);
        const subscribePromise = subscribeAgentSessionForIpc(sender, aliasPath);
        await vi.waitFor(() => expect(getBranchSpy).toHaveBeenCalledOnce());
        owner.setStatus("build", "Complete");
        branchGate.resolve(branchEntries);
        await subscribePromise;

        expect(state.extensionUi).toEqual({
            statuses: { build: "Running" },
            widgets: {},
            widgetnodes: { result: widget },
            header,
            footer,
        });
        const payload = vi.mocked(sender.send).mock.calls.at(-1)![1] as { sessionPath: string };
        expect(payload.sessionPath).toBe(aliasPath);
        expect(payload.sessionPath).not.toBe(await fs.realpath(metadata.path));
        expect(sender.send).toHaveBeenCalledWith(
            "agent:event",
            expect.objectContaining({
                sessionPath: aliasPath,
                event: expect.objectContaining({
                    type: "session_state",
                    renderedEntries: [expect.objectContaining({ customtype: "live-entry" })],
                    extensionUi: {
                        statuses: { build: "Complete" },
                        widgets: {},
                        widgetnodes: { result: widget },
                        header,
                        footer,
                    },
                }),
            })
        );
        expect(vi.mocked(buildAgentHarnessHost)).toHaveBeenCalledTimes(ownerBuildCount);
    });

    it("retries a live owner snapshot after the first snapshot send fails", async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ipc-snapshot-retry-cwd-"));
        const { metadata } = await createPaneSession(cwd);
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        let extensionUiBridge: { host?: AgentSessionRuntime };
        vi.mocked(buildAgentHarnessHost).mockImplementation((opts: any) => {
            extensionUiBridge = opts.extensionUiBridge;
            return {
                harness: { subscribe: () => () => {}, abort: async () => {} },
                session: opts.session,
                extensions: [],
                ctx: {},
                appendCustomEntry: async () => {},
                promptWithCustomEntry: async () => undefined,
                update: () => {},
                extensionLifecycleOwnerId: opts.extensionLifecycleOwnerId,
                extensionLifecycleHost: opts.extensionLifecycleHost,
            } as never;
        });
        vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-snapshot-retry");
        const sender = {
            id: 6,
            isDestroyed: vi.fn(() => false),
            once: vi.fn(),
            send: vi.fn(),
        } as unknown as electron.WebContents;

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        await handlers.get("agent:send")?.(
            { sender },
            {
                sessionMetadata: metadata,
                blockId: "block-1",
                cwd,
                text: "hello",
                provider: "p",
                model: "m",
            }
        );
        const owner = extensionUiBridge!.host!;
        const getBranchSpy = vi.spyOn(owner.host.session, "getBranch").mockRejectedValueOnce(new Error("snapshot failed once"));
        vi.mocked(sender.send).mockClear();

        await expect(subscribeAgentSessionForIpc(sender, metadata.path)).resolves.toBeUndefined();
        expect(getBranchSpy).toHaveBeenCalledTimes(2);
        expect(sender.send).toHaveBeenCalledWith(
            "agent:event",
            expect.objectContaining({
                event: expect.objectContaining({ type: "session_state" }),
            })
        );
        vi.mocked(sender.send).mockClear();
        owner.setStatus("retry", "still attached");
        expect(sender.send).toHaveBeenCalledWith(
            "agent:event",
            expect.objectContaining({
                event: expect.objectContaining({ type: "ext_ui_status", key: "retry", text: "still attached" }),
            })
        );
    });

    it("does not send a stale snapshot after reload replaces the runtime", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-stale-live-snapshot");
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        const bridges: ExtensionUiBridge[] = [];
        vi.mocked(buildAgentHarnessHost).mockImplementation((opts: any) => {
            if (opts.extensionUiBridge) bridges.push(opts.extensionUiBridge);
            return {
                ...makeHarnessHostMock(),
                session: opts.session,
                extensions: opts.extensions,
                extensionRuntime: opts.extensionRuntime,
                extensionLifecycleOwnerId: opts.extensionLifecycleOwnerId,
                extensionLifecycleHost: opts.extensionLifecycleHost,
            } as never;
        });
        vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-stale-snapshot");
        const sender = {
            id: 15,
            isDestroyed: vi.fn(() => false),
            once: vi.fn(),
            send: vi.fn(),
        } as unknown as electron.WebContents;
        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        const sendInput = {
            sessionMetadata: metadata,
            blockId: "block-1",
            cwd: metadata.cwd,
            text: "hello",
            provider: "p",
            model: "m",
        };
        await handlers.get("agent:send")?.({ sender }, sendInput);
        await subscribeAgentSessionForIpc(sender, metadata.path);
        const oldOwner = bridges[0].host as AgentSessionRuntime;
        oldOwner.setStatus("owner", "old");
        const branch = await oldOwner.host.session.getBranch();
        const branchGate = deferred<typeof branch>();
        vi.spyOn(oldOwner.host.session, "getBranch").mockReturnValueOnce(branchGate.promise);
        const staleSnapshot = subscribeAgentSessionForIpc(sender, metadata.path);
        await runAgentCommandForIpc({ command: "reload", cwd: metadata.cwd, sessionMetadata: metadata });
        await handlers.get("agent:send")?.({ sender }, sendInput);
        const newOwner = bridges[1].host as AgentSessionRuntime;
        newOwner.setStatus("owner", "new");
        vi.mocked(sender.send).mockClear();

        branchGate.resolve(branch);
        await staleSnapshot;

        expect(sender.send).not.toHaveBeenCalledWith(
            "agent:event",
            expect.objectContaining({
                event: expect.objectContaining({
                    type: "session_state",
                    extensionUi: expect.objectContaining({ statuses: { owner: "old" } }),
                }),
            })
        );
    });

    it("broadcasts an empty extension UI on no-owner navigation using the exact renderer path", async () => {
        const { metadata, session } = await createPaneSession("/tmp/agent-ipc-navigate-no-owner");
        const targetId = await session.appendMessage(user("navigate here"));
        const dir = path.dirname(metadata.path);
        const aliasPath = `${dir}${path.sep}..${path.sep}${path.basename(dir)}${path.sep}${path.basename(metadata.path)}`;
        const sender = {
            id: 4,
            isDestroyed: vi.fn(() => false),
            once: vi.fn(),
            send: vi.fn(),
        } as unknown as electron.WebContents;
        await subscribeAgentSessionForIpc(sender, aliasPath);
        vi.mocked(sender.send).mockClear();

        await navigateAgentTreeForIpc({
            sessionMetadata: { ...metadata, path: aliasPath },
            targetId,
        });

        expect(sender.send).toHaveBeenCalledOnce();
        const payload = vi.mocked(sender.send).mock.calls[0][1] as {
            sessionPath: string;
            event: { type: string; extensionUi?: unknown };
        };
        expect(payload.sessionPath).toBe(aliasPath);
        expect(payload.sessionPath).not.toBe(await fs.realpath(metadata.path));
        expect(payload.event).toEqual(
            expect.objectContaining({
                type: "session_state",
                extensionUi: { statuses: {}, widgets: {}, widgetnodes: {} },
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
            { sender: { id: 1 } },
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

    it("passes an extension lifecycle host and owner id to the pane harness", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-lifecycle");
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        vi.mocked(buildAgentHarnessHost).mockReset();
        vi.mocked(buildAgentHarnessHost).mockReturnValue({
            harness: { subscribe: () => () => {}, abort: async () => {} },
            session: { buildContext: async () => ({ messages: [] }), getBranch: async () => [] },
            extensions: [],
            ctx: {},
            appendCustomEntry: async () => {},
            promptWithCustomEntry: async () => undefined,
            update: () => {},
        } as never);
        const sendSpy = vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-lifecycle");

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }

        const result = (await handlers.get("agent:send")?.(
            { sender: { id: 1 } },
            {
                sessionMetadata: metadata,
                blockId: "block-1",
                cwd: "/tmp/agent-ipc-lifecycle",
                text: "hello",
                provider: "p",
                model: "m",
            }
        )) as { sessionMetadata: { path: string }; turnId: string };
        const harnessOptions = vi.mocked(buildAgentHarnessHost).mock.calls[0][0] as {
            extensionLifecycleHost?: { disposeAll: () => Promise<void> };
            extensionLifecycleOwnerId?: string;
        };

        expect(harnessOptions.extensionLifecycleHost).toEqual(
            expect.objectContaining({ disposeAll: expect.any(Function) })
        );
        expect(harnessOptions.extensionLifecycleOwnerId).toBe(result.sessionMetadata.path);
        sendSpy.mockRestore();
    });

    it("routes widget events to the live session ui bridge", async () => {
        const { metadata } = await createPaneSession("/tmp/agent-ipc-widget-event");
        vi.mocked(getModel).mockReturnValue({ provider: "p", id: "m", api: "openai" } as never);
        let dispatchWidgetEvent: ReturnType<typeof vi.spyOn> | undefined;
        vi.mocked(buildAgentHarnessHost).mockImplementation((opts: any) => {
            dispatchWidgetEvent = vi.spyOn(opts.extensionUiBridge, "dispatchWidgetEvent");
            return {
                harness: { subscribe: () => () => {}, abort: async () => {} },
                session: { buildContext: async () => ({ messages: [] }), getBranch: async () => [] },
                extensions: [],
                ctx: {},
                appendCustomEntry: async () => {},
                promptWithCustomEntry: async () => undefined,
                update: () => {},
            } as never;
        });
        vi.spyOn(AgentSessionRuntime.prototype, "sendWithExecutionConfig").mockResolvedValue("entry-widget");

        registerAgentIpcHandlers();
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        for (const call of vi.mocked(electron.ipcMain.handle).mock.calls) {
            handlers.set(call[0], call[1] as (...args: unknown[]) => unknown);
        }
        await handlers.get("agent:send")?.(
            { sender: { id: 1 } },
            {
                sessionMetadata: metadata,
                blockId: "block-1",
                cwd: "/tmp/agent-ipc-widget-event",
                text: "hello",
                provider: "p",
                model: "m",
            }
        );

        await respondWidgetEventForIpc(metadata.path, { nodeid: "node-1", type: "select", payload: { index: 0 } });

        expect(dispatchWidgetEvent).toHaveBeenCalledWith({ nodeid: "node-1", type: "select", payload: { index: 0 } });
    });
});
