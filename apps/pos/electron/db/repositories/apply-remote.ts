/**
 * Apply a remote SyncChange to the local DB. Dispatches per entity_type to
 * direct UPSERT statements that bypass the sync_queue + audit_log layers —
 * those side effects happened on the origin device.
 *
 * Conflict resolution: last-write-wins by (version, updated_at). The remote
 * row replaces the local row only when its version is higher OR its version
 * is equal AND its updated_at is newer. Otherwise we drop the change (this
 * device's local copy is newer).
 *
 * Why direct SQL rather than reusing the existing repository functions:
 *   - Repos always re-enqueue + audit; we don't want that for remote applies.
 *   - Schema is stable; the column lists below are the source of truth.
 *
 * When you add a new replicable table, register a handler here.
 */

import type { AppDatabase } from '../connection.js';
import type { SyncChange } from '@cheeseoclock/sync-core';

type Row = Record<string, unknown>;

interface ApplyResult {
  applied: boolean;
  reason?: 'stale' | 'unknown_entity' | 'malformed';
}

export function applyRemoteChange(db: AppDatabase, change: SyncChange): ApplyResult {
  const payload = change.payload as Row | null;
  const entityId = change.entityId;
  const remoteVersion = change.version;
  const remoteUpdatedAt = change.updatedAt;

  if (!payload && change.op !== 'delete') {
    return { applied: false, reason: 'malformed' };
  }

  // Soft-delete branch — operates on whichever table.
  if (change.op === 'delete') {
    const table = REMOTE_TABLES[change.entityType];
    if (!table) return { applied: false, reason: 'unknown_entity' };
    db.prepare(
      `UPDATE ${table.tableName} SET deleted_at = ?, updated_at = ?, version = ? WHERE id = ?`,
    ).run(remoteUpdatedAt, remoteUpdatedAt, remoteVersion, entityId);
    return { applied: true };
  }

  const handler = REMOTE_TABLES[change.entityType];
  if (!handler) return { applied: false, reason: 'unknown_entity' };

  // Stale check: skip if the local row is newer.
  const existing = db
    .prepare(
      `SELECT version, updated_at FROM ${handler.tableName} WHERE id = ?`,
    )
    .get(entityId) as { version: number; updated_at: string } | undefined;
  if (existing) {
    const remoteNewer =
      remoteVersion > existing.version ||
      (remoteVersion === existing.version && remoteUpdatedAt > existing.updated_at);
    if (!remoteNewer) {
      return { applied: false, reason: 'stale' };
    }
  }

  handler.upsert(db, payload as Row, change);
  return { applied: true };
}

interface RemoteTableHandler {
  tableName: string;
  upsert: (db: AppDatabase, payload: Row, change: SyncChange) => void;
}

/**
 * Mapping from entity_type (as recorded in sync_queue) → upsert routine.
 *
 * For convenience the upsert writes via "INSERT ... ON CONFLICT DO UPDATE";
 * SQLite handles the merge atomically. We always write the remote version,
 * updated_at, and device_id (the origin device).
 */
