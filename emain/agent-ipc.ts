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

import type { Api, Model } from "./ai";
import { getModel } from "./ai";
import { extractChangeOperationsFromMessages, generateChangeOutline } from "./agent/change-review/change-outline";
import { getBuiltInAgentCommands } from "./agent/commands/registry";
import { buildAgentForkPointViews, buildAgentTreeEntryViews, previewSessionEntry } from "./agent/commands/session-views";
import type { AgentCommandInfo, AgentForkPointView, AgentTreeEntryView } from "./agent/commands/types";
import { buildPaneHarness } from "./agent/harness-factory";
import { uuidv7 } from "./agent/harness/session/uuid";
import { buildPersistedRunsFromSessionEntries, PaneAgentSession, type AgentRun } from "./agent/pane-agent-session";
import type { SystemPromptInputs } from "./agent/build-system-prompt";
import { buildPermissionsHook, isBenchMode } from "./agent/permissions";
import { getDefaultTools } from "./agent/tools";
import { getSecret } from "./aiconfig/secrets";
import {
    createPaneSession,
    defaultSessionsDir,
    forkPaneSession,
    listSessionsForCwd,
    openPaneSession,
    openPaneSessionByPath,
} from "./agent/sessions";
import type { JsonlSessionMetadata } from "./agent/harness/types";
import type { ThinkingLevel } from "./agent/types";
import { RpcApi } from "../frontend/app/store/wshclientapi";
import { ElectronWshClient } from "./emain-wsh";

// Per-pane conversation OWNERS, keyed by session JSONL path (the natural
// session identity — same path always reopens the same conversation). The
// PaneAgentSession owns the authoritative transcript + queue state and is
// the single thing this IPC layer forwards to renderers; see
// docs/agent-rendering-architecture.md.
const sessionCache = new Map<string, PaneAgentSession>();

// Per-(sender, sessionPath) subscriptions. The value is the unsubscribe
// fn returned by PaneAgentSession.subscribe(). On sender destroy we
// walk this map and release everything that sender held.
type SubKey = string; // `${senderId}:${sessionPath}`
const subscriptions = new Map<SubKey, () => void>();
const subscriptionsBySender = new Map<number, Set<SubKey>>();
const pendingSubscriptions = new Map<SubKey, { sender: electron.WebContents; sessionPath: string; blockId?: string }>();

