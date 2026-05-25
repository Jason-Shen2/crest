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
import type { PaneHarness } from "./harness-factory";
import type { AgentHarnessEvent } from "./harness/types";
import type { AgentMessage } from "./types";

export type PaneSessionStatus = "idle" | "streaming" | "error";

/**
 * The owned conversation state at a point in time. Replayed to every new
 * subscriber so a renderer that attaches late (or re-attaches) mirrors the
 * authoritative state instead of reconstructing it from a partial stream.
 */
export interface PaneSessionSnapshot {
    messages: AgentMessage[];
    steerQueue: AgentMessage[];
    followUpQueue: AgentMessage[];
    status: PaneSessionStatus;
    errorMessage?: string;
}

export type PaneSessionListener = (event: AgentHarnessEvent) => void;

function isErroredAssistant(message: AgentMessage): boolean {
    return (
        (message as { role?: string }).role === "assistant" &&
        (message as { stopReason?: string }).stopReason === "error"
    );
}

export class PaneAgentSession {
    readonly path: string;
    pane: PaneHarness;

    messages: AgentMessage[] = [];
    steerQueue: AgentMessage[] = [];
    followUpQueue: AgentMessage[] = [];
    status: PaneSessionStatus = "idle";
    errorMessage: string | undefined;

    // Synchronous send-routing gate. Flipped true the instant we call
    // prompt() (which itself flips the harness phase synchronously), so a
    // same-tick burst of sends routes deterministically: the first starts
    // the run, the rest queue via followUp. Cleared when the run settles.
    running = false;

    listeners = new Set<PaneSessionListener>();
    unsubscribeHarness: () => void;

    constructor(path: string, pane: PaneHarness) {
        this.path = path;
        this.pane = pane;
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
                return;
            }
            case "agent_end": {
                // Authoritative transcript for the whole run — reconcile any
                // drift from the streamed deltas.
                const messages = (event as { messages?: AgentMessage[] }).messages;
                if (Array.isArray(messages)) this.messages = messages;
                this.running = false;
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
    send(text: string): void {
        if (this.running) {
            void this.pane.harness.followUp(text).catch((err) => this.onSendError("followUp", err));
            return;
        }
        this.running = true;
        void this.pane.harness
            .prompt(text)
            .catch((err) => this.onSendError("prompt", err))
            .finally(() => {
                this.running = false;
            });
    }

    abort(): void {
        void this.pane.harness.abort().catch((err) => {
            console.error(`[pane-session] abort error for ${this.path}:`, err);
        });
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
        console.error(`[pane-session] ${where} error for ${this.path}:`, err);
    }
}
