// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// agent-session-runtime.ts — the per-session conversation OWNER.
//
// This is pi's `AgentSession` aggregator pattern, applied at the
// AgentHarness layer and adapted for crest's process split. pi's own
// coding-agent wraps the low-level `Agent` (which exposes synchronous
// `state.messages`) in an `AgentSession` that subscribes once, owns the
// authoritative transcript + the steer/followUp queues, and re-emits to
// the UI (packages/coding-agent/src/core/agent-session.ts:157/336/811).
//
// crest consumes the higher-level `AgentHarness` instead — the right
// layer for an embedder, because the harness bundles session persistence
// and queue management and is event-driven (the renderer lives in another
// process and can't read synchronous state across IPC anyway). What was
// missing was the *owner*: harness events were scattered into a loose Map
// (updated only on agent_end) and concurrent sends were handled by
// catching a "busy" error. This class is that single owner:
//
//   - subscribes to the harness ONCE at construction (before any prompt),
//   - maintains the authoritative `messages` from the live event stream
//     (message_start/update/end) and reconciles on agent_end,
//   - mirrors the steer/followUp queues from the harness's own
//     `queue_update` events,
//   - tracks run status (idle/streaming/error),
//   - routes send() to prompt-vs-followUp from its own synchronously
//     tracked run state — NOT by catching AgentHarnessError("busy"),
//   - re-emits the harness event stream to its subscribers (the IPC layer
//     registers one subscriber per renderer) and replays getSessionState() so
//     a late/re-subscribing renderer converges to the owned state.
//
// See docs/agent-rendering-architecture.md.

import type { SystemPromptInputs } from "./build-system-prompt";
import type { ChangeOutline } from "./change-review/change-outline";
import { filterTreeForDisplay } from "./commands/session-views";
import type { AgentHarnessHost } from "./harness-factory";
import type { AgentHarnessEvent, SessionTreeEntry } from "./harness/types";
import type { AgentMessage } from "./types";

export type AgentSessionRuntimeStatus = "idle" | "streaming" | "error";
export type AgentTurnStatus = "streaming" | "done" | "error";

export interface AgentTurn {
    // Identity of the turn = the session entry id of the user message that
    // started it (see applyMessageUpdateToTurn).
    turnId: string;
    userMessage?: AgentMessage;
    responseMessages: AgentMessage[];
    status: AgentTurnStatus;
    errorMessage?: string;
    changeOutline?: ChangeOutline;
}

/**
 * The owned conversation state at a point in time. Replayed to every new
 * subscriber so a renderer that attaches late (or re-attaches) mirrors the
 * authoritative state instead of reconstructing it from a partial stream.
 */
export interface AgentSessionRuntimeState {
    messages: AgentMessage[];
    turns: AgentTurn[];
    steerQueue: AgentMessage[];
    followUpQueue: AgentMessage[];
    status: AgentSessionRuntimeStatus;
    errorMessage?: string;
}

export type AgentSessionRuntimeListener = (event: AgentHarnessEvent) => void;
export type AgentTurnFinishedHook = (turn: AgentTurn) => void | Promise<void>;

interface AgentSessionRuntimeStateEvent {
    type: "session_state";
    messages: AgentMessage[];
    turns: AgentTurn[];
    status: AgentSessionRuntimeStatus;
    steer: AgentMessage[];
    followUp: AgentMessage[];
}

export interface AgentSessionRuntimeOptions {
    onTurnFinished?: AgentTurnFinishedHook;
}

function isErroredAssistant(message: AgentMessage): boolean {
    return (
        (message as { role?: string }).role === "assistant" &&
        (message as { stopReason?: string }).stopReason === "error"
    );
}

/**
 * Deterministic turn reconstruction from a session branch. The session is the
 * single source of truth: each user message entry starts a turn keyed by its
 * own entry id, and the following non-user messages (until the next user
 * entry) become its responses. This mirrors the live stream, where a turn's
 * identity is the user message's session entry id (see applyMessageUpdateToTurn).
 */
export function buildPersistedTurnsFromSessionEntries(entries: SessionTreeEntry[]): AgentTurn[] {
    const turns: AgentTurn[] = [];
    let current: AgentTurn | undefined;
    for (const entry of entries) {
        if (entry.type !== "message") continue;
        const message = entry.message as AgentMessage;
        const role = (message as { role?: string }).role;
        if (role === "user") {
            current = { turnId: entry.id, userMessage: message, responseMessages: [], status: "done" };
            turns.push(current);
        } else if (current && (role === "assistant" || role === "tool" || role === "toolResult")) {
            current.responseMessages = [...current.responseMessages, message];
            if (isErroredAssistant(message)) {
                current.status = "error";
                current.errorMessage = (message as { errorMessage?: string }).errorMessage ?? "agent error";
            }
        }
    }
    return turns;
}

