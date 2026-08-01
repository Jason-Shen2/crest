// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    AssistantRuntimeProvider,
    useExternalStoreRuntime,
    type ExternalStoreAdapter,
    type ThreadMessageLike,
} from "@assistant-ui/react";
import { AgentHarness } from "@crest/agent/harness/agent-harness";
import { NodeExecutionEnv } from "@crest/agent/node";
import { getModel, registerApiProvider, resetApiProviders, type AssistantMessage, type Model } from "@crest/ai";
import { AssistantMessageEventStream } from "@crest/ai/utils/event-stream";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as electron from "electron";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        const wrapped = async (...args: unknown[]) => {
            const result = await handler(...args);
            if (!result || typeof result !== "object" || !Object.hasOwn(result, "ok")) return result;
            const envelope = result as { ok: true; value: unknown } | { ok: false; error: { message: string } };
            if (envelope.ok) return envelope.value;
            throw new Error(envelope.error.message);
        };
        const call = handle.mock.calls.at(-1);
        if (call?.[0] === channel) call[1] = wrapped;
    });
    return {
        app: {
            getPath: vi.fn(() => tmpdir()),
            isPackaged: false,
            runningUnderARM64Translation: false,
            setName: vi.fn(),
        },
        clipboard: { writeText: vi.fn() },
        dialog: { showMessageBoxSync: vi.fn() },
        ipcMain: { handle, on: vi.fn() },
        safeStorage: { decryptString: vi.fn(), isEncryptionAvailable: vi.fn(() => true) },
        shell: { openExternal: vi.fn() },
    };
});

// The E2E owns a real rewind stack. These mocks only keep unrelated model/tool
// startup out of the IPC module loaded by the test.
vi.mock("@crest/ai", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@crest/ai")>()),
    getModel: vi.fn(),
}));
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
    RpcApi: { GetCmdBlocksCommand: vi.fn(async () => []) },
}));
vi.mock("./emain-wsh", () => ({ ElectronWshClient: {} }));

import { SqliteSessionRepo } from "@crest/agent/harness/session/sqlite-repo";
import { AgentRuntimeRegistry } from "@crest/coding-agent/agent-runtime-registry";
import { buildAgentHarnessHost } from "@crest/coding-agent/harness-factory";
import { SessionMutationBarrier } from "@crest/coding-agent/session-mutation-barrier";
import { _setSessionsRepoForTests, defaultSessionsDir } from "@crest/coding-agent/sessions";
import { registerWorkspaceCheckpointManager } from "@crest/coding-agent/workspace-rewind/checkpoint-manager";
import { RewindConfirmationRegistry } from "@crest/coding-agent/workspace-rewind/confirmation-token";
import {
    applyCapturedPath,
    workspaceFilesystemApplyPlatformSupport,
} from "@crest/coding-agent/workspace-rewind/filesystem-apply";
import { WorkspaceGitRunner } from "@crest/coding-agent/workspace-rewind/git-runner";
import { makeProcessOwnerIdentity } from "@crest/coding-agent/workspace-rewind/process-owner";
import { WorkspaceRecoveryJournal } from "@crest/coding-agent/workspace-rewind/recovery-journal";
import { WorkspaceRewindEngine } from "@crest/coding-agent/workspace-rewind/rewind-engine";
import {
    buildAgentRewindSessionStateView,
    decodeWorkspaceCheckpointEntry,
} from "@crest/coding-agent/workspace-rewind/session-state";
import { WorkspaceCheckpointLimits, WorkspaceSnapshotStore } from "@crest/coding-agent/workspace-rewind/snapshot-store";
import { WorkspaceControlCustomTypes, type WorkspaceCheckpointV1 } from "@crest/coding-agent/workspace-rewind/types";
import {
    resolveCanonicalWorkspaceIdentity,
    type CanonicalWorkspaceIdentity,
} from "@crest/coding-agent/workspace-rewind/workspace-identity";
import { WorkspaceRecovery } from "@crest/coding-agent/workspace-rewind/workspace-recovery";
import { AgentRuntimeClient } from "../frontend/app/agent/agent-runtime-client";
import { Thread } from "../frontend/app/agent/assistant-ui";
import { RedoDock } from "../frontend/app/agent/rewind/redo-dock";
import { RewindPreviewDialog } from "../frontend/app/agent/rewind/rewind-preview-dialog";
import { useAgentRewind } from "../frontend/app/agent/rewind/use-agent-rewind";
import { _resetAgentIpcForTests, registerAgentIpcHandlers } from "./agent-ipc";
import { openAgentRewindFeature } from "./agent-rewind-feature";
import { AgentRewindService } from "./agent-rewind-service";

const RequestIdentity = Object.freeze({ workspaceId: "workspace-e2e", generation: 1 });
const cleanupRoots: string[] = [];
let previousConfigHome: string | undefined;
let previousDataHome: string | undefined;

