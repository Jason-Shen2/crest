// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// agent-ipc.ts — Electron main IPC surface for the integrated agent
// runtime. Holds the process-level AgentRuntimeRegistry, registers ipcMain
// handlers, and fans each runtime's event stream out to per-sender
// subscribers via a single "agent:event"
// channel. The owner — not this layer — holds the authoritative
// conversation state and decides send routing; this layer is the thin
// IPC ↔ owner adapter. See packages/coding-agent/agent-session-runtime.ts.
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

import { _resetAgentObservabilityForTests, attachAgentObservability } from "./agent-observability-ipc";
import { makeAgentEventPayload, makeAgentSubscriptionKey } from "./agent-event-routing";
import { AgentPtyHost } from "./agent-tools/agent-pty-host";
import { parseAgentExecutionContext, type AgentExecutionContext } from "@crest/coding-agent/agent-execution-context";
import { MaxAgentPtyCols, MaxAgentPtyRows } from "@crest/coding-agent/agent-pty-host";
import {
    AgentRuntimeRegistry,
    AgentSessionMutationActiveError,
} from "@crest/coding-agent/agent-runtime-registry";
import {
    AgentSessionRuntime,
    buildContextStateFromSessionEntries,
    buildPersistedTurnsFromSessionEntries,
    type AgentExecutionConfig,
    type AgentSessionRuntimeStatus,
    type AgentTurn,
} from "@crest/coding-agent/agent-session-runtime";
import type { SystemPromptInputs } from "@crest/coding-agent/build-system-prompt";
import { extractChangeOperationsFromMessages, generateChangeOutline } from "@crest/coding-agent/change-review/change-outline";
import { getBuiltInAgentCommands } from "@crest/coding-agent/commands/registry";
import { commandNoop, commandSuccess } from "@crest/coding-agent/commands/session-command-results";
import {
    buildAgentForkPointViews,
    buildAgentReferencePointViews,
    buildAgentTreeEntryViews,
    filterTreeForDisplay,
    previewSessionEntry,
} from "@crest/coding-agent/commands/session-views";
import type {
    AgentBackendCommandName,
    AgentCommandExecutionResult,
    AgentCommandInfo,
    AgentContextStateView,
    AgentForkPointView,
    AgentPrepareContextDraftInput,
    AgentReferencePointView,
    AgentRunCommandInput,
    AgentTreeEntryView,
} from "@crest/coding-agent/commands/types";
import { ContextDraftRegistry } from "@crest/coding-agent/context/draft-registry";
import { decorateContextHistory } from "@crest/coding-agent/context/history";
import type { ContextProviderRequest } from "@crest/coding-agent/context/projector";
import { createContextProviderAdapter, type ContextProviderAdapter } from "@crest/coding-agent/context/provider-adapter";
import { captureContextArtifactDraft } from "@crest/coding-agent/context/snapshot";
import { summarizeContextDraft, type ContextSummaryCompletion } from "@crest/coding-agent/context/summary";
import { createContextTurnPreparation, type ContextTurnDraftAttachmentInput } from "@crest/coding-agent/context/turn-preparer";
import type { ContextBudgetResult, ContextReferenceConfig, ContextRepresentation } from "@crest/coding-agent/context/types";
import { ContextReferenceError } from "@crest/coding-agent/context/types";
import { buildAgentHarnessHost, type AgentHarnessHost } from "@crest/coding-agent/harness-factory";
import { convertToLlm } from "@crest/agent/harness/messages";
import { InMemorySessionRepo } from "@crest/agent/harness/session/memory-repo";
import type {
    AgentHarnessTurnPreparation,
    AgentHarnessTurnPreparationInput,
    JsonlSessionMetadata,
    SessionDetailInfo,
} from "@crest/agent/harness/types";
import { buildPermissionsHook, isBenchMode } from "@crest/coding-agent/permissions";
import { loadProjectContextFiles } from "@crest/coding-agent/resource-loader";
import {
    archivePaneSession,
    createPaneSession,
    defaultSessionsDir,
    forkPaneSession,
    importPaneSessionFromJsonl,
    listSessionDetailsForCwd,
    listSessionsForCwd,
    openPaneSession,
    openPaneSessionByPath,
    renamePaneSession,
    restoreMovedPaneSession,
    stageDeletePaneSession,
} from "@crest/coding-agent/sessions";
import { loadAgentSkills } from "@crest/coding-agent/skills-loader";
import { getDefaultTools } from "@crest/coding-agent/tools";
import { createSpawnCliAgentTool } from "./agent-tools/spawn-cli-agent";
import type { AgentMessage, ThinkingLevel } from "@crest/agent/types";
import type { Api, ImageContent, Message, Model } from "@crest/ai";
import { getModel } from "@crest/ai";
import { getSecret } from "./aiconfig/secrets";
import { readAIUserConfig } from "./aiconfig/user-config";

const AgentRuntimeIdleTtlMs = 5 * 60 * 1000;
const AgentRuntimeSweepIntervalMs = 60 * 1000;
const runtimeRegistry = new AgentRuntimeRegistry<AgentSessionRuntime>({
    idleTtlMs: AgentRuntimeIdleTtlMs,
});
let contextDraftRegistry = new ContextDraftRegistry();
let contextSummaryCompletion: ContextSummaryCompletion | undefined;
const runtimeWorkspaceBindings = new WeakMap<AgentSessionRuntime, string>();
let runtimeSweepTimer: NodeJS.Timeout | undefined;
let runtimeSweepPromise: Promise<void> | undefined;

type SubKey = string;
interface AgentSubscriptionRecord {
    unsubscribe: () => void;
    sessionPath: string;
    sender: electron.WebContents;
    rendererPath: string;
    authorization: AgentSubscriptionAuthorization;
    senderId: number;
    workspaceId: string;
    generation: number;
}

interface LiveAgentRuntimeLookup {
    path: string;
    runtime: AgentSessionRuntime;
}

interface AgentSubscriptionAuthorization extends WorkspaceAgentRequestContext {
    validateCurrent: () => Promise<void>;
    guardRuntime: (lookup: LiveAgentRuntimeLookup) => Promise<void>;
}

interface PendingAgentSubscription {
    sender: electron.WebContents;
    canonicalPath: string;
    rendererPath: string;
    authorization: AgentSubscriptionAuthorization;
}

interface SuspendedAgentSubscriptions {
    intents: Map<SubKey, PendingAgentSubscription>;
}

const subscriptions = new Map<SubKey, AgentSubscriptionRecord>();
const subscriptionsBySender = new Map<number, Set<SubKey>>();
const pendingSubscriptions = new Map<SubKey, PendingAgentSubscription>();
const sendIngressTails = new Map<string, Promise<void>>();

interface SendOptions {
    /** Existing session, if any. null on first send → main mints a fresh one. */
    sessionMetadata?: JsonlSessionMetadata | null;
    context: AgentExecutionContext;
    /** Prompt text. */
    text: string;
    /** User-attached images as renderer-safe data URLs. */
    images?: string[];
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
    /** Optional pane context. */
    gitBranch?: string;
    recentCmds?: string[];
    connection?: string;
    /**
     * Per-pane tool allowlist. Optional in v1 — when omitted, permissions
     * default to allowAll:true (no approval UI exists yet; the agent
     * stays functional). Bench mode (CREST_AGENT_BENCH=1) also forces
     * allowAll regardless of this value. See packages/coding-agent/permissions.ts.
     */
    allowedTools?: string[];
    contextAttachments?: ContextTurnDraftAttachmentInput[];
}

function reserveAgentSendIngress(opts: SendOptions): <T>(operation: () => Promise<T>) => Promise<T> {
    const sessionPath = opts.sessionMetadata?.path;
    const key =
        typeof sessionPath === "string" && sessionPath.trim() !== ""
            ? `session:${path.resolve(sessionPath)}`
            : `workspace:${opts.context.workspaceId}`;
    const previous = sendIngressTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
        release = resolve;
    });
    const tail = previous.catch(() => undefined).then(async () => await hold);
    sendIngressTails.set(key, tail);
    return async <T>(operation: () => Promise<T>): Promise<T> => {
        await previous.catch(() => undefined);
        try {
            return await operation();
        } finally {
            release();
            if (sendIngressTails.get(key) === tail) sendIngressTails.delete(key);
        }
    };
}

let contextProviderAdapterFactory:
    | ((
          model: Model<Api>,
          apiKey: string | undefined,
          thinkingLevel: ThinkingLevel | "off"
      ) => ContextProviderAdapter | undefined)
    | undefined = createContextProviderAdapter;

interface AgentHostedCommandInput {
    commandId: string;
}

interface AgentHostedCommandWriteInput extends AgentHostedCommandInput {
    input: string;
}

interface AgentHostedCommandResizeInput extends AgentHostedCommandInput {
    cols: number;
    rows: number;
}

interface AgentRenameSessionInput {
    sessionMetadata: JsonlSessionMetadata;
    name: string;
}

export interface WorkspaceAgentRequestContext {
    workspaceId: string;
    generation: number;
}

export interface ResolvedWorkspaceAgentSender extends WorkspaceAgentRequestContext {
    windowId: string;
    workspaceDir: string;
}

export interface AgentIpcRegistrationOptions {
    resolveWorkspaceSender: (senderId: number) => Promise<ResolvedWorkspaceAgentSender | undefined>;
    loadWorkspace: (workspaceId: string) => Promise<Workspace>;
    saveWorkspaceAgentState: (data: SaveWorkspaceAgentStateData) => Promise<WorkspaceAgentStateCheckpoint>;
}

type AuthenticatedWorkspaceAgentSender = Readonly<ResolvedWorkspaceAgentSender>;
type AuthorizationGuard = () => Promise<void>;
type LiveRuntimeGuard = (lookup: LiveAgentRuntimeLookup) => Promise<void>;
interface AgentSessionRemovalPersistence {
    workspaceId: string;
    loadWorkspace: AgentIpcRegistrationOptions["loadWorkspace"];
    saveWorkspaceAgentState: AgentIpcRegistrationOptions["saveWorkspaceAgentState"];
}

interface PersistedSessionTarget {
    id: string;
    createdAt: string;
    cwd: string;
    trustedPaths: Set<string>;
}

function lookupLiveAgentRuntime(...paths: Array<string | undefined>): LiveAgentRuntimeLookup | undefined {
    for (const runtimePath of paths) {
        if (!runtimePath) {
            continue;
        }
        const runtime = runtimeRegistry.get(runtimePath);
        if (runtime) {
            return { path: runtimePath, runtime };
        }
    }
    return undefined;
}

async function guardLiveRuntimeIfPresent(
    paths: Array<string | undefined>,
    guardRuntime?: LiveRuntimeGuard,
    beforeReturn?: AuthorizationGuard
): Promise<void> {
    await beforeReturn?.();
    const liveRuntime = lookupLiveAgentRuntime(...paths);
    if (liveRuntime) {
        await guardRuntime?.(liveRuntime);
    }
}

function requireCommandId(input: unknown): string {
    return requireNonEmptyString((input as AgentHostedCommandInput)?.commandId, "commandId");
}

async function requireLiveRuntimeForCommand(
    sessionPath: string,
    authorization: AgentSubscriptionAuthorization
): Promise<AgentSessionRuntime> {
    await authorization.validateCurrent();
    const liveRuntime = lookupLiveAgentRuntime(sessionPath);
    if (!liveRuntime) {
        throw new Error("agent IPC: hosted command session is not running");
    }
    await authorization.guardRuntime(liveRuntime);
    return liveRuntime.runtime;
}

