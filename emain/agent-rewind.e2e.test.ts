// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
    AssistantRuntimeProvider,
    useExternalStoreRuntime,
    type ExternalStoreAdapter,
    type ThreadMessageLike,
} from "@assistant-ui/react";
import { AgentHarness } from "@crest/agent/harness/agent-harness";
import { NodeExecutionEnv } from "@crest/agent/node";
import {
    getModel,
    registerApiProvider,
    resetApiProviders,
    type AssistantMessage,
    type Model,
    type ModelCatalog,
} from "@crest/ai";
import { AssistantMessageEventStream } from "@crest/ai/utils/event-stream";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as electron from "electron";
import { createElement, useState } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        const wrapped = async (...args: unknown[]) => {
            const result = await handler(...args);
            if (!result || typeof result !== "object" || !Object.hasOwn(result, "ok")) return result;
            const envelope = result as { ok: true; value: unknown } | { ok: false; error: { message: string } };
            if ("error" in envelope) throw new Error(envelope.error.message);
            return envelope.value;
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
vi.mock("../frontend/app/gitdiff/git-diff-pane", () => ({
    DiffContentBody: (props: { loading: boolean; content?: { originalContent: string; modifiedContent: string } }) =>
        createElement(
            "output",
            { "aria-label": "Historical turn diff" },
            props.loading
                ? "loading"
                : `${props.content?.originalContent ?? ""}→${props.content?.modifiedContent ?? ""}`
        ),
}));
vi.mock("../frontend/app/agent/assistant-ui/diff-viewer", () => ({
    DiffViewer: (props: { patch: string }) =>
        createElement("pre", { "aria-label": "Rendered review diff" }, props.patch),
}));
vi.mock("./emain-wsh", () => ({ ElectronWshClient: {} }));

import { SqliteSessionRepo } from "@crest/agent/harness/session/sqlite-repo";
import type { AgentHarnessEvent } from "@crest/agent/harness/types";
import { AgentRuntimeRegistry } from "@crest/coding-agent/agent-runtime-registry";
import { buildAgentHarnessHost } from "@crest/coding-agent/harness-factory";
import { SessionMutationBarrier } from "@crest/coding-agent/session-mutation-barrier";
import { _setSessionsRepoForTests, defaultSessionsDir } from "@crest/coding-agent/sessions";
import { registerWorkspaceCheckpointManager } from "@crest/coding-agent/workspace-rewind/checkpoint-manager";
import { RewindConfirmationRegistry } from "@crest/coding-agent/workspace-rewind/confirmation-token";
import {
    applyCapturedPath,
    verifyCapturedPath,
    workspaceFilesystemApplyPlatformSupport,
} from "@crest/coding-agent/workspace-rewind/filesystem-apply";
import { WorkspaceGitRunner } from "@crest/coding-agent/workspace-rewind/git-runner";
import { PendingWorkspaceRestoreStore } from "@crest/coding-agent/workspace-rewind/pending-restore-store";
import { makeProcessOwnerIdentity } from "@crest/coding-agent/workspace-rewind/process-owner";
import { WorkspaceRewindEngine } from "@crest/coding-agent/workspace-rewind/rewind-engine";
import {
    buildAgentRewindSessionStateView,
    decodeWorkspaceCheckpointEntry,
    decodeWorkspaceStateEntry,
} from "@crest/coding-agent/workspace-rewind/session-state";
import { initializeWorkspaceCheckpointSnapshotSource } from "@crest/coding-agent/workspace-rewind/snapshot-source";
import { WorkspaceCheckpointLimits, WorkspaceSnapshotStore } from "@crest/coding-agent/workspace-rewind/snapshot-store";
import { WorkspaceControlCustomTypes, type WorkspaceCheckpointV1 } from "@crest/coding-agent/workspace-rewind/types";
import {
    resolveCanonicalWorkspaceIdentity,
    type CanonicalWorkspaceIdentity,
} from "@crest/coding-agent/workspace-rewind/workspace-identity";
import { WorkspaceFrozenError, WorkspaceRecovery } from "@crest/coding-agent/workspace-rewind/workspace-recovery";
import { AgentRuntimeClient } from "../frontend/app/agent/agent-runtime-client";
import { Thread } from "../frontend/app/agent/assistant-ui";
import { DiffReviewDialog } from "../frontend/app/agent/rewind/diff-review-dialog";
import { RedoDock } from "../frontend/app/agent/rewind/redo-dock";
import { TurnFileChangesCard } from "../frontend/app/agent/rewind/turn-file-changes-card";
import { useAgentRewind } from "../frontend/app/agent/rewind/use-agent-rewind";
import { useAgentTurnChanges } from "../frontend/app/agent/rewind/use-agent-turn-changes";
import type { TopTab } from "../frontend/app/workspace/workspace-content-state";
import { _resetAgentIpcForTests, registerAgentIpcHandlers } from "./agent-ipc";
import { openAgentRewindFeature } from "./agent-rewind-feature";
import { AgentRewindService } from "./agent-rewind-service";

const RequestIdentity = Object.freeze({ workspaceId: "workspace-e2e", generation: 1 });
const TestModelCatalog: ModelCatalog = {
    hydrate: vi.fn(async () => {}),
    getModels: vi.fn(() => []),
    getModel: vi.fn((provider, modelId) => getModel(provider, modelId)),
    getRevision: vi.fn(() => 0),
    activateProvider: vi.fn(),
    refreshProvider: vi.fn(async () => {}),
    refreshActive: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    start: vi.fn(),
    stop: vi.fn(),
};
const cleanupRoots: string[] = [];
const execFileAsync = promisify(execFile);
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
    cleanup();
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
        getTurnChangeSummary: (identity: unknown, input: unknown) =>
            invoke("agent:get-turn-change-summary", identity, input),
        getTurnFileDiff: (identity: unknown, input: unknown) => invoke("agent:get-turn-file-diff", identity, input),
        reviewTurnChanges: (identity: unknown, input: unknown) => invoke("agent:review-turn-changes", identity, input),
        previewTurnUndo: (identity: unknown, input: unknown) => invoke("agent:preview-turn-undo", identity, input),
        applyTurnUndo: (identity: unknown, input: unknown) => invoke("agent:apply-turn-undo", identity, input),
        previewTurnRedo: (identity: unknown, input: unknown) => invoke("agent:preview-turn-redo", identity, input),
        applyTurnRedo: (identity: unknown, input: unknown) => invoke("agent:apply-turn-redo", identity, input),
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

function TurnChangesE2EUi(props: {
    client: AgentRuntimeClient;
    metadata: AgentSessionMeta;
    sessionRevision: number;
    rewindState: AgentRewindSessionStateView;
    turnId: string;
}) {
    const [composer, setComposer] = useState("keep this draft");
    const controller = useAgentTurnChanges({
        client: props.client,
        sessionMetadata: props.metadata,
        sessionRevision: props.sessionRevision,
        rewindState: props.rewindState,
        turns: [{ turnId: props.turnId, responseMessages: [], status: "done" }],
        running: false,
        onError: vi.fn(),
        onMutationComplete: vi.fn(),
    });
    const card = controller.cards.get(props.turnId);
    return createElement(
        "div",
        null,
        createElement("input", {
            "aria-label": "Composer",
            value: composer,
            onChange: (event: { currentTarget: { value: string } }) => setComposer(event.currentTarget.value),
        }),
        card
            ? createElement(TurnFileChangesCard, {
                  summary: card.summary,
                  action: card.action,
                  disabled: card.disabled,
                  onOpenFile: vi.fn(),
                  onReview: () => void controller.openReview(props.turnId),
                  onUndo: () => void controller.openMutation(props.turnId),
                  onRedo: () => void controller.openMutation(props.turnId),
              })
            : null,
        createElement(DiffReviewDialog, {
            open: controller.dialog.open,
            title:
                controller.dialog.kind === "review"
                    ? "Review turn changes"
                    : controller.dialog.kind === "undo"
                      ? "Undo turn changes?"
                      : "Redo turn changes?",
            files: controller.dialog.files,
            selectedPath: controller.dialog.selectedPath,
            loading: controller.dialog.phase === "loading",
            errorMessage: controller.dialog.errorMessage,
            locked: controller.dialog.phase === "applying",
            footer:
                controller.dialog.kind === "review"
                    ? createElement("button", { type: "button", onClick: controller.closeDialog }, "Close review")
                    : createElement(
                          "button",
                          {
                              type: "button",
                              onClick: () => void controller.confirmMutation("normal"),
                              disabled:
                                  controller.dialog.phase !== "ready" ||
                                  controller.dialog.preview?.hardBlocked ||
                                  controller.dialog.preview?.forceRequired,
                          },
                          controller.dialog.kind === "undo" ? "Confirm undo" : "Confirm redo"
                      ),
            onSelectedPathChange: controller.selectDialogPath,
            onOpenChange: (open: boolean) => {
                if (!open) controller.closeDialog();
            },
        })
    );
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
    let settledCount = 0;
    let runToolCallHook:
        | ((event: {
              type: "tool_call";
              toolCallId: string;
              toolName: string;
              input: Record<string, unknown>;
          }) => Promise<unknown>)
        | undefined;
    let terminalFailure: { cause: unknown } | undefined;
    const settledWaiters = new Set<{ count: number; resolve: () => void; reject: (error: unknown) => void }>();
    const completionWaiters = new Set<{ count: number; resolve: () => void }>();
    const waitForSettled = (count: number) => {
        if (terminalFailure) {
            const rejected = Promise.reject(terminalFailure.cause);
            void rejected.catch(() => undefined);
            return rejected;
        }
        if (settledCount >= count) return Promise.resolve();
        const pending = new Promise<void>((resolve, reject) => settledWaiters.add({ count, resolve, reject }));
        void pending.catch(() => undefined);
        return pending;
    };
    const observed = {
        events: [] as string[],
        sessions: [] as Array<{ closed: boolean }>,
        settled: waitForSettled(1),
        waitForSettled,
        waitForCompleted: (count: number) => {
            if (settledCount >= count) return Promise.resolve();
            return new Promise<void>((resolve) => completionWaiters.add({ count, resolve }));
        },
    };
    registerApiProvider({
        api: model.api,
        stream: () => new AssistantMessageEventStream(),
        streamSimple: (activeModel) => {
            const output = new AssistantMessageEventStream();
            void (async () => {
                try {
                    await runToolCallHook?.({
                        type: "tool_call",
                        toolCallId: "rewind-e2e-write",
                        toolName: "future_workspace_writer",
                        input: {},
                    });
                    await mutate();
                    const message = makePromptHarnessMessage(activeModel, "stop");
                    output.push({ type: "start", partial: message });
                    output.push({ type: "done", reason: "stop", message });
                } catch (error) {
                    terminalFailure ??= { cause: error };
                    for (const waiter of settledWaiters) {
                        settledWaiters.delete(waiter);
                        waiter.reject(terminalFailure.cause);
                    }
                    const message = makePromptHarnessMessage(activeModel, "error", terminalFailure.cause);
                    output.push({ type: "error", reason: "error", error: message });
                }
            })();
            return output;
        },
    });
    vi.mocked(getModel).mockReturnValue(model as never);
    vi.mocked(buildAgentHarnessHost).mockImplementation((options) => {
        observed.sessions.push(options.session);
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
                settledCount++;
                for (const waiter of settledWaiters) {
                    if (settledCount < waiter.count) continue;
                    settledWaiters.delete(waiter);
                    waiter.resolve();
                }
                for (const waiter of completionWaiters) {
                    if (settledCount < waiter.count) continue;
                    completionWaiters.delete(waiter);
                    waiter.resolve();
                }
            }
        });
        return {
            harness,
            session: options.session,
            appendCustomEntry: (customType: string, data?: unknown) =>
                options.session.appendCustomEntry(customType, data).then(() => undefined),
            promptWithCustomEntry: vi.fn(),
            setAuthResolver: vi.fn(),
            setToolCallHook: vi.fn((hook) => {
                runToolCallHook = hook;
            }),
            resolveAuth: vi.fn(),
            runToolCallHook: vi.fn(),
            getCwd: () => options.promptInputs.cwd,
            update: vi.fn(),
        } as never;
    });
    return observed;
}

