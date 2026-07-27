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

import { _resetAgentObservabilityForTests, attachAgentObservability } from "./agent-observability-ipc";
import { makeAgentEventPayload, makeAgentSubscriptionKey } from "./agent-event-routing";
import { AgentRuntimeRegistry } from "@crest/coding-agent/agent-runtime-registry";
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
import { buildAgentHarnessHost } from "@crest/coding-agent/harness-factory";
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
    createPaneSession,
    defaultSessionsDir,
    forkPaneSession,
    importPaneSessionFromJsonl,
    listAllSessionDetails,
    listSessionDetailsForCwd,
    listSessionsForCwd,
    openPaneSession,
    openPaneSessionByPath,
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
let runtimeSweepTimer: NodeJS.Timeout | undefined;

type SubKey = string;
interface AgentSubscriptionRecord {
    unsubscribe: () => void;
    sessionPath: string;
}

const subscriptions = new Map<SubKey, AgentSubscriptionRecord>();
const subscriptionsBySender = new Map<number, Set<SubKey>>();
const pendingSubscriptions = new Map<
    SubKey,
    { sender: electron.WebContents; canonicalPath: string; rendererPath: string }
>();
const sendIngressTails = new Map<string, Promise<void>>();

interface SendOptions {
    /** Existing session, if any. null on first send → main mints a fresh one. */
    sessionMetadata?: JsonlSessionMetadata | null;
    /** Parent terminal block ID for pane-scoped tools and command context. */
    blockId: string;
    /** Pane's current cwd. Drives system prompt + tool execution dir. */
    cwd: string;
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
     * allowAll regardless of this value. See emain/agent/permissions.ts.
     */
    allowedTools?: string[];
    contextAttachments?: ContextTurnDraftAttachmentInput[];
}

