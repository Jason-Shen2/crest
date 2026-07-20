// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
    Observation,
    Score,
    ScoreDataType,
    ScoreSource,
    Trace,
    ObservationLevel,
    ObservationType,
    TraceStatus,
} from "./types";

export type TraceRow = {
    id: string;
    name: string | null;
    session_id: string | null;
    timestamp: string;
    ended_at: string | null;
    environment: string;
    tags: string;
    release: string | null;
    version: string | null;
    input: string | null;
    output: string | null;
    metadata: string;
    user_id: string | null;
    status: string;
};

export type ObservationRow = {
    id: string;
    trace_id: string;
    parent_observation_id: string | null;
    type: string;
    name: string | null;
    start_time: string;
    end_time: string | null;
    level: string;
    status_message: string | null;
    version: string | null;
    model: string | null;
    provider: string | null;
    input: string | null;
    output: string | null;
    metadata: string;
    latency: number | null;
    time_to_first_token: number | null;
    usage_details: string;
    cost_details: string;
    tool_calls: string | null;
    tool_call_names: string | null;
};

export type ScoreRow = {
    id: string;
    trace_id: string;
    observation_id: string | null;
    name: string;
    source: string;
    data_type: string;
    value: string | null;
    comment: string | null;
};

function stringify(value: unknown): string | null {
    return value == null ? null : JSON.stringify(value);
}

function stringifyRequired(value: unknown): string {
    return JSON.stringify(value ?? {});
}

function parseJson(value: string | null): unknown {
    return value == null ? null : JSON.parse(value);
}

function parseRecord(value: string): Record<string, unknown> {
    const parsed = JSON.parse(value);
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseNumberRecord(value: string): Record<string, number> {
    const parsed = parseRecord(value);
    const output: Record<string, number> = {};
    for (const [key, item] of Object.entries(parsed)) {
        if (typeof item === "number") output[key] = item;
    }
    return output;
}

function parseStringArray(value: string | null): string[] | null {
    if (value == null) return null;
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : null;
}

export function traceToRow(trace: Trace): TraceRow {
    return {
        id: trace.id,
        name: trace.name,
        session_id: trace.sessionId,
        timestamp: trace.timestamp,
        ended_at: trace.endedAt ?? null,
        environment: trace.environment,
        tags: JSON.stringify(trace.tags),
        release: trace.release,
        version: trace.version,
        input: stringify(trace.input),
        output: stringify(trace.output),
        metadata: stringifyRequired(trace.metadata),
        user_id: trace.userId,
        status: trace.status,
    };
}

export function traceFromRow(row: TraceRow): Trace {
    return {
        id: row.id,
        name: row.name,
        sessionId: row.session_id,
        timestamp: row.timestamp,
        endedAt: row.ended_at ?? undefined,
        environment: row.environment,
        tags: parseStringArray(row.tags) ?? [],
        release: row.release,
        version: row.version,
        input: parseJson(row.input),
        output: parseJson(row.output),
        metadata: parseRecord(row.metadata),
        userId: row.user_id,
        status: row.status as TraceStatus,
    };
}

export function observationToRow(observation: Observation): ObservationRow {
    return {
        id: observation.id,
        trace_id: observation.traceId,
        parent_observation_id: observation.parentObservationId,
        type: observation.type,
        name: observation.name,
        start_time: observation.startTime,
        end_time: observation.endTime,
        level: observation.level,
        status_message: observation.statusMessage,
        version: observation.version,
        model: observation.model,
        provider: typeof observation.metadata.provider === "string" ? observation.metadata.provider : null,
        input: stringify(observation.input),
        output: stringify(observation.output),
        metadata: stringifyRequired(observation.metadata),
        latency: observation.latency,
        time_to_first_token: observation.timeToFirstToken,
        usage_details: stringifyRequired(observation.usageDetails),
        cost_details: stringifyRequired(observation.costDetails),
        tool_calls: stringify(observation.toolCalls),
        tool_call_names: stringify(observation.toolCallNames),
    };
}

export function observationFromRow(row: ObservationRow): Observation {
    return {
        id: row.id,
        traceId: row.trace_id,
        parentObservationId: row.parent_observation_id,
        type: row.type as ObservationType,
        name: row.name,
        startTime: row.start_time,
        endTime: row.end_time,
        level: row.level as ObservationLevel,
        statusMessage: row.status_message,
        version: row.version,
        model: row.model,
        input: parseJson(row.input),
        output: parseJson(row.output),
        metadata: parseRecord(row.metadata),
        latency: row.latency,
        timeToFirstToken: row.time_to_first_token,
        usageDetails: parseNumberRecord(row.usage_details),
        costDetails: parseNumberRecord(row.cost_details),
        toolCalls: parseStringArray(row.tool_calls),
        toolCallNames: parseStringArray(row.tool_call_names),
    };
}

export function scoreToRow(score: Score): ScoreRow {
    return {
        id: score.id,
        trace_id: score.traceId,
        observation_id: score.observationId,
        name: score.name,
        source: score.source,
        data_type: score.dataType,
        value: stringify(score.value),
        comment: score.comment,
    };
}

export function scoreFromRow(row: ScoreRow): Score {
    return {
        id: row.id,
        traceId: row.trace_id,
        observationId: row.observation_id,
        name: row.name,
        source: row.source as ScoreSource,
        dataType: row.data_type as ScoreDataType,
        value: parseJson(row.value),
        comment: row.comment,
    };
}
