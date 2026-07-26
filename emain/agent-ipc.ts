// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// agent-ipc.ts — Electron main IPC surface for the integrated agent
// runtime. Holds the process-level AgentRuntimeRegistry, registers ipcMain
// handlers, and fans each runtime's event stream out to per-sender
// subscribers via a single "agent:event"
// channel. The owner — not this layer — holds the authoritative
// conversation state and decides send routing; this layer is the thin
// IPC ↔ owner adapter. See emain/agent/agent-session-runtime.ts.
//
// See docs/agent-runtime-architecture.md §2 for the topology and
// §6 for the per-session lifecycle this layer implements.
//
// IPC contract (mirrored in preload.ts + ElectronApi.agent typings):
//
//   handle "agent:create-session"      (cwd) → AgentSessionMeta
//   handle "agent:list-sessions-for-cwd" (cwd) → AgentSessionMeta[]
//   handle "agent:send"                (opts) → { sessionMetadata }
//     - opts.sessionMetadata? null → main mints a fresh session
//     - prompt() runs in background; events stream via "agent:event"
//     - returns the resolved sessionMetadata (renderer writes it to
//       block.meta after first send)
//   on     "agent:abort"               (sessionPath)
//   on     "agent:subscribe"           (sessionPath)
//     - subscriber tracked per-sender; renderer must call unsubscribe
//       on cleanup, but sender 'destroyed' also releases automatically
//   on     "agent:unsubscribe"         (sessionPath)
//   handle "agent:list-commands"       () → AgentCommandInfo[]
//   handle "agent:list-tree"           (metadata) → { entries, leafId }
//   handle "agent:list-fork-points"    (metadata) → AgentForkPointView[]
//   handle "agent:navigate-tree"       ({ metadata, targetId }) → { metadata, editorText? }
//   handle "agent:fork-session"        ({ metadata, cwd, entryId }) → { metadata, selectedText? }
//   handle "agent:clone-session"       ({ metadata, cwd }) → { metadata?, message? }
//
// Event stream payload (sent on "agent:event"):
//   { sessionPath: string, event: AgentHarnessEvent }
//
// Single channel + payload-identified subscriptions matches the
// "dir-changed" pattern in emain-ipc.ts (security: renderer-supplied
// strings never end up in channel names).

import * as electron from "electron";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { makeAgentEventPayload, makeAgentSubscriptionKey } from "./agent/agent-event-routing";
import type { SystemPromptInputs } from "./agent/build-system-prompt";
import { extractChangeOperationsFromMessages, generateChangeOutline } from "./agent/change-review/change-outline";
import { getBuiltInAgentCommands } from "./agent/commands/registry";
import { commandNoop, commandSuccess } from "./agent/commands/session-command-results";
import {
    buildAgentForkPointViews,
    buildAgentTreeEntryViews,
    filterTreeForDisplay,
    previewSessionEntry,
} from "./agent/commands/session-views";
import type {
    AgentBackendCommandName,
    AgentCommandExecutionResult,
    AgentCommandInfo,
    AgentFlagInfo,
    AgentForkPointView,
    AgentRunCommandInput,
    AgentShortcutInfo,
    AgentTreeEntryView,
} from "./agent/commands/types";
import { buildAgentHarnessHost } from "./agent/harness-factory";
import { InMemorySessionRepo } from "./agent/harness/session/memory-repo";
import type { JsonlSessionMetadata, SessionDetailInfo } from "./agent/harness/types";
import {
    buildPersistedTurnsFromSessionEntries,
    AgentSessionRuntime,
    type AgentExecutionConfig,
    type AgentTurn,
    type AgentSessionRuntimeStatus,
    type ExtensionReloadState,
    type ExtensionUiSnapshot,
} from "./agent/agent-session-runtime";
import { AgentRuntimeRegistry } from "./agent/agent-runtime-registry";
import { buildPermissionsHook, isBenchMode } from "./agent/permissions";
import { loadProjectContextFiles } from "./agent/resource-loader";
import {
    createPaneSession,
    defaultSessionsDir,
    forkPaneSession,
    importPaneSessionFromJsonl,
    listAllSessionDetails,
    listSessionDetailsForCwd,
    listSessionsForCwd,
    openPaneSession,
    openPaneSessionByPath,
} from "./agent/sessions";
import {
    createCommandContext,
    createExtensionContext,
    createExtensionUiBridge,
    getExtensionGraphForRuntime,
    loadAgentExtensions,
    renderExtensionSessionEntries,
    reloadExtensionsForRuntime,
} from "./agent/extensions";
import type { WidgetEvent } from "./agent/extensions";
import {
    createExtensionLifecycleHost,
    unregisterExtensionLifecycleHost,
    type ExtensionLifecycleHost,
} from "./agent/extensions/lifecycle";
import { loadAgentPromptTemplates } from "./agent/prompt-loader";
import { loadAgentSkills } from "./agent/skills-loader";
import { getDefaultTools } from "./agent/tools";
import { createSpawnCliAgentTool } from "./agent/tools/spawn-cli-agent";
import type { AgentMessage, ThinkingLevel } from "./agent/types";
import type {
    RenderedExtensionEntryNode,
    WidgetEventDispatchResult,
} from "./agent/extensions/pi-gui/crest/widget-tree";
import type { Api, Message, Model } from "./ai";
import { getModel } from "./ai";
import { getSecret } from "./aiconfig/secrets";

const AgentRuntimeIdleTtlMs = 5 * 60 * 1000;
const AgentRuntimeSweepIntervalMs = 60 * 1000;
const runtimeRegistry = new AgentRuntimeRegistry<AgentSessionRuntime>({
    idleTtlMs: AgentRuntimeIdleTtlMs,
});
let runtimeSweepTimer: NodeJS.Timeout | undefined;
const sessionOperations = new Map<string, Promise<void>>();
const extensionCwdOperations = new Map<string, Promise<void>>();
let extensionGlobalOperation: Promise<void> = Promise.resolve();
const pendingReloadStates = new Map<string, ExtensionReloadState>();

type SubKey = string;
type SubscriptionTarget = { sender: electron.WebContents; canonicalPath: string; rendererPath: string };
interface AgentSubscriptionRecord {
    unsubscribe: () => void;
    sessionPath: string;
    target: SubscriptionTarget;
}

const subscriptions = new Map<SubKey, AgentSubscriptionRecord>();
const subscriptionGenerations = new Map<SubKey, number>();
const subscriptionsBySender = new Map<number, Set<SubKey>>();
const pendingSubscriptions = new Map<SubKey, SubscriptionTarget>();

interface SendOptions {
    /** Existing session, if any. null on first send → main mints a fresh one. */
    sessionMetadata?: JsonlSessionMetadata | null;
    /** Parent terminal block ID for workspace-scoped tools and command context. */
    blockId: string;
    /** Workspace's current cwd. Drives system prompt + tool execution dir. */
    cwd: string;
    /** Prompt text. */
    text: string;
    /** Resolved provider id (e.g. "openrouter"). */
    provider: string;
    /** Resolved model id (e.g. "anthropic/claude-opus-4-7"). */
    model: string;
    /** Reasoning level, when the model supports it. */
    reasoning?: ThinkingLevel;
    /**
     * Credential reference resolved by the renderer's ai-resolver.
     * Exactly one is typically set: a literal `token` (testing / unauthed
     * local endpoints) or a `tokenSecretName` to look up in the
     * safeStorage secret store. Main resolves these into the actual API
     * key passed to pi-ai — the renderer never sees the plaintext key.
     */
    token?: string;
    tokenSecretName?: string;
    /** Optional workspace context. */
    gitBranch?: string;
    recentCmds?: string[];
    connection?: string;
    /**
     * Per-session tool allowlist. Optional in v1 — when omitted, permissions
     * default to allowAll:true (no approval UI exists yet; the agent
     * stays functional). Bench mode (CREST_AGENT_BENCH=1) also forces
     * allowAll regardless of this value. See emain/agent/permissions.ts.
     */
    allowedTools?: string[];
}

interface AgentNavigateTreeInput {
    sessionMetadata: JsonlSessionMetadata;
    targetId: string;
}

interface AgentForkSessionInput {
    sessionMetadata: JsonlSessionMetadata;
    cwd: string;
    entryId: string;
}

interface AgentCloneSessionInput {
    sessionMetadata: JsonlSessionMetadata;
    cwd: string;
}

interface AgentTreeResult {
    entries: AgentTreeEntryView[];
    leafId: string | null;
}

interface AgentNavigateTreeResult {
    sessionMetadata: JsonlSessionMetadata;
    editorText?: string;
}

interface AgentForkSessionResult {
    sessionMetadata: JsonlSessionMetadata;
    selectedText?: string;
}

