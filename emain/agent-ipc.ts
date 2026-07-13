// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// agent-ipc.ts — Electron main IPC surface for the integrated agent
// runtime. Holds the per-session owner cache (Map<sessionPath,
// PaneAgentSession>), registers ipcMain handlers, and fans each owner's
// event stream out to per-sender subscribers via a single "agent:event"
// channel. The owner — not this layer — holds the authoritative
// conversation state and decides send routing; this layer is the thin
// IPC ↔ owner adapter. See emain/agent/pane-agent-session.ts.
//
// See docs/agent-runtime-architecture.md §2 for the topology and
// §6 for the per-pane lifecycle this layer implements.
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
    AgentForkPointView,
    AgentRunCommandInput,
    AgentTreeEntryView,
} from "./agent/commands/types";
import { buildPaneHarness } from "./agent/harness-factory";
import { InMemorySessionRepo } from "./agent/harness/session/memory-repo";
import type { JsonlSessionMetadata, SessionDetailInfo } from "./agent/harness/types";
import {
    buildPersistedTurnsFromSessionEntries,
    PaneAgentSession,
    type AgentTurn,
    type PaneSessionStatus,
} from "./agent/pane-agent-session";
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
import { loadAgentSkills } from "./agent/skills-loader";
import { getDefaultTools } from "./agent/tools";
import { createSpawnCliAgentTool } from "./agent/tools/spawn-cli-agent";
import type { AgentMessage, ThinkingLevel } from "./agent/types";
import type { Api, Message, Model } from "./ai";
import { getModel } from "./ai";
import { getSecret } from "./aiconfig/secrets";

// Per-pane conversation OWNERS, keyed by session JSONL path (the natural
// session identity — same path always reopens the same conversation). The
// PaneAgentSession owns the authoritative transcript + queue state and is
// the single thing this IPC layer forwards to renderers; see
// docs/agent-rendering-architecture.md.
const sessionCache = new Map<string, PaneAgentSession>();

// Per-(sender, sessionPath) subscriptions. The value is the unsubscribe
// fn returned by PaneAgentSession.subscribe(). On sender destroy we
// walk this map and release everything that sender held.
type SubKey = string;
const subscriptions = new Map<SubKey, () => void>();
const subscriptionsBySender = new Map<number, Set<SubKey>>();
const pendingSubscriptions = new Map<
    SubKey,
    { sender: electron.WebContents; canonicalPath: string; rendererPath: string }
>();

