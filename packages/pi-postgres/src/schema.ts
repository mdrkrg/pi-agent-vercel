import type { SqlExecutor } from "./sql.ts";

export const CREATE_PI_POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS pi_poc_sessions (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  storage_version INTEGER NOT NULL,
  parent_session_id TEXT
);

CREATE TABLE IF NOT EXISTS pi_poc_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO pi_poc_schema_migrations (version) VALUES ('2026-09-control-state-v1') ON CONFLICT (version) DO NOTHING;
INSERT INTO pi_poc_schema_migrations (version) VALUES ('2026-09-control-state-v2') ON CONFLICT (version) DO NOTHING;

CREATE TABLE IF NOT EXISTS agent_session_leases (
  session_id TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  fencing_epoch BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS pi_poc_storage_sequences (
  session_id TEXT PRIMARY KEY,
  next_seq BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS pi_poc_storage_entries (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT,
  seq BIGINT NOT NULL,
  timestamp_ms BIGINT NOT NULL,
  entry_type TEXT NOT NULL,
  custom_type TEXT,
  payload JSONB NOT NULL,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS pi_poc_storage_entries_seq_idx
  ON pi_poc_storage_entries (session_id, seq);

CREATE INDEX IF NOT EXISTS pi_poc_storage_entries_parent_idx
  ON pi_poc_storage_entries (session_id, parent_id);

CREATE TABLE IF NOT EXISTS pi_poc_storage_values (
  session_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  value_key TEXT NOT NULL,
  seq BIGINT NOT NULL,
  value JSONB NOT NULL,
  PRIMARY KEY (session_id, namespace, value_key)
);

CREATE INDEX IF NOT EXISTS pi_poc_storage_values_namespace_idx
  ON pi_poc_storage_values (session_id, namespace, value_key);

CREATE TABLE IF NOT EXISTS pi_poc_storage_lists (
  session_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  list_key TEXT NOT NULL,
  seq BIGINT NOT NULL,
  value JSONB NOT NULL,
  PRIMARY KEY (session_id, namespace, list_key, seq)
);

CREATE INDEX IF NOT EXISTS pi_poc_storage_lists_read_idx
  ON pi_poc_storage_lists (session_id, namespace, list_key, seq);

CREATE TABLE IF NOT EXISTS pi_poc_storage_usage (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  entry_id TEXT,
  adjustment BOOLEAN NOT NULL,
  usage JSONB NOT NULL,
  details JSONB,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, seq)
);

CREATE TABLE IF NOT EXISTS agent_submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  operation_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
  result_ref TEXT,
  error_code TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (user_id, tenant_id, session_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS agent_submissions_session_idx ON agent_submissions (session_id, created_at);

CREATE TABLE IF NOT EXISTS agent_delegated_tasks (
  id TEXT PRIMARY KEY,
  parent_submission_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
  checkpoint_ref TEXT,
  artifact_ref TEXT,
  error_code TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
-- Forward-compatible migrations for databases created by the earlier PoC schema.
ALTER TABLE agent_submissions ADD COLUMN IF NOT EXISTS request_hash TEXT;
UPDATE agent_submissions SET request_hash = COALESCE(request_hash, 'legacy:' || id) WHERE request_hash IS NULL;
ALTER TABLE agent_submissions ALTER COLUMN request_hash SET NOT NULL;
ALTER TABLE agent_submissions DROP COLUMN IF EXISTS prompt;
ALTER TABLE agent_delegated_tasks ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
UPDATE agent_delegated_tasks SET idempotency_key = id WHERE idempotency_key IS NULL;
ALTER TABLE agent_delegated_tasks ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE agent_delegated_tasks DROP CONSTRAINT IF EXISTS agent_delegated_tasks_status_check;
ALTER TABLE agent_delegated_tasks ADD CONSTRAINT agent_delegated_tasks_status_check CHECK (status IN ('accepted', 'running', 'waiting', 'completed', 'failed', 'cancelled'));
CREATE UNIQUE INDEX IF NOT EXISTS agent_delegated_tasks_idempotency_idx_v2 ON agent_delegated_tasks (parent_submission_id, idempotency_key);

CREATE INDEX IF NOT EXISTS pi_poc_storage_usage_seq_idx
  ON pi_poc_storage_usage (session_id, seq);
`;

export async function ensurePiPostgresSchema(executor: SqlExecutor): Promise<void> {
	// Multiple fresh Function processes may bootstrap concurrently. PostgreSQL's
	// IF NOT EXISTS checks do not make a multi-table DDL batch race-free, so use
	// a transaction-scoped advisory lock around the schema bootstrap.
	await executor.transaction(async (transaction) => {
		await transaction.query("SELECT pg_advisory_xact_lock($1)", [732184901]);
		await transaction.query(CREATE_PI_POSTGRES_SCHEMA);
	});
}

export async function deletePiPostgresSession(executor: SqlExecutor, sessionId: string): Promise<void> {
	await executor.transaction(async (transaction) => {
		await transaction.query("DELETE FROM agent_session_leases WHERE session_id = $1", [sessionId]);
		await transaction.query("DELETE FROM pi_poc_storage_entries WHERE session_id = $1", [sessionId]);
		await transaction.query("DELETE FROM pi_poc_storage_values WHERE session_id = $1", [sessionId]);
		await transaction.query("DELETE FROM pi_poc_storage_lists WHERE session_id = $1", [sessionId]);
		await transaction.query("DELETE FROM pi_poc_storage_usage WHERE session_id = $1", [sessionId]);
		await transaction.query("DELETE FROM agent_delegated_tasks WHERE parent_submission_id IN (SELECT id FROM agent_submissions WHERE session_id = $1)", [sessionId]);
		await transaction.query("DELETE FROM agent_submissions WHERE session_id = $1", [sessionId]);
		await transaction.query("DELETE FROM pi_poc_storage_sequences WHERE session_id = $1", [sessionId]);
		await transaction.query("DELETE FROM pi_poc_sessions WHERE id = $1", [sessionId]);
	});
}
