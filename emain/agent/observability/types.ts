// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type TraceStatus = "running" | "success" | "error" | "aborted";

export type ObservationType =
    | "SPAN"
    | "EVENT"
    | "GENERATION"
    | "AGENT"
    | "TOOL"
    | "CHAIN"
    | "RETRIEVER"
    | "EVALUATOR"
    | "EMBEDDING"
    | "GUARDRAIL";

export type ObservationLevel = "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";

export type ScoreSource = "API" | "EVAL" | "ANNOTATION";

export type ScoreDataType = "NUMERIC" | "CATEGORICAL" | "BOOLEAN" | "CORRECTION" | "TEXT";

export interface Trace {
    id: string;
    name: string | null;
    timestamp: string;
    environment: string;
    tags: string[];
    release: string | null;
    version: string | null;
    input: unknown;
    output: unknown;
    metadata: Record<string, unknown>;
    sessionId: string | null;
    userId: string | null;
    status: TraceStatus;
    endedAt?: string;
}

export interface Observation {
    id: string;
    traceId: string;
    type: ObservationType;
    startTime: string;
    endTime: string | null;
    name: string | null;
    metadata: Record<string, unknown>;
    parentObservationId: string | null;
    level: ObservationLevel;
    statusMessage: string | null;
    version: string | null;
    model: string | null;
    input: unknown;
    output: unknown;
    latency: number | null;
    timeToFirstToken: number | null;
    usageDetails: Record<string, number>;
    costDetails: Record<string, number>;
    toolCalls: string[] | null;
    toolCallNames: string[] | null;
}

export interface Score {
    id: string;
    traceId: string;
    observationId: string | null;
    name: string;
    source: ScoreSource;
    dataType: ScoreDataType;
    value: unknown;
    comment: string | null;
}

export interface TraceDetail {
    trace: Trace;
    observations: Observation[];
    scores: Score[];
    corrections: Score[];
}

export interface TraceBuilderEventInput {
    sessionPath: string;
    event: { type: string; [key: string]: unknown };
}