interface AgentCloneSessionResult {
    sessionMetadata?: JsonlSessionMetadata;
    message?: string;
}

interface JsonlSessionHeader {
    type: "session";
    version: 3;
    id: string;
    timestamp: string;
    cwd: string;
    parentSession?: string;
}

const RunnableAgentCommands = new Set<AgentBackendCommandName>([
    "new",
    "resume",
    "compact",
    "session",
    "copy",
    "export",
    "import",
    "reload",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`agent IPC: ${fieldName} must be a non-empty string`);
    }
    return value;
}

function getPathCommandArgument(argsText: string): string | undefined {
    const argsString = argsText.trimStart();
    if (!argsString) return undefined;
    const firstChar = argsString[0];
    if (firstChar === '"' || firstChar === "'") {
        const closingQuoteIndex = argsString.indexOf(firstChar, 1);
        if (closingQuoteIndex < 0) return undefined;
        return argsString.slice(1, closingQuoteIndex);
    }
    const firstWhitespaceIndex = argsString.search(/\s/);
    if (firstWhitespaceIndex < 0) return argsString;
    return argsString.slice(0, firstWhitespaceIndex);
}

function resolvePathForCwd(inputPath: string, cwd: string): string {
    return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}

function getAssistantText(message: AgentMessage): string | undefined {
    if ((message as { role?: string }).role !== "assistant") return undefined;
    const content = (message as { content?: Array<{ type: string; text?: string }> }).content;
    if (!Array.isArray(content)) return undefined;
    const text = content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("")
        .trim();
    return text || undefined;
}

function isToolResultModelMessage(message: AgentMessage): message is Message {
    return (message as { role?: string }).role === "toolResult";
}

function assertInsideSessionsDir(sessionPath: string, sessionsRoot: string, fieldName: string): void {
    const relative = path.relative(sessionsRoot, sessionPath);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`agent IPC: ${fieldName} is outside sessions directory`);
    }
}

async function validateSessionPath(value: unknown, fieldName = "sessionPath"): Promise<string> {
    const inputPath = requireNonEmptyString(value, fieldName);
    const [sessionPath, sessionsRoot] = await Promise.all([fs.realpath(inputPath), fs.realpath(defaultSessionsDir())]);
    assertInsideSessionsDir(sessionPath, sessionsRoot, fieldName);
    return sessionPath;
}

function validateSessionMetadataShape(value: unknown): JsonlSessionMetadata {
    if (!isRecord(value)) {
        throw new Error("agent IPC: sessionMetadata must be an object");
    }
    return {
        id: typeof value.id === "string" ? value.id : "",
        createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
        path: requireNonEmptyString(value.path, "sessionMetadata.path"),
        cwd: requireNonEmptyString(value.cwd, "sessionMetadata.cwd"),
        parentSessionPath: typeof value.parentSessionPath === "string" ? value.parentSessionPath : undefined,
    };
}

function validateRunCommandInput(value: unknown): AgentRunCommandInput {
    if (!isRecord(value)) throw new Error("agent IPC: runCommand input must be an object");
    const cwd = requireNonEmptyString(value.cwd, "cwd");
    const command = requireNonEmptyString(value.command, "command") as AgentBackendCommandName;
    if (!RunnableAgentCommands.has(command)) {
        throw new Error(`agent IPC: unsupported command /${command}`);
    }
    return {
        cwd,
        command,
        argsText: typeof value.argsText === "string" ? value.argsText : "",
        sessionMetadata:
            value.sessionMetadata == null ? undefined : validateSessionMetadataShape(value.sessionMetadata),
    };
}

async function openValidatedSessionMetadata(value: unknown): Promise<{
    metadata: JsonlSessionMetadata;
    session: Awaited<ReturnType<typeof openPaneSessionByPath>>;
    requestedPath: string;
}> {
    const input = validateSessionMetadataShape(value);
    const sessionPath = await validateSessionPath(input.path, "sessionMetadata.path");
    const session = await openPaneSessionByPath(sessionPath);
    const metadata = await session.getMetadata();
    return { metadata, session, requestedPath: input.path };
}

async function requireSessionEntry(
    session: Awaited<ReturnType<typeof openPaneSessionByPath>>,
    entryId: string,
    fieldName: string
) {
    const entry = await session.getEntry(entryId);
    if (!entry) {
        throw new Error(`agent IPC: ${fieldName} does not belong to the session`);
    }
    return entry;
}

async function validateTreeInput(value: unknown): Promise<{
    metadata: JsonlSessionMetadata;
    session: Awaited<ReturnType<typeof openPaneSessionByPath>>;
    requestedPath: string;
}> {
    return openValidatedSessionMetadata(value);
}

async function validateNavigateInput(value: unknown): Promise<{
    metadata: JsonlSessionMetadata;
    session: Awaited<ReturnType<typeof openPaneSessionByPath>>;
    targetId: string;
    requestedPath: string;
}> {
    if (!isRecord(value)) throw new Error("agent IPC: navigateTree input must be an object");
    const { metadata, session, requestedPath } = await openValidatedSessionMetadata(value.sessionMetadata);
    const targetId = requireNonEmptyString(value.targetId, "targetId");
    await requireSessionEntry(session, targetId, "targetId");
    return { metadata, session, targetId, requestedPath };
}

async function validateForkInput(value: unknown): Promise<{
    metadata: JsonlSessionMetadata;
    session: Awaited<ReturnType<typeof openPaneSessionByPath>>;
    cwd: string;
    entryId: string;
}> {
    if (!isRecord(value)) throw new Error("agent IPC: forkSession input must be an object");
    const { metadata, session } = await openValidatedSessionMetadata(value.sessionMetadata);
    const cwd = requireNonEmptyString(value.cwd, "cwd");
    const entryId = requireNonEmptyString(value.entryId, "entryId");
    await requireSessionEntry(session, entryId, "entryId");
    return { metadata, session, cwd, entryId };
}

async function validateCloneInput(value: unknown): Promise<{
    metadata: JsonlSessionMetadata;
    session: Awaited<ReturnType<typeof openPaneSessionByPath>>;
    cwd: string;
}> {
    if (!isRecord(value)) throw new Error("agent IPC: cloneSession input must be an object");
    const { metadata, session } = await openValidatedSessionMetadata(value.sessionMetadata);
    const cwd = requireNonEmptyString(value.cwd, "cwd");
    return { metadata, session, cwd };
}

function resolveModelOrThrow(provider: string, modelId: string): Model<Api> {
    // pi's getModel is typed with literal generics; our renderer-supplied
    // strings can't satisfy them. Cast — runtime accepts any registered id.
    const model = (getModel as unknown as (p: string, m: string) => Model<Api> | undefined)(provider, modelId);
    if (!model) {
        throw new Error(`agent: unknown provider/model "${provider}/${modelId}"`);
    }
    return model;
}

function buildPromptInputs(opts: SendOptions): SystemPromptInputs {
    return {
        cwd: opts.cwd,
        gitBranch: opts.gitBranch,
        connection: opts.connection,
        recentCmds: opts.recentCmds,
    };
}

async function serializeSessionOperation<T>(sessionPath: string, operation: () => Promise<T>): Promise<T> {
    const previous = sessionOperations.get(sessionPath) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const completion = result.then(
        () => undefined,
        () => undefined
    );
    sessionOperations.set(sessionPath, completion);
    try {
        return await result;
    } finally {
        if (sessionOperations.get(sessionPath) === completion) {
            sessionOperations.delete(sessionPath);
        }
    }
}

async function serializeExtensionOperation<T>(cwd: string | undefined, operation: () => Promise<T>): Promise<T> {
    const cwdKey = cwd == null ? undefined : path.resolve(cwd);
    const barriers =
        cwdKey == null
            ? [extensionGlobalOperation, ...extensionCwdOperations.values()]
            : [extensionGlobalOperation, extensionCwdOperations.get(cwdKey) ?? Promise.resolve()];
    const result = Promise.all(barriers).then(operation);
    const completion = result.then(
        () => undefined,
        () => undefined
    );
    if (cwdKey == null) {
        extensionGlobalOperation = completion;
    } else {
        extensionCwdOperations.set(cwdKey, completion);
    }
    try {
        return await result;
    } finally {
        if (cwdKey != null && extensionCwdOperations.get(cwdKey) === completion) {
            extensionCwdOperations.delete(cwdKey);
        }
    }
}

async function ensureSession(opts: SendOptions): Promise<{
    metadata: JsonlSessionMetadata;
    isNew: boolean;
}> {
    if (opts.sessionMetadata) {
        const { metadata } = await openValidatedSessionMetadata(opts.sessionMetadata);
        return { metadata, isNew: false };
    }
    const created = await createPaneSession(opts.cwd);
    const { metadata } = await openValidatedSessionMetadata(await created.session.getMetadata());
    return { metadata, isNew: true };
}

