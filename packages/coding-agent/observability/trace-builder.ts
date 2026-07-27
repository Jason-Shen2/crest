// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Observation, Trace, TraceBuilderEventInput, TraceDetail, TraceStatus } from "./types";

type BuilderClock = () => string;
type BuilderIdFactory = (prefix: "trace" | "observation" | "score") => string;

export interface TraceBuilderOptions {
    now?: BuilderClock;
    createId?: BuilderIdFactory;
    environment?: string;
}

interface BuilderState {
    detail: TraceDetail;
    rootObservationId: string;
    currentTurnObservationId?: string;
    nextTurnIndex: number;
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
    model?: string;
    responseModel?: string;
    provider?: string;
    timestamp?: number;
} {
    return asRecord(message).role === "assistant";
}

function isUserMessage(
    message: unknown
): message is { role: "user"; content?: Array<{ type: string; text?: string }> } {
    return asRecord(message).role === "user";
}

function assistantText(message: { content?: Array<{ type: string; text?: string }> }): string {
    if (!Array.isArray(message.content)) return "";
    return message.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
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

function elapsedSeconds(startTime: string, endTime: string): number | null {
    const elapsedMs = Date.parse(endTime) - Date.parse(startTime);
    return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs / 1000 : null;
}

function cloneTraceDetail(detail: TraceDetail): TraceDetail {
    return {
        trace: { ...detail.trace, tags: [...detail.trace.tags], metadata: { ...detail.trace.metadata } },
        observations: detail.observations.map((observation) => ({
            ...observation,
            metadata: { ...observation.metadata },
            usageDetails: { ...observation.usageDetails },
            costDetails: { ...observation.costDetails },
            toolCalls: observation.toolCalls == null ? null : [...observation.toolCalls],
            toolCallNames: observation.toolCallNames == null ? null : [...observation.toolCallNames],
        })),
        scores: detail.scores.map((score) => ({ ...score })),
        corrections: detail.corrections.map((correction) => ({ ...correction })),
    };
}

export class TraceBuilder {
    private readonly now: BuilderClock;
    private readonly createId: BuilderIdFactory;
    private readonly environment: string;
    private readonly states = new Map<string, BuilderState>();

    constructor(options: TraceBuilderOptions = {}) {
        this.now = options.now ?? (() => new Date().toISOString());
        this.createId = options.createId ?? defaultCreateId;
        this.environment = options.environment ?? "local";
    }

    // Pure reducer over the AgentHarness subscriber stream:
    // (BuilderState, AgentHarnessEvent) => TraceDetail. The event union is
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
    applyEvent(input: TraceBuilderEventInput): TraceDetail | undefined {
        switch (input.event.type) {
            case "agent_start":
                return this.startTrace(input.sessionPath, input.event);
            case "turn_start":
                return this.startTurn(input.sessionPath);
            case "turn_end":
                return this.endTurn(input.sessionPath, input.event);
            case "message_start":
                return this.handleMessageStart(input.sessionPath, input.event.message);
            case "message_update":
                return this.updateGenerationFromMessage(input.sessionPath, input.event);
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

    getTraceDetail(sessionPath: string): TraceDetail | undefined {
        return this.snapshot(sessionPath);
    }

    private startTrace(sessionPath: string, event: Record<string, unknown>): TraceDetail {
        const traceId = this.createId("trace");
        const rootObservationId = this.createId("observation");
        const timestamp = this.now();
        const prompt = typeof event.prompt === "string" ? event.prompt : null;
        const trace: Trace = {
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
            detail: { trace, observations: [rootObservation], scores: [], corrections: [] },
            rootObservationId,
            nextTurnIndex: 0,
            activeToolObservationIds: new Map(),
        };
        this.states.set(sessionPath, state);
        return cloneTraceDetail(state.detail);
    }

    private startTurn(sessionPath: string): TraceDetail | undefined {
        const state = this.requireState(sessionPath);
        if (!state) return undefined;

        const now = this.now();
        const currentTurn = this.findObservation(state, state.currentTurnObservationId);
        if (currentTurn && currentTurn.endTime == null) {
            currentTurn.endTime = now;
            currentTurn.latency = elapsedSeconds(currentTurn.startTime, currentTurn.endTime);
        }

        const turnIndex = state.nextTurnIndex++;
        const turn = this.makeObservation({
            traceId: state.detail.trace.id,
            type: "SPAN",
            name: "turn",
            parentObservationId: state.rootObservationId,
            startTime: now,
            metadata: { turnIndex },
        });
        state.detail.observations.push(turn);
        state.currentTurnObservationId = turn.id;
        return cloneTraceDetail(state.detail);
    }

    private endTurn(sessionPath: string, event: Record<string, unknown>): TraceDetail | undefined {
        const state = this.requireState(sessionPath);
        const turn = state ? this.findObservation(state, state.currentTurnObservationId) : undefined;
        if (!state || !turn) return state ? cloneTraceDetail(state.detail) : undefined;

        const endedAt = this.now();
        turn.endTime = endedAt;
        turn.latency = elapsedSeconds(turn.startTime, endedAt);
        if (isAssistantMessage(event.message)) {
            turn.output = assistantText(event.message);
        }
        const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
        turn.metadata = {
            ...turn.metadata,
            toolResultCount: toolResults.length,
        };
        state.currentTurnObservationId = undefined;
        return cloneTraceDetail(state.detail);
    }

    private handleMessageStart(sessionPath: string, message: unknown): TraceDetail | undefined {
        if (!isAssistantMessage(message)) return this.snapshot(sessionPath);
        const state = this.requireState(sessionPath);
        if (!state || state.activeGenerationId) return state ? cloneTraceDetail(state.detail) : undefined;
        const observation = this.makeObservation({
            traceId: state.detail.trace.id,
            type: "GENERATION",
            name: "assistant_response",
            parentObservationId: this.currentParentObservationId(state),
            startTime: Number.isFinite(message.timestamp) ? new Date(message.timestamp).toISOString() : undefined,
            input: null,
        });
        this.updateGenerationModel(observation, message);
        state.activeGenerationId = observation.id;
        state.detail.observations.push(observation);
        return cloneTraceDetail(state.detail);
    }

    private updateGenerationResponse(sessionPath: string, event: Record<string, unknown>): TraceDetail | undefined {
        const state = this.requireState(sessionPath);
        const observation = state ? this.findObservation(state, state.activeGenerationId) : undefined;
        if (!state || !observation) return undefined;
        observation.metadata = {
            ...observation.metadata,
            status: event.status,
            headers: event.headers,
        };
        return cloneTraceDetail(state.detail);
    }

    private updateGenerationFromMessage(sessionPath: string, event: Record<string, unknown>): TraceDetail | undefined {
        const state = this.requireState(sessionPath);
        const observation = state ? this.findObservation(state, state.activeGenerationId) : undefined;
        const message = event.message;
        if (!state || !observation || !isAssistantMessage(message)) {
            return state ? cloneTraceDetail(state.detail) : undefined;
        }
        observation.output = assistantText(message);
        this.updateGenerationModel(observation, message);
        const updateType = asRecord(event.assistantMessageEvent).type;
        if (
            observation.timeToFirstToken == null &&
            (updateType === "text_delta" || updateType === "thinking_delta" || updateType === "toolcall_delta")
        ) {
            observation.timeToFirstToken = elapsedSeconds(observation.startTime, this.now());
        }
        return cloneTraceDetail(state.detail);
    }

    private endGenerationFromMessage(sessionPath: string, message: unknown): TraceDetail | undefined {
        const state = this.requireState(sessionPath);
        const observation = state ? this.findObservation(state, state.activeGenerationId) : undefined;
        if (!state || !observation || !isAssistantMessage(message))
            return state ? cloneTraceDetail(state.detail) : undefined;
        const usage = asRecord(message.usage);
        observation.endTime = this.now();
        observation.latency = elapsedSeconds(observation.startTime, observation.endTime);
        this.updateGenerationModel(observation, message);
        observation.output = assistantText(message);
        observation.usageDetails = usageDetails(usage);
        observation.costDetails = costDetails(usage);
        if (message.stopReason === "error") {
            observation.level = "ERROR";
            observation.statusMessage = message.errorMessage ?? "Generation failed";
            state.detail.trace.status = "error";
        }
        state.activeGenerationId = undefined;
        return cloneTraceDetail(state.detail);
    }

    private updateGenerationModel(
        observation: Observation,
        message: {
            model?: string;
            responseModel?: string;
            provider?: string;
        }
    ): void {
        const model = message.responseModel ?? message.model;
        if (model != null) observation.model = model;
        if (message.provider != null) observation.metadata.provider = message.provider;
        if (message.model != null) observation.metadata.requestedModel = message.model;
    }

    private handleMessageEnd(sessionPath: string, event: Record<string, unknown>): TraceDetail | undefined {
        if (isAssistantMessage(event.message)) {
            return this.endGenerationFromMessage(sessionPath, event.message);
        }
        if (isUserMessage(event.message)) {
            return this.updateTraceInputFromUserMessage(sessionPath, event);
        }
        if (asRecord(event.message).role === "toolResult") {
            return this.snapshot(sessionPath);
        }
        const state = this.requireState(sessionPath);
        if (!state) return undefined;
        this.appendTraceInput(state, event);
        this.appendCurrentTurnInput(state, event);
        return cloneTraceDetail(state.detail);
    }

    private updateTraceInputFromUserMessage(
        sessionPath: string,
        event: Record<string, unknown>
    ): TraceDetail | undefined {
        const state = this.requireState(sessionPath);
        if (!state || !isUserMessage(event.message)) return state ? cloneTraceDetail(state.detail) : undefined;
        this.appendTraceInput(state, event);
        this.appendCurrentTurnInput(state, event);
        return cloneTraceDetail(state.detail);
    }

    private startTool(sessionPath: string, event: Record<string, unknown>): TraceDetail | undefined {
        const state = this.requireState(sessionPath);
        if (!state) return undefined;
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : this.createId("observation");
        const toolName =
            typeof event.toolName === "string" ? event.toolName : typeof event.name === "string" ? event.name : "tool";
        const observation = this.makeObservation({
            traceId: state.detail.trace.id,
            type: "TOOL",
            name: toolName,
            parentObservationId: this.currentParentObservationId(state),
            input: event.input ?? event.args ?? null,
            toolCalls: [toolCallId],
            toolCallNames: [toolName],
        });
        state.activeToolObservationIds.set(toolCallId, observation.id);
        state.detail.observations.push(observation);
        return cloneTraceDetail(state.detail);
    }

    private endTool(sessionPath: string, event: Record<string, unknown>): TraceDetail | undefined {
        const state = this.requireState(sessionPath);
        if (!state) return undefined;
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        const observation = this.findObservation(
            state,
            toolCallId ? state.activeToolObservationIds.get(toolCallId) : undefined
        );
        if (!observation) return cloneTraceDetail(state.detail);
        const toolName = typeof event.toolName === "string" ? event.toolName : (observation.name ?? "tool");
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
        return cloneTraceDetail(state.detail);
    }

    private addEvent(sessionPath: string, name: string, event: Record<string, unknown>): TraceDetail | undefined {
        const state = this.requireState(sessionPath);
        if (!state) return undefined;
        const observation = this.makeObservation({
            traceId: state.detail.trace.id,
            type: "EVENT",
            name,
            parentObservationId: this.currentParentObservationId(state),
            input: event,
        });
        observation.endTime = observation.startTime;
        state.detail.observations.push(observation);
        return cloneTraceDetail(state.detail);
    }

    private finishTrace(
        sessionPath: string,
        status: TraceStatus,
        event: Record<string, unknown>
    ): TraceDetail | undefined {
        const state = this.requireState(sessionPath);
        if (!state) return undefined;
        const endedAt = this.now();
        state.detail.trace.status = state.detail.trace.status === "error" ? "error" : status;
        state.detail.trace.endedAt = endedAt;
        state.detail.trace.output = event;
        for (const observation of state.detail.observations) {
            if (observation.endTime == null) observation.endTime = endedAt;
        }
        return cloneTraceDetail(state.detail);
    }

    private makeObservation(input: Partial<Observation> & { traceId: string; type: Observation["type"] }): Observation {
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

    private findObservation(state: BuilderState, observationId: string | undefined): Observation | undefined {
        if (!observationId) return undefined;
        return state.detail.observations.find((observation) => observation.id === observationId);
    }

    private currentParentObservationId(state: BuilderState): string {
        return state.currentTurnObservationId ?? state.rootObservationId;
    }

    private promptPayload(event: Record<string, unknown>): Record<string, unknown> {
        const entryId = typeof event.entryId === "string" ? event.entryId : undefined;
        return {
            ...asRecord(event.message),
            ...(entryId ? { entryId } : {}),
        };
    }

    private appendTraceInput(state: BuilderState, event: Record<string, unknown>): void {
        const messages = Array.isArray(state.detail.trace.input) ? state.detail.trace.input : [];
        state.detail.trace.input = [...messages, this.promptPayload(event)];
        state.detail.observations[0].input = state.detail.trace.input;
    }

    private appendCurrentTurnInput(state: BuilderState, event: Record<string, unknown>): void {
        const turn = this.findObservation(state, state.currentTurnObservationId);
        if (!turn) return;
        const messages = Array.isArray(turn.input) ? turn.input : [];
        turn.input = [...messages, this.promptPayload(event)];
    }

    private snapshot(sessionPath: string): TraceDetail | undefined {
        const state = this.states.get(sessionPath);
        return state ? cloneTraceDetail(state.detail) : undefined;
    }
}
