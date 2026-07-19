// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { LangfuseObservation, LangfuseTrace, TraceBuilderEventInput, TraceGraph, TraceStatus } from "./types";

type BuilderClock = () => string;
type BuilderIdFactory = (prefix: "trace" | "observation" | "score") => string;

export interface LangfuseTraceBuilderOptions {
    now?: BuilderClock;
    createId?: BuilderIdFactory;
    environment?: string;
}

interface BuilderState {
    graph: TraceGraph;
    rootObservationId: string;
    activeGenerationId?: string;
    activeToolObservationIds: Map<string, string>;
}

function defaultCreateId(prefix: "trace" | "observation" | "score"): string {
    return `${prefix}-${crypto.randomUUID()}`;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value != null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isAssistantMessage(message: unknown): message is {
    role: "assistant";
    content?: Array<{ type: string; text?: string }>;
    usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        totalTokens?: number;
        cost?: Record<string, number>;
    };
    stopReason?: string;
    errorMessage?: string;
} {
    return asRecord(message).role === "assistant";
}

function isUserMessage(message: unknown): message is { role: "user"; content?: Array<{ type: string; text?: string }> } {
    return asRecord(message).role === "user";
}

function assistantText(message: { content?: Array<{ type: string; text?: string }> }): string {
    if (!Array.isArray(message.content)) return "";
    return message.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
}

function messageText(message: { content?: Array<{ type: string; text?: string }> }): string {
    return assistantText(message);
}

function usageDetails(usage: ReturnType<typeof asRecord>): Record<string, number> {
    const details: Record<string, number> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
        const value = usage[key];
        if (typeof value === "number") details[key] = value;
    }
    return details;
}

function costDetails(usage: ReturnType<typeof asRecord>): Record<string, number> {
    const cost = asRecord(usage.cost);
    const details: Record<string, number> = {};
    for (const [key, value] of Object.entries(cost)) {
        if (typeof value === "number") details[key] = value;
    }
    return details;
}

function cloneGraph(graph: TraceGraph): TraceGraph {
    return {
        trace: { ...graph.trace, tags: [...graph.trace.tags], metadata: { ...graph.trace.metadata } },
        observations: graph.observations.map((observation) => ({
            ...observation,
            metadata: { ...observation.metadata },
            usageDetails: { ...observation.usageDetails },
            costDetails: { ...observation.costDetails },
            toolCalls: observation.toolCalls == null ? null : [...observation.toolCalls],
            toolCallNames: observation.toolCallNames == null ? null : [...observation.toolCallNames],
        })),
        scores: graph.scores.map((score) => ({ ...score })),
    };
}

export class LangfuseTraceBuilder {
    private readonly now: BuilderClock;
    private readonly createId: BuilderIdFactory;
    private readonly environment: string;
    private readonly states = new Map<string, BuilderState>();

    constructor(options: LangfuseTraceBuilderOptions = {}) {
        this.now = options.now ?? (() => new Date().toISOString());
        this.createId = options.createId ?? defaultCreateId;
        this.environment = options.environment ?? "local";
    }

    // Pure reducer over the AgentHarness subscriber stream:
    // (BuilderState, AgentHarnessEvent) => TraceGraph. The event union is
    // exactly what AgentHarness.subscribe() delivers — raw AgentEvent
    // (agent_start / message_* / tool_execution_* / agent_end, emitted via
    // emitAny) plus the own events broadcast via emitOwn
    // (after_provider_response / model_select / session_compact /
    // session_tree / abort / settled).
    //
    // Hook-only events (before_agent_start / before_provider_request /
    // tool_call / tool_result) are dispatched via emitHook and NEVER reach
    // a subscriber, so they are intentionally absent here. Any enrichment
    // that today only exists on those hook payloads (system prompt, gating
    // reason, rich tool details) must be surfaced by having the harness
    // emitOwn a broadcast event — not by observing the hook channel.
    applyEvent(input: TraceBuilderEventInput): TraceGraph | undefined {
        switch (input.event.type) {
            case "agent_start":
                return this.startTrace(input.sessionPath, input.event);
            case "message_start":
                return this.handleMessageStart(input.sessionPath, input.event.message);
            case "after_provider_response":
                return this.updateGenerationResponse(input.sessionPath, input.event);
            case "message_end":
                return this.handleMessageEnd(input.sessionPath, input.event);
            case "tool_execution_start":
                return this.startTool(input.sessionPath, input.event);
            case "tool_execution_end":
                return this.endTool(input.sessionPath, input.event);
            case "model_select":
                return this.addEvent(input.sessionPath, "model_change", input.event);
            case "session_compact":
                return this.addEvent(input.sessionPath, "compaction", input.event);
            case "session_tree":
                return this.addEvent(input.sessionPath, "branch_nav", input.event);
            case "abort":
                return this.finishTrace(input.sessionPath, "aborted", input.event);
            case "agent_end":
                return this.finishTrace(input.sessionPath, "success", input.event);
            case "settled":
                return this.finishTrace(input.sessionPath, "success", input.event);
            default:
                return this.snapshot(input.sessionPath);
        }
    }

