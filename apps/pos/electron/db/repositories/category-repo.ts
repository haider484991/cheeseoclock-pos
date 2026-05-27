import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, toBool, fromBool, type Actor } from './base.js';
import type { Category } from '@cheeseoclock/shared-types';

interface Row {
  id: string;
  name: string;
  display_order: number;
  color_hex: string;
  is_active: number;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
  device_id: string;
  version: number;
}

function rowToCategory(row: Row): Category {
  return {
    id: row.id as Category['id'],
    name: row.name,
    displayOrder: row.display_order,
    colorHex: row.color_hex,
    isActive: toBool(row.is_active),
  };
}

export function listCategories(db: AppDatabase, opts?: { activeOnly?: boolean }): Category[] {
  const where = opts?.activeOnly
    ? 'WHERE deleted_at IS NULL AND is_active = 1'
    : 'WHERE deleted_at IS NULL';
  const rows = db
    .prepare(
      `SELECT id, name, display_order, color_hex, is_active,
              created_at, updated_at, synced_at, deleted_at, device_id, version
         FROM categories ${where} ORDER BY display_order, name`,
    )
    .all() as Row[];
  return rows.map(rowToCategory);
}

export function findCategory(db: AppDatabase, id: string): Category | null {
  const row = db
    .prepare(
      `SELECT id, name, display_order, color_hex, is_active,
              created_at, updated_at, synced_at, deleted_at, device_id, version
         FROM categories WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id) as Row | undefined;
  return row ? rowToCategory(row) : null;
}

export function createCategory(
  db: AppDatabase,
  input: { name: string; displayOrder: number; colorHex: string },
  actor: Actor,
): Category {
  const id = uuidv7();
  const now = nowIso();
  const cat: Category = {
    id: id as Category['id'],
    name: input.name,
    displayOrder: input.displayOrder,
    colorHex: input.colorHex,
    isActive: true,
  };
  writeWithSync({
    db,
    entityType: 'categories',
    entityId: id,
    op: 'upsert',
    action: 'create',
    actor,
    before: null,
    after: cat,
    writeRow: () => {
      db.prepare(
        `INSERT INTO categories (id, name, display_order, color_hex, is_active, created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1)`,
      ).run(id, input.name, input.displayOrder, input.colorHex, now, now, actor.deviceId);
    },
  });
  return cat;
}

export function updateCategory(
  db: AppDatabase,
  input: {
    id: string;
    name?: string;
    displayOrder?: number;
    colorHex?: string;
    isActive?: boolean;
  },
  actor: Actor,
): Category {
  const row = db
    .prepare(
      `SELECT id, name, display_order, color_hex, is_active,
              created_at, updated_at, synced_at, deleted_at, device_id, version
         FROM categories WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(input.id) as Row | undefined;
  if (!row) throw new Error('Category not found');

  const name = input.name ?? row.name;
  const displayOrder = input.displayOrder ?? row.display_order;
  const colorHex = input.colorHex ?? row.color_hex;
  const isActive = input.isActive ?? toBool(row.is_active);
  const updated: Category = {
    id: row.id as Category['id'],
    name,
    displayOrder,
    colorHex,
    isActive,
  };
  const now = nowIso();

  writeWithSync({
    db,
    entityType: 'categories',
    entityId: input.id,
    op: 'upsert',
    action: 'update',
    actor,
    before: rowToCategory(row),
    after: updated,
    writeRow: () => {
      db.prepare(
        `UPDATE categories SET name = ?, display_order = ?, color_hex = ?, is_active = ?,
                                updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(name, displayOrder, colorHex, fromBool(isActive), now, input.id);
    },
  });
  return updated;
}

export function deleteCategory(db: AppDatabase, id: string, actor: Actor): void {
  const row = db
    .prepare(`SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as Row | undefined;
  if (!row) throw new Error('Category not found');

  // Block deletion if any active menu_items reference it.
  const usage = db
    .prepare(`SELECT COUNT(*) AS n FROM menu_items WHERE category_id = ? AND deleted_at IS NULL`)
    .get(id) as { n: number };
  if (usage.n > 0) {
    throw new Error(`Category has ${usage.n} active menu items — deactivate or move them first`);
  }

  const now = nowIso();
  writeWithSync({
    db,
    entityType: 'categories',
    entityId: id,
    op: 'delete',
    action: 'delete',
    actor,
    before: rowToCategory(row),
    after: null,
    writeRow: () => {
      db.prepare(
        `UPDATE categories SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(now, now, id);
    },
  });
}
