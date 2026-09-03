import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { redactPhone } from '@cheeseoclock/pos-domain';
import { AUDIT_CHAIN_GENESIS, hashAuditRow } from '../audit-chain.js';

export interface AuditWrite {
  entityType: string;
  entityId: string;
  action: 'create' | 'update' | 'delete' | 'void' | 'refund' | 'login' | 'logout' | string;
  actorUserId: string | null;
  before: unknown;
  after: unknown;
  ip?: string | null;
}

/** Field names that contain PII and must be redacted before serialization. */
const PHONE_FIELDS = new Set([
  'phone',
  'customerPhone',
  'customer_phone',
  'customer_phone_snapshot',
  'phoneSnapshot',
]);
const EMAIL_FIELDS = new Set(['email', 'customerEmail', 'customer_email']);

/**
 * Walk an arbitrary JSON-shaped value and redact known PII fields.
 * - Phones → "••• ••• 4567" (last 4 of canonical form preserved).
 * - Emails → "f***@example.com" (first letter + masked + domain).
 * - Argon2 hashes and pin_hash never appear here, but we still tombstone them.
 *
 * Used by writeAudit so we keep an audit trail without leaking PII at rest.
 */
function redactPii(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactPii);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PHONE_FIELDS.has(k) && typeof v === 'string') {
        out[k] = redactPhone(v);
      } else if (EMAIL_FIELDS.has(k) && typeof v === 'string') {
        out[k] = maskEmail(v);
      } else if (k === 'pin' || k === 'pin_hash' || k === 'pinHash') {
        out[k] = '••••';
      } else {
        out[k] = redactPii(v);
      }
    }
    return out;
  }
  return value;
}

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 1) return '•••@•••';
  return `${email[0]}•••${email.slice(at)}`;
}

/**
 * Write a single audit_log row. MUST be called inside the same transaction that
 * mutates the business row — that's the only way to keep audit consistent.
 *
 * PII (phone, email, pin) is redacted from before/after JSON.
 *
 * Every row is chained: prev_hash is the hash of the row before it (rowid
 * order) and row_hash covers prev_hash plus this row's content, so nothing in
 * the history can be deleted, edited or reordered without breaking every hash
 * after it. See audit-chain.ts for the verifier and the reasoning.
 */
export function writeAudit(db: AppDatabase, w: AuditWrite): void {
  const before =
    w.before === null || w.before === undefined ? null : JSON.stringify(redactPii(w.before));
  const after =
    w.after === null || w.after === undefined ? null : JSON.stringify(redactPii(w.after));
  const fields = {
    id: uuidv7(),
    entityType: w.entityType,
    entityId: w.entityId,
    action: w.action,
    actorUserId: w.actorUserId,
    beforeJson: before,
    afterJson: after,
    ip: w.ip ?? null,
    createdAt: new Date().toISOString(),
  };
  const prevHash = previousHash(db);
  const rowHash = hashAuditRow(prevHash, fields);
  db.prepare(
    `INSERT INTO audit_log
       (id, entity_type, entity_id, action, actor_user_id, before_json, after_json, ip, created_at,
        prev_hash, row_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.id,
    fields.entityType,
    fields.entityId,
    fields.action,
    fields.actorUserId,
    fields.beforeJson,
    fields.afterJson,
    fields.ip,
    fields.createdAt,
    prevHash,
    rowHash,
  );
}

/**
 * The hash the next row links to: the newest hashed row; failing that, the
 * anchor a trimmed cloud copy recorded at its cut; failing that, genesis
 * (a fresh database, or history written before hashing existed).
 */
function previousHash(db: AppDatabase): string {
  const last = db
    .prepare(`SELECT row_hash FROM audit_log ORDER BY rowid DESC LIMIT 1`)
    .get() as { row_hash: string | null } | undefined;
  if (last?.row_hash) return last.row_hash;
  const anchor = db
    .prepare(`SELECT value_json FROM settings WHERE key = 'audit.chainAnchor'`)
    .get() as { value_json: string } | undefined;
  if (anchor) {
    try {
      const a = JSON.parse(anchor.value_json) as { prevHash?: string | null };
      if (a.prevHash) return a.prevHash;
    } catch {
      // unreadable anchor: start from genesis
    }
  }
  return AUDIT_CHAIN_GENESIS;
}
