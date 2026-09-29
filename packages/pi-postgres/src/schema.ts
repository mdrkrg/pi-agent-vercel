import type { SqlExecutor } from "./sql.ts";

export const CREATE_PI_POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS pi_poc_sessions (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  storage_version INTEGER NOT NULL,
  parent_session_id TEXT
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

CREATE INDEX IF NOT EXISTS pi_poc_storage_usage_seq_idx
  ON pi_poc_storage_usage (session_id, seq);
`;

export async function ensurePiPostgresSchema(executor: SqlExecutor): Promise<void> {
	await executor.query(CREATE_PI_POSTGRES_SCHEMA);
}

export async function deletePiPostgresSession(executor: SqlExecutor, sessionId: string): Promise<void> {
	await executor.transaction(async (transaction) => {
		await transaction.query("DELETE FROM pi_poc_storage_entries WHERE session_id = $1", [sessionId]);
		await transaction.query("DELETE FROM pi_poc_storage_values WHERE session_id = $1", [sessionId]);
		await transaction.query("DELETE FROM pi_poc_storage_lists WHERE session_id = $1", [sessionId]);
		await transaction.query("DELETE FROM pi_poc_storage_usage WHERE session_id = $1", [sessionId]);
		await transaction.query("DELETE FROM pi_poc_storage_sequences WHERE session_id = $1", [sessionId]);
		await transaction.query("DELETE FROM pi_poc_sessions WHERE id = $1", [sessionId]);
	});
}
