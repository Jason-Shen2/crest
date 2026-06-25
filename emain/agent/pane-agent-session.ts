// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// pane-agent-session.ts — the per-session conversation OWNER.
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
//     registers one subscriber per renderer) and replays getSnapshot() so
//     a late/re-subscribing renderer converges to the owned state.
//
// See docs/agent-rendering-architecture.md.

import type { SystemPromptInputs } from "./build-system-prompt";
import type { ChangeOutline } from "./change-review/change-outline";
import type { PaneHarness } from "./harness-factory";
import type { AgentHarnessEvent } from "./harness/types";
import type { SessionTreeEntry } from "./harness/types";
import type { AgentMessage } from "./types";

export type PaneSessionStatus = "idle" | "streaming" | "error";
export type AgentRunStatus = "streaming" | "done" | "error";
export const AgentRunSessionEntryType = "agent_run";

export interface AgentRun {
    runId: string;
    userMessage?: AgentMessage;
    responseMessages: AgentMessage[];
    status: AgentRunStatus;
    errorMessage?: string;
    changeOutline?: ChangeOutline;
}

export interface AgentTimelineRef {
    agentrunid?: string;
    seq?: number;
}

interface AgentRunSessionEntryData {
    runId?: string;
}

/**
 * The owned conversation state at a point in time. Replayed to every new
 * subscriber so a renderer that attaches late (or re-attaches) mirrors the
 * authoritative state instead of reconstructing it from a partial stream.
 */
export interface PaneSessionSnapshot {
    messages: AgentMessage[];
    runs: AgentRun[];
    steerQueue: AgentMessage[];
    followUpQueue: AgentMessage[];
    status: PaneSessionStatus;
    errorMessage?: string;
}

export type PaneSessionListener = (event: AgentHarnessEvent) => void;
export type PaneRunFinishedHook = (run: AgentRun) => void | Promise<void>;

interface PaneSnapshotEvent {
    type: "snapshot";
    messages: AgentMessage[];
    runs: AgentRun[];
    status: PaneSessionStatus;
    steer: AgentMessage[];
    followUp: AgentMessage[];
}

export interface PaneAgentSessionOptions {
    onRunFinished?: PaneRunFinishedHook;
}

function isErroredAssistant(message: AgentMessage): boolean {
    return (
        (message as { role?: string }).role === "assistant" &&
        (message as { stopReason?: string }).stopReason === "error"
    );
}

export function buildPersistedRunsFromTimeline(
    messages: AgentMessage[],
    timelineRefs: AgentTimelineRef[],
): AgentRun[] {
    const refs = timelineRefs
        .filter((ref) => ref.agentrunid)
        .slice()
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const runs: AgentRun[] = [];
    let current: AgentRun | undefined;
    let refIndex = 0;

    for (const message of messages) {
        const role = (message as { role?: string }).role;
        if (role === "user") {
            const ref = refs[refIndex++];
            if (!ref?.agentrunid) {
                current = undefined;
                continue;
            }
            current = {
                runId: ref.agentrunid,
                userMessage: message,
                responseMessages: [],
                status: "done",
            };
            runs.push(current);
            continue;
        }
        if (!current) continue;
        current.responseMessages = [...current.responseMessages, message];
        if (isErroredAssistant(message)) {
            current.status = "error";
            current.errorMessage = (message as { errorMessage?: string }).errorMessage ?? "agent error";
        }
    }

    return runs;
}

function getRunIdFromSessionEntry(entry: SessionTreeEntry): string | undefined {
    if (entry.type !== "custom") return undefined;
    if (entry.customType !== AgentRunSessionEntryType) return undefined;
    const data = entry.data as AgentRunSessionEntryData | undefined;
    return typeof data?.runId === "string" && data.runId ? data.runId : undefined;
}

export function buildPersistedRunsFromSessionEntries(
    entries: SessionTreeEntry[],
    timelineRefs: AgentTimelineRef[] = [],
): AgentRun[] {
    const runs: AgentRun[] = [];
    const messages: AgentMessage[] = [];
    let current: AgentRun | undefined;

    for (const entry of entries) {
        const runId = getRunIdFromSessionEntry(entry);
        if (runId) {
            current = { runId, responseMessages: [], status: "done" };
            runs.push(current);
            continue;
        }
        if (entry.type !== "message") continue;
        const message = entry.message as AgentMessage;
        messages.push(message);
        if (!current) continue;
        const role = (message as { role?: string }).role;
        if (role === "user" && !current.userMessage) {
            current.userMessage = message;
            continue;
        }
        current.responseMessages = [...current.responseMessages, message];
        if (isErroredAssistant(message)) {
            current.status = "error";
            current.errorMessage = (message as { errorMessage?: string }).errorMessage ?? "agent error";
        }
    }

    if (runs.length > 0) return runs;
    return buildPersistedRunsFromTimeline(messages, timelineRefs);
}