async function resolveApiKey(opts: SendOptions): Promise<string | undefined> {
    const literal = opts.token?.trim();
    if (literal) return literal;
    if (opts.tokenSecretName) {
        const value = await getSecret(opts.tokenSecretName);
        if (value) return value;
        console.warn(
            `[agent-ipc] secret "${opts.tokenSecretName}" not found in safeStorage. ` +
                `Provider ${opts.provider} may fail with "no API key" error.`
        );
    }
    return undefined;
}

async function createAgentRuntime(
    metadata: JsonlSessionMetadata,
    opts: SendOptions,
    config: AgentExecutionConfig
): Promise<AgentSessionRuntime> {
    const reloadState = pendingReloadStates.get(metadata.path);
    const piSession = await openPaneSession(metadata);
    const skills = await loadAgentSkills({ cwd: opts.cwd });
    const promptTemplates = await loadAgentPromptTemplates({ cwd: opts.cwd });
    const { extensions, runtime: extensionRuntime } = await loadAgentExtensions({ cwd: opts.cwd });
    const extensionUiBridge = createExtensionUiBridge();
    const extensionLifecycleHost = createExtensionLifecycleHost(extensionRuntime);
    let host: ReturnType<typeof buildAgentHarnessHost> | undefined;
    try {
        let getRuntimeCwd = () => config.promptInputs.cwd;
        host = buildAgentHarnessHost({
            session: piSession,
            model: config.model,
            thinkingLevel: config.thinkingLevel,
            promptInputs: config.promptInputs,
            tools: [
                ...getDefaultTools(() => getRuntimeCwd()),
                createSpawnCliAgentTool({
                    parentBlockId: opts.blockId,
                    getModel: () => host!.harness.getModel(),
                    createSession: () => new InMemorySessionRepo().create(),
                    getApiKeyAndHeaders: (model) => host!.resolveAuth(model),
                }),
            ],
            contextFiles: loadProjectContextFiles({ cwd: opts.cwd }),
            skills,
            promptTemplates,
            extensions,
            extensionRuntime,
            extensionUiBridge,
            extensionLifecycleOwnerId: metadata.path,
            extensionLifecycleHost,
            getApiKeyAndHeaders: config.authResolver,
            toolCallHook: config.toolCallHook,
        });
        getRuntimeCwd = () => host!.getCwd();
        const seed = await piSession.buildContext();
        const initialTurns = buildPersistedTurnsFromSessionEntries(await piSession.getBranch());
        const runtime: AgentSessionRuntime = new AgentSessionRuntime(metadata.path, host, seed.messages ?? [], initialTurns, {
            onTurnFinished: async (turn): Promise<void> => {
                const operations = extractChangeOperationsFromMessages(
                    turn.responseMessages.filter(isToolResultModelMessage),
                    { turnId: turn.turnId }
                );
                if (operations.length === 0) return;
                const model = host!.harness.getModel();
                const auth = await host!.resolveAuth(model);
                const changeOutline = await generateChangeOutline({
                    model,
                    operations,
                    turnId: turn.turnId,
                    apiKey: auth?.apiKey,
                });
                if (changeOutline) {
                    runtime.setTurnChangeOutline(turn.turnId, changeOutline);
                }
            },
            extensionUiBridge,
            initialExtensionUi: reloadState?.ui,
            initialFlagValues: reloadState?.flags,
        });
        extensionUiBridge.attach(runtime);
        return runtime;
    } catch (error) {
        extensionUiBridge.dispose();
        if (host) {
            await host.harness.abort().catch(() => {});
        }
        try {
            await extensionLifecycleHost.disposeOwner(metadata.path);
        } catch (cleanupError) {
            console.error(`[agent-ipc] extension cleanup error for ${metadata.path}:`, cleanupError);
        } finally {
            unregisterExtensionLifecycleHost(extensionLifecycleHost);
            extensionRuntime.invalidate();
        }
        throw error;
    }
}

async function ensureAgentRuntime(
    metadata: JsonlSessionMetadata,
    opts: SendOptions
): Promise<{ runtime: AgentSessionRuntime; config: AgentExecutionConfig }> {
    const apiKey = await resolveApiKey(opts);
    const model = resolveModelOrThrow(opts.provider, opts.model);
    const config: AgentExecutionConfig = {
        promptInputs: buildPromptInputs(opts),
        model,
        thinkingLevel: opts.reasoning ?? "off",
        authResolver: apiKey == null ? undefined : async () => ({ apiKey }),
        toolCallHook: buildPermissionsHook(
            isBenchMode()
                ? { allowAll: true }
                : opts.allowedTools
                  ? { allowAll: false, allowedTools: opts.allowedTools }
                  : { allowAll: true }
        ),
    };
    console.log(
        `[agent-ipc] send → provider=${model.provider} model=${model.id} api=${model.api} ` +
            `baseUrl=${model.baseUrl ?? "(provider default)"} ` +
            `reasoning=${config.thinkingLevel} apiKey=${apiKey ? "present" : "MISSING"} ` +
            `(tokenSecretName=${opts.tokenSecretName ?? "-"})`
    );
    const runtime = await runtimeRegistry.getOrCreate(metadata.path, () => createAgentRuntime(metadata, opts, config));
    pendingReloadStates.delete(metadata.path);
    attachPendingSubscribers(metadata.path, runtime);
    return { runtime, config };
}

function releaseSubscription(key: SubKey): void {
    const record = subscriptions.get(key);
    if (record) {
        try {
            record.unsubscribe();
        } catch (err) {
            console.error("[agent-ipc] unsubscribe error:", err);
        }
        runtimeRegistry.release(record.sessionPath, key);
        subscriptions.delete(key);
    }
    pendingSubscriptions.delete(key);
}

function releaseAllForSender(senderId: number): void {
    const keys = subscriptionsBySender.get(senderId);
    if (keys) {
        for (const key of keys) releaseSubscription(key);
        subscriptionsBySender.delete(senderId);
    }
    for (const [key, pending] of pendingSubscriptions) {
        if (pending.sender.id === senderId) pendingSubscriptions.delete(key);
    }
}

function trackSenderKey(sender: electron.WebContents, key: SubKey): void {
    let set = subscriptionsBySender.get(sender.id);
    if (!set) {
        set = new Set();
        subscriptionsBySender.set(sender.id, set);
        sender.once("destroyed", () => releaseAllForSender(sender.id));
    }
    set.add(key);
}

async function renderSessionEntriesForIpc(
    cwd: string | undefined,
    entries: Awaited<ReturnType<AgentSessionRuntime["listTreeEntries"]>>["entries"],
    owner?: AgentSessionRuntime
): Promise<RenderedExtensionEntryNode[]> {
    try {
        const extensions =
            owner?.host.extensions ?? (cwd ? (await loadAgentExtensions({ cwd, trackGraph: false })).extensions : []);
        if (extensions.length === 0) return [];
        return renderExtensionSessionEntries(extensions, entries, { width: 80 });
    } catch (err) {
        console.warn("[agent-ipc] failed to render extension session entries", err);
        return [];
    }
}

function makeEmptyExtensionUiSnapshot(): ExtensionUiSnapshot {
    return { statuses: {}, widgets: {}, widgetnodes: {} };
}

async function sendPersistedSessionState(
    sender: electron.WebContents,
    sessionPath: string,
    rendererSessionPath = sessionPath,
    subscriptionKey?: SubKey,
    subscriptionGeneration?: number
): Promise<void> {
    let canonicalPath = sessionPath;
    try {
        canonicalPath = await validateSessionPath(sessionPath);
        const session = await openPaneSessionByPath(canonicalPath);
        const metadata = await session.getMetadata();
        const context = await session.buildContext();
        const branchEntries = await session.getBranch();
        const turns = buildPersistedTurnsFromSessionEntries(branchEntries);
        const renderedEntries = await renderSessionEntriesForIpc(metadata.cwd, branchEntries);
        if (sender.isDestroyed()) return;
        if (
            subscriptionKey &&
            (subscriptionGenerations.get(subscriptionKey) !== subscriptionGeneration ||
                !pendingSubscriptions.has(subscriptionKey))
        ) {
            return;
        }
        const owner = runtimeRegistry.get(canonicalPath);
        if (owner) {
            await subscribeToOwner(sender, canonicalPath, owner, rendererSessionPath);
            return;
        }
        sender.send(
            "agent:event",
            makeAgentEventPayload(canonicalPath, rendererSessionPath, {
                type: "session_state",
                messages: context.messages,
                turns,
                status: "idle",
                steer: [],
                followUp: [],
                renderedEntries,
                extensionUi: makeEmptyExtensionUiSnapshot(),
            })
        );
    } catch (err) {
        console.error(`[agent-ipc] persisted session_state error for ${canonicalPath}:`, err);
    }
}

