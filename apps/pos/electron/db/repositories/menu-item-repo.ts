import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, toBool, fromBool, type Actor } from './base.js';
import type { MenuItem, PrepStation } from '@cheeseoclock/shared-types';

interface Row {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  base_price_cents: number;
  sku: string | null;
  barcode: string | null;
  image_url: string | null;
  is_active: number;
  prep_station: PrepStation;
  tax_category_id: string;
  sort_order: number;
  current_stock: number | null;
  low_stock_threshold: number | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
  device_id: string;
  version: number;
}

function rowToItem(row: Row): MenuItem {
  return {
    id: row.id as MenuItem['id'],
    categoryId: row.category_id as MenuItem['categoryId'],
    name: row.name,
    description: row.description,
    basePriceCents: row.base_price_cents as MenuItem['basePriceCents'],
    sku: row.sku,
    barcode: row.barcode,
    imageUrl: row.image_url,
    isActive: toBool(row.is_active),
    prepStation: row.prep_station,
    taxCategoryId: row.tax_category_id as MenuItem['taxCategoryId'],
    sortOrder: row.sort_order,
    currentStock: row.current_stock,
    lowStockThreshold: row.low_stock_threshold,
  };
}

const SELECT_COLUMNS = `
  id, category_id, name, description, base_price_cents, sku, barcode, image_url,
  is_active, prep_station, tax_category_id, sort_order, current_stock, low_stock_threshold,
  created_at, updated_at, synced_at, deleted_at, device_id, version
`;

export function listMenuItems(
  db: AppDatabase,
  opts?: { categoryId?: string; activeOnly?: boolean },
): MenuItem[] {
  const conditions: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (opts?.categoryId) {
    conditions.push('category_id = ?');
    params.push(opts.categoryId);
  }
  if (opts?.activeOnly) {
    conditions.push('is_active = 1');
  }
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM menu_items
        WHERE ${conditions.join(' AND ')}
        ORDER BY sort_order, name`,
    )
    .all(...params) as Row[];
  return rows.map(rowToItem);
}

export function findMenuItem(db: AppDatabase, id: string): MenuItem | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM menu_items WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as Row | undefined;
  return row ? rowToItem(row) : null;
}

export function findMenuItemByBarcode(db: AppDatabase, barcode: string): MenuItem | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM menu_items WHERE barcode = ? AND deleted_at IS NULL`,
    )
    .get(barcode) as Row | undefined;
  return row ? rowToItem(row) : null;
}

export interface CreateMenuItemInput {
  categoryId: string;
  name: string;
  description?: string | null;
  basePriceCents: number;
  sku?: string | null;
  barcode?: string | null;
  imageUrl?: string | null;
  prepStation?: PrepStation;
  taxCategoryId: string;
  sortOrder?: number;
  currentStock?: number | null;
  lowStockThreshold?: number | null;
}

