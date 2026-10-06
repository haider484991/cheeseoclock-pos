import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, type Actor } from './base.js';
import type { TaxCategory } from '@cheeseoclock/shared-types';

interface Row {
  id: string;
  name: string;
  rate_bps: number;
  /** The rate when paid by card / wallet / bank (0052); null = none. */
  digital_rate_bps: number | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
  device_id: string;
  version: number;
}

const ROW_SELECT = `id, name, rate_bps, digital_rate_bps, created_at, updated_at, synced_at, deleted_at, device_id, version`;

function rowToTax(row: Row): TaxCategory {
  return {
    id: row.id as TaxCategory['id'],
    name: row.name,
    rateBps: row.rate_bps as TaxCategory['rateBps'],
    digitalRateBps: (row.digital_rate_bps ?? null) as TaxCategory['digitalRateBps'],
  };
}

/**
 * The card rate as stored: whole basis points 0..10000, or null for none.
 * The same as the rate is stored as none — "8% by card" on an 8% category
 * is no card rate — so every reader's "has a card rate" means a different one.
 */
export function cleanDigitalRateBps(digitalRateBps: number | null | undefined, rateBps: number): number | null {
  if (digitalRateBps === null || digitalRateBps === undefined) return null;
  if (!Number.isInteger(digitalRateBps) || digitalRateBps < 0 || digitalRateBps > 10_000) {
    throw new Error('The card rate is a whole number of basis points between 0 and 10000');
  }
  return digitalRateBps === rateBps ? null : digitalRateBps;
}

export function listTaxCategories(db: AppDatabase): TaxCategory[] {
  const rows = db
    .prepare(`SELECT ${ROW_SELECT} FROM tax_categories WHERE deleted_at IS NULL ORDER BY name`)
    .all() as Row[];
  return rows.map(rowToTax);
}

export function findTaxCategory(db: AppDatabase, id: string): TaxCategory | null {
  const row = db
    .prepare(`SELECT ${ROW_SELECT} FROM tax_categories WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as Row | undefined;
  return row ? rowToTax(row) : null;
}

export function createTaxCategory(
  db: AppDatabase,
  input: { name: string; rateBps: number; digitalRateBps?: number | null },
  actor: Actor,
): TaxCategory {
  const id = uuidv7();
  const now = nowIso();
  const digitalRateBps = cleanDigitalRateBps(input.digitalRateBps, input.rateBps);
  const tax: TaxCategory = {
    id: id as TaxCategory['id'],
    name: input.name,
    rateBps: input.rateBps as TaxCategory['rateBps'],
    digitalRateBps: digitalRateBps as TaxCategory['digitalRateBps'],
  };
  writeWithSync({
    db,
    entityType: 'tax_categories',
    entityId: id,
    op: 'upsert',
    action: 'create',
    actor,
    before: null,
    after: tax,
    writeRow: () => {
      db.prepare(
        `INSERT INTO tax_categories (id, name, rate_bps, digital_rate_bps, created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(id, input.name, input.rateBps, digitalRateBps, now, now, actor.deviceId);
    },
  });
  return tax;
}

export function updateTaxCategory(
  db: AppDatabase,
  input: { id: string; name?: string; rateBps?: number; digitalRateBps?: number | null },
  actor: Actor,
): TaxCategory {
  const row = db
    .prepare(`SELECT ${ROW_SELECT} FROM tax_categories WHERE id = ? AND deleted_at IS NULL`)
    .get(input.id) as Row | undefined;
  if (!row) throw new Error('Tax category not found');

  const name = input.name ?? row.name;
  const rateBps = input.rateBps ?? row.rate_bps;
  // Absent = keep the card rate it has; null = no card rate any more.
  const digitalRateBps = cleanDigitalRateBps(input.digitalRateBps === undefined ? row.digital_rate_bps : input.digitalRateBps, rateBps);
  const updated: TaxCategory = {
    id: row.id as TaxCategory['id'],
    name,
    rateBps: rateBps as TaxCategory['rateBps'],
    digitalRateBps: digitalRateBps as TaxCategory['digitalRateBps'],
  };
  const now = nowIso();

  writeWithSync({
    db,
    entityType: 'tax_categories',
    entityId: input.id,
    op: 'upsert',
    action: 'update',
    actor,
    before: rowToTax(row),
    after: updated,
    writeRow: () => {
      db.prepare(
        `UPDATE tax_categories SET name = ?, rate_bps = ?, digital_rate_bps = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(name, rateBps, digitalRateBps, now, input.id);
    },
  });
  return updated;
}

export function deleteTaxCategory(db: AppDatabase, id: string, actor: Actor): void {
  const row = db
    .prepare(`SELECT * FROM tax_categories WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as Row | undefined;
  if (!row) throw new Error('Tax category not found');

  // Block deletion if any active menu_items reference it.
  const usage = db
    .prepare(`SELECT COUNT(*) AS n FROM menu_items WHERE tax_category_id = ? AND deleted_at IS NULL`)
    .get(id) as { n: number };
  if (usage.n > 0) {
    throw new Error(`Tax category is in use by ${usage.n} menu items`);
  }

  const now = nowIso();
  writeWithSync({
    db,
    entityType: 'tax_categories',
    entityId: id,
    op: 'delete',
    action: 'delete',
    actor,
    before: rowToTax(row),
    after: null,
    writeRow: () => {
      db.prepare(
        `UPDATE tax_categories SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(now, now, id);
    },
  });
}