async function buildPersistedSessionState(sessionPath: string): Promise<{
    type: "session_state";
    messages: AgentMessage[];
    turns: AgentTurn[];
    status: AgentSessionRuntimeStatus;
    steer: AgentMessage[];
    followUp: AgentMessage[];
    renderedEntries: RenderedExtensionEntryNode[];
    extensionUi: ExtensionUiSnapshot;
}> {
    const canonicalPath = await validateSessionPath(sessionPath);
    const owner = runtimeRegistry.get(canonicalPath);
    if (owner) {
        const entries = await owner.host.session.getBranch();
        const renderedEntries = await renderSessionEntriesForIpc(undefined, entries, owner);
        const state = owner.getSessionState();
        return {
            type: "session_state",
            messages: state.messages,
            turns: state.turns,
            status: state.status,
            steer: state.steerQueue,
            followUp: state.followUpQueue,
            renderedEntries,
            extensionUi: state.extensionUi,
        };
    }
    const session = await openPaneSessionByPath(canonicalPath);
    const metadata = await session.getMetadata();
    const context = await session.buildContext();
    const entries = await session.getBranch();
    return {
        type: "session_state",
        messages: context.messages,
        turns: buildPersistedTurnsFromSessionEntries(entries),
        status: "idle",
        steer: [],
        followUp: [],
        renderedEntries: await renderSessionEntriesForIpc(metadata.cwd, entries),
        extensionUi: makeEmptyExtensionUiSnapshot(),
    };
}

function subscribeToOwner(
    sender: electron.WebContents,
    sessionPath: string,
    session: AgentSessionRuntime,
    rendererSessionPath = sessionPath
): Promise<void> {
    const key: SubKey = makeAgentSubscriptionKey(sender.id, sessionPath, rendererSessionPath);
    const subscriptionGeneration = (subscriptionGenerations.get(key) ?? 0) + 1;
    subscriptionGenerations.set(key, subscriptionGeneration);
    pendingSubscriptions.delete(key);
    if (sender.isDestroyed()) return Promise.resolve();
    const existing = subscriptions.get(key);
    if (existing) {
        return sendLiveSessionState(sender, sessionPath, session, rendererSessionPath, key, subscriptionGeneration);
    }
    const unsub = session.subscribe((agentEvent) => {
        if (sender.isDestroyed()) return;
        sender.send(
            "agent:event",
            makeAgentEventPayload(sessionPath, rendererSessionPath, {
                ...agentEvent,
                turns: session.getSessionState().turns,
            })
        );
    });
    const target = { sender, canonicalPath: sessionPath, rendererPath: rendererSessionPath };
    subscriptions.set(key, { unsubscribe: unsub, sessionPath, target });
    runtimeRegistry.acquire(sessionPath, key);
    trackSenderKey(sender, key);
    return sendLiveSessionState(sender, sessionPath, session, rendererSessionPath, key, subscriptionGeneration);
}

async function sendLiveSessionState(
    sender: electron.WebContents,
    sessionPath: string,
    session: AgentSessionRuntime,
    rendererSessionPath = sessionPath,
    subscriptionKey?: SubKey,
    subscriptionGeneration?: number
): Promise<void> {
    let renderedEntries: RenderedExtensionEntryNode[] = [];
    try {
        const entries = await session.host.session.getBranch();
        renderedEntries = await renderSessionEntriesForIpc(undefined, entries, session);
    } catch {
        try {
            const entries = await session.host.session.getBranch();
            renderedEntries = await renderSessionEntriesForIpc(undefined, entries, session);
        } catch (error) {
            console.warn(`[agent-ipc] live extension entry replay failed for ${sessionPath}:`, error);
        }
    }
    if (sender.isDestroyed()) return;
    if (runtimeRegistry.get(sessionPath) !== session) return;
    if (
        subscriptionKey &&
        (subscriptionGenerations.get(subscriptionKey) !== subscriptionGeneration ||
            !subscriptions.has(subscriptionKey))
    ) {
        return;
    }
    const sessionState = session.getSessionState();
    sender.send(
        "agent:event",
        makeAgentEventPayload(sessionPath, rendererSessionPath, {
            type: "session_state",
            messages: sessionState.messages,
            turns: sessionState.turns,
            status: sessionState.status,
            steer: sessionState.steerQueue,
            followUp: sessionState.followUpQueue,
            renderedEntries,
            extensionUi: sessionState.extensionUi,
        })
    );
}

function attachPendingSubscribers(sessionPath: string, session: AgentSessionRuntime): void {
    for (const [key, sender] of pendingSubscriptions) {
        if (sender.canonicalPath !== sessionPath) continue;
        if (sender.sender.isDestroyed()) {
            pendingSubscriptions.delete(key);
            continue;
        }
        void subscribeToOwner(sender.sender, sender.canonicalPath, session, sender.rendererPath).catch((err) => {
            console.error("[agent-ipc] subscribe live session_state error:", err);
        });
    }
}

async function getSessionTreeData(sessionMetadataInput: unknown): Promise<{
    entries: Awaited<ReturnType<AgentSessionRuntime["listTreeEntries"]>>["entries"];
    leafId: string | null;
    labels: Map<string, string | undefined>;
}> {
    const { metadata: sessionMetadata, session, requestedPath } = await validateTreeInput(sessionMetadataInput);
    const owner = runtimeRegistry.get(sessionMetadata.path) ?? runtimeRegistry.get(requestedPath);
    if (owner) return owner.listTreeEntries();

    const allEntries = await session.getEntries();
    const rawLeafId = await session.getLeafId();
    const { entries, effectiveLeafId } = filterTreeForDisplay(allEntries, rawLeafId);
    const labels = new Map<string, string | undefined>();
    for (const entry of entries) {
        labels.set(entry.id, await session.getLabel(entry.id));
    }
    return { entries, leafId: effectiveLeafId, labels };
}

/**
 * Convert an extension's RegisteredCommand into the AgentCommandInfo the
 * slash-command menus consume. Execution routes through the runtime's live
 * extension ctx (action.type === "extension"), never the backend switch.
 */
function extensionCommandToInfo(command: {
    name: string;
    description?: string;
    argumentHint?: string;
    aliases?: string[];
}): AgentCommandInfo {
    return {
        name: command.name,
        description: command.description ?? "",
        argumentHint: command.argumentHint,
        aliases: command.aliases,
        source: "extension",
        action: { type: "extension", name: command.name },
    };
}

/**
 * List slash commands available to a workspace. Built-ins are always returned; when
 * a cwd is supplied we additionally discover the workspace's extensions and surface
 * any commands they registered via pi.registerCommand(). A built-in name always
 * wins over an extension name of the same id (extensions can't shadow built-ins).
 */
export async function listAgentCommandsForIpc(cwd?: string): Promise<AgentCommandInfo[]> {
    const builtins = getBuiltInAgentCommands();
    if (!cwd || cwd.trim() === "") return builtins;

    const taken = new Set<string>();
    for (const command of builtins) {
        taken.add(command.name);
        for (const alias of command.aliases ?? []) taken.add(alias);
    }

    try {
        const { extensions } = await loadAgentExtensions({ cwd, trackGraph: false });
        const extensionCommands: AgentCommandInfo[] = [];
        for (const extension of extensions) {
            for (const command of extension.commands.values()) {
                if (taken.has(command.name)) continue;
                taken.add(command.name);
                extensionCommands.push(extensionCommandToInfo(command));
            }
        }
        return [...builtins, ...extensionCommands];
    } catch (error) {
        console.warn(`[agent-ipc] listAgentCommandsForIpc: extension discovery failed: ${String(error)}`);
        return builtins;
    }
}

/**
 * List extension-registered keyboard shortcuts (pi.registerShortcut) for a
 * workspace cwd. The renderer binds these keys and routes activation back through
 * runAgentShortcutForIpc. Returns [] when cwd is empty or discovery fails.
 */
export async function listAgentShortcutsForIpc(cwd?: string): Promise<AgentShortcutInfo[]> {
    if (!cwd || cwd.trim() === "") return [];
    try {
        const { extensions } = await loadAgentExtensions({ cwd, trackGraph: false });
        const shortcuts: AgentShortcutInfo[] = [];
        const seen = new Set<string>();
        for (const extension of extensions) {
            for (const registered of extension.shortcuts.values()) {
                if (seen.has(registered.shortcut)) continue;
                seen.add(registered.shortcut);
                shortcuts.push({
                    shortcut: registered.shortcut,
                    description: registered.description,
                    extensionPath: registered.extensionPath,
                });
            }
        }
        return shortcuts;
    } catch (error) {
        console.warn(`[agent-ipc] listAgentShortcutsForIpc: extension discovery failed: ${String(error)}`);
        return [];
    }
}

