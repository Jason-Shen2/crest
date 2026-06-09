ALTER TABLE db_cmdblock ADD COLUMN kind TEXT NOT NULL DEFAULT 'shell';
ALTER TABLE db_cmdblock ADD COLUMN agent_run_id TEXT;
ALTER TABLE db_cmdblock ADD COLUMN agent_session_path TEXT;

CREATE INDEX idx_cmdblock_agent_run ON db_cmdblock(blockid, kind, agent_run_id);
