/**
 * The sync contract: every business table must carry these columns. Pure-local
 * tables are allowlisted below. A CI test introspects sqlite_schema and fails
 * any CREATE TABLE that violates this contract.
 */

export const REPLICABLE_REQUIRED_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'synced_at',
  'deleted_at',
  'device_id',
  'version',
] as const;

/** Tables that are intentionally local to a device and exempt from the sync contract. */
export const PURE_LOCAL_TABLES = new Set<string>([
  '_migrations',
  'device_info',
  'user_sessions',
  'sync_queue',
  'audit_log',
  'fbr_submission_queue',
  'settings',
  'printer_assignments',
  'order_number_counter',
  'sync_state',
]);

/** SQL fragment to drop into a CREATE TABLE for the sync-contract columns. */
export const SYNC_COLUMNS_SQL = `
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at  TEXT,
  deleted_at TEXT,
  device_id  TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1
`;