export class AgentSessionRuntime {
    readonly path: string;
    host: AgentHarnessHost;

    messages: AgentMessage[] = [];
    turns: AgentTurn[] = [];
    steerQueue: AgentMessage[] = [];
    followUpQueue: AgentMessage[] = [];
    status: AgentSessionRuntimeStatus = "idle";
    errorMessage: string | undefined;
    activeTurnId: string | undefined;
    // Resolvers for in-flight send() promises, awaiting the userEntryId that
    // arrives on the user message_end event. FIFO: one resolver per send.
    private pendingEntryIdResolvers: Array<{ resolve: (id: string) => void; reject: (err: unknown) => void }> = [];

    // Synchronous send-routing gate. Flipped true the instant we call
    // prompt() (which itself flips the harness phase synchronously), so a
    // same-tick burst of sends routes deterministically: the first starts
    // the run, the rest queue via followUp. Cleared when the run settles.
    running = false;

    listeners = new Set<AgentSessionRuntimeListener>();
    unsubscribeHarness: () => void;
    onTurnFinished: AgentTurnFinishedHook | undefined;

    constructor(
        path: string,
        host: AgentHarnessHost,
        initialMessages: AgentMessage[] = [],
        initialTurns: AgentTurn[] = [],
        options: AgentSessionRuntimeOptions = {}
    ) {
        this.path = path;
        this.host = host;
        this.onTurnFinished = options.onTurnFinished;
        // Seed the transcript from the persisted session so a REOPENED
        // conversation shows its history. A fresh session passes []. New
        // messages then accumulate via the live stream on top of this.
        this.messages = initialMessages;
        this.turns = initialTurns;
        // Attach BEFORE any prompt() runs so we never miss events — this is
        // what closes the "fast turn finished before the renderer
        // subscribed" race; the owner has the history regardless.
        this.unsubscribeHarness = host.harness.subscribe((event) => this.onHarnessEvent(event as AgentHarnessEvent));
    }

    /** Refresh execution context (cwd / git / recent cmds) for the next turn. */
    update(inputs: SystemPromptInputs): void {
        this.host.update(inputs);
    }