export class PaneAgentSession {
    readonly path: string;
    pane: PaneHarness;

    messages: AgentMessage[] = [];
    runs: AgentRun[] = [];
    steerQueue: AgentMessage[] = [];
    followUpQueue: AgentMessage[] = [];
    status: PaneSessionStatus = "idle";
    errorMessage: string | undefined;
    activeRunId: string | undefined;
    pendingRunIds: string[] = [];

    // Synchronous send-routing gate. Flipped true the instant we call
    // prompt() (which itself flips the harness phase synchronously), so a
    // same-tick burst of sends routes deterministically: the first starts
    // the run, the rest queue via followUp. Cleared when the run settles.
    running = false;

    listeners = new Set<PaneSessionListener>();
    unsubscribeHarness: () => void;
    onRunFinished: PaneRunFinishedHook | undefined;

    constructor(
        path: string,
        pane: PaneHarness,
        initialMessages: AgentMessage[] = [],
        initialRuns: AgentRun[] = [],
        options: PaneAgentSessionOptions = {},
    ) {
        this.path = path;
        this.pane = pane;
        this.onRunFinished = options.onRunFinished;
        // Seed the transcript from the persisted session so a REOPENED
        // conversation shows its history. A fresh session passes []. New
        // messages then accumulate via the live stream on top of this.
        this.messages = initialMessages;
        this.runs = initialRuns;
        // Attach BEFORE any prompt() runs so we never miss events — this is
        // what closes the "fast turn finished before the renderer
        // subscribed" race; the owner has the history regardless.
        this.unsubscribeHarness = pane.harness.subscribe((event) =>
            this.onHarnessEvent(event as AgentHarnessEvent),
        );
    }

    /** Refresh pane context (cwd / git / recent cmds) for the next turn. */
    update(inputs: SystemPromptInputs): void {
        this.pane.update(inputs);
    }