beforeEach(async () => {
    previousConfigHome = process.env.WAVETERM_CONFIG_HOME;
    previousDataHome = process.env.WAVETERM_DATA_HOME;
    const configHome = await realpath(await mkdtemp(join(tmpdir(), "crest-agent-rewind-e2e-config-")));
    cleanupRoots.push(configHome);
    process.env.WAVETERM_CONFIG_HOME = configHome;
    vi.mocked(electron.ipcMain.handle).mockClear();
    vi.mocked(electron.ipcMain.on).mockClear();
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: vi.fn(),
    });
    await _resetAgentIpcForTests();
});

afterEach(async () => {
    vi.useRealTimers();
    await _resetAgentIpcForTests();
    _setSessionsRepoForTests(undefined);
    if (previousConfigHome == null) delete process.env.WAVETERM_CONFIG_HOME;
    else process.env.WAVETERM_CONFIG_HOME = previousConfigHome;
    if (previousDataHome == null) delete process.env.WAVETERM_DATA_HOME;
    else process.env.WAVETERM_DATA_HOME = previousDataHome;
    resetApiProviders();
    vi.unstubAllGlobals();
    await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function registeredHandlers(): Map<string, (...args: unknown[]) => unknown> {
    return new Map(
        vi
            .mocked(electron.ipcMain.handle)
            .mock.calls.map((call) => [call[0] as string, call[1] as (...args: unknown[]) => unknown])
    );
}

function makeRendererTransport(
    handlers: Map<string, (...args: unknown[]) => unknown>,
    sender: { id: number; isDestroyed(): boolean; once: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }
) {
    const invoke = (channel: string, identity: unknown, input: unknown) => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`Missing IPC handler ${channel}`);
        return handler({ sender }, identity, input);
    };
    return {
        send: (identity: unknown, input: unknown) => invoke("agent:send", identity, input),
        getSessionState: (identity: unknown, input: unknown) => invoke("agent:get-session-state", identity, input),
        listTree: (identity: unknown, input: unknown) => invoke("agent:list-tree", identity, input),
        navigateTree: (identity: unknown, input: unknown) => invoke("agent:navigate-tree", identity, input),
        listRewindPoints: (identity: unknown, input: unknown) => invoke("agent:list-rewind-points", identity, input),
        previewRewind: (identity: unknown, input: unknown) => invoke("agent:preview-rewind", identity, input),
        rewindTree: (identity: unknown, input: unknown) => invoke("agent:rewind-tree", identity, input),
        redoRewind: (identity: unknown, input: unknown) => invoke("agent:redo-rewind", identity, input),
        getWorkspaceRecovery: (identity: unknown, input: unknown) =>
            invoke("agent:get-workspace-recovery", identity, input),
        resolveWorkspaceRecovery: (identity: unknown, input: unknown) =>
            invoke("agent:resolve-workspace-recovery", identity, input),
        cleanupWorkspaceCheckpoints: (identity: unknown, input: unknown) =>
            invoke("agent:cleanup-workspace-checkpoints", identity, input),
        listCheckpointStorageOwners: (identity: unknown, input: unknown) =>
            invoke("agent:list-checkpoint-storage-owners", identity, input),
        purgeTrashedSession: (identity: unknown, input: unknown) =>
            invoke("agent:purge-trashed-session", identity, input),
    };
}

function installPromptHarness(mutate: () => Promise<void>) {
    const model: Model<any> = {
        provider: "p",
        id: "m",
        name: "Rewind E2E",
        api: "rewind-e2e",
        baseUrl: "http://localhost",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000,
        maxTokens: 1_000,
    };
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve;
    });
    const observed = { events: [] as string[], settled };
    registerApiProvider({
        api: model.api,
        stream: () => new AssistantMessageEventStream(),
        streamSimple: (activeModel) => {
            const output = new AssistantMessageEventStream();
            void (async () => {
                await mutate();
                const message: AssistantMessage = {
                    role: "assistant",
                    content: [{ type: "text", text: "done" }],
                    api: activeModel.api,
                    provider: activeModel.provider,
                    model: activeModel.id,
                    stopReason: "stop",
                    timestamp: Date.now(),
                    usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                };
                output.push({ type: "start", partial: message });
                output.push({ type: "done", reason: "stop", message });
            })();
            return output;
        },
    });
    vi.mocked(getModel).mockReturnValue(model as never);
    vi.mocked(buildAgentHarnessHost).mockImplementation((options) => {
        const harness = new AgentHarness({
            env: new NodeExecutionEnv({ cwd: options.promptInputs.cwd }),
            session: options.session,
            model,
            thinkingLevel: "off",
            tools: [],
            systemPrompt: "Rewind E2E",
        });
        harness.subscribe((event) => {
            observed.events.push(event.type);
            if (event.type === "agent_end") {
                resolveSettled();
            }
        });
        return {
            harness,
            session: options.session,
            appendCustomEntry: (customType: string, data?: unknown) =>
                options.session.appendCustomEntry(customType, data).then(() => undefined),
            promptWithCustomEntry: vi.fn(),
            setAuthResolver: vi.fn(),
            setToolCallHook: vi.fn(),
            resolveAuth: vi.fn(),
            runToolCallHook: vi.fn(),
            getCwd: () => options.promptInputs.cwd,
            update: vi.fn(),
        } as never;
    });
    return observed;
}