    getTraceGraph(sessionPath: string): TraceGraph | undefined {
        return this.snapshot(sessionPath);
    }

    private startTrace(sessionPath: string, event: Record<string, unknown>): TraceGraph {
        const traceId = this.createId("trace");
        const rootObservationId = this.createId("observation");
        const timestamp = this.now();
        const prompt = typeof event.prompt === "string" ? event.prompt : null;
        const trace: LangfuseTrace = {
            id: traceId,
            name: "agent_run",
            timestamp,
            environment: this.environment,
            tags: ["crest", "agent"],
            release: null,
            version: null,
            input: prompt,
            output: null,
            metadata: { sessionPath },
            sessionId: sessionPath,
            userId: null,
            status: "running",
        };
        const rootObservation = this.makeObservation({
            id: rootObservationId,
            traceId,
            type: "AGENT",
            name: "agent",
            input: prompt,
            metadata: {
                systemPrompt: event.systemPrompt,
                resources: event.resources,
            },
        });
        const state: BuilderState = {
            graph: { trace, observations: [rootObservation], scores: [] },
            rootObservationId,
            activeToolObservationIds: new Map(),
        };
        this.states.set(sessionPath, state);
        return cloneGraph(state.graph);
    }

    private handleMessageStart(sessionPath: string, message: unknown): TraceGraph | undefined {
        if (!isAssistantMessage(message)) return this.snapshot(sessionPath);
        const state = this.requireState(sessionPath);
        if (!state || state.activeGenerationId) return state ? cloneGraph(state.graph) : undefined;
        const observation = this.makeObservation({
            traceId: state.graph.trace.id,
            type: "GENERATION",
            name: "assistant_response",
            parentObservationId: state.rootObservationId,
            input: null,
        });
        state.activeGenerationId = observation.id;
        state.graph.observations.push(observation);
        return cloneGraph(state.graph);
    }

    private updateGenerationResponse(sessionPath: string, event: Record<string, unknown>): TraceGraph | undefined {
        const state = this.requireState(sessionPath);
        const observation = state ? this.findObservation(state, state.activeGenerationId) : undefined;
        if (!state || !observation) return undefined;
        observation.metadata = {
            ...observation.metadata,
            status: event.status,
            headers: event.headers,
        };
        return cloneGraph(state.graph);
    }

    private endGenerationFromMessage(sessionPath: string, message: unknown): TraceGraph | undefined {
        const state = this.requireState(sessionPath);
        const observation = state ? this.findObservation(state, state.activeGenerationId) : undefined;
        if (!state || !observation || !isAssistantMessage(message)) return state ? cloneGraph(state.graph) : undefined;
        const usage = asRecord(message.usage);
        observation.endTime = this.now();
        observation.output = assistantText(message);
        observation.usageDetails = usageDetails(usage);
        observation.costDetails = costDetails(usage);
        if (message.stopReason === "error") {
            observation.level = "ERROR";
            observation.statusMessage = message.errorMessage ?? "Generation failed";
            state.graph.trace.status = "error";
        }
        state.activeGenerationId = undefined;
        return cloneGraph(state.graph);
    }

    private handleMessageEnd(sessionPath: string, event: Record<string, unknown>): TraceGraph | undefined {
        if (isUserMessage(event.message)) {
            return this.updateTraceInputFromUserMessage(sessionPath, event);
        }
        return this.endGenerationFromMessage(sessionPath, event.message);
    }

    private updateTraceInputFromUserMessage(sessionPath: string, event: Record<string, unknown>): TraceGraph | undefined {
        const state = this.requireState(sessionPath);
        if (!state || !isUserMessage(event.message)) return state ? cloneGraph(state.graph) : undefined;
        const text = messageText(event.message);
        if (state.graph.trace.input == null && text) {
            state.graph.trace.input = text;
        }
        if (typeof event.entryId === "string") {
            state.graph.trace.metadata = {
                ...state.graph.trace.metadata,
                userEntryId: event.entryId,
            };
        }
        state.graph.observations[0].input = state.graph.trace.input;
        return cloneGraph(state.graph);
    }