    private onHarnessEvent(event: AgentHarnessEvent): void {
        // Update owned state FIRST so a subscriber that reads getSnapshot()
        // synchronously inside its callback sees the post-event state.
        this.applyToState(event);
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                console.error(`[pane-session] listener error for ${this.path}:`, err);
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
                this.applyMessageStartToRun(message);
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
                    this.errorMessage =
                        (message as { errorMessage?: string }).errorMessage ?? "agent error";
                }
                this.applyMessageUpdateToRun(message, event.type === "message_end");
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
                this.finishActiveRun();
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
                this.finishActiveRun(false);
                if (this.status !== "error") this.status = "idle";
                return;
            }
            default:
                return;
        }
    }

    getSnapshot(): PaneSessionSnapshot {
        return {
            messages: this.messages,
            runs: this.runs,
            steerQueue: this.steerQueue,
            followUpQueue: this.followUpQueue,
            status: this.status,
            errorMessage: this.errorMessage,
        };
    }

    subscribe(listener: PaneSessionListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Send a user message. Routes prompt-vs-followUp from our own tracked
     * run state — pi decides the same way (it checks streaming state /
     * queue mode before steer/followUp; agent-session.ts:1225/1242), not by
     * catching the harness "busy" error. `running` flips synchronously so a
     * burst of sends in one tick is deterministic; prompt() flips the
     * harness phase synchronously too, so a followUp issued right after
     * never hits the idle guard.
     */
    send(runId: string, text: string): void {
        this.ensureRun(runId);
        if (this.running) {
            this.pendingRunIds = [...this.pendingRunIds, runId];
            void this.pane.harness.followUp(text).catch((err) => this.onSendError("followUp", err));
            return;
        }
        this.running = true;
        this.activeRunId = runId;
        void this.startPromptRun(runId, text);
    }

    abort(): void {
        void this.pane.harness.abort().catch((err) => {
            console.error(`[pane-session] abort error for ${this.path}:`, err);
        });
    }

    async listTreeEntries(): Promise<{
        entries: SessionTreeEntry[];
        leafId: string | null;
        labels: Map<string, string | undefined>;
    }> {
        const entries = (await this.pane.session.getEntries()).filter((entry) => entry.type !== "leaf");
        const leafId = await this.pane.session.getLeafId();
        const labels = new Map<string, string | undefined>();
        for (const entry of entries) {
            labels.set(entry.id, await this.pane.session.getLabel(entry.id));
        }
        return { entries, leafId, labels };
    }

    async navigateTree(targetId: string): Promise<{ editorText?: string }> {
        const result = await this.pane.harness.navigateTree(targetId, { summarize: false });
        if (result.cancelled) {
            return {};
        }
        await this.rebuildFromCurrentBranch();
        this.emitSnapshot();
        return { editorText: result.editorText };
    }

    async getLeafId(): Promise<string | null> {
        return this.pane.session.getLeafId();
    }

    dispose(): void {
        this.unsubscribeHarness();
        this.listeners.clear();
        void this.pane.harness.abort().catch(() => {
            // best-effort on teardown
        });
    }

    private onSendError(where: "prompt" | "followUp", err: unknown): void {
        this.running = false;
        this.status = "error";
        this.errorMessage = err instanceof Error ? err.message : String(err);
        const run = this.getActiveRun();
        if (run) {
            run.status = "error";
            run.errorMessage = this.errorMessage;
            this.runs = this.runs.map((r) => (r.runId === run.runId ? run : r));
        }
        console.error(`[pane-session] ${where} error for ${this.path}:`, err);
    }

    private async startPromptRun(runId: string, text: string): Promise<void> {
        try {
            await this.pane.promptWithCustomEntry(AgentRunSessionEntryType, { runId }, text);
        } catch (err) {
            this.onSendError("prompt", err);
        } finally {
            this.running = false;
        }
    }

    private ensureRun(runId: string): AgentRun {
        const existing = this.runs.find((run) => run.runId === runId);
        if (existing) return existing;
        const run: AgentRun = { runId, responseMessages: [], status: "streaming" };
        this.runs = [...this.runs, run];
        return run;
    }

    private getActiveRun(): AgentRun | undefined {
        if (!this.activeRunId) return undefined;
        return this.runs.find((run) => run.runId === this.activeRunId);
    }

    private setRun(nextRun: AgentRun): void {
        this.runs = this.runs.map((run) => (run.runId === nextRun.runId ? nextRun : run));
    }

    setRunChangeOutline(runId: string, changeOutline: ChangeOutline | undefined): void {
        const run = this.runs.find((item) => item.runId === runId);
        if (!run) return;
        this.setRun({ ...run, changeOutline });
        this.emitRunUpdate();
    }

    private applyMessageStartToRun(message: AgentMessage): void {
        const role = (message as { role?: string }).role;
        if (role === "user" && !this.activeRunId) {
            const nextRunId = this.pendingRunIds.shift();
            if (nextRunId) this.activeRunId = nextRunId;
        }
        const run = this.getActiveRun();
        if (!run) return;
        if (role === "user") {
            this.setRun({ ...run, userMessage: message, status: "streaming", errorMessage: undefined });
            return;
        }
        this.setRun({
            ...run,
            responseMessages: [...run.responseMessages, message],
            status: "streaming",
            errorMessage: undefined,
        });
    }

    private applyMessageUpdateToRun(message: AgentMessage, isEnd: boolean): void {
        const role = (message as { role?: string }).role;
        const run = this.getActiveRun();
        if (!run) return;
        if (role === "user") {
            this.setRun({ ...run, userMessage: message });
            return;
        }
        const responseMessages = run.responseMessages.length === 0 ? [message] : run.responseMessages.slice();
        responseMessages[responseMessages.length - 1] = message;
        const errored = isEnd && isErroredAssistant(message);
        this.setRun({
            ...run,
            responseMessages,
            status: errored ? "error" : run.status,
            errorMessage: errored ? ((message as { errorMessage?: string }).errorMessage ?? "agent error") : run.errorMessage,
        });
    }

    private finishActiveRun(notifyFinished = true): void {
        const run = this.getActiveRun();
        let finishedRun = run;
        if (run && run.status !== "error") {
            finishedRun = { ...run, status: "done" };
            this.setRun(finishedRun);
        }
        this.activeRunId = undefined;
        if (notifyFinished && finishedRun?.status === "done") {
            this.notifyRunFinished(finishedRun);
        }
    }

    private notifyRunFinished(run: AgentRun): void {
        if (!this.onRunFinished) return;
        void Promise.resolve(this.onRunFinished(run)).catch((err) => {
            console.error(`[pane-session] onRunFinished error for ${this.path}:`, err);
        });
    }

    private async rebuildFromCurrentBranch(): Promise<void> {
        const entries = await this.pane.session.getBranch();
        this.messages = entries
            .filter((entry): entry is Extract<SessionTreeEntry, { type: "message" }> => entry.type === "message")
            .map((entry) => entry.message as AgentMessage);
        this.runs = buildPersistedRunsFromSessionEntries(entries);
        this.steerQueue = [];
        this.followUpQueue = [];
        this.status = "idle";
        this.errorMessage = undefined;
        this.activeRunId = undefined;
        this.pendingRunIds = [];
        this.running = false;
    }

    private emitSnapshot(): void {
        const event: PaneSnapshotEvent = {
            type: "snapshot",
            messages: this.messages,
            runs: this.runs,
            status: this.status,
            steer: this.steerQueue,
            followUp: this.followUpQueue,
        };
        for (const listener of this.listeners) {
            try {
                listener(event as unknown as AgentHarnessEvent);
            } catch (err) {
                console.error(`[pane-session] listener error for ${this.path}:`, err);
            }
        }
    }

    private emitRunUpdate(): void {
        const event = { type: "agent_run_update" } as AgentHarnessEvent;
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                console.error(`[pane-session] listener error for ${this.path}:`, err);
            }
        }
    }
}
