DROP INDEX IF EXISTS idx_cmdblock_agent_run;
ALTER TABLE db_cmdblock DROP COLUMN agent_session_path;
ALTER TABLE db_cmdblock DROP COLUMN agent_run_id;
ALTER TABLE db_cmdblock DROP COLUMN kind;