interface SendOptions {
    /** Existing session, if any. null on first send → main mints a fresh one. */
    sessionMetadata?: JsonlSessionMetadata | null;
    /** Parent terminal block ID for pane-scoped tools and command context. */
    blockId: string;
    /** Pane's current cwd. Drives system prompt + tool execution dir. */
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

async function ensurePaneSession(metadata: JsonlSessionMetadata, opts: SendOptions): Promise<PaneAgentSession> {
    const existing = sessionCache.get(metadata.path);
    if (existing) {
        existing.update(buildPromptInputs(opts));
        return existing;
    }
    const piSession = await openPaneSession(metadata);
    // Resolve the provider API key once for this session's harness: a
    // literal token wins, else look up the secret in safeStorage. pi-ai
    // would otherwise fall back to provider env vars (which crest doesn't
    // set), failing with "No API key for provider: <provider>".
    const apiKey = await resolveApiKey(opts);
    const model = resolveModelOrThrow(opts.provider, opts.model);
    // Discover skills from <configHome>/skills and <cwd>/.crest/skills.
    // Loaded once per harness construction (session open); the skills
    // section is only injected into the system prompt when the read
    // tool is active (build-system-prompt.ts).
    const skills = await loadAgentSkills({ cwd: opts.cwd });
    // Diagnostic: the agent's LLM request goes out from the MAIN process
    // (Node fetch in pi-ai), so it never shows in the renderer's Network
    // tab. Log the resolved model config (never the key itself) so the
    // provider/model/baseUrl/key wiring is verifiable from the main
    // console (the `task electron:quickdev` terminal).
    console.log(
        `[agent-ipc] send → provider=${model.provider} model=${model.id} api=${model.api} ` +
            `baseUrl=${(model as { baseUrl?: string }).baseUrl ?? "(provider default)"} ` +
            `reasoning=${opts.reasoning ?? "off"} apiKey=${apiKey ? "present" : "MISSING"} ` +
            `(tokenSecretName=${opts.tokenSecretName ?? "-"})`
    );
    const pane = buildPaneHarness({
        session: piSession,
        model,
        thinkingLevel: opts.reasoning,
        promptInputs: buildPromptInputs(opts),
        tools: [
            ...getDefaultTools(opts.cwd),
            // spawn_cli_agent delegates long-running / interactive commands to a
            // CLI subagent. Only the main pane agent gets it (never in
            // getDefaultTools, which the subagent factory also draws from). The
            // subagent runs in an ephemeral in-memory session and shares this
            // pane's resolved model + API key.
            createSpawnCliAgentTool({
                parentBlockId: opts.blockId,
                model,
                createSession: () => new InMemorySessionRepo().create(),
                getApiKeyAndHeaders: apiKey == null ? undefined : async () => ({ apiKey }),
            }),
        ],
        // Load AGENTS.md / CLAUDE.md from cwd up to the filesystem root so
        // project-specific instructions reach the system prompt. Loaded once
        // per harness construction (session open); cheap sync reads.
        contextFiles: loadProjectContextFiles({ cwd: opts.cwd }),
        skills,
        getApiKeyAndHeaders: apiKey == null ? undefined : async () => ({ apiKey }),
        // Bench mode (eval harness sets CREST_AGENT_BENCH=1) bypasses
        // the allowlist entirely. Otherwise: v1 defaults to allowAll
        // when the renderer didn't pass an allowedTools list (no
        // approval UI yet); future task wires this to a per-pane
        // setting written from the renderer.
        toolCallHook: buildPermissionsHook(
            isBenchMode()
                ? { allowAll: true }
                : opts.allowedTools
                  ? { allowAll: false, allowedTools: opts.allowedTools }
                  : { allowAll: true }
        ),
    });
    // Wrap the harness in the per-session owner. Its constructor attaches
    // the harness subscription NOW (before any prompt() runs), so it owns
    // the authoritative transcript + queue state from the first event on —
    // never missing a turn that finishes before a renderer subscribes.
    // Seed it with the persisted transcript so a reopened session shows its
    // history (a fresh session's buildContext is empty).
    const seed = await piSession.buildContext();
    const initialTurns = buildPersistedTurnsFromSessionEntries(await piSession.getBranch());
    let owner: PaneAgentSession;
    const onTurnFinished = async (turn: AgentTurn): Promise<void> => {
        const operations = extractChangeOperationsFromMessages(turn.responseMessages.filter(isToolResultModelMessage), {
            turnId: turn.turnId,
        });
        if (operations.length === 0) return;
        const changeOutline = await generateChangeOutline({
            model,
            operations,
            turnId: turn.turnId,
            apiKey,
        });
        if (changeOutline) {
            owner.setTurnChangeOutline(turn.turnId, changeOutline);
        }
    };
    owner = new PaneAgentSession(metadata.path, pane, seed.messages ?? [], initialTurns, { onTurnFinished });
    sessionCache.set(metadata.path, owner);
    attachPendingSubscribers(metadata.path, owner);
    return owner;
}

function releaseSubscription(key: SubKey): void {
    const unsub = subscriptions.get(key);
    if (unsub) {
        try {
            unsub();
        } catch (err) {
            console.error("[agent-ipc] unsubscribe error:", err);
        }
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
        const turns = buildPersistedTurnsFromSessionEntries(await session.getBranch());
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
    status: PaneSessionStatus;
    steer: AgentMessage[];
    followUp: AgentMessage[];
}> {
    const canonicalPath = await validateSessionPath(sessionPath);
    const owner = sessionCache.get(canonicalPath);
    if (owner) {
        const state = owner.getSessionState();
        return {
            type: "session_state",
            messages: state.messages,
            turns: state.turns,
            status: state.status,
            steer: state.steerQueue,
            followUp: state.followUpQueue,
        };
    }
    const session = await openPaneSessionByPath(canonicalPath);
    const context = await session.buildContext();
    return {
        type: "session_state",
        messages: context.messages,
        turns: buildPersistedTurnsFromSessionEntries(await session.getBranch()),
        status: "idle",
        steer: [],
        followUp: [],
    };
}

function subscribeToOwner(
    sender: electron.WebContents,
    sessionPath: string,
    session: PaneAgentSession,
    rendererSessionPath = sessionPath
): void {
    const key: SubKey = makeAgentSubscriptionKey(sender.id, sessionPath, rendererSessionPath);
    pendingSubscriptions.delete(key);
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
    subscriptions.set(key, unsub);
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
        })
    );
}

