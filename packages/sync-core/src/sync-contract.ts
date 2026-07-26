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

/**
 * Tables that are intentionally local to a device and exempt from the sync
 * contract.
 *
 * Keep this in step with the migrations — `db-contracts.test.ts` fails any
 * table that is in neither this set nor compliant with the contract, which is
 * what caught login_attempts, print_queue and web_order_imports drifting in
 * unlisted from migrations 0009, 0010 and 0012.
 */
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
  // PIN brute-force lockout counter — an attacker at *this* terminal is a
  // per-device concern, and replicating it would lock every till at once.
  'login_attempts',
  // Each till drives its own printer; mirrors fbr_submission_queue above.
  'print_queue',
  // Bridge-only web-order → local-order mapping. Only the device running the
  // bridge needs it; the imported orders themselves replicate as normal.
  'web_order_imports',
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
