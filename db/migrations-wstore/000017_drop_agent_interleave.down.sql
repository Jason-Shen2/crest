ALTER TABLE db_cmdblock ADD COLUMN agent_session_path TEXT;
ALTER TABLE db_cmdblock ADD COLUMN agent_user_entry_id TEXT;
CREATE INDEX idx_cmdblock_agent_user_entry ON db_cmdblock(blockid, kind, agent_user_entry_id);