function attachPendingSubscribers(sessionPath: string, session: PaneAgentSession): void {
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
    entries: Awaited<ReturnType<PaneAgentSession["listTreeEntries"]>>["entries"];
    leafId: string | null;
    labels: Map<string, string | undefined>;
}> {
    const { metadata: sessionMetadata, session, requestedPath } = await validateTreeInput(sessionMetadataInput);
    const owner = sessionCache.get(sessionMetadata.path) ?? sessionCache.get(requestedPath);
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

export async function getAgentSessionStateForIpc(
    sessionMetadata: unknown
): Promise<Awaited<ReturnType<typeof buildPersistedSessionState>>> {
    const { metadata, requestedPath } = await openValidatedSessionMetadata(sessionMetadata);
    return await buildPersistedSessionState(requestedPath || metadata.path);
}

export async function navigateAgentTreeForIpc(input: unknown): Promise<AgentNavigateTreeResult> {
    const { metadata, session, targetId, requestedPath } = await validateNavigateInput(input);
    const owner = sessionCache.get(metadata.path) ?? sessionCache.get(requestedPath);

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
    const owner = sessionCache.get(metadata.path) ?? sessionCache.get(requestedPath);
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
    sessionCache.get(canonicalPath)?.abort();
}

export async function subscribeAgentSessionForIpc(sender: electron.WebContents, sessionPath: unknown): Promise<void> {
    const rendererPath = requireNonEmptyString(sessionPath, "sessionPath");
    const canonicalPath = await validateSessionPath(rendererPath);
    const session = sessionCache.get(canonicalPath);
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
        async (_event, opts: SendOptions): Promise<{ sessionMetadata: JsonlSessionMetadata; turnId: string }> => {
            console.log(
                `[agent-ipc] agent:send provider=${opts.provider} model=${opts.model} ` +
                    `reasoning=${opts.reasoning ?? "off"} ` +
                    `cred=${opts.token ? "token" : opts.tokenSecretName ? `secret:${opts.tokenSecretName}` : "NONE"} ` +
                    `textLen=${opts.text?.length ?? 0}`
            );
            const { metadata } = await ensureSession(opts);
            const session = await ensurePaneSession(metadata, opts);

            // Turn identity IS the session entry id of the user message that
            // starts the turn. Prompt first so the session mints that entry,
            // the single source of truth.
            const userEntryId = await session.send(opts.text);

            return { sessionMetadata: metadata, turnId: userEntryId };
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

/** Test-only escape hatch: clear the harness cache + subscriptions. */
export function _resetAgentIpcForTests(): void {
    for (const unsub of subscriptions.values()) {
        try {
            unsub();
        } catch {
            // ignore
        }
    }
    subscriptions.clear();
    subscriptionsBySender.clear();
    for (const session of sessionCache.values()) {
        try {
            session.dispose();
        } catch {
            // ignore
        }
    }
    sessionCache.clear();
}