    private onHarnessEvent(event: AgentHarnessEvent): void {
        // Update owned state FIRST so a subscriber that reads getSessionState()
        // synchronously inside its callback sees the post-event state.
        this.applyToState(event);
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                console.error(`[agent-session] listener error for ${this.path}:`, err);
            }
        }
    }

    private applyToState(event: AgentHarnessEvent): void {
        switch (event.type) {
            case "agent_start":
            case "turn_start":
                this.status = "streaming";
                this.errorMessage = undefined;
                return;
            case "message_start": {
                const message = (event as { message?: AgentMessage }).message;
                if (!message) return;
                this.messages = [...this.messages, message];
                this.applyMessageStartToTurn(message);
                return;
            }
            case "message_update":
            case "message_end": {
                const message = (event as { message?: AgentMessage }).message;
                if (!message) return;
                if (this.messages.length === 0) {
                    this.messages = [message];
                } else {
                    const next = this.messages.slice();
                    next[next.length - 1] = message;
                    this.messages = next;
                }
                if (event.type === "message_end" && isErroredAssistant(message)) {
                    this.status = "error";
                    this.errorMessage = (message as { errorMessage?: string }).errorMessage ?? "agent error";
                }
                this.applyMessageUpdateToTurn(
                    message,
                    event.type === "message_end",
                    (event as { entryId?: string }).entryId
                );
                return;
            }
            case "agent_end": {
                // NOTE: agent_end.messages is RUN-SCOPED — only this
                // prompt()'s new messages (agent-loop.ts builds it as
                // `[...prompts]` + responses), NOT the full conversation. So
                // we must NOT replace `this.messages` with it; doing so wipes
                // every prior run (the "…loading agent run…" bug). The live
                // message_start/message_end stream already accumulated the
                // full transcript on top of the seeded history. agent_end is
                // only a run-lifecycle signal here.
                this.running = false;
                this.finishActiveTurn();
                if (this.status !== "error") this.status = "idle";
                return;
            }
            case "queue_update": {
                this.steerQueue = (event as { steer?: AgentMessage[] }).steer ?? [];
                this.followUpQueue = (event as { followUp?: AgentMessage[] }).followUp ?? [];
                return;
            }
            case "abort": {
                this.running = false;
                this.finishActiveTurn(false);
                if (this.status !== "error") this.status = "idle";
                // Any send() still awaiting its userEntryId will never get one:
                // abort clears the harness followUpQueue (agent-harness.ts:999)
                // so a queued-but-undrained followUp never emits a user
                // message_end. Reject those promises now — otherwise they hang
                // forever AND leave a stale resolver at the FIFO head, which
                // would mis-resolve the NEXT send. See agent-harness abort().
                this.rejectPendingSends(new Error("send aborted before the user message was committed"));
                return;
            }
            default:
                return;
        }
    }

    getSessionState(): AgentSessionRuntimeState {
        return {
            messages: this.messages,
            turns: this.turns,
            steerQueue: this.steerQueue,
            followUpQueue: this.followUpQueue,
            status: this.status,
            errorMessage: this.errorMessage,
        };
    }

    subscribe(listener: AgentSessionRuntimeListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Send a user message. Resolves with the userEntryId of THIS send's user
     * message — the run identity, which only becomes known when the user
     * message_end event arrives (carrying the session entry id). Routes
     * prompt-vs-followUp from our own tracked run state — pi decides the same
     * way (it checks streaming state / queue mode before steer/followUp;
     * agent-session.ts:1225/1242), not by catching the harness "busy" error.
     * `running` flips synchronously so a burst of sends in one tick is
     * deterministic; prompt() flips the harness phase synchronously too, so a
     * followUp issued right after never hits the idle guard.
     */
    send(text: string): Promise<string> {
        const promise = new Promise<string>((resolve, reject) => {
            this.pendingEntryIdResolvers.push({ resolve, reject });
        });
        if (this.running) {
            void this.host.harness.followUp(text).catch((err) => this.onSendError("followUp", err));
            return promise;
        }
        this.running = true;
        void this.startPromptTurn(text);
        return promise;
    }

    abort(): void {
        void this.host.harness.abort().catch((err) => {
            console.error(`[agent-session] abort error for ${this.path}:`, err);
        });
    }

    async listTreeEntries(): Promise<{
        entries: SessionTreeEntry[];
        leafId: string | null;
        labels: Map<string, string | undefined>;
    }> {
        const allEntries = await this.host.session.getEntries();
        const leafId = await this.host.session.getLeafId();
        const { entries, effectiveLeafId } = filterTreeForDisplay(allEntries, leafId);
        const labels = new Map<string, string | undefined>();
        for (const entry of entries) {
            labels.set(entry.id, await this.host.session.getLabel(entry.id));
        }
        return { entries, leafId: effectiveLeafId, labels };
    }

    async navigateTree(targetId: string): Promise<{ editorText?: string }> {
        const result = await this.host.harness.navigateTree(targetId, { summarize: false });
        if (result.cancelled) {
            return {};
        }
        await this.rebuildFromCurrentBranch();
        this.emitSessionState();
        return { editorText: result.editorText };
    }

    async compact(customInstructions?: string): Promise<void> {
        await this.host.harness.compact(customInstructions);
        await this.rebuildFromCurrentBranch();
        this.emitSessionState();
    }

    async getLeafId(): Promise<string | null> {
        return this.host.session.getLeafId();
    }

    dispose(): void {
        this.unsubscribeHarness();
        this.listeners.clear();
        // Reject any send() promises still awaiting a userEntryId — the
        // abort below tears down the run, so their user message_end will
        // never arrive.
        this.rejectPendingSends(new Error("session disposed before the user message was committed"));
        void this.host.harness.abort().catch(() => {
            // best-effort on teardown
        });
    }

    private rejectPendingSends(err: unknown): void {
        const pending = this.pendingEntryIdResolvers;
        this.pendingEntryIdResolvers = [];
        for (const { reject } of pending) {
            reject(err);
        }
    }

    private onSendError(where: "prompt" | "followUp", err: unknown): void {
        this.running = false;
        this.status = "error";
        this.errorMessage = err instanceof Error ? err.message : String(err);
        const turn = this.getActiveTurn();
        if (turn) {
            turn.status = "error";
            turn.errorMessage = this.errorMessage;
            this.turns = this.turns.map((t) => (t.turnId === turn.turnId ? turn : t));
        }
        // The user message_end that would resolve a waiting send() will never
        // arrive on a prompt/followUp failure — reject the oldest pending
        // resolver so callers don't hang forever.
        const pending = this.pendingEntryIdResolvers.shift();
        pending?.reject(err);
        console.error(`[agent-session] ${where} error for ${this.path}:`, err);
    }

    private async startPromptTurn(text: string): Promise<void> {
        try {
            await this.host.harness.prompt(text);
        } catch (err) {
            this.onSendError("prompt", err);
        } finally {
            this.running = false;
        }
    }

    private ensureTurn(turnId: string): AgentTurn {
        const existing = this.turns.find((turn) => turn.turnId === turnId);
        if (existing) return existing;
        const turn: AgentTurn = { turnId, responseMessages: [], status: "streaming" };
        this.turns = [...this.turns, turn];
        return turn;
    }

    private getActiveTurn(): AgentTurn | undefined {
        if (!this.activeTurnId) return undefined;
        return this.turns.find((turn) => turn.turnId === this.activeTurnId);
    }

    private setTurn(nextTurn: AgentTurn): void {
        this.turns = this.turns.map((turn) => (turn.turnId === nextTurn.turnId ? nextTurn : turn));
    }

    setTurnChangeOutline(turnId: string, changeOutline: ChangeOutline | undefined): void {
        const turn = this.turns.find((item) => item.turnId === turnId);
        if (!turn) return;
        this.setTurn({ ...turn, changeOutline });
        this.emitTurnUpdate();
    }

    private applyMessageStartToTurn(message: AgentMessage): void {
        const role = (message as { role?: string }).role;
        // User turns open on message_end (where the entryId — the turn
        // identity — is available), not here. A user message_start only
        // accumulates the transcript; we defer turn bookkeeping.
        if (role === "user") return;
        const turn = this.getActiveTurn();
        if (!turn) return;
        this.setTurn({
            ...turn,
            responseMessages: [...turn.responseMessages, message],
            status: "streaming",
            errorMessage: undefined,
        });
    }

    private applyMessageUpdateToTurn(message: AgentMessage, isEnd: boolean, entryId?: string): void {
        const role = (message as { role?: string }).role;
        if (role === "user") {
            // The turn's identity IS the user message's session entry id. It
            // only becomes known on message_end, so we open/identify the turn
            // here and resolve the matching send() promise.
            if (isEnd && entryId) {
                this.activeTurnId = entryId;
                const turn = this.ensureTurn(entryId);
                this.setTurn({ ...turn, userMessage: message, status: "streaming", errorMessage: undefined });
                const pending = this.pendingEntryIdResolvers.shift();
                pending?.resolve(entryId);
                return;
            }
            const turn = this.getActiveTurn();
            if (!turn) return;
            this.setTurn({ ...turn, userMessage: message });
            return;
        }
        const turn = this.getActiveTurn();
        if (!turn) return;
        const responseMessages = turn.responseMessages.length === 0 ? [message] : turn.responseMessages.slice();
        responseMessages[responseMessages.length - 1] = message;
        const errored = isEnd && isErroredAssistant(message);
        this.setTurn({
            ...turn,
            responseMessages,
            status: errored ? "error" : turn.status,
            errorMessage: errored
                ? ((message as { errorMessage?: string }).errorMessage ?? "agent error")
                : turn.errorMessage,
        });
    }

    private finishActiveTurn(notifyFinished = true): void {
        const turn = this.getActiveTurn();
        let finishedTurn = turn;
        if (turn && turn.status !== "error") {
            finishedTurn = { ...turn, status: "done" };
            this.setTurn(finishedTurn);
        }
        this.activeTurnId = undefined;
        if (notifyFinished && finishedTurn?.status === "done") {
            this.notifyTurnFinished(finishedTurn);
        }
    }

    private notifyTurnFinished(turn: AgentTurn): void {
        if (!this.onTurnFinished) return;
        void Promise.resolve(this.onTurnFinished(turn)).catch((err) => {
            console.error(`[agent-session] onTurnFinished error for ${this.path}:`, err);
        });
    }

    private async rebuildFromCurrentBranch(): Promise<void> {
        const entries = await this.host.session.getBranch();
        this.messages = entries
            .filter((entry): entry is Extract<SessionTreeEntry, { type: "message" }> => entry.type === "message")
            .map((entry) => entry.message as AgentMessage);
        this.turns = buildPersistedTurnsFromSessionEntries(entries);
        this.steerQueue = [];
        this.followUpQueue = [];
        this.status = "idle";
        this.errorMessage = undefined;
        this.activeTurnId = undefined;
        this.running = false;
    }

    private emitSessionState(): void {
        const event: AgentSessionRuntimeStateEvent = {
            type: "session_state",
            messages: this.messages,
            turns: this.turns,
            status: this.status,
            steer: this.steerQueue,
            followUp: this.followUpQueue,
        };
        for (const listener of this.listeners) {
            try {
                listener(event as unknown as AgentHarnessEvent);
            } catch (err) {
                console.error(`[agent-session] listener error for ${this.path}:`, err);
            }
        }
    }

    private emitTurnUpdate(): void {
        const event = { type: "agent_turn_update" } as unknown as AgentHarnessEvent;
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                console.error(`[agent-session] listener error for ${this.path}:`, err);
            }
        }
    }
}