export async function guardLiveAgentRuntimeAccess(options: {
    lookup: LiveAgentRuntimeLookup;
    workspaceId: string;
    beforeAccess: AuthorizationGuard;
    allowFirstBinding?: boolean;
}): Promise<void> {
    await options.beforeAccess();
    if (runtimeRegistry.get(options.lookup.path) !== options.lookup.runtime) {
        throw new Error("agent IPC: live runtime changed during request");
    }
    const boundWorkspaceId = runtimeWorkspaceBindings.get(options.lookup.runtime);
    if (!boundWorkspaceId && options.allowFirstBinding) {
        runtimeWorkspaceBindings.set(options.lookup.runtime, options.workspaceId);
        return;
    }
    if (boundWorkspaceId !== options.workspaceId) {
        throw new Error("agent IPC: live runtime belongs to another Workspace");
    }
}

function imageContentFromDataUrl(src: string): ImageContent | undefined {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(src);
    if (!match) return undefined;
    return {
        type: "image",
        mimeType: match[1],
        data: match[2],
    };
}

function imageContentsFromRenderer(images: string[] | undefined): ImageContent[] | undefined {
    const result = (images ?? []).map(imageContentFromDataUrl).filter((item): item is ImageContent => item != null);
    return result.length > 0 ? result : undefined;
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
    "info",
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

function requireSessionName(value: unknown): string {
    const name = requireNonEmptyString(value, "name").trim();
    if (name.length > 120) {
        throw new Error("agent IPC: name is too long");
    }
    return name;
}

function validateRequestContext(value: unknown): WorkspaceAgentRequestContext {
    if (!isRecord(value)) {
        throw new Error("agent IPC: request context must be an object");
    }
    const keys = Reflect.ownKeys(value);
    if (
        keys.length !== 2 ||
        !Object.hasOwn(value, "workspaceId") ||
        !Object.hasOwn(value, "generation") ||
        typeof value.workspaceId !== "string" ||
        !value.workspaceId.trim() ||
        typeof value.generation !== "number" ||
        !Number.isInteger(value.generation) ||
        value.generation <= 0
    ) {
        throw new Error("agent IPC: invalid Workspace request context");
    }
    return { workspaceId: value.workspaceId, generation: value.generation };
}

async function authenticateWorkspaceSender(
    options: AgentIpcRegistrationOptions,
    senderId: number,
    requestContext: unknown
): Promise<AuthenticatedWorkspaceAgentSender> {
    const requested = validateRequestContext(requestContext);
    const resolved = await options.resolveWorkspaceSender(senderId);
    if (resolved) {
        releaseStaleSubscriptionsForSender(senderId, resolved);
    } else {
        releaseAllForSender(senderId);
    }
    if (!resolved || resolved.workspaceId !== requested.workspaceId || resolved.generation !== requested.generation) {
        throw new Error("agent IPC: sender is not the current Workspace renderer");
    }
    return Object.freeze(resolved);
}

async function assertWorkspaceSenderCurrent(
    options: AgentIpcRegistrationOptions,
    senderId: number,
    authenticated: AuthenticatedWorkspaceAgentSender
): Promise<void> {
    const current = await options.resolveWorkspaceSender(senderId);
    if (
        !current ||
        current.windowId !== authenticated.windowId ||
        current.workspaceId !== authenticated.workspaceId ||
        current.generation !== authenticated.generation ||
        current.workspaceDir !== authenticated.workspaceDir
    ) {
        throw new Error("agent IPC: Workspace sender changed during request");
    }
}

async function requireSessionBelongsToWorkspace(
    authenticated: AuthenticatedWorkspaceAgentSender,
    sessionMetadata: unknown
): Promise<JsonlSessionMetadata> {
    const input = validateSessionMetadataShape(sessionMetadata);
    return await withCanonicalSessionAccess(
        input.path,
        async (canonicalPath) => {
            const { metadata, session } = await openValidatedSessionMetadata({ ...input, path: canonicalPath });
            try {
                let sessionCwd: string;
                try {
                    sessionCwd = await fs.realpath(metadata.cwd);
                } catch {
                    throw new Error("agent IPC: session cwd is not an existing directory");
                }
                if (sessionCwd !== authenticated.workspaceDir) {
                    throw new Error("agent IPC: session does not belong to this Workspace");
                }
                return metadata;
            } finally {
                session.close();
            }
        },
        "sessionMetadata.path"
    );
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

async function withCanonicalSessionAccess<T>(
    sessionPath: unknown,
    fn: (canonicalPath: string) => Promise<T> | T,
    fieldName = "sessionPath"
): Promise<T> {
    const canonicalPath = await validateSessionPath(sessionPath, fieldName);
    return await runtimeRegistry.withSessionAccess(canonicalPath, () => fn(canonicalPath));
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
    try {
        const metadata = await session.getMetadata();
        return { metadata, session, requestedPath: input.path };
    } catch (error) {
        session.close();
        throw error;
    }
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
    try {
        const targetId = requireNonEmptyString(value.targetId, "targetId");
        await requireSessionEntry(session, targetId, "targetId");
        return { metadata, session, targetId, requestedPath };
    } catch (error) {
        session.close();
        throw error;
    }
}

async function validateForkInput(value: unknown): Promise<{
    metadata: JsonlSessionMetadata;
    session: Awaited<ReturnType<typeof openPaneSessionByPath>>;
    cwd: string;
    entryId: string;
    requestedPath: string;
}> {
    if (!isRecord(value)) throw new Error("agent IPC: forkSession input must be an object");
    const { metadata, session, requestedPath } = await openValidatedSessionMetadata(value.sessionMetadata);
    try {
        const cwd = requireNonEmptyString(value.cwd, "cwd");
        const entryId = requireNonEmptyString(value.entryId, "entryId");
        await requireSessionEntry(session, entryId, "entryId");
        return { metadata, session, cwd, entryId, requestedPath };
    } catch (error) {
        session.close();
        throw error;
    }
}

async function validateCloneInput(value: unknown): Promise<{
    metadata: JsonlSessionMetadata;
    session: Awaited<ReturnType<typeof openPaneSessionByPath>>;
    cwd: string;
    requestedPath: string;
}> {
    if (!isRecord(value)) throw new Error("agent IPC: cloneSession input must be an object");
    const { metadata, session, requestedPath } = await openValidatedSessionMetadata(value.sessionMetadata);
    try {
        const cwd = requireNonEmptyString(value.cwd, "cwd");
        return { metadata, session, cwd, requestedPath };
    } catch (error) {
        session.close();
        throw error;
    }
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
        cwd: opts.context.workspaceDir,
        gitBranch: opts.context.gitBranch,
    };
}

async function ensureSession(opts: SendOptions): Promise<{
    metadata: JsonlSessionMetadata;
    isNew: boolean;
}> {
    if (opts.sessionMetadata) {
        const input = validateSessionMetadataShape(opts.sessionMetadata);
        return await withCanonicalSessionAccess(
            input.path,
            async (canonicalPath) => {
                const { metadata, session } = await openValidatedSessionMetadata({ ...input, path: canonicalPath });
                try {
                    return { metadata, isNew: false };
                } finally {
                    session.close();
                }
            },
            "sessionMetadata.path"
        );
    }
    const created = await createPaneSession(opts.context.workspaceDir);
    try {
        const createdMetadata = await created.session.getMetadata();
        return await withCanonicalSessionAccess(
            createdMetadata.path,
            async (canonicalPath) => {
                const { metadata, session } = await openValidatedSessionMetadata({
                    ...createdMetadata,
                    path: canonicalPath,
                });
                try {
                    return { metadata, isNew: true };
                } finally {
                    session.close();
                }
            },
            "sessionMetadata.path"
        );
    } finally {
        created.session.close();
    }
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
    config: AgentExecutionConfig,
    options: { attachObservability?: boolean } = {}
): Promise<AgentSessionRuntime> {
    const piSession = await openPaneSession(metadata);
    try {
        return await createAgentRuntimeFromSession(metadata, opts, config, piSession, options);
    } catch (error) {
        piSession.close();
        throw error;
    }
}

async function createAgentRuntimeFromSession(
    metadata: JsonlSessionMetadata,
    opts: SendOptions,
    config: AgentExecutionConfig,
    piSession: Awaited<ReturnType<typeof openPaneSession>>,
    options: { attachObservability?: boolean } = {}
): Promise<AgentSessionRuntime> {
    // Discover skills from <configHome>/skills and <cwd>/.crest/skills.
    // Loaded once per harness construction (session open); the skills
    // section is only injected into the system prompt when the read
    // tool is active (build-system-prompt.ts).
    const skills = await loadAgentSkills({ cwd: opts.context.workspaceDir });
    let getRuntimeCwd = () => config.promptInputs.cwd;
    let owner: AgentSessionRuntime | undefined;
    let host: AgentHarnessHost;
    const runtimeForTools = {
        startHostedCommand: (...args: Parameters<AgentSessionRuntime["startHostedCommand"]>) => {
            if (!owner) throw new Error("agent runtime is not ready");
            return owner.startHostedCommand(...args);
        },
    } as AgentSessionRuntime;
    host = buildAgentHarnessHost({
        session: piSession,
        model: config.model,
        thinkingLevel: config.thinkingLevel,
        promptInputs: config.promptInputs,
        tools: [
            ...getDefaultTools(() => getRuntimeCwd()),
            createSpawnCliAgentTool({
                runtime: runtimeForTools,
                getModel: () => host.harness.getModel(),
                createSession: async () => new InMemorySessionRepo().create({}),
                getApiKeyAndHeaders: config.authResolver,
                getExecutionContext: (cwd) => ({ ...opts.context, workspaceDir: cwd }),
            }),
        ],
        // Load AGENTS.md / CLAUDE.md from cwd up to the filesystem root so
        // project-specific instructions reach the system prompt. Loaded once
        // per harness construction (session open); cheap sync reads.
        contextFiles: loadProjectContextFiles({ cwd: opts.context.workspaceDir }),
        skills,
        getApiKeyAndHeaders: config.authResolver,
        toolCallHook: config.toolCallHook,
        transformSessionContext: async ({ entries, context }) =>
            await decorateContextHistory({
                entries,
                context,
                targetSessionPath: metadata.path,
            }),
    });
    getRuntimeCwd = () => host.getCwd();
    // Wrap the harness in the per-session owner. Its constructor attaches
    // the harness subscription NOW (before any prompt() runs), so it owns
    // the authoritative transcript + queue state from the first event on —
    // never missing a turn that finishes before a renderer subscribes.
    // Seed it with the persisted transcript so a reopened session shows its
    // history (a fresh session's buildContext is empty).
    const seed = await piSession.buildContext();
    const initialEntries = await piSession.getBranch();
    const initialTurns = buildPersistedTurnsFromSessionEntries(initialEntries);
    const onTurnFinished = async (turn: AgentTurn): Promise<void> => {
        const operations = extractChangeOperationsFromMessages(turn.responseMessages.filter(isToolResultModelMessage), {
            turnId: turn.turnId,
        });
        if (operations.length === 0) return;
        const model = host.harness.getModel();
        const auth = await host.resolveAuth(model);
        const changeOutline = await generateChangeOutline({
            model,
            operations,
            turnId: turn.turnId,
            apiKey: auth?.apiKey,
        });
        if (changeOutline) {
            owner.setTurnChangeOutline(turn.turnId, changeOutline);
        }
    };
    owner = new AgentSessionRuntime(metadata.path, host, seed.messages ?? [], initialTurns, {
        onTurnFinished,
        initialContextEntries: initialEntries,
        ptyHost: new AgentPtyHost(),
    });
    if (typeof host.harness.inspectCurrentContext === "function") {
        void owner.refreshContextSnapshot("initial context");
    }
    if (options.attachObservability !== false) {
        attachAgentObservability(metadata.path, host.harness);
    }
    return owner;
}

async function ensureAgentRuntime(
    metadata: JsonlSessionMetadata,
    opts: SendOptions,
    workspaceId?: string
): Promise<{ runtime: AgentSessionRuntime; config: AgentExecutionConfig }> {
    const resolved = await resolveAgentExecution(opts);
    const runtime = await runtimeRegistry.getOrCreate(metadata.path, async () => {
        const created = await createAgentRuntime(metadata, opts, resolved.config);
        if (workspaceId) {
            runtimeWorkspaceBindings.set(created, workspaceId);
        }
        return created;
    });
    const boundWorkspaceId = runtimeWorkspaceBindings.get(runtime);
    if (workspaceId && boundWorkspaceId && boundWorkspaceId !== workspaceId) {
        throw new Error("agent IPC: live runtime belongs to another Workspace");
    }
    if (workspaceId && !boundWorkspaceId) {
        runtimeWorkspaceBindings.set(runtime, workspaceId);
    }
    return { runtime, config: resolved.config };
}

async function resolveAgentExecution(opts: SendOptions): Promise<{ config: AgentExecutionConfig; apiKey?: string }> {
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
    return { config, ...(apiKey == null ? {} : { apiKey }) };
}

function releaseSubscription(key: SubKey): void {
    const record = subscriptions.get(key);
    const pending = pendingSubscriptions.get(key);
    const senderId = record?.senderId ?? pending?.sender.id;
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
    if (senderId != null) {
        const keys = subscriptionsBySender.get(senderId);
        keys?.delete(key);
        if (keys?.size === 0) {
            subscriptionsBySender.delete(senderId);
        }
    }
}

function releaseAllForSender(senderId: number): void {
    const keys = subscriptionsBySender.get(senderId);
    if (keys) {
        for (const key of keys) releaseSubscription(key);
        subscriptionsBySender.delete(senderId);
    }
    for (const [key, pending] of pendingSubscriptions) {
        if (pending.sender.id === senderId) releaseSubscription(key);
    }
}

function suspendSubscriptionsForPath(
    sessionPath: string,
    suspended: SuspendedAgentSubscriptions = { intents: new Map() }
): SuspendedAgentSubscriptions {
    const { intents } = suspended;
    for (const [key, record] of [...subscriptions]) {
        if (record.sessionPath !== sessionPath) continue;
        const intent = {
            sender: record.sender,
            canonicalPath: record.sessionPath,
            rendererPath: record.rendererPath,
            authorization: record.authorization,
        };
        try {
            record.unsubscribe();
        } catch (err) {
            console.error("[agent-ipc] unsubscribe error:", err);
        }
        runtimeRegistry.release(record.sessionPath, key);
        subscriptions.delete(key);
        pendingSubscriptions.set(key, intent);
        intents.set(key, intent);
    }
    for (const [key, pending] of [...pendingSubscriptions]) {
        if (pending.canonicalPath !== sessionPath) continue;
        intents.set(key, pending);
    }
    return suspended;
}

function commitSuspendedSubscriptions(suspended: SuspendedAgentSubscriptions): void {
    for (const key of suspended.intents.keys()) {
        releaseSubscription(key);
    }
}

async function restoreSuspendedSubscriptions(suspended: SuspendedAgentSubscriptions): Promise<void> {
    for (const [key, intent] of suspended.intents) {
        if (intent.sender.isDestroyed()) {
            releaseSubscription(key);
            continue;
        }
        try {
            await intent.authorization.validateCurrent();
        } catch {
            releaseSubscription(key);
            continue;
        }
        pendingSubscriptions.set(key, intent);
        trackSenderKey(intent.sender, key);
        const liveRuntime = lookupLiveAgentRuntime(intent.canonicalPath);
        if (liveRuntime) {
            try {
                await subscribeToOwner(
                    intent.sender,
                    intent.canonicalPath,
                    liveRuntime.runtime,
                    intent.rendererPath,
                    intent.authorization
                );
            } catch {
                releaseSubscription(key);
            }
        }
    }
}

function releaseSubscriptionsForSenderPath(senderId: number, sessionPath: string): void {
    for (const [key, record] of [...subscriptions]) {
        if (record.senderId === senderId && record.sessionPath === sessionPath) {
            releaseSubscription(key);
        }
    }
    for (const [key, pending] of [...pendingSubscriptions]) {
        if (pending.sender.id === senderId && pending.canonicalPath === sessionPath) {
            releaseSubscription(key);
        }
    }
}

function releaseStaleSubscriptionsForSender(senderId: number, identity: WorkspaceAgentRequestContext): void {
    const keys = subscriptionsBySender.get(senderId);
    if (keys) {
        for (const key of [...keys]) {
            const record = subscriptions.get(key);
            if (record && (record.workspaceId !== identity.workspaceId || record.generation !== identity.generation)) {
                releaseSubscription(key);
                keys.delete(key);
            }
        }
        if (keys.size === 0) {
            subscriptionsBySender.delete(senderId);
        }
    }
    for (const [key, pending] of pendingSubscriptions) {
        if (
            pending.sender.id === senderId &&
            (pending.authorization.workspaceId !== identity.workspaceId ||
                pending.authorization.generation !== identity.generation)
        ) {
            releaseSubscription(key);
        }
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

function makeFallbackSubscriptionAuthorization(beforeMutation?: AuthorizationGuard): AgentSubscriptionAuthorization {
    const fallbackWorkspaceId = "workspace-test";
    return {
        workspaceId: fallbackWorkspaceId,
        generation: 1,
        validateCurrent: async () => {
            await beforeMutation?.();
        },
        guardRuntime: async (lookup) => {
            await guardLiveAgentRuntimeAccess({
                lookup,
                workspaceId: fallbackWorkspaceId,
                beforeAccess: async () => {
                    await beforeMutation?.();
                },
                allowFirstBinding: true,
            });
        },
    };
}

async function sendPersistedSessionState(
    sender: electron.WebContents,
    sessionPath: string,
    rendererSessionPath: string,
    authorization: AgentSubscriptionAuthorization,
    key: SubKey
): Promise<void> {
    let canonicalPath = sessionPath;
    try {
        canonicalPath = await validateSessionPath(sessionPath);
        const session = await openPaneSessionByPath(canonicalPath);
        try {
            const context = await session.buildContext();
            const branch = await session.getBranch();
            const contextState = buildContextStateFromSessionEntries(branch);
            const liveRuntime = lookupLiveAgentRuntime(canonicalPath);
            if (liveRuntime) {
                await authorization.guardRuntime(liveRuntime);
            } else {
                await authorization.validateCurrent();
            }
            if (sender.isDestroyed()) return;
            sender.send(
                "agent:event",
                makeAgentEventPayload(canonicalPath, rendererSessionPath, authorization, {
                    type: "session_state",
                    messages: context.messages,
                    turns: buildPersistedTurnsFromSessionEntries(branch),
                    status: "idle",
                    steer: [],
                    followUp: [],
                    commands: [],
                    ...contextState,
                })
            );
        } finally {
            session.close();
        }
    } catch (err) {
        releaseSubscription(key);
        console.error(`[agent-ipc] persisted session_state error for ${canonicalPath}:`, err);
    }
}

async function buildPersistedSessionState(
    sessionPath: string,
    guardRuntime?: LiveRuntimeGuard,
    beforeReturn?: AuthorizationGuard
): Promise<{
    type: "session_state";
    messages: AgentMessage[];
    turns: AgentTurn[];
    status: AgentSessionRuntimeStatus;
    steer: AgentMessage[];
    followUp: AgentMessage[];
    contextReports: ReturnType<typeof buildContextStateFromSessionEntries>["contextReports"];
    commands: ReturnType<AgentSessionRuntime["getSessionState"]>["commands"];
}> {
    const canonicalPath = await validateSessionPath(sessionPath);
    const liveRuntime = lookupLiveAgentRuntime(canonicalPath);
    if (liveRuntime) {
        await guardRuntime?.(liveRuntime);
        const state = liveRuntime.runtime.getSessionState();
        return {
            type: "session_state",
            messages: state.messages,
            turns: state.turns,
            status: state.status,
            steer: state.steerQueue,
            followUp: state.followUpQueue,
            contextReports: state.contextReports,
            commands: state.commands,
        };
    }
    const session = await openPaneSessionByPath(canonicalPath);
    try {
        const context = await session.buildContext();
        const branch = await session.getBranch();
        await guardLiveRuntimeIfPresent([canonicalPath], guardRuntime, beforeReturn);
        return {
            type: "session_state",
            messages: context.messages,
            turns: buildPersistedTurnsFromSessionEntries(branch),
            status: "idle",
            steer: [],
            followUp: [],
            commands: [],
            ...buildContextStateFromSessionEntries(branch),
        };
    } finally {
        session.close();
    }
}

async function subscribeToOwner(
    sender: electron.WebContents,
    sessionPath: string,
    session: AgentSessionRuntime,
    rendererSessionPath: string,
    authorization: AgentSubscriptionAuthorization
): Promise<void> {
    const key: SubKey = makeAgentSubscriptionKey(sender.id, sessionPath, rendererSessionPath, authorization);
    pendingSubscriptions.delete(key);
    if (sender.isDestroyed()) return;
    if (subscriptions.has(key)) return;
    const lookup = { path: sessionPath, runtime: session };
    await authorization.guardRuntime(lookup);
    const unsub = session.subscribe((agentEvent) => {
        void runtimeRegistry
            .withSessionAccess(sessionPath, async () => {
                await authorization.guardRuntime(lookup);
                if (sender.isDestroyed()) {
                    releaseSubscription(key);
                    return;
                }
                sender.send(
                    "agent:event",
                    makeAgentEventPayload(sessionPath, rendererSessionPath, authorization, {
                        ...agentEvent,
                        turns: session.getSessionState().turns,
                    })
                );
            })
            .catch((error) => {
                if (error instanceof AgentSessionMutationActiveError) return;
                releaseSubscription(key);
            });
    });
    subscriptions.set(key, {
        unsubscribe: unsub,
        sessionPath,
        sender,
        rendererPath: rendererSessionPath,
        authorization,
        senderId: sender.id,
        workspaceId: authorization.workspaceId,
        generation: authorization.generation,
    });
    runtimeRegistry.acquire(sessionPath, key);
    trackSenderKey(sender, key);
    try {
        await authorization.guardRuntime(lookup);
        const sessionState = session.getSessionState();
        if (sender.isDestroyed()) {
            releaseSubscription(key);
            return;
        }
        sender.send(
            "agent:event",
            makeAgentEventPayload(sessionPath, rendererSessionPath, authorization, {
                type: "session_state",
                messages: sessionState.messages,
                turns: sessionState.turns,
                status: sessionState.status,
                steer: sessionState.steerQueue,
                followUp: sessionState.followUpQueue,
                contextReports: sessionState.contextReports,
                commands: sessionState.commands,
            })
        );
    } catch (error) {
        releaseSubscription(key);
        throw error;
    }
}

async function attachPendingSubscribers(sessionPath: string, session: AgentSessionRuntime): Promise<void> {
    for (const [key, pending] of [...pendingSubscriptions]) {
        if (pending.canonicalPath !== sessionPath) continue;
        if (pending.sender.isDestroyed()) {
            pendingSubscriptions.delete(key);
            continue;
        }
        try {
            await pending.authorization.guardRuntime({ path: sessionPath, runtime: session });
            await subscribeToOwner(
                pending.sender,
                pending.canonicalPath,
                session,
                pending.rendererPath,
                pending.authorization
            );
        } catch {
            releaseSubscription(key);
        }
    }
}

async function getSessionTreeData(
    sessionMetadataInput: unknown,
    guardRuntime?: LiveRuntimeGuard,
    beforeReturn?: AuthorizationGuard
): Promise<{
    entries: Awaited<ReturnType<AgentSessionRuntime["listTreeEntries"]>>["entries"];
    leafId: string | null;
    labels: Map<string, string | undefined>;
}> {
    const { metadata: sessionMetadata, session, requestedPath } = await validateTreeInput(sessionMetadataInput);
    try {
        const liveRuntime = lookupLiveAgentRuntime(sessionMetadata.path, requestedPath);
        if (liveRuntime) {
            await guardRuntime?.(liveRuntime);
            const treeData = await liveRuntime.runtime.listTreeEntries();
            await guardRuntime?.(liveRuntime);
            return treeData;
        }

        const allEntries = await session.getEntries();
        const rawLeafId = await session.getLeafId();
        const { entries, effectiveLeafId } = filterTreeForDisplay(allEntries, rawLeafId);
        const labels = new Map<string, string | undefined>();
        for (const entry of entries) {
            labels.set(entry.id, await session.getLabel(entry.id));
        }
        await guardLiveRuntimeIfPresent([sessionMetadata.path, requestedPath], guardRuntime, beforeReturn);
        return { entries, leafId: effectiveLeafId, labels };
    } finally {
        session.close();
    }
}

export function listAgentCommandsForIpc(): AgentCommandInfo[] {
    return getBuiltInAgentCommands();
}

export async function listAgentTreeForIpc(
    sessionMetadata: unknown,
    guardRuntime?: LiveRuntimeGuard,
    beforeReturn?: AuthorizationGuard
): Promise<AgentTreeResult> {
    const input = validateSessionMetadataShape(sessionMetadata);
    return await withCanonicalSessionAccess(
        input.path,
        async (canonicalPath) => {
            const { entries, leafId, labels } = await getSessionTreeData(
                { ...input, path: canonicalPath },
                guardRuntime,
                beforeReturn
            );
            return { entries: buildAgentTreeEntryViews(entries, leafId, labels), leafId };
        },
        "sessionMetadata.path"
    );
}

export async function listAgentForkPointsForIpc(
    sessionMetadata: unknown,
    guardRuntime?: LiveRuntimeGuard,
    beforeReturn?: AuthorizationGuard
): Promise<AgentForkPointView[]> {
    const input = validateSessionMetadataShape(sessionMetadata);
    return await withCanonicalSessionAccess(
        input.path,
        async (canonicalPath) => {
            const { entries } = await getSessionTreeData({ ...input, path: canonicalPath }, guardRuntime, beforeReturn);
            return buildAgentForkPointViews(entries);
        },
        "sessionMetadata.path"
    );
}

async function readContextReferenceConfig(): Promise<ContextReferenceConfig> {
    const result = await readAIUserConfig();
    if (result.status !== "ok" || !result.config) {
        throw new ContextReferenceError("disabled", "Context references require a valid AI configuration");
    }
    const configured = result.config.context_references;
    return {
        enabled: configured?.enabled ?? true,
        ...(configured?.max_tokens == null
            ? {}
            : { maxTokens: Math.max(0, Math.min(128_000, Math.trunc(configured.max_tokens))) }),
    };
}

async function requireContextReferencesEnabled(): Promise<ContextReferenceConfig> {
    const config = await readContextReferenceConfig();
    if (!config.enabled) {
        throw new ContextReferenceError("disabled", "Context references are disabled");
    }
    return config;
}

async function openCanonicalContextSession(value: unknown, fieldName: string) {
    const requestedPath = requireNonEmptyString(value, fieldName);
    let canonicalPath: string;
    try {
        canonicalPath = await validateSessionPath(requestedPath, fieldName);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ContextReferenceError(
            message.includes("outside sessions directory") ? "invalid_input" : "source_not_found",
            `${fieldName} does not identify a managed session`,
            error instanceof Error ? error : undefined
        );
    }
    if (path.resolve(requestedPath) !== canonicalPath) {
        throw new ContextReferenceError("invalid_input", `${fieldName} must be a canonical session path`);
    }
    const session = await openPaneSessionByPath(canonicalPath);
    return { canonicalPath, session, metadata: await session.getMetadata() };
}

function requireContextObject(input: unknown, operation: string): Record<string, unknown> {
    if (!isRecord(input)) {
        throw new ContextReferenceError("invalid_input", `${operation} input must be an object`);
    }
    return input;
}

export async function listAgentReferencePointsForIpc(input: unknown): Promise<AgentReferencePointView[]> {
    const value = requireContextObject(input, "listReferencePoints");
    const { session } = await openCanonicalContextSession(value.sourceSessionPath, "sourceSessionPath");
    try {
        return buildAgentReferencePointViews(await session.getBranch());
    } finally {
        session.close();
    }
}

export async function prepareContextDraftForIpc(input: unknown) {
    await requireContextReferencesEnabled();
    const value = requireContextObject(input, "prepareContextDraft");
    for (const forbidden of ["artifact", "messages", "summary", "snapshot"]) {
        if (Object.hasOwn(value, forbidden)) {
            throw new ContextReferenceError(
                "invalid_input",
                "Renderer-provided context artifact content is not accepted"
            );
        }
    }
    const target = await openCanonicalContextSession(value.targetSessionPath, "targetSessionPath");
    try {
        const source = await openCanonicalContextSession(value.sourceSessionPath, "sourceSessionPath");
        try {
            if (value.sourceKind !== "turn" && value.sourceKind !== "session") {
                throw new ContextReferenceError("invalid_input", "sourceKind must be turn or session");
            }
            const sourceTurnId =
                value.sourceTurnId == null ? undefined : requireNonEmptyString(value.sourceTurnId, "sourceTurnId");
            if (value.sourceKind === "turn" && sourceTurnId == null) {
                throw new ContextReferenceError("invalid_input", "sourceTurnId is required for turn context");
            }
            if (value.sourceKind === "session" && sourceTurnId != null) {
                throw new ContextReferenceError("invalid_input", "sourceTurnId is not valid for session context");
            }
            const sourceEntries = await source.session.getBranch();
            const sourceTitle = (await source.session.getSessionName()) || path.basename(source.metadata.cwd) || undefined;
            const draft = captureContextArtifactDraft({
                sourceMetadata: source.metadata,
                sourceEntries,
                sourceLeafId: sourceEntries.at(-1)?.id ?? null,
                sourceKind: value.sourceKind as AgentPrepareContextDraftInput["sourceKind"],
                ...(sourceTitle == null ? {} : { sourceTitle }),
                ...(sourceTurnId == null ? {} : { sourceTurnId }),
            });
            return contextDraftRegistry.create(target.canonicalPath, draft);
        } finally {
            source.session.close();
        }
    } finally {
        target.session.close();
    }
}

export async function listContextStateForIpc(input: unknown): Promise<AgentContextStateView> {
    const value = requireContextObject(input, "listContextState");
    const target = await openCanonicalContextSession(value.targetSessionPath, "targetSessionPath");
    try {
        const state = buildContextStateFromSessionEntries(await target.session.getBranch());
        return {
            drafts: contextDraftRegistry.list(target.canonicalPath),
            contextReports: state.contextReports,
        };
    } finally {
        target.session.close();
    }
}

export async function discardContextDraftForIpc(input: unknown): Promise<{ discarded: boolean }> {
    const value = requireContextObject(input, "discardContextDraft");
    const target = await openCanonicalContextSession(value.targetSessionPath, "targetSessionPath");
    try {
        const draftId = requireNonEmptyString(value.draftId, "draftId");
        const existing = contextDraftRegistry.peek(target.canonicalPath, draftId);
        if (!existing) {
            if (contextDraftRegistry.findTarget(draftId) != null) {
                throw new ContextReferenceError("invalid_input", "Context draft belongs to another target session");
            }
            return { discarded: false };
        }
        return { discarded: contextDraftRegistry.discard(target.canonicalPath, draftId) };
    } finally {
        target.session.close();
    }
}

async function resolveContextSummaryConfig() {
    const result = await readAIUserConfig();
    if (result.status !== "ok" || !result.config) {
        throw new ContextReferenceError("disabled", "Context summaries require a valid AI configuration");
    }
    const provider = result.config.default.provider;
    const modelId = result.config.default.model;
    const credentials = result.config.providers[provider];
    const apiKey =
        credentials?.token?.trim() ||
        (credentials?.tokensecretname ? await getSecret(credentials.tokensecretname) : undefined);
    return {
        model: resolveModelOrThrow(provider, modelId),
        modelKey: `${provider}/${modelId}`,
        ...(apiKey ? { apiKey } : {}),
        ...(contextSummaryCompletion ? { complete: contextSummaryCompletion } : {}),
    };
}

export async function summarizeContextDraftForIpc(input: unknown) {
    await requireContextReferencesEnabled();
    const value = requireContextObject(input, "summarizeContextDraft");
    const target = await openCanonicalContextSession(value.targetSessionPath, "targetSessionPath");
    try {
        const draftId = requireNonEmptyString(value.draftId, "draftId");
        const result = await summarizeContextDraft({
            registry: contextDraftRegistry,
            targetSessionPath: target.canonicalPath,
            draftId,
            ...(await resolveContextSummaryConfig()),
        });
        if (!result.ok) throw result.error;
        return contextDraftRegistry.peek(target.canonicalPath, draftId);
    } finally {
        target.session.close();
    }
}

function requireRepresentation(value: unknown): ContextRepresentation {
    if (value !== "full" && value !== "summary") {
        throw new ContextReferenceError("invalid_input", "requestedRepresentation is invalid");
    }
    return value;
}

function parseContextAttachments(value: unknown): ContextTurnDraftAttachmentInput[] {
    if (value == null) return [];
    if (!Array.isArray(value)) {
        throw new ContextReferenceError("invalid_input", "contextAttachments must be an array");
    }
    return value.map((item) => {
        const input = requireContextObject(item, "contextAttachment");
        for (const forbidden of ["artifact", "body", "messages", "snapshot", "summary"]) {
            if (Object.hasOwn(input, forbidden)) {
                throw new ContextReferenceError(
                    "invalid_input",
                    "Renderer-provided context attachment content is not accepted"
                );
            }
        }
        const draftId = requireNonEmptyString(input.draftId, "draftId");
        if (input.deliveryScope !== "message" && input.deliveryScope !== "conversation") {
            throw new ContextReferenceError("invalid_input", "context attachment delivery scope is invalid");
        }
        return {
            draftId,
            deliveryScope: input.deliveryScope,
            requestedRepresentation: requireRepresentation(input.requestedRepresentation),
        };
    });
}

function makeContextTurnPrepareCallback(input: {
    targetSessionPath: string;
    session: Awaited<ReturnType<typeof openPaneSessionByPath>>;
    attachments: ContextTurnDraftAttachmentInput[];
    model: Model<Api>;
}) {
    let prepare: ReturnType<typeof createContextTurnPreparation> | undefined;
    let finalProviderRequestOptions:
        | Awaited<ReturnType<AgentHarnessTurnPreparationInput["transformProviderRequest"]>>
        | undefined;

    return async (turn: AgentHarnessTurnPreparationInput) => {
        if (!prepare) {
            finalProviderRequestOptions = await turn.transformProviderRequest();
            const providerRequest: ContextProviderRequest = {
                systemPrompt: turn.systemPrompt,
                tools: turn.activeTools,
                history: await convertToLlm(turn.messages),
                currentUserContent: null,
            };
            prepare = createContextTurnPreparation({
                session: input.session,
                draftRegistry: contextDraftRegistry,
                targetSessionPath: input.targetSessionPath,
                userMessage: turn.userMessage,
                contextMessages: turn.messages,
                attachments: input.attachments,
                provider: input.model.provider,
                modelKey: `${input.model.provider}/${input.model.id}`,
                contextWindow: input.model.contextWindow,
                effectiveOutputReserve: input.model.maxTokens,
                request: providerRequest,
                revisionData: {
                    model: input.model,
                    attachments: input.attachments,
                },
                signal: turn.signal,
            });
        }
        const result = await prepare();
        if ("error" in result) {
            result.error.budget = result.budget;
            throw result.error;
        }
        const transformedMessages = await turn.transformContextMessages(
            result.transformedContextMessages ?? turn.messages
        );
        return {
            userEntryId: result.userEntryId,
            systemPromptSuffix: result.systemPromptSuffix,
            projectionReport: result.projectionReport,
            finalProviderRequestOptions,
            transformedContextMessages: transformedMessages,
        };
    };
}

export async function getAgentSessionStateForIpc(
    sessionMetadata: unknown,
    guardRuntime?: LiveRuntimeGuard,
    beforeReturn?: AuthorizationGuard
): Promise<Awaited<ReturnType<typeof buildPersistedSessionState>>> {
    const input = validateSessionMetadataShape(sessionMetadata);
    return await withCanonicalSessionAccess(
        input.path,
        async (canonicalPath) => {
            const { metadata, session } = await openValidatedSessionMetadata({ ...input, path: canonicalPath });
            try {
                return await buildPersistedSessionState(metadata.path, guardRuntime, beforeReturn);
            } finally {
                session.close();
            }
        },
        "sessionMetadata.path"
    );
}

type ContextIpcEnvelope<T> =
    | { ok: true; value: T }
    | {
          ok: false;
          error:
              | {
                    kind: "context";
                    code: ContextReferenceError["code"];
                    message: string;
                    budget?: ContextBudgetResult;
                }
              | { kind: "generic"; message: string };
      };

async function contextIpcEnvelope<T>(operation: () => Promise<T>): Promise<ContextIpcEnvelope<T>> {
    try {
        return { ok: true, value: await operation() };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!(error instanceof ContextReferenceError)) {
            return { ok: false, error: { kind: "generic", message } };
        }
        const budget =
            error != null && typeof error === "object" && "budget" in error
                ? (error as { budget?: ContextBudgetResult }).budget
                : undefined;
        return {
            ok: false,
            error: { kind: "context", code: error.code, message, ...(budget == null ? {} : { budget }) },
        };
    }
}

export async function navigateAgentTreeForIpc(
    input: unknown,
    beforeMutation?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<AgentNavigateTreeResult> {
    if (!isRecord(input)) throw new Error("agent IPC: navigateTree input must be an object");
    const sessionMetadata = validateSessionMetadataShape(input.sessionMetadata);
    return await withCanonicalSessionAccess(
        sessionMetadata.path,
        (canonicalPath) =>
            navigateAgentTreeWithAccess(
                { ...input, sessionMetadata: { ...sessionMetadata, path: canonicalPath } },
                beforeMutation,
                guardRuntime
            ),
        "sessionMetadata.path"
    );
}

async function navigateAgentTreeWithAccess(
    input: unknown,
    beforeMutation?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<AgentNavigateTreeResult> {
    const opened = await validateNavigateInput(input);
    try {
        return await navigateAgentTreeWithOpenSession(opened, beforeMutation, guardRuntime);
    } finally {
        opened.session.close();
    }
}

async function navigateAgentTreeWithOpenSession(
    opened: Awaited<ReturnType<typeof validateNavigateInput>>,
    beforeMutation?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<AgentNavigateTreeResult> {
    const { metadata, session, targetId, requestedPath } = opened;
    const liveRuntime = lookupLiveAgentRuntime(metadata.path, requestedPath);

    if (liveRuntime) {
        await guardRuntime?.(liveRuntime);
        const result = await liveRuntime.runtime.navigateTree(targetId);
        await guardRuntime?.(liveRuntime);
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
        await guardLiveRuntimeIfPresent([metadata.path, requestedPath], guardRuntime, beforeMutation);
        await session.moveTo(newLeafId);
        await guardLiveRuntimeIfPresent([metadata.path, requestedPath], guardRuntime, beforeMutation);
    }
    const branchEntries = await session.getBranch();
    const context = await session.buildContext();
    const turns = buildPersistedTurnsFromSessionEntries(branchEntries);
    await guardLiveRuntimeIfPresent([metadata.path, requestedPath], guardRuntime, beforeMutation);

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
        errorMessage: undefined as string | undefined,
        ...buildContextStateFromSessionEntries(branchEntries),
    };
    for (const [, pending] of pendingSubscriptions) {
        if (pending.canonicalPath !== metadata.path) continue;
        const { sender } = pending;
        if (sender.isDestroyed()) continue;
        await pending.authorization.validateCurrent();
        sender.send(
            "agent:event",
            makeAgentEventPayload(metadata.path, pending.rendererPath, pending.authorization, sessionState)
        );
    }
    // Also send to the IPC caller if it's not already covered. The caller
    // doesn't wait for the IPC event — the navigate return carries
    // editorText, but the renderer relies on "agent:event" session_state to
    // repopulate turns. The subscription effect in use-pi-chat registers
    // before navigate fires, so the sender is already in pendingSubscriptions
    // above; nothing else to do here.
    return { sessionMetadata: metadata, editorText };
}

export async function forkAgentSessionForIpc(
    input: unknown,
    beforeMutation?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<AgentForkSessionResult> {
    if (!isRecord(input)) throw new Error("agent IPC: forkSession input must be an object");
    const sessionMetadata = validateSessionMetadataShape(input.sessionMetadata);
    return await withCanonicalSessionAccess(
        sessionMetadata.path,
        (canonicalPath) =>
            forkAgentSessionWithAccess(
                { ...input, sessionMetadata: { ...sessionMetadata, path: canonicalPath } },
                beforeMutation,
                guardRuntime
            ),
        "sessionMetadata.path"
    );
}

async function forkAgentSessionWithAccess(
    input: unknown,
    beforeMutation?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<AgentForkSessionResult> {
    const { metadata: sourceMetadata, session: source, cwd, entryId, requestedPath } = await validateForkInput(input);
    try {
        const target = await source.getEntry(entryId);
        await guardLiveRuntimeIfPresent([sourceMetadata.path, requestedPath], guardRuntime, beforeMutation);
        const forked = await forkPaneSession(sourceMetadata, {
            cwd,
            entryId,
        });
        forked.session.close();
        await guardLiveRuntimeIfPresent([sourceMetadata.path, requestedPath], guardRuntime, beforeMutation);
        return {
            sessionMetadata: forked.metadata,
            ...(target ? { selectedText: previewSessionEntry(target) } : {}),
        };
    } finally {
        source.close();
    }
}

export async function cloneAgentSessionForIpc(
    input: unknown,
    beforeMutation?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<AgentCloneSessionResult> {
    if (!isRecord(input)) throw new Error("agent IPC: cloneSession input must be an object");
    const sessionMetadata = validateSessionMetadataShape(input.sessionMetadata);
    return await withCanonicalSessionAccess(
        sessionMetadata.path,
        (canonicalPath) =>
            cloneAgentSessionWithAccess(
                { ...input, sessionMetadata: { ...sessionMetadata, path: canonicalPath } },
                beforeMutation,
                guardRuntime
            ),
        "sessionMetadata.path"
    );
}

async function cloneAgentSessionWithAccess(
    input: unknown,
    beforeMutation?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<AgentCloneSessionResult> {
    const { metadata: sourceMetadata, session: source, cwd, requestedPath } = await validateCloneInput(input);
    try {
        const leafId = await source.getLeafId();
        if (!leafId) {
            await guardLiveRuntimeIfPresent([sourceMetadata.path, requestedPath], guardRuntime, beforeMutation);
            return { message: "No session branch to clone yet." };
        }
        await requireSessionEntry(source, leafId, "targetId");
        await guardLiveRuntimeIfPresent([sourceMetadata.path, requestedPath], guardRuntime, beforeMutation);
        const forked = await forkPaneSession(sourceMetadata, { cwd, entryId: leafId, position: "at" });
        forked.session.close();
        await guardLiveRuntimeIfPresent([sourceMetadata.path, requestedPath], guardRuntime, beforeMutation);
        return { sessionMetadata: forked.metadata };
    } finally {
        source.close();
    }
}

export async function runAgentCommandForIpc(
    input: unknown,
    beforeMutation?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<AgentCommandExecutionResult> {
    const parsed = validateRunCommandInput(input);
    if (!parsed.sessionMetadata?.path) {
        return await runParsedAgentCommand(parsed, beforeMutation, guardRuntime);
    }
    return await withCanonicalSessionAccess(
        parsed.sessionMetadata.path,
        (canonicalPath) =>
            runParsedAgentCommand(
                {
                    ...parsed,
                    sessionMetadata: { ...parsed.sessionMetadata!, path: canonicalPath },
                },
                beforeMutation,
                guardRuntime
            ),
        "sessionMetadata.path"
    );
}

async function runParsedAgentCommand(
    parsed: AgentRunCommandInput,
    beforeMutation?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<AgentCommandExecutionResult> {
    switch (parsed.command) {
        case "new":
            return await runNewAgentSessionCommand(parsed.cwd);
        case "compact":
            return await runCompactSessionCommand(
                parsed.sessionMetadata,
                parsed.argsText,
                beforeMutation,
                guardRuntime
            );
        case "session":
        case "resume":
            return {
                status: "success",
                message: "Open session manager",
                managerMode: "session",
            };
        case "info":
            return await runSessionInfoCommand(parsed.sessionMetadata, beforeMutation, guardRuntime);
        case "copy":
            return await runCopyLastAssistantMessageCommand(parsed.sessionMetadata, beforeMutation, guardRuntime);
        case "export":
            return await runExportSessionCommand(
                parsed.sessionMetadata,
                parsed.cwd,
                parsed.argsText,
                beforeMutation,
                guardRuntime
            );
        case "import":
            await beforeMutation?.();
            return await runImportSessionCommand(parsed.cwd, parsed.argsText);
        case "reload":
            return commandSuccess("Reloaded keybindings, extensions, skills, prompts, themes");
        default:
            return commandNoop(`Agent command /${parsed.command} is not implemented yet.`);
    }
}

async function runNewAgentSessionCommand(_cwd: string): Promise<AgentCommandExecutionResult> {
    // Lazy creation: /new does NOT mint a session or touch disk. It only
    // signals the renderer to reset the pane to a "no session" state; the
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
    argsText: string,
    beforeMutation?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<AgentCommandExecutionResult> {
    if (!sessionMetadata?.path) return commandNoop("No active agent session to compact.");
    const { metadata, session, requestedPath } = await openValidatedSessionMetadata(sessionMetadata);
    try {
        const liveRuntime = lookupLiveAgentRuntime(metadata.path, requestedPath);
        if (!liveRuntime) return commandNoop("No active agent session to compact.");
        const customInstructions = argsText.trim() || undefined;
        await guardRuntime?.(liveRuntime);
        await liveRuntime.runtime.compact(customInstructions);
        await guardRuntime?.(liveRuntime);
        return commandSuccess("Compacted session context.");
    } finally {
        session.close();
    }
}

async function runSessionInfoCommand(
    sessionMetadata: JsonlSessionMetadata | undefined,
    beforeReturn?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<AgentCommandExecutionResult> {
    if (!sessionMetadata?.path) return commandNoop("No active agent session yet.");
    const opened = await openValidatedSessionMetadata(sessionMetadata);
    try {
        return await buildSessionInfoCommand(opened, beforeReturn, guardRuntime);
    } finally {
        opened.session.close();
    }
}

async function buildSessionInfoCommand(
    opened: Awaited<ReturnType<typeof openValidatedSessionMetadata>>,
    beforeReturn?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<AgentCommandExecutionResult> {
    const { metadata, session, requestedPath } = opened;
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
    await guardLiveRuntimeIfPresent([metadata.path, requestedPath], guardRuntime, beforeReturn);
    return commandSuccess(lines.join("\n"));
}

async function runCopyLastAssistantMessageCommand(
    sessionMetadata: JsonlSessionMetadata | undefined,
    beforeMutation?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<AgentCommandExecutionResult> {
    if (!sessionMetadata?.path) return commandNoop("No active agent session yet.");
    const { metadata, session, requestedPath } = await openValidatedSessionMetadata(sessionMetadata);
    try {
        const context = await session.buildContext();
        const text = [...(context.messages ?? [])]
            .reverse()
            .map(getAssistantText)
            .find((value) => value);
        if (!text) {
            await guardLiveRuntimeIfPresent([metadata.path, requestedPath], guardRuntime, beforeMutation);
            return commandNoop("No agent messages to copy yet.");
        }
        await guardLiveRuntimeIfPresent([metadata.path, requestedPath], guardRuntime, beforeMutation);
        electron.clipboard.writeText(text);
        return commandSuccess("Copied last agent message to clipboard");
    } finally {
        session.close();
    }
}

async function runExportSessionCommand(
    sessionMetadata: JsonlSessionMetadata | undefined,
    cwd: string,
    argsText: string,
    beforeMutation?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<AgentCommandExecutionResult> {
    if (!sessionMetadata?.path) return commandNoop("No active agent session yet.");
    const outputArg = getPathCommandArgument(argsText);
    const outputPath = resolvePathForCwd(
        outputArg ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
        cwd
    );
    const opened = await openValidatedSessionMetadata(sessionMetadata);
    try {
        return await exportOpenSession(opened, outputPath, beforeMutation, guardRuntime);
    } finally {
        opened.session.close();
    }
}

async function exportOpenSession(
    opened: Awaited<ReturnType<typeof openValidatedSessionMetadata>>,
    outputPath: string,
    beforeMutation?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<AgentCommandExecutionResult> {
    const { metadata, session, requestedPath } = opened;
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
    await guardLiveRuntimeIfPresent([metadata.path, requestedPath], guardRuntime, beforeMutation);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await guardLiveRuntimeIfPresent([metadata.path, requestedPath], guardRuntime, beforeMutation);
    await fs.writeFile(outputPath, `${lines.join("\n")}\n`);
    await guardLiveRuntimeIfPresent([metadata.path, requestedPath], guardRuntime, beforeMutation);
    return commandSuccess(`Session exported to: ${outputPath}`);
}

async function runImportSessionCommand(cwd: string, argsText: string): Promise<AgentCommandExecutionResult> {
    const inputArg = getPathCommandArgument(argsText);
    if (!inputArg) throw new Error("Usage: /import <path.jsonl>");
    const inputPath = resolvePathForCwd(inputArg, cwd);
    const imported = await importPaneSessionFromJsonl(inputPath, cwd);
    try {
        return {
            status: "success",
            message: `Session imported from: ${inputPath}`,
            sessionMetadata: imported.metadata,
        };
    } finally {
        imported.session.close();
    }
}

export async function abortAgentSessionForIpc(
    sessionPath: unknown,
    beforeMutation?: AuthorizationGuard,
    guardRuntime?: LiveRuntimeGuard
): Promise<void> {
    await withCanonicalSessionAccess(sessionPath, async (canonicalPath) => {
        const liveRuntime = lookupLiveAgentRuntime(canonicalPath);
        if (!liveRuntime) {
            await beforeMutation?.();
            return;
        }
        if (guardRuntime) {
            await guardRuntime(liveRuntime);
        } else {
            await beforeMutation?.();
        }
        liveRuntime.runtime.abort();
    });
}

export async function subscribeAgentSessionForIpc(
    sender: electron.WebContents,
    sessionPath: unknown,
    authorizationOrBeforeMutation?: AgentSubscriptionAuthorization | AuthorizationGuard
): Promise<void> {
    const authorization =
        typeof authorizationOrBeforeMutation === "function"
            ? makeFallbackSubscriptionAuthorization(authorizationOrBeforeMutation)
            : (authorizationOrBeforeMutation ?? makeFallbackSubscriptionAuthorization());
    const rendererPath = requireNonEmptyString(sessionPath, "sessionPath");
    await withCanonicalSessionAccess(rendererPath, async (canonicalPath) => {
        await authorization.validateCurrent();
        if (sender.isDestroyed()) return;
        releaseStaleSubscriptionsForSender(sender.id, authorization);
        const liveRuntime = lookupLiveAgentRuntime(canonicalPath);
        if (!liveRuntime) {
            const key: SubKey = makeAgentSubscriptionKey(sender.id, canonicalPath, rendererPath, authorization);
            if (!pendingSubscriptions.has(key)) {
                pendingSubscriptions.set(key, { sender, canonicalPath, rendererPath, authorization });
                trackSenderKey(sender, key);
            }
            await sendPersistedSessionState(sender, canonicalPath, rendererPath, authorization, key);
            return;
        }
        await subscribeToOwner(sender, canonicalPath, liveRuntime.runtime, rendererPath, authorization);
    });
}

export async function unsubscribeAgentSessionForIpc(
    senderId: number,
    sessionPath: unknown,
    authorizationOrBeforeMutation?: AgentSubscriptionAuthorization | AuthorizationGuard
): Promise<void> {
    const authorization =
        typeof authorizationOrBeforeMutation === "function"
            ? makeFallbackSubscriptionAuthorization(authorizationOrBeforeMutation)
            : (authorizationOrBeforeMutation ?? makeFallbackSubscriptionAuthorization());
    const rendererPath = requireNonEmptyString(sessionPath, "sessionPath");
    await withCanonicalSessionAccess(rendererPath, async (canonicalPath) => {
        await authorization.validateCurrent();
        const key: SubKey = makeAgentSubscriptionKey(senderId, canonicalPath, rendererPath, authorization);
        releaseSubscription(key);
        const set = subscriptionsBySender.get(senderId);
        if (set) {
            set.delete(key);
            if (set.size === 0) subscriptionsBySender.delete(senderId);
        }
    });
}

function normalizedSessionPath(sessionPath: string): string {
    return path.resolve(sessionPath);
}

async function preparePersistedSessionTarget(
    workspace: Workspace,
    workspaceId: string,
    sessionMetadata: JsonlSessionMetadata
): Promise<PersistedSessionTarget | undefined> {
    if (workspace.oid !== workspaceId) {
        throw new Error("agent IPC: loaded Workspace does not match the authorized Workspace");
    }
    const activeSession = workspace.agentstate?.activesession;
    if (
        !activeSession ||
        activeSession.id !== sessionMetadata.id ||
        activeSession.createdAt !== sessionMetadata.createdAt ||
        activeSession.cwd !== sessionMetadata.cwd
    ) {
        return undefined;
    }
    let activeCanonicalPath: string;
    try {
        activeCanonicalPath = await fs.realpath(activeSession.path);
    } catch {
        activeCanonicalPath = normalizedSessionPath(activeSession.path);
    }
    if (activeCanonicalPath !== sessionMetadata.path) return undefined;
    return {
        id: sessionMetadata.id,
        createdAt: sessionMetadata.createdAt,
        cwd: sessionMetadata.cwd,
        trustedPaths: new Set([normalizedSessionPath(sessionMetadata.path), normalizedSessionPath(activeSession.path)]),
    };
}

function persistedActiveSessionMatchesTarget(state: WorkspaceAgentState, target: PersistedSessionTarget): boolean {
    const activeSession = state?.activesession;
    if (
        !activeSession ||
        activeSession.id !== target.id ||
        activeSession.createdAt !== target.createdAt ||
        activeSession.cwd !== target.cwd
    ) {
        return false;
    }
    return target.trustedPaths.has(normalizedSessionPath(activeSession.path));
}

function withoutActiveSession(state: WorkspaceAgentState): WorkspaceAgentState {
    const next = {
        ...state,
        ...(state.selection ? { selection: { ...state.selection } } : {}),
    };
    delete next.activesession;
    return next;
}

function isStaleWorkspaceAgentCheckpointError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("stale workspace checkpoint") || message.includes("expected Agent revision");
}

async function clearPersistedActiveSession(
    persistence: AgentSessionRemovalPersistence,
    initialWorkspace: Workspace,
    target: PersistedSessionTarget
): Promise<void> {
    let workspace = initialWorkspace;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!persistedActiveSessionMatchesTarget(workspace.agentstate, target)) return;
        try {
            await persistence.saveWorkspaceAgentState({
                workspaceid: persistence.workspaceId,
                expectedrevision: workspace.agentrevision ?? 0,
                state: withoutActiveSession(workspace.agentstate),
            });
            return;
        } catch (error) {
            if (!isStaleWorkspaceAgentCheckpointError(error) || attempt > 0) {
                throw error;
            }
            workspace = await persistence.loadWorkspace(persistence.workspaceId);
            if (workspace.oid !== persistence.workspaceId) {
                throw new Error("agent IPC: loaded Workspace does not match the authorized Workspace");
            }
        }
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function rollbackMovedSession(
    operation: "archive" | "delete",
    movedMetadata: JsonlSessionMetadata,
    canonicalPath: string,
    mutationError: unknown
): Promise<void> {
    try {
        await restoreMovedPaneSession(movedMetadata, canonicalPath);
    } catch (rollbackError) {
        throw new AggregateError(
            [mutationError, rollbackError],
            `agent IPC: ${operation} partial failure: ${errorMessage(mutationError)}; rollback failed: ${errorMessage(rollbackError)}`
        );
    }
}

export async function renameAgentSessionForIpc(
    sessionMetadata: JsonlSessionMetadata,
    name: string,
    beforeMutation?: AuthorizationGuard
): Promise<void> {
    const canonicalPath = await validateSessionPath(sessionMetadata.path);
    await beforeMutation?.();
    await runtimeRegistry.withExclusiveSessionMutation(canonicalPath, { rejectIfRunning: true }, async () => {
        await beforeMutation?.();
        await renamePaneSession({ ...sessionMetadata, path: canonicalPath }, name);
        await beforeMutation?.();
    });
}

export async function archiveAgentSessionForIpc(
    sessionMetadata: JsonlSessionMetadata,
    beforeMutation?: AuthorizationGuard,
    persistence?: AgentSessionRemovalPersistence
): Promise<JsonlSessionMetadata> {
    const canonicalPath = await validateSessionPath(sessionMetadata.path);
    await beforeMutation?.();
    const canonicalMetadata = { ...sessionMetadata, path: canonicalPath };
    let workspace: Workspace | undefined;
    let target: PersistedSessionTarget | undefined;
    let suspended: SuspendedAgentSubscriptions | undefined;
    let suspensionFinalized = false;
    try {
        return await runtimeRegistry.withExclusiveSessionMutation(
            canonicalPath,
            {
                rejectIfRunning: true,
                onExclusiveStart: () => {
                    suspended = suspendSubscriptionsForPath(canonicalPath);
                },
                afterSessionAccessDrained: () => {
                    suspended = suspendSubscriptionsForPath(canonicalPath, suspended!);
                },
                beforeRuntimeDisposal: async () => {
                    await beforeMutation?.();
                    workspace = persistence ? await persistence.loadWorkspace(persistence.workspaceId) : undefined;
                    target =
                        workspace && persistence
                            ? await preparePersistedSessionTarget(workspace, persistence.workspaceId, canonicalMetadata)
                            : undefined;
                },
                onFailureBeforeRelease: async () => {
                    if (suspended && !suspensionFinalized) {
                        await restoreSuspendedSubscriptions(suspended);
                        suspensionFinalized = true;
                    }
                },
            },
            async () => {
                await beforeMutation?.();
                const activeSuspension = suspended!;
                let archived: JsonlSessionMetadata | undefined;
                try {
                    archived = await archivePaneSession(canonicalMetadata);
                    if (workspace && target && persistence) {
                        await clearPersistedActiveSession(persistence, workspace, target);
                    }
                    commitSuspendedSubscriptions(activeSuspension);
                    suspensionFinalized = true;
                    return archived;
                } catch (error) {
                    if (!archived) {
                        await restoreSuspendedSubscriptions(activeSuspension);
                        suspensionFinalized = true;
                        throw error;
                    }
                    try {
                        await rollbackMovedSession("archive", archived, canonicalPath, error);
                    } catch (rollbackError) {
                        commitSuspendedSubscriptions(activeSuspension);
                        suspensionFinalized = true;
                        throw rollbackError;
                    }
                    await restoreSuspendedSubscriptions(activeSuspension);
                    suspensionFinalized = true;
                    throw error;
                }
            }
        );
    } catch (error) {
        if (suspended && !suspensionFinalized) {
            throw new AggregateError([error], "agent IPC: archive subscription recovery did not complete");
        }
        throw error;
    }
}

export async function deleteAgentSessionForIpc(
    sessionMetadata: JsonlSessionMetadata,
    beforeMutation?: AuthorizationGuard,
    persistence?: AgentSessionRemovalPersistence
): Promise<void> {
    const canonicalPath = await validateSessionPath(sessionMetadata.path);
    await beforeMutation?.();
    const canonicalMetadata = { ...sessionMetadata, path: canonicalPath };
    let workspace: Workspace | undefined;
    let target: PersistedSessionTarget | undefined;
    let suspended: SuspendedAgentSubscriptions | undefined;
    let suspensionFinalized = false;
    try {
        await runtimeRegistry.withExclusiveSessionMutation(
            canonicalPath,
            {
                rejectIfRunning: true,
                onExclusiveStart: () => {
                    suspended = suspendSubscriptionsForPath(canonicalPath);
                },
                afterSessionAccessDrained: () => {
                    suspended = suspendSubscriptionsForPath(canonicalPath, suspended!);
                },
                beforeRuntimeDisposal: async () => {
                    await beforeMutation?.();
                    workspace = persistence ? await persistence.loadWorkspace(persistence.workspaceId) : undefined;
                    target =
                        workspace && persistence
                            ? await preparePersistedSessionTarget(workspace, persistence.workspaceId, canonicalMetadata)
                            : undefined;
                },
                onFailureBeforeRelease: async () => {
                    if (suspended && !suspensionFinalized) {
                        await restoreSuspendedSubscriptions(suspended);
                        suspensionFinalized = true;
                    }
                },
            },
            async () => {
                await beforeMutation?.();
                const activeSuspension = suspended!;
                let staged: JsonlSessionMetadata | undefined;
                try {
                    staged = await stageDeletePaneSession(canonicalMetadata);
                    if (workspace && target && persistence) {
                        await clearPersistedActiveSession(persistence, workspace, target);
                    }
                    commitSuspendedSubscriptions(activeSuspension);
                    suspensionFinalized = true;
                } catch (error) {
                    if (!staged) {
                        await restoreSuspendedSubscriptions(activeSuspension);
                        suspensionFinalized = true;
                        throw error;
                    }
                    try {
                        await rollbackMovedSession("delete", staged, canonicalPath, error);
                    } catch (rollbackError) {
                        commitSuspendedSubscriptions(activeSuspension);
                        suspensionFinalized = true;
                        throw rollbackError;
                    }
                    await restoreSuspendedSubscriptions(activeSuspension);
                    suspensionFinalized = true;
                    throw error;
                }
            }
        );
    } catch (error) {
        if (suspended && !suspensionFinalized) {
            throw new AggregateError([error], "agent IPC: delete subscription recovery did not complete");
        }
        throw error;
    }
}

function sweepIdleAgentRuntimes(): Promise<void> {
    if (runtimeSweepPromise) {
        return runtimeSweepPromise;
    }
    const sweep = runtimeRegistry
        .evictIdle()
        .then(() => {})
        .catch((error) => {
            console.error("[agent-ipc] runtime sweep failed:", error);
        })
        .finally(() => {
            if (runtimeSweepPromise === sweep) {
                runtimeSweepPromise = undefined;
            }
        });
    runtimeSweepPromise = sweep;
    return sweep;
}

/**
 * Wire the agent IPC handlers. Call once at app startup from
 * emain-ipc.ts initIpcHandlers().
 */
export function registerAgentIpcHandlers(options: AgentIpcRegistrationOptions): void {
    if (!runtimeSweepTimer) {
        runtimeSweepTimer = setInterval(() => {
            void sweepIdleAgentRuntimes();
            contextDraftRegistry.sweepExpired();
        }, AgentRuntimeSweepIntervalMs);
        runtimeSweepTimer.unref();
    }

    const authenticate = async (
        event: electron.IpcMainInvokeEvent,
        requestContext: unknown
    ): Promise<AuthenticatedWorkspaceAgentSender> => {
        return await authenticateWorkspaceSender(options, event.sender.id, requestContext);
    };
    const assertCurrent = async (
        event: electron.IpcMainInvokeEvent,
        authenticated: AuthenticatedWorkspaceAgentSender
    ): Promise<void> => {
        await assertWorkspaceSenderCurrent(options, event.sender.id, authenticated);
    };
    const makeAuthorization = (
        event: electron.IpcMainInvokeEvent,
        authenticated: AuthenticatedWorkspaceAgentSender
    ): AgentSubscriptionAuthorization => ({
        workspaceId: authenticated.workspaceId,
        generation: authenticated.generation,
        validateCurrent: () => assertCurrent(event, authenticated),
        guardRuntime: (lookup) =>
            guardLiveAgentRuntimeAccess({
                lookup,
                workspaceId: authenticated.workspaceId,
                beforeAccess: () => assertCurrent(event, authenticated),
            }),
    });
    const authorizeSession = async (
        event: electron.IpcMainInvokeEvent,
        requestContext: unknown,
        sessionMetadata: unknown
    ): Promise<{ authenticated: AuthenticatedWorkspaceAgentSender; metadata: JsonlSessionMetadata }> => {
        const authenticated = await authenticate(event, requestContext);
        const metadata = await requireSessionBelongsToWorkspace(authenticated, sessionMetadata);
        await assertCurrent(event, authenticated);
        return { authenticated, metadata };
    };

    electron.ipcMain.handle("agent:create-session", async (event, requestContext): Promise<JsonlSessionMetadata> => {
        const authenticated = await authenticate(event, requestContext);
        await assertCurrent(event, authenticated);
        const created = await createPaneSession(authenticated.workspaceDir);
        try {
            await assertCurrent(event, authenticated);
            return created.metadata;
        } finally {
            created.session.close();
        }
    });

    electron.ipcMain.handle("agent:list-sessions", async (event, requestContext): Promise<JsonlSessionMetadata[]> => {
        const authenticated = await authenticate(event, requestContext);
        const sessions = await listSessionsForCwd(authenticated.workspaceDir);
        await assertCurrent(event, authenticated);
        return sessions;
    });

    electron.ipcMain.handle(
        "agent:list-session-details",
        async (event, requestContext, limit?: number): Promise<SessionDetailInfo[]> => {
            const authenticated = await authenticate(event, requestContext);
            const sessions = await listSessionDetailsForCwd(authenticated.workspaceDir, limit);
            await assertCurrent(event, authenticated);
            return sessions;
        }
    );

    electron.ipcMain.handle("agent:list-commands", async (event, requestContext): Promise<AgentCommandInfo[]> => {
        const authenticated = await authenticate(event, requestContext);
        await assertCurrent(event, authenticated);
        return listAgentCommandsForIpc();
    });

    electron.ipcMain.handle(
        "agent:list-tree",
        async (event, requestContext, sessionMetadata: JsonlSessionMetadata): Promise<AgentTreeResult> => {
            const { authenticated, metadata } = await authorizeSession(event, requestContext, sessionMetadata);
            const authorization = makeAuthorization(event, authenticated);
            const result = await listAgentTreeForIpc(
                metadata,
                authorization.guardRuntime,
                authorization.validateCurrent
            );
            await assertCurrent(event, authenticated);
            return result;
        }
    );

    electron.ipcMain.handle("agent:get-session-state", async (event, requestContext, sessionMetadata) => {
        const { authenticated, metadata } = await authorizeSession(event, requestContext, sessionMetadata);
        const authorization = makeAuthorization(event, authenticated);
        const result = await getAgentSessionStateForIpc(
            metadata,
            authorization.guardRuntime,
            authorization.validateCurrent
        );
        await assertCurrent(event, authenticated);
        return result;
    });

    electron.ipcMain.handle(
        "agent:list-fork-points",
        async (event, requestContext, sessionMetadata: JsonlSessionMetadata): Promise<AgentForkPointView[]> => {
            const { authenticated, metadata } = await authorizeSession(event, requestContext, sessionMetadata);
            const authorization = makeAuthorization(event, authenticated);
            const result = await listAgentForkPointsForIpc(
                metadata,
                authorization.guardRuntime,
                authorization.validateCurrent
            );
            await assertCurrent(event, authenticated);
            return result;
        }
    );

    const contextHandler =
        <T>(operation: (input: unknown) => Promise<T>) =>
        async (event: electron.IpcMainInvokeEvent, requestContext: unknown, input: unknown) =>
            await contextIpcEnvelope(async () => {
                const authenticated = await authenticate(event, requestContext);
                const value = requireContextObject(input, "context");
                for (const fieldName of ["targetSessionPath", "sourceSessionPath"] as const) {
                    if (value[fieldName] == null) continue;
                    const opened = await openCanonicalContextSession(value[fieldName], fieldName);
                    try {
                        await requireSessionBelongsToWorkspace(authenticated, opened.metadata);
                    } finally {
                        opened.session.close();
                    }
                }
                await assertCurrent(event, authenticated);
                const result = await operation(input);
                await assertCurrent(event, authenticated);
                return result;
            });
    electron.ipcMain.handle("agent:prepare-context-draft", contextHandler(prepareContextDraftForIpc));
    electron.ipcMain.handle("agent:discard-context-draft", contextHandler(discardContextDraftForIpc));
    electron.ipcMain.handle("agent:list-reference-points", contextHandler(listAgentReferencePointsForIpc));
    electron.ipcMain.handle("agent:list-context-state", contextHandler(listContextStateForIpc));
    electron.ipcMain.handle("agent:summarize-context-draft", contextHandler(summarizeContextDraftForIpc));

    electron.ipcMain.handle(
        "agent:navigate-tree",
        async (event, requestContext, input: AgentNavigateTreeInput): Promise<AgentNavigateTreeResult> => {
            const { authenticated, metadata } = await authorizeSession(event, requestContext, input?.sessionMetadata);
            const authorization = makeAuthorization(event, authenticated);
            const result = await navigateAgentTreeForIpc(
                { ...input, sessionMetadata: metadata },
                authorization.validateCurrent,
                authorization.guardRuntime
            );
            await assertCurrent(event, authenticated);
            return result;
        }
    );

    electron.ipcMain.handle(
        "agent:fork-session",
        async (event, requestContext, input: AgentForkSessionInput): Promise<AgentForkSessionResult> => {
            const { authenticated, metadata } = await authorizeSession(event, requestContext, input?.sessionMetadata);
            const authorization = makeAuthorization(event, authenticated);
            const result = await forkAgentSessionForIpc(
                {
                    ...input,
                    sessionMetadata: metadata,
                    cwd: authenticated.workspaceDir,
                },
                authorization.validateCurrent,
                authorization.guardRuntime
            );
            await assertCurrent(event, authenticated);
            return result;
        }
    );

    electron.ipcMain.handle(
        "agent:clone-session",
        async (event, requestContext, input: AgentCloneSessionInput): Promise<AgentCloneSessionResult> => {
            const { authenticated, metadata } = await authorizeSession(event, requestContext, input?.sessionMetadata);
            const authorization = makeAuthorization(event, authenticated);
            const result = await cloneAgentSessionForIpc(
                {
                    ...input,
                    sessionMetadata: metadata,
                    cwd: authenticated.workspaceDir,
                },
                authorization.validateCurrent,
                authorization.guardRuntime
            );
            await assertCurrent(event, authenticated);
            return result;
        }
    );

    electron.ipcMain.handle(
        "agent:run-command",
        async (event, requestContext, input: AgentRunCommandInput): Promise<AgentCommandExecutionResult> => {
            const authenticated = await authenticate(event, requestContext);
            let sessionMetadata = input?.sessionMetadata;
            if (sessionMetadata) {
                sessionMetadata = await requireSessionBelongsToWorkspace(authenticated, sessionMetadata);
            }
            const authorization = makeAuthorization(event, authenticated);
            await authorization.validateCurrent();
            const result = await runAgentCommandForIpc(
                {
                    ...input,
                    cwd: authenticated.workspaceDir,
                    sessionMetadata,
                },
                authorization.validateCurrent,
                authorization.guardRuntime
            );
            await assertCurrent(event, authenticated);
            return result;
        }
    );

    electron.ipcMain.handle(
        "agent:send",
        async (
            event,
            requestContext,
            input: SendOptions
        ): Promise<ContextIpcEnvelope<{ sessionMetadata: JsonlSessionMetadata; turnId: string }>> => {
            return await contextIpcEnvelope(async () => {
                const authenticated = await authenticate(event, requestContext);
                const rendererContext = await parseAgentExecutionContext(input.context);
                if (
                    rendererContext.workspaceId !== authenticated.workspaceId ||
                    rendererContext.workspaceDir !== authenticated.workspaceDir
                ) {
                    throw new Error("agent IPC: execution context does not match authenticated Workspace");
                }
                let sessionMetadata = input.sessionMetadata;
                if (sessionMetadata) {
                    sessionMetadata = await requireSessionBelongsToWorkspace(authenticated, sessionMetadata);
                }
                if (rendererContext.sessionPath) {
                    const contextSessionPath = await validateSessionPath(
                        rendererContext.sessionPath,
                        "context.sessionPath"
                    );
                    if (!sessionMetadata || contextSessionPath !== sessionMetadata.path) {
                        throw new Error("agent IPC: execution context session does not match the request");
                    }
                }
                await assertCurrent(event, authenticated);
                const opts: SendOptions = {
                    ...input,
                    sessionMetadata,
                    context: {
                        ...rendererContext,
                        workspaceId: authenticated.workspaceId,
                        workspaceDir: authenticated.workspaceDir,
                    },
                };
                console.log(
                    `[agent-ipc] agent:send provider=${opts.provider} model=${opts.model} ` +
                        `reasoning=${opts.reasoning ?? "off"} ` +
                        `cred=${opts.token ? "token" : opts.tokenSecretName ? `secret:${opts.tokenSecretName}` : "NONE"} ` +
                        `textLen=${opts.text?.length ?? 0}`
                );
                const runInIngress = reserveAgentSendIngress(opts);
                return await runInIngress(async () => {
                    const { metadata } = await ensureSession(opts);
                    return await runtimeRegistry.withSessionAccess(metadata.path, async () => {
                        await assertCurrent(event, authenticated);
                        const { runtime, config } = await ensureAgentRuntime(
                            metadata,
                            opts,
                            authenticated.workspaceId
                        );
                        const authorization = makeAuthorization(event, authenticated);
                        await authorization.guardRuntime({ path: metadata.path, runtime });
                        await attachPendingSubscribers(metadata.path, runtime);

                        const targetSessionPath = await validateSessionPath(metadata.path);
                        const targetSession = await openPaneSessionByPath(targetSessionPath);
                        const attachments = parseContextAttachments(opts.contextAttachments);
                        const images = imageContentsFromRenderer(opts.images);
                        try {
                            const resolveContextPreparation = async (): Promise<
                                AgentHarnessTurnPreparation | undefined
                            > => {
                                if (attachments.length === 0) return undefined;
                                await requireContextReferencesEnabled();
                                contextDraftRegistry.readMany(
                                    targetSessionPath,
                                    attachments.map((attachment) => attachment.draftId)
                                );
                                return makeContextTurnPrepareCallback({
                                    targetSessionPath,
                                    session: targetSession,
                                    attachments,
                                    model: config.model,
                                });
                            };
                            await authorization.guardRuntime({ path: metadata.path, runtime });
                            const userEntryId = await runtime.sendWithExecutionConfig(opts.text, config, {
                                ...(images ? { images } : {}),
                                activatePreparation: async () => await resolveContextPreparation(),
                            });
                            await authorization.guardRuntime({ path: metadata.path, runtime });
                            return { sessionMetadata: metadata, turnId: userEntryId };
                        } finally {
                            targetSession.close();
                        }
                    });
                });
            });
        }
    );

    electron.ipcMain.handle("agent:command-read", async (event, requestContext, sessionMetadata, input) => {
        const { authenticated, metadata } = await authorizeSession(event, requestContext, sessionMetadata);
        const authorization = makeAuthorization(event, authenticated);
        return await runtimeRegistry.withSessionAccess(metadata.path, async () => {
            const runtime = await requireLiveRuntimeForCommand(metadata.path, authorization);
            const commandId = requireCommandId(input);
            const result = runtime.readHostedCommand(commandId);
            await authorization.guardRuntime({ path: metadata.path, runtime });
            return result;
        });
    });

    electron.ipcMain.handle("agent:command-write", async (event, requestContext, sessionMetadata, input) => {
        const { authenticated, metadata } = await authorizeSession(event, requestContext, sessionMetadata);
        const authorization = makeAuthorization(event, authenticated);
        await runtimeRegistry.withSessionAccess(metadata.path, async () => {
            const runtime = await requireLiveRuntimeForCommand(metadata.path, authorization);
            const commandId = requireCommandId(input);
            const text = requireNonEmptyString((input as AgentHostedCommandWriteInput)?.input, "input");
            await runtime.writeHostedCommand(commandId, text);
            await authorization.guardRuntime({ path: metadata.path, runtime });
        });
    });

    electron.ipcMain.handle("agent:command-resize", async (event, requestContext, sessionMetadata, input) => {
        const { authenticated, metadata } = await authorizeSession(event, requestContext, sessionMetadata);
        const authorization = makeAuthorization(event, authenticated);
        await runtimeRegistry.withSessionAccess(metadata.path, async () => {
            const runtime = await requireLiveRuntimeForCommand(metadata.path, authorization);
            const commandId = requireCommandId(input);
            const { cols, rows } = input as AgentHostedCommandResizeInput;
            if (
                !Number.isFinite(cols) ||
                cols < 1 ||
                cols > MaxAgentPtyCols ||
                !Number.isFinite(rows) ||
                rows < 1 ||
                rows > MaxAgentPtyRows
            ) {
                throw new Error("agent IPC: invalid hosted command size");
            }
            runtime.resizeHostedCommand(commandId, cols, rows);
            await authorization.guardRuntime({ path: metadata.path, runtime });
        });
    });

    electron.ipcMain.handle("agent:command-stop", async (event, requestContext, sessionMetadata, input) => {
        const { authenticated, metadata } = await authorizeSession(event, requestContext, sessionMetadata);
        const authorization = makeAuthorization(event, authenticated);
        await runtimeRegistry.withSessionAccess(metadata.path, async () => {
            const runtime = await requireLiveRuntimeForCommand(metadata.path, authorization);
            const commandId = requireCommandId(input);
            await runtime.stopHostedCommand(commandId);
            await authorization.guardRuntime({ path: metadata.path, runtime });
        });
    });

    electron.ipcMain.handle("agent:rename-session", async (event, requestContext, input: AgentRenameSessionInput) => {
        if (!isRecord(input)) {
            throw new Error("agent IPC: renameSession input must be an object");
        }
        const { authenticated, metadata } = await authorizeSession(event, requestContext, input.sessionMetadata);
        const name = requireSessionName(input.name);
        await renameAgentSessionForIpc(metadata, name, () => assertCurrent(event, authenticated));
        await assertCurrent(event, authenticated);
    });

    electron.ipcMain.handle(
        "agent:archive-session",
        async (event, requestContext, sessionMetadata): Promise<JsonlSessionMetadata> => {
            const { authenticated, metadata } = await authorizeSession(event, requestContext, sessionMetadata);
            const archived = await archiveAgentSessionForIpc(metadata, () => assertCurrent(event, authenticated), {
                workspaceId: authenticated.workspaceId,
                loadWorkspace: options.loadWorkspace,
                saveWorkspaceAgentState: options.saveWorkspaceAgentState,
            });
            await assertCurrent(event, authenticated);
            return archived;
        }
    );

    electron.ipcMain.handle("agent:delete-session", async (event, requestContext, sessionMetadata) => {
        const { authenticated, metadata } = await authorizeSession(event, requestContext, sessionMetadata);
        await deleteAgentSessionForIpc(metadata, () => assertCurrent(event, authenticated), {
            workspaceId: authenticated.workspaceId,
            loadWorkspace: options.loadWorkspace,
            saveWorkspaceAgentState: options.saveWorkspaceAgentState,
        });
        await assertCurrent(event, authenticated);
    });

    electron.ipcMain.handle("agent:abort", async (event, requestContext, sessionPath: string) => {
        const authenticated = await authenticate(event, requestContext);
        const metadata = await requireSessionBelongsToWorkspace(authenticated, {
            id: "",
            createdAt: "",
            path: sessionPath,
            cwd: authenticated.workspaceDir,
        });
        const authorization = makeAuthorization(event, authenticated);
        await authorization.validateCurrent();
        await abortAgentSessionForIpc(metadata.path, authorization.validateCurrent, authorization.guardRuntime);
        await authorization.validateCurrent();
    });

    electron.ipcMain.handle("agent:subscribe", async (event, requestContext, sessionPath: string) => {
        const authenticated = await authenticate(event, requestContext);
        const metadata = await requireSessionBelongsToWorkspace(authenticated, {
            id: "",
            createdAt: "",
            path: sessionPath,
            cwd: authenticated.workspaceDir,
        });
        const authorization = makeAuthorization(event, authenticated);
        await authorization.validateCurrent();
        try {
            await subscribeAgentSessionForIpc(event.sender, metadata.path, authorization);
            await authorization.validateCurrent();
        } catch (error) {
            releaseSubscriptionsForSenderPath(event.sender.id, metadata.path);
            throw error;
        }
    });

    electron.ipcMain.handle("agent:unsubscribe", async (event, requestContext, sessionPath: string) => {
        const authenticated = await authenticate(event, requestContext);
        const metadata = await requireSessionBelongsToWorkspace(authenticated, {
            id: "",
            createdAt: "",
            path: sessionPath,
            cwd: authenticated.workspaceDir,
        });
        const authorization = makeAuthorization(event, authenticated);
        await authorization.validateCurrent();
        await unsubscribeAgentSessionForIpc(event.sender.id, metadata.path, authorization);
        await authorization.validateCurrent();
    });
}

export async function disposeAgentRuntimesForShutdown(): Promise<void> {
    for (const record of subscriptions.values()) {
        try {
            record.unsubscribe();
        } catch {
            // ignore
        }
    }
    subscriptions.clear();
    subscriptionsBySender.clear();
    pendingSubscriptions.clear();
    sendIngressTails.clear();
    if (runtimeSweepTimer) {
        clearInterval(runtimeSweepTimer);
        runtimeSweepTimer = undefined;
    }
    await runtimeSweepPromise;
    await runtimeRegistry.disposeAll();
    contextDraftRegistry = new ContextDraftRegistry();
    contextSummaryCompletion = undefined;
    contextProviderAdapterFactory = createContextProviderAdapter;
}

export function _setContextSummaryCompletionForTests(completion: ContextSummaryCompletion | undefined): void {
    contextSummaryCompletion = completion;
}

export function _setContextProviderAdapterFactoryForTests(factory: typeof contextProviderAdapterFactory): void {
    contextProviderAdapterFactory = factory;
}

/** Test-only escape hatch: clear the runtime registry + subscriptions. */
export async function _resetAgentIpcForTests(): Promise<void> {
    _resetAgentObservabilityForTests();
    await disposeAgentRuntimesForShutdown();
}