function reserveAgentSendIngress(opts: SendOptions): <T>(operation: () => Promise<T>) => Promise<T> {
    const sessionPath = opts.sessionMetadata?.path;
    const key =
        typeof sessionPath === "string" && sessionPath.trim() !== ""
            ? `session:${path.resolve(sessionPath)}`
            : `new:${opts.blockId}`;
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
    config: AgentExecutionConfig,
    options: { attachObservability?: boolean } = {}
): Promise<AgentSessionRuntime> {
    const piSession = await openPaneSession(metadata);
    // Discover skills from <configHome>/skills and <cwd>/.crest/skills.
    // Loaded once per harness construction (session open); the skills
    // section is only injected into the system prompt when the read
    // tool is active (build-system-prompt.ts).
    const skills = await loadAgentSkills({ cwd: opts.cwd });
    let getRuntimeCwd = () => config.promptInputs.cwd;
    const host = buildAgentHarnessHost({
        session: piSession,
        model: config.model,
        thinkingLevel: config.thinkingLevel,
        promptInputs: config.promptInputs,
        tools: [
            ...getDefaultTools(() => getRuntimeCwd()),
            // spawn_cli_agent delegates long-running / interactive commands to a
            // CLI subagent. Only the main agent runtime gets it (never in
            // getDefaultTools, which the subagent factory also draws from). The
            // subagent runs in an ephemeral in-memory session and shares this
            // runtime's initial resolved model + API key.
            createSpawnCliAgentTool({
                parentBlockId: opts.blockId,
                getModel: () => host.harness.getModel(),
                createSession: () => new InMemorySessionRepo().create(),
                getApiKeyAndHeaders: (model) => host.resolveAuth(model),
            }),
        ],
        // Load AGENTS.md / CLAUDE.md from cwd up to the filesystem root so
        // project-specific instructions reach the system prompt. Loaded once
        // per harness construction (session open); cheap sync reads.
        contextFiles: loadProjectContextFiles({ cwd: opts.cwd }),
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
    const owner = new AgentSessionRuntime(metadata.path, host, seed.messages ?? [], initialTurns, {
        onTurnFinished,
        initialContextEntries: initialEntries,
    });
    if (options.attachObservability !== false) {
        attachAgentObservability(metadata.path, host.harness);
    }
    return owner;
}

async function ensureAgentRuntime(
    metadata: JsonlSessionMetadata,
    opts: SendOptions
): Promise<{ runtime: AgentSessionRuntime; config: AgentExecutionConfig; apiKey?: string }> {
    const resolved = await resolveAgentExecution(opts);
    const runtime = await runtimeRegistry.getOrCreate(metadata.path, () =>
        createAgentRuntime(metadata, opts, resolved.config)
    );
    attachPendingSubscribers(metadata.path, runtime);
    return { runtime, ...resolved };
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

async function sendPersistedSessionState(
    sender: electron.WebContents,
    sessionPath: string,
    rendererSessionPath = sessionPath
): Promise<void> {
    let canonicalPath = sessionPath;
    try {
        canonicalPath = await validateSessionPath(sessionPath);
        const session = await openPaneSessionByPath(canonicalPath);
        const context = await session.buildContext();
        const branch = await session.getBranch();
        const turns = buildPersistedTurnsFromSessionEntries(branch);
        const contextState = buildContextStateFromSessionEntries(branch);
        if (sender.isDestroyed()) return;
        sender.send(
            "agent:event",
            makeAgentEventPayload(canonicalPath, rendererSessionPath, {
                type: "session_state",
                messages: context.messages,
                turns,
                status: "idle",
                steer: [],
                followUp: [],
                ...contextState,
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
    contextReports: ReturnType<typeof buildContextStateFromSessionEntries>["contextReports"];
}> {
    const canonicalPath = await validateSessionPath(sessionPath);
    const owner = runtimeRegistry.get(canonicalPath);
    if (owner) {
        const state = owner.getSessionState();
        return {
            type: "session_state",
            messages: state.messages,
            turns: state.turns,
            status: state.status,
            steer: state.steerQueue,
            followUp: state.followUpQueue,
            contextReports: state.contextReports,
        };
    }
    const session = await openPaneSessionByPath(canonicalPath);
    const context = await session.buildContext();
    const branch = await session.getBranch();
    return {
        type: "session_state",
        messages: context.messages,
        turns: buildPersistedTurnsFromSessionEntries(branch),
        status: "idle",
        steer: [],
        followUp: [],
        ...buildContextStateFromSessionEntries(branch),
    };
}

function subscribeToOwner(
    sender: electron.WebContents,
    sessionPath: string,
    session: AgentSessionRuntime,
    rendererSessionPath = sessionPath
): void {
    const key: SubKey = makeAgentSubscriptionKey(sender.id, sessionPath, rendererSessionPath);
    pendingSubscriptions.delete(key);
    if (sender.isDestroyed()) return;
    if (subscriptions.has(key)) return;
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
    subscriptions.set(key, { unsubscribe: unsub, sessionPath });
    runtimeRegistry.acquire(sessionPath, key);
    trackSenderKey(sender, key);
    const sessionState = session.getSessionState();
    if (sender.isDestroyed()) return;
    sender.send(
        "agent:event",
        makeAgentEventPayload(sessionPath, rendererSessionPath, {
            type: "session_state",
            messages: sessionState.messages,
            turns: sessionState.turns,
            status: sessionState.status,
            steer: sessionState.steerQueue,
            followUp: sessionState.followUpQueue,
            contextReports: sessionState.contextReports,
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
        subscribeToOwner(sender.sender, sender.canonicalPath, session, sender.rendererPath);
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

export function listAgentCommandsForIpc(): AgentCommandInfo[] {
    return getBuiltInAgentCommands();
}

export async function listAgentTreeForIpc(sessionMetadata: unknown): Promise<AgentTreeResult> {
    const { entries, leafId, labels } = await getSessionTreeData(sessionMetadata);
    return { entries: buildAgentTreeEntryViews(entries, leafId, labels), leafId };
}

export async function listAgentForkPointsForIpc(sessionMetadata: unknown): Promise<AgentForkPointView[]> {
    const { entries } = await getSessionTreeData(sessionMetadata);
    return buildAgentForkPointViews(entries);
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
    return buildAgentReferencePointViews(await session.getBranch());
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
    const source = await openCanonicalContextSession(value.sourceSessionPath, "sourceSessionPath");
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
}

export async function listContextStateForIpc(input: unknown): Promise<AgentContextStateView> {
    const value = requireContextObject(input, "listContextState");
    const target = await openCanonicalContextSession(value.targetSessionPath, "targetSessionPath");
    const state = buildContextStateFromSessionEntries(await target.session.getBranch());
    return {
        drafts: contextDraftRegistry.list(target.canonicalPath),
        contextReports: state.contextReports,
    };
}

export async function discardContextDraftForIpc(input: unknown): Promise<{ discarded: boolean }> {
    const value = requireContextObject(input, "discardContextDraft");
    const target = await openCanonicalContextSession(value.targetSessionPath, "targetSessionPath");
    const draftId = requireNonEmptyString(value.draftId, "draftId");
    const existing = contextDraftRegistry.peek(target.canonicalPath, draftId);
    if (!existing) {
        if (contextDraftRegistry.findTarget(draftId) != null) {
            throw new ContextReferenceError("invalid_input", "Context draft belongs to another target session");
        }
        return { discarded: false };
    }
    return { discarded: contextDraftRegistry.discard(target.canonicalPath, draftId) };
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
    const draftId = requireNonEmptyString(value.draftId, "draftId");
    const result = await summarizeContextDraft({
        registry: contextDraftRegistry,
        targetSessionPath: target.canonicalPath,
        draftId,
        ...(await resolveContextSummaryConfig()),
    });
    if (!result.ok) throw result.error;
    return contextDraftRegistry.peek(target.canonicalPath, draftId);
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
    sessionMetadata: unknown
): Promise<Awaited<ReturnType<typeof buildPersistedSessionState>>> {
    const { metadata, requestedPath } = await openValidatedSessionMetadata(sessionMetadata);
    return await buildPersistedSessionState(requestedPath || metadata.path);
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
        case "resume":
            return {
                status: "success",
                message: "Open session manager",
                managerMode: "session",
            };
        case "info":
            return await runSessionInfoCommand(parsed.sessionMetadata);
        case "copy":
            return await runCopyLastAssistantMessageCommand(parsed.sessionMetadata);
        case "export":
            return await runExportSessionCommand(parsed.sessionMetadata, parsed.cwd, parsed.argsText);
        case "import":
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

export async function subscribeAgentSessionForIpc(sender: electron.WebContents, sessionPath: unknown): Promise<void> {
    const rendererPath = requireNonEmptyString(sessionPath, "sessionPath");
    const canonicalPath = await validateSessionPath(rendererPath);
    if (sender.isDestroyed()) return;
    const session = runtimeRegistry.get(canonicalPath);
    if (!session) {
        const key: SubKey = makeAgentSubscriptionKey(sender.id, canonicalPath, rendererPath);
        if (!pendingSubscriptions.has(key)) {
            pendingSubscriptions.set(key, { sender, canonicalPath, rendererPath });
            trackSenderKey(sender, key);
        }
        await sendPersistedSessionState(sender, canonicalPath, rendererPath);
        return;
    }
    subscribeToOwner(sender, canonicalPath, session, rendererPath);
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
            runtimeRegistry.evictIdle();
            contextDraftRegistry.sweepExpired();
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

    electron.ipcMain.handle("agent:list-commands", (): AgentCommandInfo[] => {
        return listAgentCommandsForIpc();
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

    const contextHandler =
        <T>(operation: (input: unknown) => Promise<T>) =>
        async (_event: unknown, input: unknown) =>
            await contextIpcEnvelope(() => operation(input));
    electron.ipcMain.handle("agent:prepare-context-draft", contextHandler(prepareContextDraftForIpc));
    electron.ipcMain.handle("agent:discard-context-draft", contextHandler(discardContextDraftForIpc));
    electron.ipcMain.handle("agent:list-reference-points", contextHandler(listAgentReferencePointsForIpc));
    electron.ipcMain.handle("agent:list-context-state", contextHandler(listContextStateForIpc));
    electron.ipcMain.handle("agent:summarize-context-draft", contextHandler(summarizeContextDraftForIpc));

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
        "agent:send",
        async (
            _event,
            opts: SendOptions
        ): Promise<ContextIpcEnvelope<{ sessionMetadata: JsonlSessionMetadata; turnId: string }>> => {
            const runInIngress = reserveAgentSendIngress(opts);
            return await runInIngress(
                async () =>
                    await contextIpcEnvelope(async () => {
                        console.log(
                            `[agent-ipc] agent:send provider=${opts.provider} model=${opts.model} ` +
                                `reasoning=${opts.reasoning ?? "off"} ` +
                                `cred=${opts.token ? "token" : opts.tokenSecretName ? `secret:${opts.tokenSecretName}` : "NONE"} ` +
                                `textLen=${opts.text?.length ?? 0}`
                        );
                        const { metadata } = await ensureSession(opts);
                        const targetSessionPath = await validateSessionPath(metadata.path);
                        const targetSession = await openPaneSessionByPath(targetSessionPath);
                        const attachments = parseContextAttachments(opts.contextAttachments);
                        const { runtime, config } = await ensureAgentRuntime(metadata, opts);
                        const images = imageContentsFromRenderer(opts.images);
                        const resolveContextPreparation = async (): Promise<
                            AgentHarnessTurnPreparation | undefined
                        > => {
                            if (attachments.length === 0) return undefined;
                            try {
                                await requireContextReferencesEnabled();
                            } catch (error) {
                                if (
                                    attachments.length > 0 ||
                                    !(error instanceof ContextReferenceError) ||
                                    error.code !== "disabled"
                                ) {
                                    throw error;
                                }
                                return undefined;
                            }
                            if (attachments.length > 0) {
                                contextDraftRegistry.readMany(
                                    targetSessionPath,
                                    attachments.map((attachment) => attachment.draftId)
                                );
                            }
                            return makeContextTurnPrepareCallback({
                                targetSessionPath,
                                session: targetSession,
                                attachments,
                                model: config.model,
                            });
                        };
                        const userEntryId = await runtime.sendWithExecutionConfig(opts.text, config, {
                            ...(images ? { images } : {}),
                            activatePreparation: async () => await resolveContextPreparation(),
                        });

                        return { sessionMetadata: metadata, turnId: userEntryId };
                    })
            );
        }
    );

    electron.ipcMain.on("agent:abort", (_event, sessionPath: string) => {
        void abortAgentSessionForIpc(sessionPath).catch((err) => {
            console.error("[agent-ipc] abort validation error:", err);
        });
    });

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
export function _resetAgentIpcForTests(): void {
    _resetAgentObservabilityForTests();
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
    runtimeRegistry.disposeAll();
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
