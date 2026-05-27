import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { redactPhone } from '@cheeseoclock/pos-domain';

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
 */
export function writeAudit(db: AppDatabase, w: AuditWrite): void {
  const before = w.before === null || w.before === undefined ? null : JSON.stringify(redactPii(w.before));
  const after = w.after === null || w.after === undefined ? null : JSON.stringify(redactPii(w.after));
  db.prepare(
    `INSERT INTO audit_log
       (id, entity_type, entity_id, action, actor_user_id, before_json, after_json, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidv7(),
    w.entityType,
    w.entityId,
    w.action,
    w.actorUserId,
    before,
    after,
    w.ip ?? null,
    new Date().toISOString(),
  );
}