/**
 * List extension-registered flags (pi.registerFlag) for a session. When a live
 * owner exists (sessionMetadata resolves in the cache) the current value comes
 * from that session's bound runtime; otherwise it falls back to the registered
 * default (headless discovery). Returns [] when cwd is empty or discovery
 * fails.
 */
export async function listAgentFlagsForIpc(cwd?: string, sessionMetadata?: unknown): Promise<AgentFlagInfo[]> {
    if (!cwd || cwd.trim() === "") return [];
    const owner = await resolveCanonicalSessionOwner(sessionMetadata);
    try {
        const { extensions } = await loadAgentExtensions({ cwd, trackGraph: false });
        const flags: AgentFlagInfo[] = [];
        const seen = new Set<string>();
        for (const extension of extensions) {
            for (const registered of extension.flags.values()) {
                if (seen.has(registered.name)) continue;
                seen.add(registered.name);
                const live = owner?.getFlagValue(registered.name);
                flags.push({
                    name: registered.name,
                    description: registered.description,
                    type: registered.type,
                    default: registered.default,
                    value: live !== undefined ? live : registered.default,
                    extensionPath: registered.extensionPath,
                });
            }
        }
        return flags;
    } catch (error) {
        console.warn(`[agent-ipc] listAgentFlagsForIpc: extension discovery failed: ${String(error)}`);
        return [];
    }
}

async function resolveCanonicalSessionOwner(sessionMetadata: unknown): Promise<AgentSessionRuntime | undefined> {
    if (!isRecord(sessionMetadata)) return undefined;
    const rawPath = sessionMetadata.path;
    if (typeof rawPath !== "string" || rawPath.trim() === "") return undefined;
    const canonicalPath = await validateSessionPath(rawPath, "sessionMetadata.path");
    return runtimeRegistry.get(canonicalPath);
}

interface AgentRunShortcutInput {
    sessionMetadata?: JsonlSessionMetadata;
    cwd: string;
    shortcut: string;
}

function validateRunShortcutInput(value: unknown): AgentRunShortcutInput {
    if (!isRecord(value)) throw new Error("agent IPC: runShortcut input must be an object");
    return {
        cwd: requireNonEmptyString(value.cwd, "cwd"),
        shortcut: requireNonEmptyString(value.shortcut, "shortcut"),
        sessionMetadata:
            value.sessionMetadata == null ? undefined : validateSessionMetadataShape(value.sessionMetadata),
    };
}

/**
 * Activate an extension keyboard shortcut. When a live AgentSessionRuntime owns
 * the requested session we route through it (correct cwd + attached ctx.ui host);
 * otherwise we run headless with a fresh ctx (ctx.ui degrades to no-op). Mirrors
 * runAgentExtensionCommandForIpc.
 */
export async function runAgentShortcutForIpc(input: unknown): Promise<AgentCommandExecutionResult> {
    const parsed = validateRunShortcutInput(input);

    const owner = await resolveCanonicalSessionOwner(parsed.sessionMetadata);
    if (owner) {
        return await owner.runShortcut(parsed.shortcut);
    }

    const { extensions } = await loadAgentExtensions({ cwd: parsed.cwd, trackGraph: false });
    const ctx = createExtensionContext(() => parsed.cwd);
    for (const extension of extensions) {
        const registered = extension.shortcuts.get(parsed.shortcut);
        if (!registered) continue;
        await registered.handler(ctx);
        return commandSuccess(`Ran extension shortcut ${parsed.shortcut}`);
    }
    return commandNoop(`Extension shortcut ${parsed.shortcut} is not available.`);
}

interface AgentSetFlagInput {
    sessionMetadata?: JsonlSessionMetadata;
    name: string;
    value: boolean | string;
}

function validateSetFlagInput(value: unknown): AgentSetFlagInput {
    if (!isRecord(value)) throw new Error("agent IPC: setFlag input must be an object");
    const flagValue = value.value;
    if (typeof flagValue !== "boolean" && typeof flagValue !== "string") {
        throw new Error("agent IPC: setFlag value must be a boolean or string");
    }
    return {
        name: requireNonEmptyString(value.name, "name"),
        value: flagValue,
        sessionMetadata:
            value.sessionMetadata == null ? undefined : validateSessionMetadataShape(value.sessionMetadata),
    };
}

/**
 * Write a flag value. Only meaningful when a live owner exists — the flag value
 * lives in that session's bound extension runtime, which the running agent reads
 * via pi.getFlag(). Without an owner (no session yet) the write is a no-op:
 * headless discovery rebuilds runtimes per call, so there's nothing durable to
 * mutate. Returns success/noop the renderer can surface.
 */
export async function setAgentFlagForIpc(input: unknown): Promise<AgentCommandExecutionResult> {
    const parsed = validateSetFlagInput(input);
    if (!parsed.sessionMetadata?.path) {
        return commandNoop(`No active agent session to set flag ${parsed.name}.`);
    }
    const canonicalPath = await validateSessionPath(parsed.sessionMetadata.path, "sessionMetadata.path");
    return await serializeSessionOperation(canonicalPath, () =>
        serializeExtensionOperation(undefined, async () => {
            const owner = runtimeRegistry.get(canonicalPath);
            if (!owner) {
                return commandNoop(`No active agent session to set flag ${parsed.name}.`);
            }
            const result = owner.setFlagValue(parsed.name, parsed.value);
            if (result === "missing") return commandNoop(`Flag ${parsed.name} is not available.`);
            if (result === "invalid") return commandNoop(`Flag ${parsed.name} does not accept this value.`);
            return commandSuccess(`Set flag ${parsed.name}`);
        })
    );
}

export async function listAgentTreeForIpc(sessionMetadata: unknown): Promise<AgentTreeResult> {
    const { entries, leafId, labels } = await getSessionTreeData(sessionMetadata);
    return { entries: buildAgentTreeEntryViews(entries, leafId, labels), leafId };
}

export async function listAgentForkPointsForIpc(sessionMetadata: unknown): Promise<AgentForkPointView[]> {
    const { entries } = await getSessionTreeData(sessionMetadata);
    return buildAgentForkPointViews(entries);
}

export async function getAgentSessionStateForIpc(
    sessionMetadata: unknown
): Promise<Awaited<ReturnType<typeof buildPersistedSessionState>>> {
    const { metadata, requestedPath } = await openValidatedSessionMetadata(sessionMetadata);
    return await buildPersistedSessionState(requestedPath || metadata.path);
}

export async function navigateAgentTreeForIpc(input: unknown): Promise<AgentNavigateTreeResult> {
    const { metadata, session, targetId, requestedPath } = await validateNavigateInput(input);
    const owner = runtimeRegistry.get(metadata.path) ?? runtimeRegistry.get(requestedPath);

    if (owner) {
        const result = await owner.navigateTree(targetId);
        return { sessionMetadata: metadata, ...result };
    }

    // No live owner (typical case: rehydrated session, user hasn't sent a new
    // prompt yet — only the one-shot subscribe session_state exists). Replicate the
    // harness's summarize:false navigate directly against the jsonl session,
    // then push a fresh session_state to every pending subscriber.
    const targetEntry = await session.getEntry(targetId);
    if (!targetEntry) {
        throw new Error(`agent IPC: targetId ${targetId} not found in session`);
    }
    const oldLeafId = await session.getLeafId();
    let editorText: string | undefined;
    let newLeafId: string | null;
    if (targetEntry.type === "message" && (targetEntry.message as { role?: string }).role === "user") {
        newLeafId = targetEntry.parentId ?? targetId;
        const content = (targetEntry.message as { content?: unknown }).content;
        editorText =
            typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? content
                        .filter(
                            (c): c is { type: "text"; text: string } =>
                                c && typeof c === "object" && "type" in c && c.type === "text"
                        )
                        .map((c) => c.text)
                        .join("")
                  : undefined;
    } else if (targetEntry.type === "custom_message") {
        newLeafId = targetEntry.parentId ?? targetId;
        const content = (targetEntry as { content?: unknown }).content;
        editorText =
            typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? content
                        .filter(
                            (c): c is { type: "text"; text: string } =>
                                c && typeof c === "object" && "type" in c && c.type === "text"
                        )
                        .map((c) => c.text)
                        .join("")
                  : undefined;
    } else {
        newLeafId = targetId;
    }
    if (oldLeafId !== newLeafId) {
        await session.moveTo(newLeafId);
    }
    const branchEntries = await session.getBranch();
    const context = await session.buildContext();
    const turns = buildPersistedTurnsFromSessionEntries(branchEntries);
    const renderedEntries = await renderSessionEntriesForIpc(metadata.cwd, branchEntries);

    // Broadcast the post-navigate session_state to every sender that has a
    // subscription (pending or active) on this session. Active-subscription
    // owners can't exist here (we already took the owner branch above), so
    // walk pendingSubscriptions. Turns derive solely from the session branch,
    // so every subscriber gets the same session state regardless of its block.
    const sessionState = {
        type: "session_state" as const,
        messages: context.messages,
        turns,
        status: "idle" as const,
        steer: [] as AgentMessage[],
        followUp: [] as AgentMessage[],
        renderedEntries,
        extensionUi: makeEmptyExtensionUiSnapshot(),
        errorMessage: undefined as string | undefined,
    };
    for (const [, pending] of pendingSubscriptions) {
        if (pending.canonicalPath !== metadata.path) continue;
        const { sender } = pending;
        if (sender.isDestroyed()) continue;
        sender.send("agent:event", makeAgentEventPayload(metadata.path, pending.rendererPath, sessionState));
    }
    // Also send to the IPC caller if it's not already covered. The caller
    // doesn't wait for the IPC event — the navigate return carries
    // editorText, but the renderer relies on "agent:event" session_state to
    // repopulate turns. The subscription effect in use-pi-chat registers
    // before navigate fires, so the sender is already in pendingSubscriptions
    // above; nothing else to do here.
    return { sessionMetadata: metadata, editorText };
}

