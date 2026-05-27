-- 0001_initial_schema.sql
-- Phase 1 schema: auth + cross-cutting infra (audit, sync queue, settings, device).
-- This file is immutable once committed. New columns/tables go in new migrations.

------------------------------------------------------------
-- Device info — singleton row per install. Pure-local table.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_info (
  id            TEXT PRIMARY KEY DEFAULT 'singleton',
  device_id     TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  last_sync_at  TEXT,
  CHECK (id = 'singleton')
);

------------------------------------------------------------
-- Settings — key/value JSON. Pure-local; sync handled per key.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

------------------------------------------------------------
-- Users — replicable table (cashiers configured per device for now,
-- but the data is replicable for the future cloud admin panel).
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  full_name     TEXT NOT NULL,
  pin_hash      TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'cashier')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  synced_at     TEXT,
  deleted_at    TEXT,
  device_id     TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active, role) WHERE deleted_at IS NULL;

------------------------------------------------------------
-- User sessions — pure-local (a session is per-device by definition).
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  device_id  TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_open
  ON user_sessions(user_id) WHERE ended_at IS NULL;

------------------------------------------------------------
-- Audit log — write-once. Pure-local; rolled up to cloud later via separate job.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id             TEXT PRIMARY KEY,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  action         TEXT NOT NULL,
  actor_user_id  TEXT,
  before_json    TEXT,
  after_json     TEXT,
  ip             TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log(actor_user_id, created_at);

------------------------------------------------------------
-- Sync queue — append-only event log of business mutations. Pure-local.
------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_queue (
  id            TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  op            TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  payload_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  attempted_at  TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  synced_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_pending
  ON sync_queue(created_at) WHERE synced_at IS NULL;