function RewindMessageUi(props: {
    client: AgentRuntimeClient;
    metadata: AgentSessionMeta;
    rewindState: AgentRewindSessionStateView;
    turnId: string;
    prompt: string;
    onEditorText: (text: string) => void;
    onError: (message: string) => void;
}) {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: props.prompt }],
                metadata: { custom: { turnId: props.turnId } },
            } as ThreadMessageLike,
        ],
        convertMessage: (message) => message,
        onNew: async () => {},
    } satisfies ExternalStoreAdapter<ThreadMessageLike>);
    const controller = useAgentRewind({
        client: props.client,
        sessionMetadata: props.metadata,
        sessionRevision: 1,
        rewindState: props.rewindState,
        onRevealTurn: async () => true,
        onEditorText: props.onEditorText,
        onError: props.onError,
    });
    return createElement(
        AssistantRuntimeProvider,
        { runtime },
        createElement(Thread, {
            rewindableTurnIds: controller.rewindableTurnIds,
            rewindBusy: controller.busy,
            onRevertTurn: controller.openRewind,
        }),
        createElement(RewindPreviewDialog, {
            open: controller.preview.open,
            operation: controller.preview.operation,
            phase: controller.preview.phase,
            busy: controller.busy,
            preview: controller.preview.result,
            errorMessage: controller.preview.errorMessage,
            onCancel: controller.cancelPreview,
            onConfirm: controller.confirmPreview,
        })
    );
}

