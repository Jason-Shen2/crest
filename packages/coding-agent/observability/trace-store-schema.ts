// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export const TraceStoreSchemaSql = `
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  name TEXT,
  session_id TEXT,
  timestamp TEXT NOT NULL,
  ended_at TEXT,
  environment TEXT NOT NULL,
  tags TEXT NOT NULL,
  release TEXT,
  version TEXT,
  input TEXT,
  output TEXT,
  metadata TEXT NOT NULL,
  user_id TEXT,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_observation_id TEXT,
  type TEXT NOT NULL,
  name TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  level TEXT NOT NULL,
  status_message TEXT,
  version TEXT,
  model TEXT,
  provider TEXT,
  input TEXT,
  output TEXT,
  metadata TEXT NOT NULL,
  latency REAL,
  time_to_first_token REAL,
  usage_details TEXT NOT NULL,
  cost_details TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_names TEXT,
  FOREIGN KEY(trace_id) REFERENCES traces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  observation_id TEXT,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  data_type TEXT NOT NULL,
  value TEXT,
  comment TEXT,
  FOREIGN KEY(trace_id) REFERENCES traces(id) ON DELETE CASCADE,
  FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_traces_session_id ON traces(session_id);
CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON traces(timestamp);
CREATE INDEX IF NOT EXISTS idx_observations_trace_id ON observations(trace_id);
CREATE INDEX IF NOT EXISTS idx_scores_trace_id ON scores(trace_id);
`;