interface SendOptions {
    /** Existing session, if any. null on first send → main mints a fresh one. */
    sessionMetadata?: JsonlSessionMetadata | null;
    /** Parent terminal block ID for timeline marker persistence. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`agent IPC: ${fieldName} must be a non-empty string`);
    }
    return value;
}

function assertInsideSessionsDir(sessionPath: string, sessionsRoot: string, fieldName: string): void {
    const relative = path.relative(sessionsRoot, sessionPath);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`agent IPC: ${fieldName} is outside sessions directory`);
    }
}

async function validateSessionPath(value: unknown, fieldName = "sessionPath"): Promise<string> {
    const inputPath = requireNonEmptyString(value, fieldName);
    const [sessionPath, sessionsRoot] = await Promise.all([
        fs.realpath(inputPath),
        fs.realpath(defaultSessionsDir()),
    ]);
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
    fieldName: string,
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
    targetId: string;
    requestedPath: string;
}> {
    if (!isRecord(value)) throw new Error("agent IPC: navigateTree input must be an object");
    const { metadata, session, requestedPath } = await openValidatedSessionMetadata(value.sessionMetadata);
    const targetId = requireNonEmptyString(value.targetId, "targetId");
    await requireSessionEntry(session, targetId, "targetId");
    return { metadata, targetId, requestedPath };
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
    const model = (getModel as unknown as (p: string, m: string) => Model<Api> | undefined)(
        provider,
        modelId,
    );
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
    }
    // No credential resolved — let pi-ai try its own env-var fallback
    // (returning undefined means we don't override it). The provider's
    // own "no API key" error surfaces to the renderer if that also fails.
    return undefined;
}

async function ensurePaneSession(
    metadata: JsonlSessionMetadata,
    opts: SendOptions,
): Promise<PaneAgentSession> {
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
    // Diagnostic: the agent's LLM request goes out from the MAIN process
    // (Node fetch in pi-ai), so it never shows in the renderer's Network
    // tab. Log the resolved model config (never the key itself) so the
    // provider/model/baseUrl/key wiring is verifiable from the main
    // console (the `task electron:quickdev` terminal).
    console.log(
        `[agent-ipc] send → provider=${model.provider} model=${model.id} api=${model.api} ` +
            `baseUrl=${(model as { baseUrl?: string }).baseUrl ?? "(provider default)"} ` +
            `reasoning=${opts.reasoning ?? "off"} apiKey=${apiKey ? "present" : "MISSING"} ` +
            `(tokenSecretName=${opts.tokenSecretName ?? "-"})`,
    );
    const pane = buildPaneHarness({
        session: piSession,
        model,
        thinkingLevel: opts.reasoning,
        promptInputs: buildPromptInputs(opts),
        tools: getDefaultTools(opts.cwd),
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
                  : { allowAll: true },
        ),
    });
    // Wrap the harness in the per-session owner. Its constructor attaches
    // the harness subscription NOW (before any prompt() runs), so it owns
    // the authoritative transcript + queue state from the first event on —
    // never missing a turn that finishes before a renderer subscribes.
    // Seed it with the persisted transcript so a reopened session shows its
    // history (a fresh session's buildContext is empty).
    const seed = await piSession.buildContext();
    let initialRuns = [];
    if (opts.blockId) {
        const rows = await RpcApi.GetCmdBlocksCommand(ElectronWshClient, { blockid: opts.blockId });
        initialRuns = buildPersistedRunsFromSessionEntries(await piSession.getBranch(), rows ?? []);
    }
    let owner: PaneAgentSession;
    const onRunFinished = async (run: AgentRun): Promise<void> => {
        const operations = extractChangeOperationsFromMessages(run.responseMessages, { runId: run.runId });
        if (operations.length === 0) return;
        const changeOutline = await generateChangeOutline({
            model,
            operations,
            runId: run.runId,
            apiKey,
        });
        if (changeOutline) {
            owner.setRunChangeOutline(run.runId, changeOutline);
        }
    };
    owner = new PaneAgentSession(metadata.path, pane, seed.messages ?? [], initialRuns, { onRunFinished });
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

async function sendPersistedSnapshot(
    sender: electron.WebContents,
    sessionPath: string,
    blockId?: string,
): Promise<void> {
    let canonicalPath = sessionPath;
    try {
        canonicalPath = await validateSessionPath(sessionPath);
        const session = await openPaneSessionByPath(canonicalPath);
        const context = await session.buildContext();
        let runs = [];
        if (blockId) {
            const rows = await RpcApi.GetCmdBlocksCommand(ElectronWshClient, { blockid: blockId });
            runs = buildPersistedRunsFromSessionEntries(await session.getBranch(), rows ?? []);
        }
        if (sender.isDestroyed()) return;
        sender.send("agent:event", {
            sessionPath: canonicalPath,
            event: {
                type: "snapshot",
                messages: context.messages,
                runs,
                status: "idle",
                steer: [],
                followUp: [],
            },
        });
    } catch (err) {
        console.error(`[agent-ipc] persisted snapshot error for ${canonicalPath}:`, err);
    }
}

function subscribeToOwner(
    sender: electron.WebContents,
    sessionPath: string,
    session: PaneAgentSession,
): void {
    const key: SubKey = `${sender.id}:${sessionPath}`;
    pendingSubscriptions.delete(key);
    if (subscriptions.has(key)) return;
    const unsub = session.subscribe((agentEvent) => {
        if (sender.isDestroyed()) return;
        sender.send("agent:event", {
            sessionPath,
            event: {
                ...agentEvent,
                runs: session.getSnapshot().runs,
            },
        });
    });
    subscriptions.set(key, unsub);
    trackSenderKey(sender, key);
    const snapshot = session.getSnapshot();
    if (sender.isDestroyed()) return;
    sender.send("agent:event", {
        sessionPath,
        event: {
            type: "snapshot",
            messages: snapshot.messages,
            runs: snapshot.runs,
            status: snapshot.status,
            steer: snapshot.steerQueue,
            followUp: snapshot.followUpQueue,
        },
    });
}

function attachPendingSubscribers(sessionPath: string, session: PaneAgentSession): void {
    for (const [key, sender] of pendingSubscriptions) {
        if (sender.sessionPath !== sessionPath) continue;
        if (sender.sender.isDestroyed()) {
            pendingSubscriptions.delete(key);
            continue;
        }
        subscribeToOwner(sender.sender, sessionPath, session);
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

    const entries = (await session.getEntries()).filter((entry) => entry.type !== "leaf");
    const leafId = await session.getLeafId();
    const labels = new Map<string, string | undefined>();
    for (const entry of entries) {
        labels.set(entry.id, await session.getLabel(entry.id));
    }
    return { entries, leafId, labels };
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

export async function navigateAgentTreeForIpc(input: unknown): Promise<AgentNavigateTreeResult> {
    const { metadata, targetId, requestedPath } = await validateNavigateInput(input);
    const owner = sessionCache.get(metadata.path) ?? sessionCache.get(requestedPath);
    if (!owner) {
        throw new Error(`agent session is not active: ${metadata.path}`);
    }
    const result = await owner.navigateTree(targetId);
    return { sessionMetadata: metadata, ...result };
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
    const { metadata } = await forkPaneSession(
        sourceMetadata,
        { cwd, entryId: leafId, position: "at" },
    );
    return { sessionMetadata: metadata };
}

export async function abortAgentSessionForIpc(sessionPath: unknown): Promise<void> {
    const canonicalPath = await validateSessionPath(sessionPath);
    sessionCache.get(canonicalPath)?.abort();
}

export async function subscribeAgentSessionForIpc(
    sender: electron.WebContents,
    sessionPath: unknown,
    opts?: { blockId?: string },
): Promise<void> {
    const canonicalPath = await validateSessionPath(sessionPath);
    const session = sessionCache.get(canonicalPath);
    if (!session) {
        const key: SubKey = `${sender.id}:${canonicalPath}`;
        if (!pendingSubscriptions.has(key)) {
            pendingSubscriptions.set(key, { sender, sessionPath: canonicalPath, blockId: opts?.blockId });
            trackSenderKey(sender, key);
        }
        await sendPersistedSnapshot(sender, canonicalPath, opts?.blockId);
        return;
    }
    subscribeToOwner(sender, canonicalPath, session);
}

export async function unsubscribeAgentSessionForIpc(senderId: number, sessionPath: unknown): Promise<void> {
    const canonicalPath = await validateSessionPath(sessionPath);
    const key: SubKey = `${senderId}:${canonicalPath}`;
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
    electron.ipcMain.handle(
        "agent:create-session",
        async (_event, cwd: string): Promise<JsonlSessionMetadata> => {
            const { metadata } = await createPaneSession(cwd);
            return metadata;
        },
    );

    electron.ipcMain.handle(
        "agent:list-sessions-for-cwd",
        async (_event, cwd: string): Promise<JsonlSessionMetadata[]> => {
            return await listSessionsForCwd(cwd);
        },
    );

    electron.ipcMain.handle("agent:list-commands", (): AgentCommandInfo[] => {
        return listAgentCommandsForIpc();
    });

    electron.ipcMain.handle("agent:list-tree", async (_event, sessionMetadata: JsonlSessionMetadata): Promise<AgentTreeResult> => {
        return await listAgentTreeForIpc(sessionMetadata);
    });

    electron.ipcMain.handle(
        "agent:list-fork-points",
        async (_event, sessionMetadata: JsonlSessionMetadata): Promise<AgentForkPointView[]> => {
            return await listAgentForkPointsForIpc(sessionMetadata);
        },
    );

    electron.ipcMain.handle(
        "agent:navigate-tree",
        async (_event, input: AgentNavigateTreeInput): Promise<AgentNavigateTreeResult> => {
            return await navigateAgentTreeForIpc(input);
        },
    );

    electron.ipcMain.handle(
        "agent:fork-session",
        async (_event, input: AgentForkSessionInput): Promise<AgentForkSessionResult> => {
            return await forkAgentSessionForIpc(input);
        },
    );

    electron.ipcMain.handle(
        "agent:clone-session",
        async (_event, input: AgentCloneSessionInput): Promise<AgentCloneSessionResult> => {
            return await cloneAgentSessionForIpc(input);
        },
    );

    electron.ipcMain.handle(
        "agent:send",
        async (
            _event,
            opts: SendOptions,
        ): Promise<{ sessionMetadata: JsonlSessionMetadata; runId: string }> => {
            console.log(
                `[agent-ipc] agent:send provider=${opts.provider} model=${opts.model} ` +
                    `reasoning=${opts.reasoning ?? "off"} ` +
                    `cred=${opts.token ? "token" : opts.tokenSecretName ? `secret:${opts.tokenSecretName}` : "NONE"} ` +
                    `textLen=${opts.text?.length ?? 0}`,
            );
            const { metadata } = await ensureSession(opts);
            const session = await ensurePaneSession(metadata, opts);

            // Phase 1: main owns run identity. Generate a stable runId
            // (uuidv7 — time-ordered, globally unique, no coordination)
            // and persist the timeline marker row BEFORE starting the
            // prompt. The renderer no longer derives or persists run IDs.
            const runId = `run-${uuidv7()}`;
            if (opts.blockId) {
                try {
                    await RpcApi.AppendAgentRunCommand(ElectronWshClient, {
                        blockid: opts.blockId,
                        sessionpath: metadata.path,
                        runid: runId,
                    });
                } catch (err) {
                    console.error(`[agent-ipc] failed to persist timeline marker:`, err);
                }
            }

            session.send(runId, opts.text);
            return { sessionMetadata: metadata, runId };
        },
    );

    electron.ipcMain.on("agent:abort", (_event, sessionPath: string) => {
        void abortAgentSessionForIpc(sessionPath).catch((err) => {
            console.error("[agent-ipc] abort validation error:", err);
        });
    });

    electron.ipcMain.on("agent:subscribe", (event, sessionPath: string, opts?: { blockId?: string }) => {
        void subscribeAgentSessionForIpc(event.sender, sessionPath, opts).catch((err) => {
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