function makePromptHarnessMessage(model: Model<any>, stopReason: "stop" | "error", error?: unknown): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: stopReason === "stop" ? "done" : "" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason,
        ...(error ? { errorMessage: error instanceof Error ? error.message : String(error) } : {}),
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
        createElement(DiffReviewDialog, {
            open: controller.preview.open,
            title: controller.preview.operation === "rewind" ? "Revert changes?" : "Redo changes?",
            files: controller.preview.result?.files ?? [],
            loading: controller.preview.phase === "loading",
            errorMessage: controller.preview.errorMessage,
            locked: controller.busy,
            footer: createElement(
                "button",
                {
                    type: "button",
                    onClick: () => void controller.confirmPreview("normal"),
                    disabled:
                        controller.busy ||
                        controller.preview.phase !== "ready" ||
                        controller.preview.result?.hardBlocked,
                },
                `Revert ${controller.preview.result?.fileCount ?? 0} file`
            ),
            onSelectedPathChange: vi.fn(),
            onOpenChange: (open: boolean) => {
                if (!open) controller.cancelPreview();
            },
        })
    );
}

async function makeFixture(options: { git?: boolean } = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "crest-agent-rewind-e2e-")));
    cleanupRoots.push(root);
    const workspaceRoot = await realpath(await mkdir(join(root, "workspace"), { recursive: true }));
    if (options.git) {
        const bootstrapGit = new WorkspaceGitRunner();
        await bootstrapGit.run(["init"], { cwd: workspaceRoot, timeoutMs: 5_000 });
        await writeFile(join(workspaceRoot, ".gitignore"), "");
        await execFileAsync("git", ["add", ".gitignore"], { cwd: workspaceRoot });
        await execFileAsync(
            "git",
            [
                "-c",
                "user.name=Crest Tests",
                "-c",
                "user.email=crest@example.invalid",
                "commit",
                "-m",
                "baseline",
            ],
            { cwd: workspaceRoot }
        );
    }
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
    const snapshotSource = await initializeWorkspaceCheckpointSnapshotSource({
        store,
        fullReconcile: (options) => store.captureFullReconcile(options),
    });
    const manager = registerWorkspaceCheckpointManager({
        harness: harness as never,
        session,
        sessionId: metadata.id,
        workspaceRoot,
        store,
        snapshotSource,
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
        const recovery = new WorkspaceRecovery({
            workspace: identity,
            store,
            locateSession: async (sessionId, sessionPath) => {
                const owner = await repo.findById(sessionId);
                if (!owner || owner.path !== sessionPath) return undefined;
                return {
                    async getLeafId() {
                        const opened = await repo.open(owner);
                        try {
                            return await opened.getLeafId();
                        } finally {
                            opened.close();
                        }
                    },
                    async getEntry(id) {
                        const opened = await repo.open(owner);
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
            recovery,
            confirmations,
            snapshotSource,
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
            broadcaster: { publishForLease } as never,
        });
        return { service, registry };
    };
    const register = (
        service: AgentRewindService,
        recoveryGate?: NonNullable<Parameters<typeof registerAgentIpcHandlers>[0]["recoveryGate"]>
    ) => {
        const sender = { id: 7, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
        registerAgentIpcHandlers({
            modelCatalog: TestModelCatalog,
            resolveWorkspaceSender: async () => ({
                ...RequestIdentity,
                windowId: "window-e2e",
                workspaceDir: workspaceRoot,
                validatePreferredTerminal: async () => true,
            }),
            loadWorkspace: async () => ({}) as never,
            saveWorkspaceAgentState: async () => ({}) as never,
            rewindService: service,
            ...(recoveryGate ? { recoveryGate } : {}),
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
        await manager.beforeWorkspaceTool("future_workspace_writer");
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
                readBlob: (oid) => store.readBlob(oid),
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
        snapshotSource,
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
    const before = await value.snapshotSource.synchronizeExternal();
    const metadata = await session.getMetadata();
    const turnId = await session.appendMessage({
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: Date.now(),
    } as never);
    await mutate();
    const after = await value.snapshotSource.captureOwnedTurn({
        base: before.ref,
        sessionId: metadata.id,
        turnId,
    });
    const checkpoint: Extract<WorkspaceCheckpointV1, { status: "available" }> = {
        schemaVersion: 1,
        status: "available",
        originSessionId: metadata.id,
        turnId,
        workspaceIdentity: value.store.identity.workspaceIdentity,
        workspaceIncarnation: value.store.identity.workspaceIncarnation,
        before: before.ref,
        after: after.after,
        changes: after.changes,
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

    it("renders tool-independent turn changes, reviews immutable history, and cycles Undo → Redo → Undo without touching conversation or composer", async () => {
        const value = await makeFixture();
        await mkdir(join(value.workspaceRoot, ".git"));
        const path = "direct-shell.txt";
        const file = join(value.workspaceRoot, path);
        await writeFile(file, "before\n");
        const turnId = await value.sendTurn("change without write/edit metadata", async () => {
            await writeFile(file, "after\n");
            await value.session.appendMessage({
                role: "assistant",
                content: [{ type: "text", text: "changed from an arbitrary tool" }],
                timestamp: Date.now(),
            } as never);
        });
        await value.manager.dispose();

        const running = value.makeService();
        const { client } = value.register(running.service);
        const initial = await client.getSessionState(value.metadata);
        const initialRewind = initial.rewindState!;
        const initialMessages = (await value.session.getEntries())
            .filter((entry) => entry.type === "message")
            .map((entry) => structuredClone(entry));
        expect(initialRewind.turnChanges).toEqual([{ turnId, action: "undo" }]);

        const ui = render(
            createElement(TurnChangesE2EUi, {
                client,
                metadata: value.metadata,
                sessionRevision: 1,
                rewindState: initialRewind,
                turnId,
            })
        );
        expect(await screen.findByText("已编辑 1 个文件")).not.toBeNull();
        expect(screen.getAllByText("+1")).toHaveLength(2);
        expect(screen.getAllByText("-1")).toHaveLength(2);
        expect(screen.getByRole("button", { name: /撤销/ })).not.toBeNull();
        expect(screen.queryByRole("button", { name: /重做/ })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "审核" }));
        const reviewDialog = await screen.findByRole("dialog");
        expect(await within(reviewDialog).findByRole("heading", { name: "Review turn changes" })).not.toBeNull();
        expect(await within(reviewDialog).findByTitle(path)).not.toBeNull();
        const renderedReview = await within(reviewDialog).findByLabelText("Rendered review diff");
        expect(renderedReview.textContent).toContain("-before");
        expect(renderedReview.textContent).toContain("+after");
        const review = await client.reviewTurnChanges({
            sessionMetadata: value.metadata,
            expectedSemanticLeafId: initialRewind.semanticLeafId,
            turnId,
        });
        expect(review.files[0]?.diff).toContain("-before");
        expect(review.files[0]?.diff).toContain("+after");
        fireEvent.click(within(reviewDialog).getByRole("button", { name: "Close review" }));

        const historical = await client.getTurnFileDiff({
            sessionMetadata: value.metadata,
            expectedSemanticLeafId: null,
            turnId,
            path,
        });
        expect(historical).toMatchObject({
            originalContent: "before\n",
            modifiedContent: "after\n",
            additions: 1,
            deletions: 1,
        });
        const turnDiffTab: Extract<TopTab, { kind: "agent-turn-diff" }> = {
            id: "e2e-turn-diff",
            kind: "agent-turn-diff",
            sessionId: value.metadata.id,
            sessionCreatedAt: value.metadata.createdAt,
            sessionCwd: value.metadata.cwd,
            sessionPath: value.metadata.path,
            turnId,
            path,
            title: path,
        };
        const { AgentTurnDiffTopTab } = await import("../frontend/app/workspace/agent-turn-diff-top-tab");
        const historyRequest = vi.spyOn(client, "getTurnFileDiff");
        const historyTab = render(createElement(AgentTurnDiffTopTab, { tab: turnDiffTab, client }));
        await waitFor(() => expect(historyRequest).toHaveBeenCalledWith(expect.objectContaining({ turnId, path })));
        await waitFor(() => expect(screen.getByLabelText("Historical turn diff").textContent).toBe("before\n→after\n"));
        historyTab.unmount();

        fireEvent.change(screen.getByRole("textbox", { name: "Composer" }), {
            target: { value: "draft survives turn restore" },
        });
        fireEvent.click(screen.getByRole("button", { name: /撤销/ }));
        const undoDialog = await screen.findByRole("dialog");
        expect(await within(undoDialog).findByText("Undo turn changes?")).not.toBeNull();
        const applyUndo = vi.spyOn(client, "applyTurnUndo");
        const confirmUndo = within(undoDialog).getByRole("button", { name: "Confirm undo" }) as HTMLButtonElement;
        await waitFor(() => expect(confirmUndo.disabled).toBe(false));
        fireEvent.click(confirmUndo);
        await waitFor(() => expect(applyUndo).toHaveBeenCalledOnce());
        await act(async () => await applyUndo.mock.results[0]!.value);
        await waitFor(async () => expect(await readFile(file, "utf8")).toBe("before\n"));

        const undone = (await client.getSessionState(value.metadata)).rewindState!;
        expect(await value.session.getLeafId()).toBe(undone.semanticLeafId);
        const firstUndoEntry = await value.session.getEntry(undone.semanticLeafId!);
        expect(firstUndoEntry).toBeDefined();
        const firstUndoMarker = decodeWorkspaceStateEntry(firstUndoEntry!);
        expect(firstUndoEntry?.parentId).toBe(initialRewind.semanticLeafId);
        expect(firstUndoMarker).toMatchObject({
            kind: "turn-undo",
            sourceTurnId: turnId,
            sessionId: value.metadata.id,
            workspaceIdentity: value.store.identity.workspaceIdentity,
            workspaceIncarnation: value.store.identity.workspaceIncarnation,
        });
        ui.rerender(
            createElement(TurnChangesE2EUi, {
                client,
                metadata: value.metadata,
                sessionRevision: 1,
                rewindState: undone,
                turnId,
            })
        );
        await waitFor(() => expect(screen.getByRole("button", { name: /重做/ })).not.toBeNull());
        expect(screen.queryByRole("button", { name: /撤销/ })).toBeNull();
        expect((screen.getByRole("textbox", { name: "Composer" }) as HTMLInputElement).value).toBe(
            "draft survives turn restore"
        );
        expect(undone.displayLeafId).toBe(initialRewind.displayLeafId);
        expect(
            (await value.session.getEntries())
                .filter((entry) => entry.type === "message")
                .map((entry) => structuredClone(entry))
        ).toEqual(initialMessages);

        fireEvent.click(screen.getByRole("button", { name: /重做/ }));
        const redoDialog = await screen.findByRole("dialog");
        const confirmRedo = within(redoDialog).getByRole("button", { name: "Confirm redo" }) as HTMLButtonElement;
        await waitFor(() => expect(confirmRedo.disabled).toBe(false));
        const applyRedo = vi.spyOn(client, "applyTurnRedo");
        fireEvent.click(confirmRedo);
        await waitFor(() => expect(applyRedo).toHaveBeenCalledOnce());
        await act(async () => await applyRedo.mock.results[0]!.value);
        await waitFor(async () => expect(await readFile(file, "utf8")).toBe("after\n"));
        const redone = (await client.getSessionState(value.metadata)).rewindState!;
        expect(await value.session.getLeafId()).toBe(redone.semanticLeafId);
        const redoEntry = await value.session.getEntry(redone.semanticLeafId!);
        expect(redoEntry).toBeDefined();
        const redoMarker = decodeWorkspaceStateEntry(redoEntry!);
        expect(redoEntry?.parentId).toBe(undone.semanticLeafId);
        expect(redoMarker).toMatchObject({
            kind: "turn-redo",
            sourceTurnId: turnId,
            undoOperationId: firstUndoMarker?.operationId,
            sessionId: value.metadata.id,
        });
        ui.rerender(
            createElement(TurnChangesE2EUi, {
                client,
                metadata: value.metadata,
                sessionRevision: 1,
                rewindState: redone,
                turnId,
            })
        );
        await waitFor(() => expect(screen.getByRole("button", { name: /撤销/ })).not.toBeNull());
        expect(screen.queryByRole("button", { name: /重做/ })).toBeNull();
        expect(redone.displayLeafId).toBe(initialRewind.displayLeafId);

        const secondPreviewUndo = vi.spyOn(client, "previewTurnUndo");
        fireEvent.click(screen.getByRole("button", { name: /撤销/ }));
        const secondUndoDialog = await screen.findByRole("dialog");
        await waitFor(() => expect(secondPreviewUndo).toHaveBeenCalledOnce());
        await act(async () => await secondPreviewUndo.mock.results[0]!.value);
        const confirmSecondUndo = within(secondUndoDialog).getByRole("button", {
            name: "Confirm undo",
        }) as HTMLButtonElement;
        await waitFor(() => expect(confirmSecondUndo.disabled).toBe(false));
        fireEvent.click(confirmSecondUndo);
        await waitFor(() => expect(applyUndo).toHaveBeenCalledTimes(2));
        await act(async () => await applyUndo.mock.results[1]!.value);
        await waitFor(async () => expect(await readFile(file, "utf8")).toBe("before\n"));

        const secondUndone = (await client.getSessionState(value.metadata)).rewindState!;
        ui.rerender(
            createElement(TurnChangesE2EUi, {
                client,
                metadata: value.metadata,
                sessionRevision: 1,
                rewindState: secondUndone,
                turnId,
            })
        );
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await waitFor(() => expect(screen.getByRole("button", { name: /重做/ })).not.toBeNull());
        expect(screen.queryByRole("button", { name: /撤销/ })).toBeNull();
        expect((screen.getByRole("textbox", { name: "Composer" }) as HTMLInputElement).value).toBe(
            "draft survives turn restore"
        );
        expect(secondUndone.displayLeafId).toBe(initialRewind.displayLeafId);
        expect(
            (await value.session.getEntries())
                .filter((entry) => entry.type === "message")
                .map((entry) => structuredClone(entry))
        ).toEqual(initialMessages);
        expect(await value.session.getLeafId()).toBe(secondUndone.semanticLeafId);
        const secondUndoEntry = await value.session.getEntry(secondUndone.semanticLeafId!);
        expect(secondUndoEntry).toBeDefined();
        const secondUndoMarker = decodeWorkspaceStateEntry(secondUndoEntry!);
        expect(secondUndoEntry?.parentId).toBe(redone.semanticLeafId);
        expect(secondUndoMarker).toMatchObject({
            kind: "turn-undo",
            sourceTurnId: turnId,
            sessionId: value.metadata.id,
            workspaceIdentity: value.store.identity.workspaceIdentity,
            workspaceIncarnation: value.store.identity.workspaceIncarnation,
        });
        expect(secondUndoMarker?.operationId).not.toBe(firstUndoMarker?.operationId);
        expect(secondUndoMarker?.operationId).not.toBe(redoMarker?.operationId);
        expect(secondUndoMarker).not.toHaveProperty("undoOperationId");
        value.session.close();
    }, 30_000);

    it("invalidates turn Undo after preview drift and Force restores only the preview red-list", async () => {
        const value = await makeFixture();
        const drifted = join(value.workspaceRoot, "turn-drifted.txt");
        const clean = join(value.workspaceRoot, "turn-clean.txt");
        const outside = join(value.workspaceRoot, "turn-outside.txt");
        await Promise.all([
            writeFile(drifted, "before-drifted"),
            writeFile(clean, "before-clean"),
            writeFile(outside, "before-outside"),
        ]);
        const turnId = await value.sendTurn("turn files", async () => {
            await Promise.all([writeFile(drifted, "agent-drifted"), writeFile(clean, "agent-clean")]);
        });
        await value.manager.dispose();
        const running = value.makeService();
        const { client } = value.register(running.service);
        const state = (await client.getSessionState(value.metadata)).rewindState!;
        const stale = await client.previewTurnUndo({
            sessionMetadata: value.metadata,
            expectedSemanticLeafId: state.semanticLeafId,
            turnId,
        });
        await writeFile(drifted, "writer-after-preview");
        await expect(
            client.applyTurnUndo({
                sessionMetadata: value.metadata,
                expectedSemanticLeafId: state.semanticLeafId,
                turnId,
                mode: "normal",
                confirmationToken: stale.confirmationToken!,
            })
        ).rejects.toThrow(/confirmation|changed|plan/i);
        expect(await readFile(drifted, "utf8")).toBe("writer-after-preview");
        expect(await readFile(clean, "utf8")).toBe("agent-clean");

        const force = await client.previewTurnUndo({
            sessionMetadata: value.metadata,
            expectedSemanticLeafId: state.semanticLeafId,
            turnId,
        });
        expect(force.files.filter((file) => file.conflict !== "none").map((file) => file.path)).toEqual([
            "turn-drifted.txt",
        ]);
        expect(force).toMatchObject({ forceRequired: true, hardBlocked: false });
        await writeFile(outside, "outside-after-preview");
        await client.applyTurnUndo({
            sessionMetadata: value.metadata,
            expectedSemanticLeafId: state.semanticLeafId,
            turnId,
            mode: "force-drift",
            confirmationToken: force.confirmationToken!,
        });
        expect(await readFile(drifted, "utf8")).toBe("before-drifted");
        expect(await readFile(clean, "utf8")).toBe("before-clean");
        expect(await readFile(outside, "utf8")).toBe("outside-after-preview");
        value.session.close();
    }, 30_000);

    it("does not expose a turn card for a historical session without a checkpoint", async () => {
        const value = await makeFixture();
        const turnId = await value.session.appendMessage({
            role: "user",
            content: [{ type: "text", text: "legacy turn" }],
            timestamp: Date.now(),
        } as never);
        await value.session.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "legacy answer" }],
            timestamp: Date.now(),
        } as never);
        await value.manager.dispose();
        const running = value.makeService();
        const { client } = value.register(running.service);
        const summaryRead = vi.spyOn(client, "getTurnChangeSummary");
        const state = (await client.getSessionState(value.metadata)).rewindState!;
        render(
            createElement(TurnChangesE2EUi, {
                client,
                metadata: value.metadata,
                sessionRevision: 1,
                rewindState: state,
                turnId,
            })
        );

        await act(async () => {
            await Promise.resolve();
        });
        expect(state.turnChanges).toEqual([]);
        expect(screen.queryByLabelText("Turn file changes")).toBeNull();
        expect(summaryRead).not.toHaveBeenCalled();
        value.session.close();
    }, 30_000);

    it("rejects every prompt waiter with the provider mutation failure", async () => {
        const value = await makeFixture();
        await value.manager.dispose();
        const failure = new Error("provider mutation failed");
        const promptHarness = installPromptHarness(async () => {
            throw failure;
        });
        const running = value.makeService();
        const disposeAll = vi.spyOn(running.registry, "disposeAll");
        const secondWaiter = promptHarness.waitForSettled(2);

        try {
            const { client } = value.register(running.service);
            await client.send({
                sessionMetadata: value.metadata,
                context: {
                    workspaceId: RequestIdentity.workspaceId,
                    workspaceDir: value.workspaceRoot,
                    sessionPath: value.metadata.path,
                    environment: {},
                },
                text: "fail provider mutation",
                provider: "p",
                model: "m",
            });
            await expect(promptHarness.settled).rejects.toBe(failure);
            await expect(secondWaiter).rejects.toBe(failure);
            await promptHarness.waitForCompleted(1);
        } finally {
            await running.registry.disposeAll();
            value.session.close();
        }

        expect(disposeAll).toHaveBeenCalledOnce();
        expect(running.registry.entries.size).toBe(0);
    }, 10_000);

    describe.sequential("live incremental 3-turn restore workflow", () => {
        type Fixture = Awaited<ReturnType<typeof makeFixture>>;
        type RunningService = ReturnType<Fixture["makeService"]>;

        let originalConfigHome: string | undefined;
        let originalDataHome: string | undefined;
        let sharedConfigHome: string;
        let value: Fixture | undefined;
        let file: string;
        let promptHarness: ReturnType<typeof installPromptHarness> | undefined;
        let fullReconcile: ReturnType<typeof vi.spyOn> | undefined;
        let repoOpen: ReturnType<typeof vi.spyOn> | undefined;
        let running: RunningService | undefined;
        let disposeAll: ReturnType<typeof vi.spyOn> | undefined;
        let client: AgentRuntimeClient | undefined;
        let mutateNextPrompt = false;
        let firstTurnId: string | undefined;
        let secondTurnId: string | undefined;
        let thirdTurnId: string | undefined;
        let workflowFailure: unknown;
        let cleaned = false;
        const openedSessions: Array<{ closed: boolean }> = [];
        const originalFullReconcile = WorkspaceSnapshotStore.prototype.captureFullReconcile;
        let originalRepoOpen: Fixture["repo"]["open"] | undefined;
        let originalRegistryDisposeAll: RunningService["registry"]["disposeAll"] | undefined;

        const cleanupWorkflow = async () => {
            if (cleaned) return;
            cleaned = true;
            try {
                if (running) {
                    await running.registry.disposeAll();
                    expect(disposeAll).toHaveBeenCalledOnce();
                    expect(running.registry.entries.size).toBe(0);
                }
                await _resetAgentIpcForTests();
                if (openedSessions.length > 0) {
                    expect(openedSessions.every((session) => session.closed)).toBe(true);
                }
                if (promptHarness?.sessions.length) {
                    expect(promptHarness.sessions.every((session) => session.closed)).toBe(true);
                }
            } finally {
                fullReconcile?.mockRestore();
                repoOpen?.mockRestore();
                disposeAll?.mockRestore();
                expect(WorkspaceSnapshotStore.prototype.captureFullReconcile).toBe(originalFullReconcile);
                if (value) {
                    expect(value.repo.open).toBe(originalRepoOpen);
                    expect(running?.registry.disposeAll).toBe(originalRegistryDisposeAll);
                    await value.manager.dispose();
                    value.session.close();
                    expect(value.session.closed).toBe(true);
                    await rm(value.root, { recursive: true, force: true });
                }
                if (sharedConfigHome) await rm(sharedConfigHome, { recursive: true, force: true });
            }
        };

        const setupWorkflow = async () => {
            originalConfigHome = process.env.WAVETERM_CONFIG_HOME;
            originalDataHome = process.env.WAVETERM_DATA_HOME;
            sharedConfigHome = await realpath(await mkdtemp(join(tmpdir(), "crest-agent-rewind-e2e-shared-")));
            process.env.WAVETERM_CONFIG_HOME = sharedConfigHome;
            try {
                value = await makeFixture({ git: true });
                const cleanupIndex = cleanupRoots.lastIndexOf(value.root);
                if (cleanupIndex >= 0) cleanupRoots.splice(cleanupIndex, 1);
                file = join(value.workspaceRoot, "incremental-boundary.txt");
                await writeFile(file, "before\n");
                await value.manager.dispose();
                promptHarness = installPromptHarness(async () => {
                    if (!mutateNextPrompt) return;
                    mutateNextPrompt = false;
                    await writeFile(file, "after\n");
                });
                originalRepoOpen = value.repo.open;
                const openSession = originalRepoOpen.bind(value.repo);
                repoOpen = vi.spyOn(value.repo, "open").mockImplementation(async (metadata) => {
                    const session = await openSession(metadata);
                    openedSessions.push(session);
                    return session;
                });
                fullReconcile = vi.spyOn(WorkspaceSnapshotStore.prototype, "captureFullReconcile");
                running = value.makeService(applyCapturedPath, async () => {
                    await value!.rewindState();
                });
                originalRegistryDisposeAll = running.registry.disposeAll;
                disposeAll = vi.spyOn(running.registry, "disposeAll");
                client = value.register(running.service).client;
            } catch (error) {
                workflowFailure = error;
                await cleanupWorkflow();
                throw error;
            }
        };

        beforeEach(() => {
            if (!value) return;
            process.env.WAVETERM_CONFIG_HOME = sharedConfigHome;
            process.env.WAVETERM_DATA_HOME = join(value.root, "data");
            _setSessionsRepoForTests(value.repo);
        });

        afterAll(async () => {
            try {
                await cleanupWorkflow();
            } finally {
                if (originalConfigHome == null) delete process.env.WAVETERM_CONFIG_HOME;
                else process.env.WAVETERM_CONFIG_HOME = originalConfigHome;
                if (originalDataHome == null) delete process.env.WAVETERM_DATA_HOME;
                else process.env.WAVETERM_DATA_HOME = originalDataHome;
            }
        });

        it("phase 1 captures two no-change turns and one direct disk write", async () => {
            let complete = false;
            try {
                await setupWorkflow();
                if (!value || !client || !promptHarness || !fullReconcile) {
                    throw new Error("incremental workflow setup is unavailable", { cause: workflowFailure });
                }
                const send = async (text: string, settledCount: number) => {
                    const result = await client!.send({
                        sessionMetadata: value!.metadata,
                        context: {
                            workspaceId: RequestIdentity.workspaceId,
                            workspaceDir: value!.workspaceRoot,
                            sessionPath: value!.metadata.path,
                            environment: {},
                        },
                        text,
                        provider: "p",
                        model: "m",
                    });
                    await promptHarness!.waitForSettled(settledCount);
                    return result.turnId;
                };

                firstTurnId = await send("cold boundary", 1);
                secondTurnId = await send("no workspace changes", 2);
                mutateNextPrompt = true;
                thirdTurnId = await send("shell changes a file", 3);
                expect(await readFile(file, "utf8")).toBe("after\n");
                const checkpoints = (await value.session.getEntries())
                    .map(decodeWorkspaceCheckpointEntry)
                    .filter(
                        (checkpoint): checkpoint is Extract<WorkspaceCheckpointV1, { status: "available" }> =>
                            checkpoint?.status === "available"
                    );
                const first = checkpoints.find((checkpoint) => checkpoint.turnId === firstTurnId)!;
                const second = checkpoints.find((checkpoint) => checkpoint.turnId === secondTurnId)!;
                const third = checkpoints.find((checkpoint) => checkpoint.turnId === thirdTurnId)!;

                expect(fullReconcile).not.toHaveBeenCalled();
                expect(first.before).toEqual(first.after);
                expect(second).toMatchObject({ before: first.after, after: first.after, changes: [] });
                expect(third.before).toEqual(first.after);
                expect(third.after).not.toEqual(third.before);
                expect(third.changes).toEqual([expect.objectContaining({ path: "incremental-boundary.txt" })]);
                expect(
                    JSON.parse((await value.store.readBlob(third.after.scopeManifest)).toString("utf8"))
                ).toMatchObject({
                    schemaversion: 3,
                });
                complete = true;
            } catch (error) {
                workflowFailure = error;
                throw error;
            } finally {
                if (!complete) await cleanupWorkflow();
            }
        }, 30_000);

        it("phase 2 continues the persisted marker through Revert → Redo → turn Undo", async () => {
            try {
                if (workflowFailure || !value || !client || !thirdTurnId) {
                    throw new Error("incremental workflow phase 1 is unavailable", { cause: workflowFailure });
                }
                expect(promptHarness?.sessions.length).toBeGreaterThan(0);
                expect(promptHarness?.sessions.every((session) => session.closed)).toBe(true);
                const state = (await client.getSessionState(value.metadata)).rewindState!;
                const rewindPreview = await client.previewRewind({
                    sessionMetadata: value.metadata,
                    expectedSemanticLeafId: state.semanticLeafId,
                    target: { kind: "rewind", targetTurnId: thirdTurnId },
                });
                expect(rewindPreview).toMatchObject({
                    fileCount: 1,
                    hardBlocked: false,
                    forceRequired: false,
                    files: [expect.objectContaining({ path: "incremental-boundary.txt" })],
                });
                const revertedResult = await client.rewindTree({
                    sessionMetadata: value.metadata,
                    expectedSemanticLeafId: state.semanticLeafId,
                    targetTurnId: thirdTurnId,
                    mode: "normal",
                    confirmationToken: rewindPreview.confirmationToken!,
                });
                expect(await readFile(file, "utf8")).toBe("before\n");

                const reverted = (await client.getSessionState(value.metadata)).rewindState!;
                expect(reverted).toMatchObject({
                    semanticLeafId: revertedResult.semanticLeafId,
                    redo: { fileCount: 1 },
                });
                const redoPreview = await client.previewRewind({
                    sessionMetadata: value.metadata,
                    expectedSemanticLeafId: reverted.semanticLeafId,
                    target: { kind: "redo" },
                });
                expect(redoPreview).toMatchObject({
                    fileCount: 1,
                    hardBlocked: false,
                    forceRequired: false,
                    files: [expect.objectContaining({ path: "incremental-boundary.txt" })],
                });
                const redoneResult = await client.redoRewind({
                    sessionMetadata: value.metadata,
                    expectedSemanticLeafId: reverted.semanticLeafId,
                    confirmationToken: redoPreview.confirmationToken!,
                });
                expect(await readFile(file, "utf8")).toBe("after\n");

                const redone = (await client.getSessionState(value.metadata)).rewindState!;
                expect(redone.semanticLeafId).toBe(redoneResult.semanticLeafId);
                const undoPreview = await client.previewTurnUndo({
                    sessionMetadata: value.metadata,
                    expectedSemanticLeafId: redone.semanticLeafId,
                    turnId: thirdTurnId,
                });
                expect(undoPreview.files).toEqual(rewindPreview.files);
                const undoneResult = await client.applyTurnUndo({
                    sessionMetadata: value.metadata,
                    expectedSemanticLeafId: redone.semanticLeafId,
                    turnId: thirdTurnId,
                    mode: "normal",
                    confirmationToken: undoPreview.confirmationToken!,
                });
                expect(undoneResult.semanticLeafId).not.toBe(redone.semanticLeafId);
                expect(await readFile(file, "utf8")).toBe("before\n");
            } finally {
                await cleanupWorkflow();
            }
        }, 30_000);
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
        expect(
            (await value.session.getEntries()).map((entry) => [
                entry.type,
                entry.type === "custom" ? entry.customType : undefined,
            ])
        ).toContainEqual(["custom", WorkspaceControlCustomTypes.checkpoint]);
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
        expect(await within(previewDialog).findByRole("heading", { name: "Revert changes?" })).not.toBeNull();
        expect(within(previewDialog).queryByText("Original user prompt")).toBeNull();
        expect(await readFile(file, "utf8")).toBe("after");
        fireEvent.click(await within(previewDialog).findByRole("button", { name: "Revert 1 file" }));
        await waitFor(() => expect(applyFromUi).toHaveBeenCalledOnce());
        await act(async () => await applyFromUi.mock.results[0]!.value);
        expect(applyFromUi).toHaveBeenCalledWith(expect.objectContaining({ mode: "normal", targetTurnId: turnId }));
        await waitFor(async () => expect(await readFile(file, "utf8")).toBe("before"));
        await waitFor(() => expect(editorText).toHaveBeenCalledWith("Original user prompt"));
        expect(errors).not.toHaveBeenCalled();
        expect(authoritativePublish).toHaveBeenCalled();

        state = await value.rewindState();
        await waitFor(() => expect(state.redo?.messages).toEqual(["Original user prompt"]));
        rewindUi.unmount();

        // A reload drops every in-memory confirmation and reconstructs the
        // service/client from the persisted SQLite branch and Git store.
        vi.mocked(electron.ipcMain.handle).mockClear();
        const reloaded = value.makeService();
        const { client: reloadedClient } = value.register(reloaded.service);
        const persisted = await value.rewindState();
        expect(persisted.redo).toMatchObject({
            messages: ["Original user prompt"],
            messageCount: 1,
            fileCount: 1,
            files: [expect.objectContaining({ path: "changed.txt", additions: 1, deletions: 1 })],
        });
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

    it("surfaces V2 unknown facts and keeps retry frozen through IPC", async () => {
        const value = await makeFixture();
        const file = join(value.workspaceRoot, "recovery.txt");
        await writeFile(file, "before");
        const turnId = await value.sendTurn("interrupted restore", async () => {
            await writeFile(file, "after");
        });
        await value.manager.dispose();
        const checkpointEntry = (await value.session.getEntries()).find(
            (entry) => decodeWorkspaceCheckpointEntry(entry)?.turnId === turnId
        );
        if (!checkpointEntry) throw new Error("missing interrupted restore checkpoint");

        const snapshotSource = await initializeWorkspaceCheckpointSnapshotSource({
            store: value.store,
            fullReconcile: (options) => value.store.captureFullReconcile(options),
        });
        const pending = new PendingWorkspaceRestoreStore(value.store);
        const recovery = new WorkspaceRecovery({
            workspace: value.store.identity,
            store: value.store,
            pending,
            locateSession: async () => undefined,
            withSessionMutation: async (_sessionPath, operation) => await operation(),
        });
        const confirmations = new RewindConfirmationRegistry();
        const engine = new WorkspaceRewindEngine({
            store: value.store,
            pending,
            recovery,
            confirmations,
            snapshotSource,
            createOperationId: () => "operation-e2e-crash",
            verifyPath: async (input) => {
                await verifyCapturedPath(input);
                await writeFile(file, "external-during-final-verification");
            },
        });
        const preview = await engine.previewRewind({
            session: value.session,
            sessionId: value.metadata.id,
            workspace: value.store.identity,
            semanticLeafId: checkpointEntry.id,
            targetTurnId: turnId,
        });
        await expect(
            engine.applyRewind({
                session: value.session,
                sessionId: value.metadata.id,
                workspace: value.store.identity,
                semanticLeafId: checkpointEntry.id,
                targetTurnId: turnId,
                mode: "normal",
                confirmation: confirmations.take(preview.confirmationToken!),
            })
        ).rejects.toBeInstanceOf(WorkspaceFrozenError);

        await writeFile(file, "external-after-crash");
        const recoveryGate: NonNullable<Parameters<typeof registerAgentIpcHandlers>[0]["recoveryGate"]> = {
            scanBeforeIpcRegistration: async () => {},
            assertWorkspaceWritable: async () => recovery.assertWorkspaceWritable(),
            getRecovery: async () => {
                const decision = await recovery.inspectPending();
                return decision.state === "needs-user" ? decision.view : undefined;
            },
            resolveRecovery: async (_workspace, operationId, action, assertCurrent) => {
                if (action !== "retry") throw new Error(`unexpected recovery action ${action}`);
                await assertCurrent();
                await recovery.resolvePending(operationId);
            },
        };
        const running = value.makeService();
        const { client } = value.register(running.service, recoveryGate);

        const frozen = await client.getWorkspaceRecovery({ sessionMetadata: value.metadata });
        expect(frozen).toMatchObject({
            operationId: "operation-e2e-crash",
            corrupt: false,
            paths: [{ path: "recovery.txt", classification: "unknown" }],
            allowedActions: ["retry"],
        });
        expect(frozen).not.toHaveProperty("phase");
        expect(JSON.stringify(frozen)).not.toMatch(/force/i);
        await client.resolveWorkspaceRecovery({
            sessionMetadata: value.metadata,
            operationId: frozen!.operationId,
            action: "retry",
        });
        await expect(client.getWorkspaceRecovery({ sessionMetadata: value.metadata })).resolves.toMatchObject({
            operationId: frozen!.operationId,
            allowedActions: ["retry"],
        });
        await expect(pending.readLocked()).resolves.toMatchObject({
            kind: "valid",
            record: { schemaVersion: 2, operationId: frozen!.operationId },
        });
        expect(await readFile(file, "utf8")).toBe("external-after-crash");
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
                softQuotaBytes: WorkspaceCheckpointLimits.softQuotaBytes,
            });
            expect(quotaBefore.referencedBytes).toBeGreaterThan(0);
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