export async function forkAgentSessionForIpc(input: unknown): Promise<AgentForkSessionResult> {
    const { metadata: sourceMetadata, session: source, cwd, entryId } = await validateForkInput(input);
    const target = await source.getEntry(entryId);
    const { metadata } = await forkPaneSession(sourceMetadata, {
        cwd,
        entryId,
    });
    return {
        sessionMetadata: metadata,
        ...(target ? { selectedText: previewSessionEntry(target) } : {}),
    };
}

export async function cloneAgentSessionForIpc(input: unknown): Promise<AgentCloneSessionResult> {
    const { metadata: sourceMetadata, session: source, cwd } = await validateCloneInput(input);
    const leafId = await source.getLeafId();
    if (!leafId) {
        return { message: "No session branch to clone yet." };
    }
    await requireSessionEntry(source, leafId, "targetId");
    const { metadata } = await forkPaneSession(sourceMetadata, { cwd, entryId: leafId, position: "at" });
    return { sessionMetadata: metadata };
}

export async function runAgentCommandForIpc(input: unknown): Promise<AgentCommandExecutionResult> {
    const parsed = validateRunCommandInput(input);
    switch (parsed.command) {
        case "new":
            return await runNewAgentSessionCommand(parsed.cwd);
        case "compact":
            return await runCompactSessionCommand(parsed.sessionMetadata, parsed.argsText);
        case "session":
            return await runSessionInfoCommand(parsed.sessionMetadata);
        case "copy":
            return await runCopyLastAssistantMessageCommand(parsed.sessionMetadata);
        case "export":
            return await runExportSessionCommand(parsed.sessionMetadata, parsed.cwd, parsed.argsText);
        case "import":
            return await runImportSessionCommand(parsed.cwd, parsed.argsText);
        case "reload": {
            if (!parsed.sessionMetadata?.path) {
                return await serializeExtensionOperation(undefined, () => runReloadAgentCommand(parsed));
            }
            const canonicalPath = await validateSessionPath(parsed.sessionMetadata.path, "sessionMetadata.path");
            return await serializeSessionOperation(canonicalPath, () =>
                serializeExtensionOperation(parsed.cwd, () => runReloadAgentCommand(parsed))
            );
        }
        default:
            return commandNoop(`Agent command /${parsed.command} is not implemented yet.`);
    }
}

