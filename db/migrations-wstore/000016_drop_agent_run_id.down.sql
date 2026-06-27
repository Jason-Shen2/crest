ALTER TABLE db_cmdblock ADD COLUMN agent_run_id TEXT;
CREATE INDEX idx_cmdblock_agent_run ON db_cmdblock(blockid, kind, agent_run_id);
