import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, toBool, fromBool, type Actor } from './base.js';
import { normalizePhone } from '@cheeseoclock/pos-domain';
import type { Rider } from '@cheeseoclock/shared-types';

/**
 * Riders / delivery staff. Replicable (synced) — assignments need to be visible
 * across devices in the future. We keep the record minimal: name + phone is
 * the bare minimum to dispatch.
 */

interface RiderRow {
  id: string;
  name: string;
  phone: string;
  is_active: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const RIDER_SELECT = `id, name, phone, is_active, notes, created_at, updated_at`;

function rowToRider(r: RiderRow): Rider {
  return {
    id: r.id as Rider['id'],
    name: r.name,
    phone: r.phone,
    isActive: toBool(r.is_active),
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listRiders(
  db: AppDatabase,
  opts?: { activeOnly?: boolean },
): Rider[] {
  const where: string[] = ['deleted_at IS NULL'];
  if (opts?.activeOnly) where.push('is_active = 1');
  const rows = db
    .prepare(
      `SELECT ${RIDER_SELECT} FROM riders WHERE ${where.join(' AND ')} ORDER BY is_active DESC, name`,
    )
    .all() as RiderRow[];
  return rows.map(rowToRider);
}

export function findRider(db: AppDatabase, id: string): Rider | null {
  const row = db
    .prepare(`SELECT ${RIDER_SELECT} FROM riders WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as RiderRow | undefined;
  return row ? rowToRider(row) : null;
}

export interface CreateRiderInput {
  name: string;
  phone: string;
  notes?: string | null;
}

/**
 * Add a rider. Cashiers can do this from the Assign rider dialog, so the phone
 * number is the identity: a number already on the roster is not added twice —
 * an active rider is refused with their name (pick them from the list), and an
 * inactive one is switched back on under the name just typed.
 */
export function createRider(db: AppDatabase, input: CreateRiderInput, actor: Actor): Rider {
  const id = uuidv7();
  const now = nowIso();
  if (!input.name.trim()) throw new Error('Rider name is required');
  const normalizedPhone = normalizePhone(input.phone) ?? input.phone.trim();
  if (!normalizedPhone) throw new Error('Rider phone is required');

  const existing = db
    .prepare(`SELECT ${RIDER_SELECT} FROM riders WHERE phone = ? AND deleted_at IS NULL`)
    .get(normalizedPhone) as RiderRow | undefined;
  if (existing) {
    if (existing.is_active === 1) {
      throw new Error(`${existing.name} is already a rider with this number — pick them from the list`);
    }
    return updateRider(
      db,
      { id: existing.id, name: input.name, isActive: true, ...(input.notes !== undefined ? { notes: input.notes } : {}) },
      actor,
    );
  }

  const rider: Rider = {
    id: id as Rider['id'],
    name: input.name.trim(),
    phone: normalizedPhone,
    isActive: true,
    notes: input.notes?.trim() || null,
    createdAt: now,
    updatedAt: now,
  };
  writeWithSync({
    db,
    entityType: 'riders',
    entityId: id,
    op: 'upsert',
    action: 'create',
    actor,
    before: null,
    after: rider,
    writeRow: () => {
      db.prepare(
        `INSERT INTO riders (id, name, phone, is_active, notes,
                              created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1)`,
      ).run(id, rider.name, rider.phone, rider.notes, now, now, actor.deviceId);
    },
  });
  return rider;
}

export interface UpdateRiderInput {
  id: string;
  name?: string;
  phone?: string;
  notes?: string | null;
  isActive?: boolean;
}

export function updateRider(db: AppDatabase, input: UpdateRiderInput, actor: Actor): Rider {
  const row = db
    .prepare(`SELECT ${RIDER_SELECT} FROM riders WHERE id = ? AND deleted_at IS NULL`)
    .get(input.id) as RiderRow | undefined;
  if (!row) throw new Error('Rider not found');
  const before = rowToRider(row);
  const next: Rider = {
    ...before,
    name: input.name?.trim() ?? before.name,
    phone:
      input.phone !== undefined
        ? normalizePhone(input.phone) ?? input.phone.trim()
        : before.phone,
    notes:
      input.notes !== undefined
        ? input.notes?.trim() || null
        : before.notes,
    isActive: input.isActive ?? before.isActive,
    updatedAt: nowIso(),
  };
  writeWithSync({
    db,
    entityType: 'riders',
    entityId: next.id,
    op: 'upsert',
    action: 'update',
    actor,
    before,
    after: next,
    writeRow: () => {
      db.prepare(
        `UPDATE riders SET name = ?, phone = ?, is_active = ?, notes = ?,
                            updated_at = ?, version = version + 1
          WHERE id = ?`,
      ).run(
        next.name,
        next.phone,
        fromBool(next.isActive),
        next.notes,
        next.updatedAt,
        next.id,
      );
    },
  });
  return next;
}

/**
 * Take a rider off the assignment list. They stay on the roster as inactive
 * (the Riders page lists them, a manager can switch them back on) — this used
 * to set deleted_at too, so a deactivated rider vanished for good and could
 * never be reactivated. Orders already assigned keep pointing at them.
 */
export function deactivateRider(db: AppDatabase, id: string, actor: Actor): void {
  const row = db
    .prepare(`SELECT ${RIDER_SELECT} FROM riders WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as RiderRow | undefined;
  if (!row) throw new Error('Rider not found');
  const before = rowToRider(row);
  const now = nowIso();
  writeWithSync({
    db,
    entityType: 'riders',
    entityId: id,
    op: 'upsert',
    action: 'deactivate',
    actor,
    before,
    after: { ...before, isActive: false, updatedAt: now },
    writeRow: () => {
      db.prepare(
        `UPDATE riders SET is_active = 0, updated_at = ?, version = version + 1
          WHERE id = ?`,
      ).run(now, id);
    },
  });
}