async function runReloadAgentCommand(parsed: AgentRunCommandInput): Promise<AgentCommandExecutionResult> {
    let graph: Awaited<ReturnType<typeof reloadExtensionsForRuntime>>;
    try {
        const owner = await getCachedSessionOwnerForReload(parsed.sessionMetadata);
        const reloadState = owner?.getReloadState();
        let lifecycleHost = owner?.host.extensionLifecycleHost;
        if (owner) {
            await detachCachedSessionOwnerForReload(owner, reloadState);
        } else {
            lifecycleHost = await detachWorkspaceSessionOwnersForReload(parsed.cwd);
        }
        graph = await reloadExtensionsForRuntime({
            cwd: parsed.cwd,
            lifecycleHost,
        });
        if (lifecycleHost) {
            unregisterExtensionLifecycleHost(lifecycleHost);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return commandNoop(`Reload failed: ${message}`);
    }
    return commandSuccess(`Reloaded ${graph.nodes.length} extension${graph.nodes.length === 1 ? "" : "s"}.`);
}

async function detachWorkspaceSessionOwnersForReload(cwd: string): Promise<ExtensionLifecycleHost> {
    const resolvedCwd = path.resolve(cwd);
    const targets = [...runtimeRegistry.entries.entries()].filter(
        ([, entry]) => path.resolve(entry.runtime.host.getCwd()) === resolvedCwd
    );
    if (targets.some(([, entry]) => entry.runtime.isRunning())) {
        throw new Error("cannot reload extensions while an agent session in this workspace is running");
    }
    const lifecycleHost =
        targets.map(([, entry]) => entry.runtime.host.extensionLifecycleHost).find((host) => host != null) ??
        createExtensionLifecycleHost();
    for (const [sessionPath, entry] of targets) {
        const runtime = entry.runtime;
        pendingReloadStates.set(sessionPath, runtime.getReloadState());
        moveActiveSubscriptionsToPending(sessionPath);
        await runtimeRegistry.invalidate(sessionPath, (current) => current.dispose("reload"));
    }
    return lifecycleHost;
}

async function getCachedSessionOwnerForReload(
    sessionMetadata: JsonlSessionMetadata | undefined
): Promise<AgentSessionRuntime | undefined> {
    return await resolveCanonicalSessionOwner(sessionMetadata);
}

async function detachCachedSessionOwnerForReload(
    owner: AgentSessionRuntime | undefined,
    reloadState: ExtensionReloadState | undefined
): Promise<void> {
    if (!owner) return;
    const canonicalPath = owner.path;
    if (reloadState) {
        pendingReloadStates.set(canonicalPath, reloadState);
    }
    try {
        moveActiveSubscriptionsToPending(canonicalPath);
        await runtimeRegistry.invalidate(canonicalPath, (runtime) => runtime.dispose("reload"));
    } catch (error) {
        pendingReloadStates.delete(canonicalPath);
        throw error;
    }
}

function moveActiveSubscriptionsToPending(sessionPath: string): void {
    for (const [key, record] of subscriptions) {
        if (record.sessionPath !== sessionPath) continue;
        try {
            record.unsubscribe();
        } catch (err) {
            console.error("[agent-ipc] unsubscribe error:", err);
        }
        subscriptions.delete(key);
        runtimeRegistry.release(sessionPath, key);
        if (!record.target.sender.isDestroyed()) {
            pendingSubscriptions.set(key, record.target);
        }
    }
}

interface AgentRunExtensionCommandInput {
    sessionMetadata?: JsonlSessionMetadata;
    cwd: string;
    name: string;
    argsText: string;
}

function validateRunExtensionCommandInput(value: unknown): AgentRunExtensionCommandInput {
    if (!isRecord(value)) throw new Error("agent IPC: runExtensionCommand input must be an object");
    return {
        cwd: requireNonEmptyString(value.cwd, "cwd"),
        name: requireNonEmptyString(value.name, "name"),
        argsText: typeof value.argsText === "string" ? value.argsText : "",
        sessionMetadata:
            value.sessionMetadata == null ? undefined : validateSessionMetadataShape(value.sessionMetadata),
    };
}

/**
 * Execute an extension-registered slash command (pi.registerCommand). Runs on a
 * separate IPC channel from runAgentCommandForIpc so the built-in command union
 * stays closed. When a live AgentSessionRuntime owns this session we route
 * through it (correct cwd + attached ctx.ui host). Otherwise — the command was
 * invoked before the first prompt minted a session — we fall back to a headless
 * load: discover the workspace's extensions for `cwd` and run the handler with a
 * fresh headless ctx (ctx.ui degrades to the no-op shim, no UI host attached).
 */
export async function runAgentExtensionCommandForIpc(input: unknown): Promise<AgentCommandExecutionResult> {
    const parsed = validateRunExtensionCommandInput(input);

    const owner = await resolveCanonicalSessionOwner(parsed.sessionMetadata);
    if (owner) {
        return await owner.runExtensionCommand(parsed.name, parsed.argsText);
    }

    // Headless fallback: no live owner (no session yet, or a different workspace).
    // No command host available → session-control methods degrade to no-ops.
    const { extensions } = await loadAgentExtensions({ cwd: parsed.cwd, trackGraph: false });
    const ctx = createCommandContext(createExtensionContext(() => parsed.cwd));
    for (const extension of extensions) {
        const command = extension.commands.get(parsed.name);
        if (!command) continue;
        await command.handler(parsed.argsText, ctx);
        return commandSuccess(`Ran extension command /${parsed.name}`);
    }
    return commandNoop(`Extension command /${parsed.name} is not available.`);
}


async function runNewAgentSessionCommand(_cwd: string): Promise<AgentCommandExecutionResult> {
    // Lazy creation: /new does NOT mint a session or touch disk. It only
    // signals the renderer to reset the surface to a "no session" state; the
    // next prompt flows through usePiChat.send's existing lazy-create path
    // (createSession on first send), so repeated /new never leaves behind
    // empty .jsonl files. No sessionMetadata is returned by design.
    return {
        status: "success",
        message: "New session started",
    };
}

async function runCompactSessionCommand(
    sessionMetadata: JsonlSessionMetadata | undefined,
    argsText: string
): Promise<AgentCommandExecutionResult> {
    if (!sessionMetadata?.path) return commandNoop("No active agent session to compact.");
    const { metadata, requestedPath } = await openValidatedSessionMetadata(sessionMetadata);
    const owner = runtimeRegistry.get(metadata.path) ?? runtimeRegistry.get(requestedPath);
    if (!owner) return commandNoop("No active agent session to compact.");
    const customInstructions = argsText.trim() || undefined;
    await owner.compact(customInstructions);
    return commandSuccess("Compacted session context.");
}

async function runSessionInfoCommand(
    sessionMetadata: JsonlSessionMetadata | undefined
): Promise<AgentCommandExecutionResult> {
    if (!sessionMetadata?.path) return commandNoop("No active agent session yet.");
    const { metadata, session } = await openValidatedSessionMetadata(sessionMetadata);
    const context = await session.buildContext();
    const messages = context.messages ?? [];
    const userMessages = messages.filter((message) => message.role === "user").length;
    const assistantMessages = messages.filter((message) => message.role === "assistant").length;
    const toolResults = messages.filter((message) => message.role === "toolResult").length;
    let toolCalls = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost = 0;
    for (const message of messages) {
        if (message.role !== "assistant") continue;
        const assistant = message as unknown as {
            content?: Array<{ type: string }>;
            usage?: {
                input?: number;
                output?: number;
                cacheRead?: number;
                cacheWrite?: number;
                cost?: { total?: number };
            };
        };
        toolCalls += assistant.content?.filter((item) => item.type === "toolCall").length ?? 0;
        totalInput += assistant.usage?.input ?? 0;
        totalOutput += assistant.usage?.output ?? 0;
        totalCacheRead += assistant.usage?.cacheRead ?? 0;
        totalCacheWrite += assistant.usage?.cacheWrite ?? 0;
        totalCost += assistant.usage?.cost?.total ?? 0;
    }
    const lines = [
        "Session Info",
        "",
        `File: ${metadata.path}`,
        `ID: ${metadata.id}`,
        "",
        "Messages",
        `User: ${userMessages}`,
        `Assistant: ${assistantMessages}`,
        `Tool Calls: ${toolCalls}`,
        `Tool Results: ${toolResults}`,
        `Total: ${messages.length}`,
        "",
        "Tokens",
        `Input: ${totalInput.toLocaleString()}`,
        `Output: ${totalOutput.toLocaleString()}`,
    ];
    if (totalCacheRead > 0) lines.push(`Cache Read: ${totalCacheRead.toLocaleString()}`);
    if (totalCacheWrite > 0) lines.push(`Cache Write: ${totalCacheWrite.toLocaleString()}`);
    lines.push(`Total: ${(totalInput + totalOutput + totalCacheRead + totalCacheWrite).toLocaleString()}`);
    if (totalCost > 0) lines.push("", "Cost", `Total: ${totalCost.toFixed(4)}`);
    return commandSuccess(lines.join("\n"));
}

async function runCopyLastAssistantMessageCommand(
    sessionMetadata: JsonlSessionMetadata | undefined
): Promise<AgentCommandExecutionResult> {
    if (!sessionMetadata?.path) return commandNoop("No active agent session yet.");
    const { session } = await openValidatedSessionMetadata(sessionMetadata);
    const context = await session.buildContext();
    const text = [...(context.messages ?? [])]
        .reverse()
        .map(getAssistantText)
        .find((value) => value);
    if (!text) return commandNoop("No agent messages to copy yet.");
    electron.clipboard.writeText(text);
    return commandSuccess("Copied last agent message to clipboard");
}

async function runExportSessionCommand(
    sessionMetadata: JsonlSessionMetadata | undefined,
    cwd: string,
    argsText: string
): Promise<AgentCommandExecutionResult> {
    if (!sessionMetadata?.path) return commandNoop("No active agent session yet.");
    const outputArg = getPathCommandArgument(argsText);
    const outputPath = resolvePathForCwd(
        outputArg ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
        cwd
    );
    const { metadata, session } = await openValidatedSessionMetadata(sessionMetadata);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const header: JsonlSessionHeader = {
        type: "session",
        version: 3,
        id: metadata.id,
        timestamp: metadata.createdAt,
        cwd: metadata.cwd,
        parentSession: metadata.parentSessionPath,
    };
    const branchEntries = await session.getBranch();
    const lines = [JSON.stringify(header)];
    let prevId: string | null = null;
    for (const entry of branchEntries) {
        const linear = { ...entry, parentId: prevId };
        lines.push(JSON.stringify(linear));
        prevId = entry.id;
    }
    await fs.writeFile(outputPath, `${lines.join("\n")}\n`);
    return commandSuccess(`Session exported to: ${outputPath}`);
}

async function runImportSessionCommand(cwd: string, argsText: string): Promise<AgentCommandExecutionResult> {
    const inputArg = getPathCommandArgument(argsText);
    if (!inputArg) throw new Error("Usage: /import <path.jsonl>");
    const inputPath = resolvePathForCwd(inputArg, cwd);
    const { metadata } = await importPaneSessionFromJsonl(inputPath, cwd);
    return {
        status: "success",
        message: `Session imported from: ${inputPath}`,
        sessionMetadata: metadata,
    };
}

export async function abortAgentSessionForIpc(sessionPath: unknown): Promise<void> {
    const canonicalPath = await validateSessionPath(sessionPath);
    runtimeRegistry.get(canonicalPath)?.abort();
}

/**
 * Deliver a renderer's answer to a pending ctx.ui request (confirm/select/
 * input) back to the owning session. sessionPath is validated the same way as
 * the other agent IPC entry points; unknown paths / requestIds are ignored.
 */
export async function respondUiForIpc(
    sessionPath: unknown,
    requestId: unknown,
    result: unknown
): Promise<void> {
    const canonicalPath = await validateSessionPath(sessionPath);
    const id = requireNonEmptyString(requestId, "requestId");
    runtimeRegistry.get(canonicalPath)?.respondUi(id, result);
}

export async function respondWidgetEventForIpc(
    sessionPath: unknown,
    event: unknown
): Promise<WidgetEventDispatchResult> {
    const operationKey =
        typeof sessionPath === "string" ? path.resolve(sessionPath) : `invalid-widget-session:${typeof sessionPath}`;
    return await serializeSessionOperation(operationKey, async () => {
        const rendererPath = requireNonEmptyString(sessionPath, "sessionPath");
        const canonicalPath = await validateSessionPath(rendererPath);
        const widgetEvent = event as WidgetEvent | undefined;
        if (!widgetEvent || typeof widgetEvent.nodeid !== "string" || typeof widgetEvent.type !== "string") {
            throw new Error("Invalid widget event");
        }
        return runtimeRegistry.get(canonicalPath)?.respondWidgetEvent(widgetEvent) ?? {
            handled: false,
            published: false,
        };
    });
}

export async function subscribeAgentSessionForIpc(sender: electron.WebContents, sessionPath: unknown): Promise<void> {
    const rendererPath = requireNonEmptyString(sessionPath, "sessionPath");
    const canonicalPath = await validateSessionPath(rendererPath);
    if (sender.isDestroyed()) return;
    const session = runtimeRegistry.get(canonicalPath);
    if (!session) {
        const key: SubKey = makeAgentSubscriptionKey(sender.id, canonicalPath, rendererPath);
        const subscriptionGeneration = (subscriptionGenerations.get(key) ?? 0) + 1;
        subscriptionGenerations.set(key, subscriptionGeneration);
        if (!pendingSubscriptions.has(key)) {
            pendingSubscriptions.set(key, { sender, canonicalPath, rendererPath });
            trackSenderKey(sender, key);
        }
        await sendPersistedSessionState(sender, canonicalPath, rendererPath, key, subscriptionGeneration);
        return;
    }
    await subscribeToOwner(sender, canonicalPath, session, rendererPath);
}

export async function unsubscribeAgentSessionForIpc(senderId: number, sessionPath: unknown): Promise<void> {
    const rendererPath = requireNonEmptyString(sessionPath, "sessionPath");
    const canonicalPath = await validateSessionPath(rendererPath);
    const key: SubKey = makeAgentSubscriptionKey(senderId, canonicalPath, rendererPath);
    releaseSubscription(key);
    const set = subscriptionsBySender.get(senderId);
    if (set) {
        set.delete(key);
        if (set.size === 0) subscriptionsBySender.delete(senderId);
    }
}

/**
 * Wire the agent IPC handlers. Call once at app startup from
 * emain-ipc.ts initIpcHandlers().
 */
export function registerAgentIpcHandlers(): void {
    if (!runtimeSweepTimer) {
        runtimeSweepTimer = setInterval(() => {
            void runtimeRegistry.evictIdle().catch((error) => {
                console.error("[agent-ipc] runtime eviction error:", error);
            });
        }, AgentRuntimeSweepIntervalMs);
        runtimeSweepTimer.unref();
    }

    electron.ipcMain.handle("agent:create-session", async (_event, cwd: string): Promise<JsonlSessionMetadata> => {
        const { metadata } = await createPaneSession(cwd);
        return metadata;
    });

    electron.ipcMain.handle(
        "agent:list-sessions-for-cwd",
        async (_event, cwd: string): Promise<JsonlSessionMetadata[]> => {
            return await listSessionsForCwd(cwd);
        }
    );

    electron.ipcMain.handle(
        "agent:list-session-details-for-cwd",
        async (_event, cwd: string, limit?: number): Promise<SessionDetailInfo[]> => {
            return await listSessionDetailsForCwd(cwd, limit);
        }
    );

    electron.ipcMain.handle(
        "agent:list-all-session-details",
        async (_event, limit?: number): Promise<SessionDetailInfo[]> => {
            return await listAllSessionDetails(limit);
        }
    );

    electron.ipcMain.handle("agent:list-commands", async (_event, cwd?: string): Promise<AgentCommandInfo[]> => {
        return await listAgentCommandsForIpc(typeof cwd === "string" ? cwd : undefined);
    });

    electron.ipcMain.handle("agent:list-shortcuts", async (_event, cwd?: string): Promise<AgentShortcutInfo[]> => {
        return await listAgentShortcutsForIpc(typeof cwd === "string" ? cwd : undefined);
    });

    electron.ipcMain.handle(
        "agent:run-shortcut",
        async (_event, input: unknown): Promise<AgentCommandExecutionResult> => {
            return await runAgentShortcutForIpc(input);
        }
    );

    electron.ipcMain.handle(
        "agent:list-flags",
        async (_event, cwd?: string, sessionMetadata?: unknown): Promise<AgentFlagInfo[]> => {
            return await listAgentFlagsForIpc(typeof cwd === "string" ? cwd : undefined, sessionMetadata);
        }
    );

    electron.ipcMain.handle(
        "agent:set-flag",
        async (_event, input: unknown): Promise<AgentCommandExecutionResult> => {
            return await setAgentFlagForIpc(input);
        }
    );

    electron.ipcMain.handle("agent:extensions-graph", async () => {
        return getExtensionGraphForRuntime();
    });

    electron.ipcMain.handle(
        "agent:list-tree",
        async (_event, sessionMetadata: JsonlSessionMetadata): Promise<AgentTreeResult> => {
            return await listAgentTreeForIpc(sessionMetadata);
        }
    );

    electron.ipcMain.handle("agent:get-session-state", async (_event, sessionMetadata: JsonlSessionMetadata) => {
        return await getAgentSessionStateForIpc(sessionMetadata);
    });

    electron.ipcMain.handle(
        "agent:list-fork-points",
        async (_event, sessionMetadata: JsonlSessionMetadata): Promise<AgentForkPointView[]> => {
            return await listAgentForkPointsForIpc(sessionMetadata);
        }
    );

    electron.ipcMain.handle(
        "agent:navigate-tree",
        async (_event, input: AgentNavigateTreeInput): Promise<AgentNavigateTreeResult> => {
            return await navigateAgentTreeForIpc(input);
        }
    );

    electron.ipcMain.handle(
        "agent:fork-session",
        async (_event, input: AgentForkSessionInput): Promise<AgentForkSessionResult> => {
            return await forkAgentSessionForIpc(input);
        }
    );

    electron.ipcMain.handle(
        "agent:clone-session",
        async (_event, input: AgentCloneSessionInput): Promise<AgentCloneSessionResult> => {
            return await cloneAgentSessionForIpc(input);
        }
    );

    electron.ipcMain.handle(
        "agent:run-command",
        async (_event, input: AgentRunCommandInput): Promise<AgentCommandExecutionResult> => {
            return await runAgentCommandForIpc(input);
        }
    );

    electron.ipcMain.handle(
        "agent:run-extension-command",
        async (_event, input: unknown): Promise<AgentCommandExecutionResult> => {
            return await runAgentExtensionCommandForIpc(input);
        }
    );

    electron.ipcMain.handle(
        "agent:send",
        async (_event, opts: SendOptions): Promise<{ sessionMetadata: JsonlSessionMetadata; turnId: string }> => {
            console.log(
                `[agent-ipc] agent:send provider=${opts.provider} model=${opts.model} ` +
                    `reasoning=${opts.reasoning ?? "off"} ` +
                    `cred=${opts.token ? "token" : opts.tokenSecretName ? `secret:${opts.tokenSecretName}` : "NONE"} ` +
                    `textLen=${opts.text?.length ?? 0}`
            );
            const { metadata } = await ensureSession(opts);
            const userEntryId = await serializeSessionOperation(metadata.path, () =>
                serializeExtensionOperation(opts.cwd, async () => {
                    const { runtime, config } = await ensureAgentRuntime(metadata, opts);
                    // Turn identity IS the session entry id of the user message that
                    // starts the turn. Prompt first so the session mints that entry,
                    // the single source of truth.
                    return await runtime.sendWithExecutionConfig(opts.text, config);
                })
            );
            return { sessionMetadata: metadata, turnId: userEntryId };
        }
    );

    electron.ipcMain.on("agent:abort", (_event, sessionPath: string) => {
        void abortAgentSessionForIpc(sessionPath).catch((err) => {
            console.error("[agent-ipc] abort validation error:", err);
        });
    });

    electron.ipcMain.handle(
        "agent:ui-response",
        async (_event, sessionPath: string, requestId: string, result: unknown): Promise<void> => {
            await respondUiForIpc(sessionPath, requestId, result);
        }
    );

    electron.ipcMain.handle(
        "agent:widget-event",
        async (_event, sessionPath: string, event: unknown): Promise<WidgetEventDispatchResult> => {
            return await respondWidgetEventForIpc(sessionPath, event);
        }
    );

    electron.ipcMain.on("agent:subscribe", (event, sessionPath: string) => {
        void subscribeAgentSessionForIpc(event.sender, sessionPath).catch((err) => {
            console.error("[agent-ipc] subscribe validation error:", err);
        });
    });

    electron.ipcMain.on("agent:unsubscribe", (event, sessionPath: string) => {
        void unsubscribeAgentSessionForIpc(event.sender.id, sessionPath).catch((err) => {
            console.error("[agent-ipc] unsubscribe validation error:", err);
        });
    });
}

/** Test-only escape hatch: clear the runtime registry + subscriptions. */
export async function _resetAgentIpcForTests(options?: { preservePendingReloadStates?: boolean }): Promise<void> {
    for (const record of subscriptions.values()) {
        try {
            record.unsubscribe();
        } catch {
            // ignore
        }
    }
    subscriptions.clear();
    subscriptionGenerations.clear();
    subscriptionsBySender.clear();
    pendingSubscriptions.clear();
    if (runtimeSweepTimer) {
        clearInterval(runtimeSweepTimer);
        runtimeSweepTimer = undefined;
    }
    await runtimeRegistry.disposeAll();
    sessionOperations.clear();
    extensionCwdOperations.clear();
    extensionGlobalOperation = Promise.resolve();
    if (!options?.preservePendingReloadStates) {
        pendingReloadStates.clear();
    }
}