export function createMenuItem(
  db: AppDatabase,
  input: CreateMenuItemInput,
  actor: Actor,
): MenuItem {
  const id = uuidv7();
  const now = nowIso();
  const item: MenuItem = {
    id: id as MenuItem['id'],
    categoryId: input.categoryId as MenuItem['categoryId'],
    name: input.name,
    description: input.description ?? null,
    basePriceCents: input.basePriceCents as MenuItem['basePriceCents'],
    sku: input.sku ?? null,
    barcode: input.barcode ?? null,
    imageUrl: input.imageUrl ?? null,
    isActive: true,
    prepStation: input.prepStation ?? 'kitchen',
    taxCategoryId: input.taxCategoryId as MenuItem['taxCategoryId'],
    sortOrder: input.sortOrder ?? 0,
    currentStock: input.currentStock ?? null,
    lowStockThreshold: input.lowStockThreshold ?? null,
  };
  writeWithSync({
    db,
    entityType: 'menu_items',
    entityId: id,
    op: 'upsert',
    action: 'create',
    actor,
    before: null,
    after: item,
    writeRow: () => {
      db.prepare(
        `INSERT INTO menu_items
           (id, category_id, name, description, base_price_cents, sku, barcode, image_url,
            is_active, prep_station, tax_category_id, sort_order, current_stock, low_stock_threshold,
            created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        id,
        item.categoryId,
        item.name,
        item.description,
        item.basePriceCents,
        item.sku,
        item.barcode,
        item.imageUrl,
        item.prepStation,
        item.taxCategoryId,
        item.sortOrder,
        item.currentStock,
        item.lowStockThreshold,
        now,
        now,
        actor.deviceId,
      );
    },
  });
  return item;
}

export interface UpdateMenuItemInput {
  id: string;
  categoryId?: string;
  name?: string;
  description?: string | null;
  basePriceCents?: number;
  sku?: string | null;
  barcode?: string | null;
  imageUrl?: string | null;
  isActive?: boolean;
  prepStation?: PrepStation;
  taxCategoryId?: string;
  sortOrder?: number;
  currentStock?: number | null;
  lowStockThreshold?: number | null;
}

export function updateMenuItem(
  db: AppDatabase,
  input: UpdateMenuItemInput,
  actor: Actor,
): MenuItem {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM menu_items WHERE id = ? AND deleted_at IS NULL`)
    .get(input.id) as Row | undefined;
  if (!row) throw new Error('Menu item not found');

  const before = rowToItem(row);
  const after: MenuItem = {
    ...before,
    categoryId: (input.categoryId ?? before.categoryId) as MenuItem['categoryId'],
    name: input.name ?? before.name,
    description: input.description !== undefined ? input.description : before.description,
    basePriceCents: (input.basePriceCents ?? before.basePriceCents) as MenuItem['basePriceCents'],
    sku: input.sku !== undefined ? input.sku : before.sku,
    barcode: input.barcode !== undefined ? input.barcode : before.barcode,
    imageUrl: input.imageUrl !== undefined ? input.imageUrl : before.imageUrl,
    isActive: input.isActive ?? before.isActive,
    prepStation: input.prepStation ?? before.prepStation,
    taxCategoryId: (input.taxCategoryId ?? before.taxCategoryId) as MenuItem['taxCategoryId'],
    sortOrder: input.sortOrder ?? before.sortOrder,
    currentStock: input.currentStock !== undefined ? input.currentStock : before.currentStock,
    lowStockThreshold:
      input.lowStockThreshold !== undefined ? input.lowStockThreshold : before.lowStockThreshold,
  };
  const now = nowIso();

  writeWithSync({
    db,
    entityType: 'menu_items',
    entityId: input.id,
    op: 'upsert',
    action: 'update',
    actor,
    before,
    after,
    writeRow: () => {
      db.prepare(
        `UPDATE menu_items SET
            category_id = ?, name = ?, description = ?, base_price_cents = ?,
            sku = ?, barcode = ?, image_url = ?, is_active = ?, prep_station = ?,
            tax_category_id = ?, sort_order = ?, current_stock = ?, low_stock_threshold = ?,
            updated_at = ?, version = version + 1
          WHERE id = ?`,
      ).run(
        after.categoryId,
        after.name,
        after.description,
        after.basePriceCents,
        after.sku,
        after.barcode,
        after.imageUrl,
        fromBool(after.isActive),
        after.prepStation,
        after.taxCategoryId,
        after.sortOrder,
        after.currentStock,
        after.lowStockThreshold,
        now,
        input.id,
      );
    },
  });
  return after;
}

export function deleteMenuItem(db: AppDatabase, id: string, actor: Actor): void {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM menu_items WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as Row | undefined;
  if (!row) throw new Error('Menu item not found');
  const now = nowIso();
  writeWithSync({
    db,
    entityType: 'menu_items',
    entityId: id,
    op: 'delete',
    action: 'delete',
    actor,
    before: rowToItem(row),
    after: null,
    writeRow: () => {
      db.prepare(
        `UPDATE menu_items SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(now, now, id);
    },
  });
}