async function makeFixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "crest-agent-rewind-e2e-")));
    cleanupRoots.push(root);
    const workspaceRoot = await realpath(await mkdir(join(root, "workspace"), { recursive: true }));
    process.env.WAVETERM_DATA_HOME = join(root, "data");
    const identity = await resolveCanonicalWorkspaceIdentity(workspaceRoot);
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: join(root, "data"),
        identity,
        git: new WorkspaceGitRunner(),
        processOwner: await makeProcessOwnerIdentity(),
    });
    const repo = new SqliteSessionRepo({ sessionsRoot: defaultSessionsDir() });
    _setSessionsRepoForTests(repo);
    const session = await repo.create({ cwd: workspaceRoot, id: "session-e2e" });
    const metadata = await session.getMetadata();
    const listeners = new Set<(event: AgentHarnessEvent) => void | Promise<void>>();
    const harness = {
        subscribe(listener: (event: AgentHarnessEvent) => void | Promise<void>) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    const emit = async (event: AgentHarnessEvent) => {
        await Promise.all([...listeners].map(async (listener) => await listener(event)));
    };
    const manager = registerWorkspaceCheckpointManager({
        harness: harness as never,
        session,
        sessionId: metadata.id,
        workspaceRoot,
        store,
        mutationBarrier: new SessionMutationBarrier(),
        hasRunningHostedCommands: () => false,
        processOwner: await makeProcessOwnerIdentity(),
        onCheckpointCommitted: async () => undefined,
    });
    const makeService = (
        applyPath: typeof applyCapturedPath = applyCapturedPath,
        publishForLease: () => Promise<void> = async () => undefined
    ) => {
        const confirmations = new RewindConfirmationRegistry();
        const registry = new AgentRuntimeRegistry({ idleTtlMs: 60_000 });
        let publishState = async () => undefined;
        const journal = new WorkspaceRecoveryJournal(store);
        const recovery = new WorkspaceRecovery({
            workspace: identity,
            store,
            journal,
            locateSession: async (sessionId) => {
                if (sessionId !== metadata.id) return undefined;
                return {
                    async getLeafId() {
                        const opened = await repo.open(metadata);
                        try {
                            return await opened.getLeafId();
                        } finally {
                            opened.close();
                        }
                    },
                    async getEntry(id) {
                        const opened = await repo.open(metadata);
                        try {
                            return await opened.getEntry(id);
                        } finally {
                            opened.close();
                        }
                    },
                };
            },
        });
        const engine = new WorkspaceRewindEngine({
            store,
            journal,
            recovery,
            confirmations,
            applyPath,
            onCommitted: async () => await publishState(),
        });
        const service = new AgentRewindService({
            registry: registry as never,
            confirmations,
            openSession: (input) => repo.open(input),
            resolveWorkspace: async (input) => {
                if (input.mode === "mutation") publishState = input.publishState;
                return { workspace: identity, store, engine };
            },
            broadcaster: { publishForLease },
        });
        return { service, registry };
    };
    const register = (
        service: AgentRewindService,
        rewindMaintenance?: NonNullable<Parameters<typeof registerAgentIpcHandlers>[0]["rewindMaintenance"]>
    ) => {
        const sender = { id: 7, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
        registerAgentIpcHandlers({
            resolveWorkspaceSender: async () => ({
                ...RequestIdentity,
                windowId: "window-e2e",
                workspaceDir: workspaceRoot,
                validatePreferredTerminal: async () => true,
            }),
            loadWorkspace: async () => ({}) as never,
            saveWorkspaceAgentState: async () => ({}) as never,
            rewindService: service,
            ...(rewindMaintenance ? { rewindMaintenance } : {}),
        });
        const transport = makeRendererTransport(registeredHandlers(), sender);
        return { client: new AgentRuntimeClient(transport as never, RequestIdentity), sender };
    };
    const sendTurn = async (prompt: string, mutate: () => Promise<void>) => {
        const boundaryToken = crypto.randomUUID();
        await emit({
            type: "session_before_user_turn",
            boundaryToken,
            userMessage: { role: "user", content: [{ type: "text", text: prompt }] },
        } as AgentHarnessEvent);
        const turnId = await session.appendMessage({
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
        } as never);
        await emit({ type: "session_user_turn_committed", boundaryToken, userEntryId: turnId } as AgentHarnessEvent);
        await mutate();
        await emit({
            type: "session_user_turn_terminal",
            boundaryToken,
            reason: "agent_end",
        } as AgentHarnessEvent);
        return turnId;
    };
    const rewindState = async () => {
        const opened = await repo.open(metadata);
        try {
            return await buildAgentRewindSessionStateView(await opened.getEntries(), metadata.id, {
                enabled: true,
                busy: false,
                frozen: false,
                verifySnapshot: (snapshot) => store.verifyOwnedSnapshot(snapshot),
                getQuota: async () => {
                    const quota = await store.getQuotaStatus();
                    return { ...quota, cleanupAvailable: quota.status !== "ok" };
                },
            });
        } finally {
            opened.close();
        }
    };
    return {
        root,
        workspaceRoot,
        metadata,
        store,
        repo,
        session,
        manager,
        makeService,
        register,
        sendTurn,
        rewindState,
    };
}

async function appendCheckpoint(
    value: Awaited<ReturnType<typeof makeFixture>>,
    session: Awaited<ReturnType<SqliteSessionRepo["create"]>>,
    prompt: string,
    mutate: () => Promise<void>
) {
    const before = await value.store.capture({ profile: "pre-turn" });
    const turnId = await session.appendMessage({
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: Date.now(),
    } as never);
    await mutate();
    const after = await value.store.capture({ profile: "terminal" });
    const metadata = await session.getMetadata();
    const checkpoint: Extract<WorkspaceCheckpointV1, { status: "available" }> = {
        schemaVersion: 1,
        status: "available",
        originSessionId: metadata.id,
        turnId,
        workspaceIdentity: value.store.identity.workspaceIdentity,
        workspaceIncarnation: value.store.identity.workspaceIncarnation,
        before: before.ref,
        after: after.ref,
        changes: await value.store.diff(before.ref, after.ref),
        coverage: after.coverage,
    };
    const checkpointId = await session.appendCustomEntry(WorkspaceControlCustomTypes.checkpoint, checkpoint);
    return { metadata, turnId, checkpointId, checkpoint };
}

describe("Agent rewind renderer → IPC → production persistence E2E", () => {
    it("exposes the typed Windows rollout hard-block before inspect or apply", async () => {
        const feature = await openAgentRewindFeature({
            workspaceRoot: "C:\\workspace",
            dataRoot: "C:\\data",
            dependencies: {
                resolveIdentity: async () =>
                    ({
                        canonicalRoot: "C:\\workspace",
                        workspaceIdentity: "1".repeat(64),
                        workspaceIncarnation: "2".repeat(64),
                        storeKey: "windows-hard-block",
                        ancestorIdentityChain: [],
                    }) as CanonicalWorkspaceIdentity,
                openStore: async () => {
                    throw new Error("Windows ACL owner-only store support is unavailable");
                },
            },
        });

        expect(feature).toEqual({
            state: "unavailable",
            message: "Windows ACL owner-only store support is unavailable",
        });
        expect(workspaceFilesystemApplyPlatformSupport("win32")).toEqual({
            supported: false,
            code: "windows-reparse-unsupported",
        });
    });

    it("checkpoints a sent turn, restores through the renderer hook, reloads, and redoes", async () => {
        const value = await makeFixture();
        const file = join(value.workspaceRoot, "changed.txt");
        await writeFile(file, "before");
        await value.manager.dispose();
        const promptHarness = installPromptHarness(async () => await writeFile(file, "after"));

        const authoritativePublish = vi.fn(async () => undefined);
        const first = value.makeService(applyCapturedPath, authoritativePublish);
        expect(first.registry.get(value.metadata.path)).toBeUndefined();
        const { client } = value.register(first.service);
        const sent = await client.send({
            sessionMetadata: value.metadata,
            context: {
                workspaceId: RequestIdentity.workspaceId,
                workspaceDir: value.workspaceRoot,
                sessionPath: value.metadata.path,
                environment: {},
            },
            text: "Original user prompt",
            provider: "p",
            model: "m",
        });
        const turnId = sent.turnId;
        await promptHarness.settled;
        expect(
            promptHarness.events.filter((type) =>
                ["session_before_user_turn", "session_user_turn_committed", "session_user_turn_terminal"].includes(type)
            )
        ).toEqual(["session_before_user_turn", "session_user_turn_committed", "session_user_turn_terminal"]);
        const liveState = await client.getSessionState(value.metadata);
        expect(liveState).toMatchObject({
            workspaceRewind: { status: "enabled" },
            rewindState: {
                enabled: true,
                busy: false,
                eligibleTurnIds: [turnId],
            },
        });
        expect((await value.session.getEntries()).map((entry) => [entry.type, entry.customType])).toContainEqual([
            "custom",
            WorkspaceControlCustomTypes.checkpoint,
        ]);
        expect(
            (await value.session.getEntries()).map(decodeWorkspaceCheckpointEntry).filter((entry) => entry != null)
        ).toEqual([expect.objectContaining({ status: "available", turnId })]);
        const points = await client.listRewindPoints({ sessionMetadata: value.metadata });
        expect(points.points).toEqual([
            expect.objectContaining({ turnId, preview: "Original user prompt", eligible: true }),
        ]);

        const editorText = vi.fn();
        const errors = vi.fn();
        const applyFromUi = vi.spyOn(client, "rewindTree");
        let state = liveState.rewindState!;
        const rewindUi = render(
            createElement(RewindMessageUi, {
                client,
                metadata: value.metadata,
                rewindState: state,
                turnId,
                prompt: "Original user prompt",
                onEditorText: editorText,
                onError: errors,
            })
        );
        fireEvent.click(screen.getByRole("button", { name: "Revert" }));
        const previewDialog = await screen.findByRole("dialog");
        expect(await within(previewDialog).findByText("Original user prompt")).not.toBeNull();
        expect(await readFile(file, "utf8")).toBe("after");
        fireEvent.click(within(previewDialog).getByRole("button", { name: "Revert" }));
        await waitFor(() => expect(applyFromUi).toHaveBeenCalledOnce());
        await act(async () => await applyFromUi.mock.results[0]!.value);
        expect(applyFromUi).toHaveBeenCalledWith(expect.objectContaining({ mode: "normal", targetTurnId: turnId }));
        await waitFor(async () => expect(await readFile(file, "utf8")).toBe("before"));
        await waitFor(() => expect(editorText).toHaveBeenCalledWith("Original user prompt"));
        expect(errors).not.toHaveBeenCalled();
        expect(authoritativePublish).toHaveBeenCalled();

        state = await value.rewindState();
        await waitFor(() => expect(state.redo?.targetPrompt).toBe("Original user prompt"));
        rewindUi.unmount();

        // A reload drops every in-memory confirmation and reconstructs the
        // service/client from the persisted SQLite branch and Git store.
        vi.mocked(electron.ipcMain.handle).mockClear();
        const reloaded = value.makeService();
        const { client: reloadedClient } = value.register(reloaded.service);
        const persisted = await value.rewindState();
        expect(persisted.redo).toMatchObject({ targetPrompt: "Original user prompt", fileCount: 1 });
        const dock = render(
            createElement(RedoDock, {
                redo: persisted.redo!,
                busy: false,
                onRedo: vi.fn(),
            })
        );
        expect(screen.getByRole("region", { name: "Reverted workspace changes" })).not.toBeNull();
        expect(screen.getByRole("button", { name: "Redo" })).not.toBeNull();
        dock.unmount();
        const redo = await reloadedClient.previewRewind({
            sessionMetadata: value.metadata,
            expectedSemanticLeafId: persisted.semanticLeafId,
            target: { kind: "redo" },
        });
        await reloadedClient.redoRewind({
            sessionMetadata: value.metadata,
            expectedSemanticLeafId: persisted.semanticLeafId,
            confirmationToken: redo.confirmationToken!,
        });

        expect(await readFile(file, "utf8")).toBe("after");
        expect((await value.rewindState()).redo).toBeUndefined();
        value.session.close();
    }, 30_000);

    it("rejects stale confirmation and hard-blocks a real directory collision", async () => {
        const value = await makeFixture();
        const file = join(value.workspaceRoot, "changed.txt");
        await writeFile(file, "before");
        const turnId = await value.sendTurn("change it", async () => await writeFile(file, "after"));
        await value.manager.dispose();
        const running = value.makeService();
        const { client } = value.register(running.service);
        const points = await client.listRewindPoints({ sessionMetadata: value.metadata });
        const planned = await client.previewRewind({
            sessionMetadata: value.metadata,
            expectedSemanticLeafId: points.semanticLeafId,
            target: { kind: "rewind", targetTurnId: turnId },
        });

        await writeFile(file, "external writer");
        await expect(
            client.rewindTree({
                sessionMetadata: value.metadata,
                expectedSemanticLeafId: points.semanticLeafId,
                targetTurnId: turnId,
                mode: "force-drift",
                confirmationToken: planned.confirmationToken!,
            })
        ).rejects.toThrow(/confirmation|changed|plan/i);
        expect(await readFile(file, "utf8")).toBe("external writer");

        await rm(file);
        await mkdir(file);
        const blocked = await client.previewRewind({
            sessionMetadata: value.metadata,
            expectedSemanticLeafId: points.semanticLeafId,
            target: { kind: "rewind", targetTurnId: turnId },
        });
        expect(blocked).toMatchObject({
            hardBlocked: true,
            files: [expect.objectContaining({ path: "changed.txt", conflict: "hard-blocker" })],
        });
        expect(blocked.confirmationToken).toBeUndefined();
        value.session.close();
    }, 30_000);

    it("force reverts only the confirmed red-listed drift through production IPC", async () => {
        const value = await makeFixture();
        const drifted = join(value.workspaceRoot, "drifted.txt");
        const clean = join(value.workspaceRoot, "clean.txt");
        const outside = join(value.workspaceRoot, "outside.txt");
        await Promise.all([
            writeFile(drifted, "before-drifted"),
            writeFile(clean, "before-clean"),
            writeFile(outside, "before-outside"),
        ]);
        const turnId = await value.sendTurn("change two files", async () => {
            await Promise.all([writeFile(drifted, "agent-drifted"), writeFile(clean, "agent-clean")]);
        });
        await value.manager.dispose();
        await Promise.all([writeFile(drifted, "external-drift"), writeFile(outside, "external-outside")]);

        const running = value.makeService();
        const { client } = value.register(running.service);
        const points = await client.listRewindPoints({ sessionMetadata: value.metadata });
        const preview = await client.previewRewind({
            sessionMetadata: value.metadata,
            expectedSemanticLeafId: points.semanticLeafId,
            target: { kind: "rewind", targetTurnId: turnId },
        });

        expect(preview).toMatchObject({
            forceRequired: true,
            hardBlocked: false,
            files: expect.arrayContaining([
                expect.objectContaining({ path: "drifted.txt", conflict: "forceable-drift" }),
                expect.objectContaining({ path: "clean.txt", conflict: "none" }),
            ]),
        });
        expect(preview.files.filter((file) => file.conflict !== "none").map((file) => file.path)).toEqual([
            "drifted.txt",
        ]);

        await client.rewindTree({
            sessionMetadata: value.metadata,
            expectedSemanticLeafId: points.semanticLeafId,
            targetTurnId: turnId,
            mode: "force-drift",
            confirmationToken: preview.confirmationToken!,
        });

        expect(await readFile(drifted, "utf8")).toBe("before-drifted");
        expect(await readFile(clean, "utf8")).toBe("before-clean");
        expect(await readFile(outside, "utf8")).toBe("external-outside");
        value.session.close();
    }, 30_000);

    it("serializes concurrent sessions through the production service workspace lock", async () => {
        const value = await makeFixture();
        await writeFile(join(value.workspaceRoot, "a.txt"), "base-a");
        await writeFile(join(value.workspaceRoot, "b.txt"), "base-b");
        const turnA = await value.sendTurn("change a", async () => {
            await writeFile(join(value.workspaceRoot, "a.txt"), "after-a");
        });
        await value.manager.dispose();
        const metadataA = value.metadata;
        const sessionB = await value.repo.create({ cwd: value.workspaceRoot, id: "session-e2e-b" });
        const b = await appendCheckpoint(value, sessionB, "change b", async () => {
            await writeFile(join(value.workspaceRoot, "b.txt"), "after-b");
        });

        const events: string[] = [];
        const running = value.makeService(async (input) => {
            events.push(`start:${input.path}`);
            await new Promise<void>((resolve) => setImmediate(resolve));
            await applyCapturedPath(input);
            events.push(`end:${input.path}`);
        });
        const { client } = value.register(running.service);
        const [pointsA, pointsB] = await Promise.all([
            client.listRewindPoints({ sessionMetadata: metadataA }),
            client.listRewindPoints({ sessionMetadata: b.metadata }),
        ]);
        const [previewA, previewB] = await Promise.all([
            client.previewRewind({
                sessionMetadata: metadataA,
                expectedSemanticLeafId: pointsA.semanticLeafId,
                target: { kind: "rewind", targetTurnId: turnA },
            }),
            client.previewRewind({
                sessionMetadata: b.metadata,
                expectedSemanticLeafId: pointsB.semanticLeafId,
                target: { kind: "rewind", targetTurnId: b.turnId },
            }),
        ]);

        await Promise.all([
            client.rewindTree({
                sessionMetadata: metadataA,
                expectedSemanticLeafId: pointsA.semanticLeafId,
                targetTurnId: turnA,
                mode: "normal",
                confirmationToken: previewA.confirmationToken!,
            }),
            client.rewindTree({
                sessionMetadata: b.metadata,
                expectedSemanticLeafId: pointsB.semanticLeafId,
                targetTurnId: b.turnId,
                mode: "normal",
                confirmationToken: previewB.confirmationToken!,
            }),
        ]);

        expect(events).toHaveLength(4);
        expect(events[0]!.replace("start:", "")).toBe(events[1]!.replace("end:", ""));
        expect(events[2]!.replace("start:", "")).toBe(events[3]!.replace("end:", ""));
        expect(new Set(events.map((event) => event.split(":")[1]))).toEqual(new Set(["a.txt", "b.txt"]));
        sessionB.close();
        value.session.close();
    }, 30_000);

    it("keeps production /tree navigation conversation-only", async () => {
        const value = await makeFixture();
        const file = join(value.workspaceRoot, "tree.txt");
        await writeFile(file, "before");
        const turnId = await value.sendTurn("tree navigation", async () => {
            await writeFile(file, "after");
        });
        await value.manager.dispose();
        const running = value.makeService();
        const { client } = value.register(running.service);
        const beforeBytes = await readFile(file);
        const beforeRefs = await value.store.listCrestRefs();

        const tree = await client.listTree(value.metadata as never);
        expect(tree.entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: turnId })]));
        await client.navigateTree({
            sessionMetadata: value.metadata,
            targetId: turnId,
            semanticAnchorId: null,
            expectedSemanticLeafId: tree.semanticLeafId,
        } as never);

        expect(await readFile(file)).toEqual(beforeBytes);
        expect(await value.store.listCrestRefs()).toEqual(beforeRefs);
        value.session.close();
    }, 30_000);

    it("surfaces and resolves a real interrupted restore journal through IPC", async () => {
        const value = await makeFixture();
        const file = join(value.workspaceRoot, "recovery.txt");
        await writeFile(file, "pre-crash");
        const safety = await value.store.capture({ profile: "safety", requiredPaths: ["recovery.txt"] });
        const preState = await value.store.readPathState(safety.ref, "recovery.txt");
        await writeFile(file, "target");
        const target = await value.store.capture({ profile: "terminal", requiredPaths: ["recovery.txt"] });
        const targetState = await value.store.readPathState(target.ref, "recovery.txt");
        await writeFile(file, "pre-crash");
        const expectedLeaf = await value.session.appendMessage({
            role: "user",
            content: "interrupted restore",
            timestamp: Date.now(),
        } as never);
        const journal = new WorkspaceRecoveryJournal(value.store);
        await journal.begin({
            schemaVersion: 2,
            phase: "prepared",
            workspaceIdentity: value.store.identity.workspaceIdentity,
            workspaceIncarnation: value.store.identity.workspaceIncarnation,
            sessionId: value.metadata.id,
            sessionPath: value.metadata.path,
            operationId: "operation-e2e-crash",
            target: { kind: "rewind", targetTurnId: expectedLeaf },
            commitParentId: null,
            applyMode: "normal",
            expectedSemanticLeafId: expectedLeaf,
            safetySnapshot: safety.ref,
            confirmedConflictFingerprints: [],
            paths: [
                {
                    path: "recovery.txt",
                    preState,
                    target: targetState,
                    expectedCurrent: preState,
                    confirmedLiveFingerprint: "5".repeat(64),
                    createdParentDirectories: [],
                },
            ],
            workspaceStateEntryId: "workspace-state-e2e-crash",
        });
        await journal.transition("operation-e2e-crash", "applying_files");
        const recovery = new WorkspaceRecovery({
            workspace: value.store.identity,
            store: value.store,
            journal,
            locateSession: async (sessionId) => (sessionId === value.metadata.id ? value.session : undefined),
        });
        const maintenance = {
            getRecovery: async () => await recovery.getRecoveryState(value.store.identity),
            resolveRecovery: async (input: unknown) => {
                const action = (input as { action: string }).action;
                if (action !== "abandon-current") throw new Error(`unexpected recovery action ${action}`);
                await recovery.abandonKeepingCurrent("operation-e2e-crash");
            },
            cleanup: async () => {
                throw new Error("unused");
            },
            listStorageOwners: async () => {
                throw new Error("unused");
            },
            purgeTrashedSession: async () => {
                throw new Error("unused");
            },
        };
        const running = value.makeService();
        const { client } = value.register(running.service, maintenance);

        const frozen = await client.getWorkspaceRecovery({ sessionMetadata: value.metadata });
        expect(frozen).toMatchObject({
            operationId: "operation-e2e-crash",
            phase: "applying_files",
            allowedActions: expect.arrayContaining(["abandon-current"]),
        });
        expect(JSON.stringify(frozen)).not.toMatch(/force/i);
        await client.resolveWorkspaceRecovery({
            sessionMetadata: value.metadata,
            operationId: "operation-e2e-crash",
            action: "abandon-current",
        });
        await expect(client.getWorkspaceRecovery({ sessionMetadata: value.metadata })).resolves.toBeUndefined();
        expect(await readFile(file, "utf8")).toBe("pre-crash");
        value.session.close();
    }, 30_000);

    it("cleans a real unowned object after production quota classification exceeds the soft limit", async () => {
        const value = await makeFixture();
        await value.manager.dispose();
        const unowned = await value.store.git.run(["hash-object", "-w", "--stdin"], {
            gitDir: value.store.storeRoot,
            stdin: randomBytes(64 * 1024),
            timeoutMs: 5_000,
        });
        const unownedOid = unowned.stdout.toString("ascii").trim();
        const originalRun = WorkspaceGitRunner.prototype.run;
        let reportQuotaPressure = true;
        let gcCalls = 0;
        const gitRun = vi.spyOn(WorkspaceGitRunner.prototype, "run").mockImplementation(async function (args, options) {
            if (args[0] === "count-objects" && reportQuotaPressure) {
                return {
                    stdout: Buffer.from(
                        [
                            "count: 1",
                            `size: ${Math.floor(WorkspaceCheckpointLimits.softQuotaBytes / 1024) + 1}`,
                            "in-pack: 0",
                            "packs: 0",
                            "size-pack: 0",
                            "prune-packable: 0",
                            "garbage: 0",
                            "size-garbage: 0",
                            "",
                        ].join("\n")
                    ),
                    stderr: Buffer.alloc(0),
                };
            }
            const result = await originalRun.call(this, args, options);
            if (args[0] === "gc") {
                gcCalls++;
                reportQuotaPressure = false;
            }
            return result;
        });

        try {
            const quotaBefore = await value.store.getQuotaStatus();
            expect(quotaBefore).toMatchObject({
                status: "soft-quota-exceeded",
                referencedBytes: 0,
                softQuotaBytes: WorkspaceCheckpointLimits.softQuotaBytes,
            });
            expect(quotaBefore.usedBytes).toBeGreaterThan(quotaBefore.softQuotaBytes);

            const running = value.makeService();
            const { client } = value.register(running.service);
            const cleanup = await client.cleanupWorkspaceCheckpoints({ sessionMetadata: value.metadata });

            expect(gcCalls).toBe(1);
            expect(cleanup.removedUnownedBytes).toBeGreaterThan(0);
            expect(cleanup.quota).toMatchObject({
                status: "ok",
                cleanupAvailable: false,
            });
            expect(cleanup.quota.usedBytes).toBeLessThan(quotaBefore.usedBytes);
            await expect(
                value.store.git.run(["cat-file", "blob", unownedOid], {
                    gitDir: value.store.storeRoot,
                    timeoutMs: 5_000,
                })
            ).rejects.toThrow();
        } finally {
            gitRun.mockRestore();
            value.session.close();
        }
    }, 30_000);

    it("preserves active/archive owners and purges only a confirmed real trash owner", async () => {
        const value = await makeFixture();
        await writeFile(join(value.workspaceRoot, "owned.txt"), "base");
        await value.sendTurn("active owner", async () => {
            await writeFile(join(value.workspaceRoot, "owned.txt"), "active");
        });
        await value.manager.dispose();
        const activeCheckpoint = (await value.session.getEntries())
            .map(decodeWorkspaceCheckpointEntry)
            .find((checkpoint) => checkpoint?.status === "available")!;
        const archiveSession = await value.repo.create({ cwd: value.workspaceRoot, id: "session-e2e-archive" });
        const archiveCheckpoint = await appendCheckpoint(value, archiveSession, "archive owner", async () => {
            await writeFile(join(value.workspaceRoot, "archive-owned.txt"), "archive");
        });
        const archiveMetadata = await archiveSession.getMetadata();
        archiveSession.close();
        await value.repo.archive(archiveMetadata);
        const trashSession = await value.repo.create({ cwd: value.workspaceRoot, id: "session-e2e-trash" });
        const trashCheckpoint = await appendCheckpoint(value, trashSession, "trash owner", async () => {
            await writeFile(join(value.workspaceRoot, "trash-owned.txt"), "trash");
        });
        trashSession.close();
        await value.repo.stageDelete(trashCheckpoint.metadata);
        const ownedSnapshots = [
            activeCheckpoint.before,
            activeCheckpoint.after,
            archiveCheckpoint.checkpoint.before,
            archiveCheckpoint.checkpoint.after,
            trashCheckpoint.checkpoint.before,
            trashCheckpoint.checkpoint.after,
        ];

        const running = value.makeService();
        const { client } = value.register(running.service);
        const quotaBefore = await value.store.getQuotaStatus();
        const cleanup = await client.cleanupWorkspaceCheckpoints({ sessionMetadata: value.metadata });
        expect(cleanup.removedUnownedBytes).toBeGreaterThanOrEqual(0);
        await Promise.all(ownedSnapshots.map((snapshot) => value.store.verifyOwnedSnapshot(snapshot)));

        const owners = await client.listCheckpointStorageOwners({ sessionMetadata: value.metadata });
        expect(owners.trashOwners).toHaveLength(1);
        const owner = owners.trashOwners[0]!;
        expect(owner.sessionId).toBe("session-e2e-trash");
        expect(owner.confirmationToken.length).toBeGreaterThan(32);
        expect(owner.confirmationToken).not.toContain(owner.sessionId);
        const purged = await client.purgeTrashedSession({
            sessionMetadata: value.metadata,
            trashedSessionId: owner.sessionId,
            confirmationToken: owner.confirmationToken,
        });
        expect(purged.purgedSessionId).toBe(owner.sessionId);
        expect((await client.listCheckpointStorageOwners({ sessionMetadata: value.metadata })).trashOwners).toEqual([]);
        await expect(value.repo.open(trashCheckpoint.metadata)).rejects.toThrow(/not found/i);

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(Date.now() + 8 * 24 * 60 * 60 * 1_000));
        await client.cleanupWorkspaceCheckpoints({ sessionMetadata: value.metadata });
        vi.useRealTimers();
        const quotaAfter = await value.store.getQuotaStatus();
        expect(quotaAfter.referencedBytes).toBeLessThan(quotaBefore.referencedBytes);
        expect(quotaAfter.referencedBytes).toBeGreaterThan(0);
        value.session.close();
    }, 30_000);
});
