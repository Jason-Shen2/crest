// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { defaultConfigHome } from "../sessions";
import { SqliteDb } from "../harness/session/sqlite-driver";
import { TraceStoreSchemaSql } from "./trace-store-schema";
import {
    observationFromRow,
    observationToRow,
    scoreToRow,
    traceFromRow,
    traceToRow,
    type ObservationRow,
    type TraceRow,
} from "./trace-store-rows";
import type { TraceGraph } from "./types";

export interface TraceStore {
    saveGraph(graph: TraceGraph): void;
    listTraces(sessionId?: string): TraceGraph["trace"][];
    getTraceGraph(traceId: string, sessionId?: string): TraceGraph | undefined;
}

export function defaultTraceStorePath(): string {
    return path.join(defaultConfigHome(), "observability", "traces.db");
}

export class SqliteTraceStore implements TraceStore {
    private readonly db: SqliteDb;

    constructor(location = defaultTraceStorePath()) {
        mkdirSync(path.dirname(location), { recursive: true });
        this.db = new SqliteDb(location);
        this.db.exec(TraceStoreSchemaSql);
    }

    saveGraph(graph: TraceGraph): void {
        const trace = traceToRow(graph.trace);
        this.db.run(
            `INSERT OR REPLACE INTO traces
             (id, name, session_id, timestamp, ended_at, environment, tags, release, version, input, output, metadata, user_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            trace.id,
            trace.name,
            trace.session_id,
            trace.timestamp,
            trace.ended_at,
            trace.environment,
            trace.tags,
            trace.release,
            trace.version,
            trace.input,
            trace.output,
            trace.metadata,
            trace.user_id,
            trace.status
        );

        for (const observation of graph.observations.map(observationToRow)) {
            this.db.run(
                `INSERT OR REPLACE INTO observations
                 (id, trace_id, parent_observation_id, type, name, start_time, end_time, level, status_message, version, model, provider, input, output, metadata, latency, time_to_first_token, usage_details, cost_details, tool_calls, tool_call_names)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                observation.id,
                observation.trace_id,
                observation.parent_observation_id,
                observation.type,
                observation.name,
                observation.start_time,
                observation.end_time,
                observation.level,
                observation.status_message,
                observation.version,
                observation.model,
                observation.provider,
                observation.input,
                observation.output,
                observation.metadata,
                observation.latency,
                observation.time_to_first_token,
                observation.usage_details,
                observation.cost_details,
                observation.tool_calls,
                observation.tool_call_names
            );
        }

        for (const score of graph.scores.map(scoreToRow)) {
            this.db.run(
                `INSERT OR REPLACE INTO scores
                 (id, trace_id, observation_id, name, source, data_type, value, comment)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                score.id,
                score.trace_id,
                score.observation_id,
                score.name,
                score.source,
                score.data_type,
                score.value,
                score.comment
            );
        }
    }

    listTraces(sessionId?: string): TraceGraph["trace"][] {
        const rows =
            sessionId == null
                ? this.db.all<TraceRow>("SELECT * FROM traces ORDER BY timestamp DESC")
                : this.db.all<TraceRow>("SELECT * FROM traces WHERE session_id = ? ORDER BY timestamp DESC", sessionId);
        return rows.map(traceFromRow);
    }

    getTraceGraph(traceId: string, sessionId?: string): TraceGraph | undefined {
        const traceRow =
            sessionId == null
                ? this.db.get<TraceRow>("SELECT * FROM traces WHERE id = ?", traceId)
                : this.db.get<TraceRow>("SELECT * FROM traces WHERE id = ? AND session_id = ?", traceId, sessionId);
        if (!traceRow) return undefined;
        const observationRows = this.db.all<ObservationRow>(
            "SELECT * FROM observations WHERE trace_id = ? ORDER BY start_time ASC",
            traceId
        );
        return {
            trace: traceFromRow(traceRow),
            observations: observationRows.map(observationFromRow),
            scores: [],
        };
    }

    close(): void {
        this.db.close();
    }
}