    private startTool(sessionPath: string, event: Record<string, unknown>): TraceGraph | undefined {
        const state = this.requireState(sessionPath);
        if (!state) return undefined;
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : this.createId("observation");
        const toolName =
            typeof event.toolName === "string" ? event.toolName : typeof event.name === "string" ? event.name : "tool";
        const observation = this.makeObservation({
            traceId: state.graph.trace.id,
            type: "TOOL",
            name: toolName,
            parentObservationId: state.rootObservationId,
            input: event.input ?? event.args ?? null,
            toolCalls: [toolCallId],
            toolCallNames: [toolName],
        });
        state.activeToolObservationIds.set(toolCallId, observation.id);
        state.graph.observations.push(observation);
        return cloneGraph(state.graph);
    }

    private endTool(sessionPath: string, event: Record<string, unknown>): TraceGraph | undefined {
        const state = this.requireState(sessionPath);
        if (!state) return undefined;
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        const observation = this.findObservation(state, toolCallId ? state.activeToolObservationIds.get(toolCallId) : undefined);
        if (!observation) return cloneGraph(state.graph);
        const toolName = typeof event.toolName === "string" ? event.toolName : observation.name ?? "tool";
        const isError = event.isError === true;
        observation.endTime = this.now();
        observation.output = {
            content: event.content ?? event.result ?? null,
            details: event.details ?? null,
        };
        if (isError) {
            observation.level = "ERROR";
            observation.statusMessage = `Tool ${toolName} failed`;
        }
        if (toolCallId) state.activeToolObservationIds.delete(toolCallId);
        return cloneGraph(state.graph);
    }

    private addEvent(sessionPath: string, name: string, event: Record<string, unknown>): TraceGraph | undefined {
        const state = this.requireState(sessionPath);
        if (!state) return undefined;
        const observation = this.makeObservation({
            traceId: state.graph.trace.id,
            type: "EVENT",
            name,
            parentObservationId: state.rootObservationId,
            input: event,
        });
        observation.endTime = observation.startTime;
        state.graph.observations.push(observation);
        return cloneGraph(state.graph);
    }

    private finishTrace(sessionPath: string, status: TraceStatus, event: Record<string, unknown>): TraceGraph | undefined {
        const state = this.requireState(sessionPath);
        if (!state) return undefined;
        const endedAt = this.now();
        state.graph.trace.status = state.graph.trace.status === "error" ? "error" : status;
        state.graph.trace.endedAt = endedAt;
        state.graph.trace.output = event;
        for (const observation of state.graph.observations) {
            if (observation.endTime == null) observation.endTime = endedAt;
        }
        return cloneGraph(state.graph);
    }

    private makeObservation(input: Partial<LangfuseObservation> & { traceId: string; type: LangfuseObservation["type"] }): LangfuseObservation {
        return {
            id: input.id ?? this.createId("observation"),
            traceId: input.traceId,
            type: input.type,
            startTime: input.startTime ?? this.now(),
            endTime: input.endTime ?? null,
            name: input.name ?? null,
            metadata: input.metadata ?? {},
            parentObservationId: input.parentObservationId ?? null,
            level: input.level ?? "DEFAULT",
            statusMessage: input.statusMessage ?? null,
            version: input.version ?? null,
            model: input.model ?? null,
            input: input.input ?? null,
            output: input.output ?? null,
            latency: input.latency ?? null,
            timeToFirstToken: input.timeToFirstToken ?? null,
            usageDetails: input.usageDetails ?? {},
            costDetails: input.costDetails ?? {},
            toolCalls: input.toolCalls ?? null,
            toolCallNames: input.toolCallNames ?? null,
        };
    }

    private requireState(sessionPath: string): BuilderState | undefined {
        return this.states.get(sessionPath);
    }

    private findObservation(state: BuilderState, observationId: string | undefined): LangfuseObservation | undefined {
        if (!observationId) return undefined;
        return state.graph.observations.find((observation) => observation.id === observationId);
    }

    private snapshot(sessionPath: string): TraceGraph | undefined {
        const state = this.states.get(sessionPath);
        return state ? cloneGraph(state.graph) : undefined;
    }
}
