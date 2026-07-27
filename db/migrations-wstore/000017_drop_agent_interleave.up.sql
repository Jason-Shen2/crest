DELETE FROM db_cmdblock WHERE kind = 'agent';
DROP INDEX IF EXISTS idx_cmdblock_agent_user_entry;
ALTER TABLE db_cmdblock DROP COLUMN agent_session_path;
ALTER TABLE db_cmdblock DROP COLUMN agent_user_entry_id;