const REMOTE_TABLES: Record<string, RemoteTableHandler> = {
  // Tax categories ------------------------------------------------------------
  tax_categories: {
    tableName: 'tax_categories',
    upsert(db, p, c) {
      db.prepare(
        `INSERT INTO tax_categories (id, name, rate_bps, created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, rate_bps = excluded.rate_bps,
           updated_at = excluded.updated_at, version = excluded.version,
           deleted_at = NULL`,
      ).run(
        c.entityId,
        p.name,
        p.rateBps,
        p.createdAt ?? c.updatedAt,
        c.updatedAt,
        c.deviceId,
        c.version,
      );
    },
  },

  // Categories ----------------------------------------------------------------
  categories: {
    tableName: 'categories',
    upsert(db, p, c) {
      db.prepare(
        `INSERT INTO categories
           (id, name, display_order, color_hex, is_active, created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, display_order = excluded.display_order, color_hex = excluded.color_hex,
           is_active = excluded.is_active, updated_at = excluded.updated_at, version = excluded.version,
           deleted_at = NULL`,
      ).run(
        c.entityId,
        p.name,
        p.displayOrder,
        p.colorHex,
        p.isActive ? 1 : 0,
        p.createdAt ?? c.updatedAt,
        c.updatedAt,
        c.deviceId,
        c.version,
      );
    },
  },

  // Menu items ---------------------------------------------------------------
  menu_items: {
    tableName: 'menu_items',
    upsert(db, p, c) {
      db.prepare(
        `INSERT INTO menu_items
           (id, category_id, name, description, base_price_cents, sku, barcode, image_url,
            is_active, prep_station, tax_category_id, sort_order, current_stock, low_stock_threshold,
            created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           category_id = excluded.category_id, name = excluded.name, description = excluded.description,
           base_price_cents = excluded.base_price_cents, sku = excluded.sku, barcode = excluded.barcode,
           image_url = excluded.image_url, is_active = excluded.is_active, prep_station = excluded.prep_station,
           tax_category_id = excluded.tax_category_id, sort_order = excluded.sort_order,
           current_stock = excluded.current_stock, low_stock_threshold = excluded.low_stock_threshold,
           updated_at = excluded.updated_at, version = excluded.version, deleted_at = NULL`,
      ).run(
        c.entityId,
        p.categoryId,
        p.name,
        p.description ?? null,
        p.basePriceCents,
        p.sku ?? null,
        p.barcode ?? null,
        p.imageUrl ?? null,
        p.isActive ? 1 : 0,
        p.prepStation,
        p.taxCategoryId,
        p.sortOrder,
        p.currentStock ?? null,
        p.lowStockThreshold ?? null,
        p.createdAt ?? c.updatedAt,
        c.updatedAt,
        c.deviceId,
        c.version,
      );
    },
  },

  // Customers ----------------------------------------------------------------
  customers: {
    tableName: 'customers',
    upsert(db, p, c) {
      db.prepare(
        `INSERT INTO customers
           (id, name, phone, email, notes, loyalty_points, is_active,
            created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, phone = excluded.phone, email = excluded.email,
           notes = excluded.notes, loyalty_points = excluded.loyalty_points, is_active = excluded.is_active,
           updated_at = excluded.updated_at, version = excluded.version, deleted_at = NULL`,
      ).run(
        c.entityId,
        p.name,
        p.phone ?? null,
        p.email ?? null,
        p.notes ?? null,
        p.loyaltyPoints ?? 0,
        p.isActive ? 1 : 0,
        p.createdAt ?? c.updatedAt,
        c.updatedAt,
        c.deviceId,
        c.version,
      );
    },
  },

  // Customer addresses -------------------------------------------------------
  customer_addresses: {
    tableName: 'customer_addresses',
    upsert(db, p, c) {
      db.prepare(
        `INSERT INTO customer_addresses
           (id, customer_id, label, address_line, area, city, notes, is_default,
            created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           customer_id = excluded.customer_id, label = excluded.label,
           address_line = excluded.address_line, area = excluded.area, city = excluded.city,
           notes = excluded.notes, is_default = excluded.is_default,
           updated_at = excluded.updated_at, version = excluded.version, deleted_at = NULL`,
      ).run(
        c.entityId,
        p.customerId,
        p.label,
        p.addressLine,
        p.area ?? null,
        p.city ?? null,
        p.notes ?? null,
        p.isDefault ? 1 : 0,
        c.updatedAt,
        c.updatedAt,
        c.deviceId,
        c.version,
      );
    },
  },
};

/**
 * Return the list of entity_types this dispatcher handles. Sync worker uses
 * this to log which kinds of remote events the device can apply.
 */
export function listKnownRemoteEntities(): string[] {
  return Object.keys(REMOTE_TABLES);
}
