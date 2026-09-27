/**
 * Apply a remote SyncChange to the local DB. These writes bypass the
 * sync_queue (re-enqueueing would echo every change around the ring forever);
 * those side effects happened on the origin device.
 *
 * Two payload shapes arrive:
 *   - Row images (every replicable table, from this version on): the whole
 *     row, one key per column. Written back column by column from the live
 *     schema, so every replicable table is handled with no per-table code.
 *     A soft-deleted row travels as its image with deletedAt set, and stays
 *     deleted here.
 *   - The older domain-shaped payloads (a till not yet updated): only the five
 *     tables below have handlers for those; anything else is 'unknown_entity'.
 *
 * Conflict resolution: last-write-wins by (version, updated_at). The remote
 * row replaces the local row only when its version is higher OR its version
 * is equal AND its updated_at is newer. Otherwise we drop the change (this
 * device's local copy is newer).
 *
 * A change that cannot be saved (a parent row not here yet, a clash with a
 * row made on this till) is kept aside, retried on every pull and counted in
 * Settings (applyRemoteBatch) instead of stopping the link.
 */

import type { AppDatabase } from '../connection.js';
import {
  RECEIVER_KEEPS_ON_UPDATE,
  RECEIVER_OWNED_COLUMNS,
  ROW_IMAGE_KEY,
  columnKey,
  isLocalOnlyColumn,
  isRowImage,
  type RowImage,
  type SyncChange,
} from '@cheeseoclock/sync-core';
import { baseUnitConversion, orderStockNoteKind, returnsToOtherTill, unitFactor } from '@cheeseoclock/pos-domain';
import { quoteIdent, replicableTables } from '../replicable-schema.js';
import { writeAudit } from './audit-repo.js';
import { readParked, writeParked, type ParkedChange } from './sync-repo.js';

type Row = Record<string, unknown>;

export interface ApplyResult {
  applied: boolean;
  reason?: 'stale' | 'unknown_entity' | 'malformed';
}

/**
 * A user made on the other till arrives without a PIN (PIN hashes never leave
 * the till they were set on). This value is not an argon2 hash, so verifyPin
 * refuses every PIN until a manager sets one here.
 */
export const PIN_NOT_SHARED = '!pin-not-shared';

/** NOT NULL columns an image never carries, and what a new row here gets instead. */
const RECEIVER_FILL: Readonly<Record<string, Readonly<Record<string, string | number>>>> = {
  users: { pin_hash: PIN_NOT_SHARED },
};

export function applyRemoteChange(db: AppDatabase, change: SyncChange): ApplyResult {
  if (isRowImage(change.payload)) return applyRowImage(db, change, change.payload);

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
  if (isStale(db, handler.tableName, entityId, remoteVersion, remoteUpdatedAt)) {
    return { applied: false, reason: 'stale' };
  }

  handler.upsert(db, payload as Row, change);
  return { applied: true };
}

/** True when this device's copy of the row is as new or newer than the remote one. */
function isStale(
  db: AppDatabase,
  table: string,
  id: string,
  remoteVersion: number,
  remoteUpdatedAt: string,
): boolean {
  const existing = db
    .prepare(`SELECT version, updated_at FROM ${quoteIdent(table)} WHERE id = ?`)
    .get(id) as { version: number; updated_at: string } | undefined;
  if (!existing) return false;
  const remoteNewer =
    remoteVersion > existing.version ||
    (remoteVersion === existing.version && remoteUpdatedAt > existing.updated_at);
  return !remoteNewer;
}

/**
 * Write a row image back as a row. The table must be one of this database's
 * replicable tables (never a name taken from the payload unchecked: settings,
 * audit_log and sync_state are refused). Columns come from the live schema;
 * a key the image does not carry leaves that column alone (its default on a
 * new row), so an older or newer till with a column more or less still works.
 */
function applyRowImage(db: AppDatabase, change: SyncChange, image: RowImage): ApplyResult {
  const table = replicableTables(db).get(change.entityType);
  if (!table) return { applied: false, reason: 'unknown_entity' };
  if (change.op !== 'upsert' && change.op !== 'delete') return { applied: false, reason: 'malformed' };
  if (image.id !== change.entityId) return { applied: false, reason: 'malformed' };
  if (
    typeof change.version !== 'number' ||
    !Number.isInteger(change.version) ||
    typeof change.updatedAt !== 'string'
  ) {
    return { applied: false, reason: 'malformed' };
  }
  if (isStale(db, table.name, change.entityId, change.version, change.updatedAt)) {
    return { applied: false, reason: 'stale' };
  }

  const cols: string[] = [];
  const vals: Array<string | number | null> = [];
  for (const col of table.columns) {
    if (RECEIVER_OWNED_COLUMNS.has(col.name) || isLocalOnlyColumn(table.name, col.name)) continue;
    let v: unknown;
    if (col.name === 'version') v = change.version;
    else if (col.name === 'updated_at') v = change.updatedAt;
    else if (col.name === 'device_id') {
      v = typeof image['deviceId'] === 'string' ? image['deviceId'] : change.deviceId;
    } else {
      const key = columnKey(col.name);
      if (key === ROW_IMAGE_KEY || !Object.hasOwn(image, key)) continue;
      v = image[key];
    }
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (v !== null && typeof v !== 'string' && typeof v !== 'number') {
      return { applied: false, reason: 'malformed' };
    }
    if (typeof v === 'number' && !Number.isFinite(v)) return { applied: false, reason: 'malformed' };
    cols.push(col.name);
    vals.push(v);
  }

  // Tables whose remote changes go into this till's own audit trail: who can
  // sign in (users) and the owner's shop-wide settings (business_settings).
  const audited = table.name === 'users' || table.name === 'business_settings';
  const before = audited
    ? (db.prepare(`SELECT * FROM ${quoteIdent(table.name)} WHERE id = ?`).get(change.entityId) as Row | undefined)
    : undefined;
  const isNew = audited
    ? before === undefined
    : db.prepare(`SELECT 1 AS x FROM ${quoteIdent(table.name)} WHERE id = ?`).get(change.entityId) === undefined;

  if (isNew) {
    // A new row needs every NOT NULL column without a default: the image has
    // them, apart from the ones that never travel (a user's PIN hash).
    for (const col of table.columns) {
      if (!col.notNull || col.hasDefault || cols.includes(col.name)) continue;
      const fill = RECEIVER_FILL[table.name]?.[col.name];
      if (fill === undefined) return { applied: false, reason: 'malformed' };
      cols.push(col.name);
      vals.push(fill);
    }
    db.prepare(
      `INSERT INTO ${quoteIdent(table.name)} (${cols.map(quoteIdent).join(', ')})
       VALUES (${cols.map(() => '?').join(', ')})`,
    ).run(...vals);
    if (table.name === 'stock_movements') arrivedMovement(db, change.entityId);
  } else {
    // An UPDATE, not an upsert: SQLite checks NOT NULL on an upsert's insert
    // half first, and a user row here never gets the other till's PIN.
    const keepHere = new Set(['id', 'created_at', ...(RECEIVER_KEEPS_ON_UPDATE[table.name] ?? [])]);
    const set = cols.map((c, i) => ({ c, v: vals[i] })).filter(({ c }) => !keepHere.has(c));
    if (table.name === 'ingredients') {
      const count = countInNewUnit(db, change.entityId, image, change.deviceId);
      if (count !== null) set.push({ c: 'current_qty', v: count });
    }
    if (set.length > 0) {
      db.prepare(
        `UPDATE ${quoteIdent(table.name)} SET ${set.map(({ c }) => `${quoteIdent(c)} = ?`).join(', ')}
          WHERE id = ?`,
      ).run(...set.map(({ v }) => v), change.entityId);
    }
  }

  if (table.name === 'users') {
    // Who can sign in, and as what, changed from another till: keep that in
    // this till's own tamper-evident trail (PIN/password hashes never
    // included, nor the kind that stays with them on this till).
    const { pin_hash: _pin, secret_kind: _kind, ...beforeRow } = before ?? {};
    const { [ROW_IMAGE_KEY]: _marker, ...afterImage } = image;
    writeAudit(db, {
      entityType: 'users',
      entityId: change.entityId,
      action: 'remote_apply',
      actorUserId: null,
      before: before ? beforeRow : null,
      after: { ...afterImage, fromDeviceId: change.deviceId },
    });
  }
  if (table.name === 'business_settings') {
    // A setting saved on the other till: one remote_apply row per key, so a
    // card's History here shows the other till's saves too (audit_log is this
    // till's own), with who saved it there. The value as it was sent.
    writeAudit(db, {
      entityType: 'business_settings',
      entityId: change.entityId,
      action: 'remote_apply',
      actorUserId: null,
      before: before ? { key: before['key'], value: parseJsonOr(before['value_json']) } : null,
      after: {
        key: image['key'],
        value: parseJsonOr(image['valueJson']),
        updatedByUserId: typeof image['updatedByUserId'] === 'string' ? image['updatedByUserId'] : null,
        deleted: typeof image['deletedAt'] === 'string',
        fromDeviceId: change.deviceId,
      },
    });
  }
  return { applied: true };
}

function parseJsonOr(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * This till keeps its own stock count for an ingredient it already has
 * (RECEIVER_KEEPS_ON_UPDATE), but a count is only a number in a unit. When
 * the other till converted the ingredient (Convert: kg → g, l → ml, which
 * rescales its own count, recipes and costs), this till's count must be
 * rescaled the same way, or 5 kg here becomes 5 g. Returns the count to
 * write, or null when the unit did not change. The change goes into this
 * till's own audit trail as a 'convert_unit' row, as if it had been done
 * here: it is when the count here changed unit.
 */
function countInNewUnit(db: AppDatabase, id: string, image: RowImage, fromDeviceId: string): number | null {
  const newUnit = image['unit'];
  if (typeof newUnit !== 'string') return null;
  const here = db.prepare(`SELECT unit, current_qty FROM ingredients WHERE id = ?`).get(id) as
    | { unit: string; current_qty: number }
    | undefined;
  if (!here || here.unit === newUnit) return null;
  const conv = baseUnitConversion(here.unit);
  let count: number | null;
  if (conv && conv.unit === newUnit) count = here.current_qty * conv.factor;
  else {
    // No known conversion between the two: the other till's count is at least
    // in the right unit.
    const theirs = image['currentQty'];
    count = typeof theirs === 'number' && Number.isFinite(theirs) ? theirs : null;
  }
  writeAudit(db, {
    entityType: 'ingredients',
    entityId: id,
    action: 'convert_unit',
    actorUserId: null,
    before: { unit: here.unit, currentQty: here.current_qty },
    after: { unit: newUnit, currentQty: count ?? here.current_qty, fromDeviceId },
  });
  return count;
}

/**
 * A stock movement new to this till. Two things only this till can do:
 *  - a row from a till that does not stamp units yet (before 0029) is given
 *    the ingredient's unit here now — rows apply in the order they were
 *    written, so that is the unit it was written in, and a later Convert
 *    can't turn its "2 kg" into "2 g";
 *  - a put-back the other till booked for stock THIS till took ("…put back
 *    on the till that sent it") goes back on this till's count
 *    (applyOtherTillReturn).
 * What the row was worth (value_cents, unit_cost_mc, cost_basis — 0033)
 * arrives with it and is kept as written: nothing is re-costed here at this
 * till's prices (costing spec Phase 2). A row from a till without costing
 * arrives with no value and is valued like an older row (Reports estimates
 * it). The cost a sale kept (order_item_costs) arrives the same way, by its
 * name-based id, so both tills hold the same rows.
 *
 * Prices likewise (costing spec Phase 4): an ingredient's new price arrives
 * as its row and its price history row (ingredient_costs), and the batches
 * rolled up from it arrive as their own 'batch' rows, written by the till
 * that wrote the price. Nothing is rolled up here — never
 * ingredient-cost-repo.rollUpBatches on arrival — so a price is rolled up
 * once, on one till, and the rows (name-based ids) settle by id.
 */
function arrivedMovement(db: AppDatabase, id: string): void {
  db.prepare(
    `UPDATE stock_movements
        SET unit = (SELECT i.unit FROM ingredients i WHERE i.id = stock_movements.ingredient_id)
      WHERE id = ? AND unit IS NULL`,
  ).run(id);
  const here = localDeviceId(db);
  if (here !== null) applyOtherTillReturn(db, id, here);
}

// -----------------------------------------------------------------------------
// Stock this till took, put back by the other till
// -----------------------------------------------------------------------------

/*
 * Each till keeps its own count (sync-core RECEIVER_KEEPS_ON_UPDATE): a sale
 * on till A lowers A's count, and its movement rows travel to B as history
 * only. When B cancels or fully refunds such an order as "Not made" (or puts
 * a sealed drink of it back), B books A's share in rows that do not move B's
 * count — "…put back on the till that sent it" (order-stock-repo.ts). This is
 * the other half: when one of those rows arrives here (once, as a new row),
 * the count here goes up by what this till still holds of that order — never
 * more, so a cancel settled on both tills while the link was down can't put
 * it back twice — unless a stock take here after the order was sent already
 * counted it on the shelf.
 *
 * Like the rest of this file nothing is queued: current_qty is each till's
 * own and never travels on an update. The change goes into this till's own
 * audit trail (who decided, on which till, for which order).
 */

/** This till's id (device_info), or null before it has one. */
function localDeviceId(db: AppDatabase): string | null {
  const row = db.prepare(`SELECT device_id AS id FROM device_info WHERE id = 'singleton'`).get() as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

interface ArrivedMovementRow {
  id: string;
  ingredient_id: string;
  reason: string;
  delta_qty: number;
  unit: string | null;
  notes: string | null;
  ref_order_id: string | null;
  device_id: string;
  actor_user_id: string | null;
}

/**
 * Apply a newly arrived movement row that puts stock back on this till's
 * count. Returns what the count went up by (0 when the row is not one of
 * those, or nothing is left to put back).
 */
function applyOtherTillReturn(db: AppDatabase, movementId: string, deviceId: string): number {
  const m = db
    .prepare(
      `SELECT id, ingredient_id, reason, delta_qty, unit, notes, ref_order_id, device_id, actor_user_id
         FROM stock_movements WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(movementId) as ArrivedMovementRow | undefined;
  if (!m || m.reason !== 'sale' || !(Number(m.delta_qty) > 0) || !m.ref_order_id) return 0;
  if (m.device_id === deviceId || !returnsToOtherTill(orderStockNoteKind(m.notes))) return 0;

  const ing = db
    .prepare(`SELECT unit, current_qty FROM ingredients WHERE id = ? AND deleted_at IS NULL`)
    .get(m.ingredient_id) as { unit: string; current_qty: number } | undefined;
  if (!ing) return 0;
  const factor = unitFactor(m.unit, ing.unit);
  if (factor === null) return 0;
  const qty = Number(m.delta_qty) * factor;

  // What this till still holds of the order: its own 'sale' rows (the take,
  // and any settle of its own), less what the other till already put back
  // onto this count.
  const rows = db
    .prepare(
      `SELECT id, delta_qty, unit, notes, device_id, occurred_at
         FROM stock_movements
        WHERE ref_order_id = ? AND ingredient_id = ? AND reason = 'sale' AND deleted_at IS NULL`,
    )
    .all(m.ref_order_id, m.ingredient_id) as Array<{
    id: string;
    delta_qty: number;
    unit: string | null;
    notes: string | null;
    device_id: string;
    occurred_at: string;
  }>;
  let ownNet = 0;
  let alreadyBack = 0;
  let takenAt: string | null = null;
  for (const r of rows) {
    const f = unitFactor(r.unit, ing.unit);
    if (f === null) continue;
    const q = Number(r.delta_qty) * f;
    if (r.device_id === deviceId) {
      ownNet += q;
      if (q < 0 && (takenAt === null || r.occurred_at < takenAt)) takenAt = r.occurred_at;
    } else if (r.id !== m.id && q > 0 && returnsToOtherTill(orderStockNoteKind(r.notes))) {
      alreadyBack += q;
    }
  }
  const back = Math.min(qty, Math.max(0, -ownNet - alreadyBack));
  if (!(back > 0) || takenAt === null) return 0;

  // A stock take here after the order was sent already saw it on the shelf.
  const count = db
    .prepare(
      `SELECT 1 AS x FROM stock_movements
        WHERE ingredient_id = ? AND reason = 'count' AND ref_order_id IS NULL AND deleted_at IS NULL
          AND device_id = ? AND occurred_at > ?
        LIMIT 1`,
    )
    .get(m.ingredient_id, deviceId, takenAt);
  const alreadyCounted = count !== undefined;
  const after = alreadyCounted ? ing.current_qty : ing.current_qty + back;
  if (!alreadyCounted) {
    // Not version or updated_at: the count is this till's own (see recordStockMovement).
    db.prepare(`UPDATE ingredients SET current_qty = ? WHERE id = ?`).run(after, m.ingredient_id);
  }
  writeAudit(db, {
    entityType: 'ingredients',
    entityId: m.ingredient_id,
    action: 'put_back_by_other_till',
    actorUserId: m.actor_user_id,
    before: { qty: ing.current_qty },
    after: {
      qty: after,
      delta: alreadyCounted ? 0 : back,
      orderId: m.ref_order_id,
      movementId: m.id,
      fromDeviceId: m.device_id,
      alreadyCounted,
    },
  });
  return alreadyCounted ? 0 : back;
}

// -----------------------------------------------------------------------------
// A pulled batch
// -----------------------------------------------------------------------------

export interface BatchApplyResult {
  /** Changes written here (new ones and ones kept from earlier pulls). */
  applied: number;
  /** Already as new here; nothing to do. */
  stale: number;
  /** Left waiting for a retry (see readParked). */
  waiting: number;
  /** Dropped past the waiting list's cap (still counted in Settings). */
  dropped: number;
  /** A shop-wide setting from the other till was written here (the screens re-read them). */
  settingsChanged: boolean;
}

/** Changes per transaction; the event loop is given back between chunks. */
const APPLY_CHUNK = 500;
/** Retry rounds inside one batch, for a row that arrived before its parent. */
const APPLY_PASSES = 5;

/**
 * Apply one pull's changes, together with the ones kept from earlier pulls
 * (those go first: they are older).
 *
 * Each change runs in its own savepoint, so one that fails (a foreign key to
 * a row not here yet, a unique clash such as the same phone number made on
 * both tills) is rolled back alone and the rest still land. Failures are
 * retried in further rounds while a round still applies something (a child
 * that came just before its parent); what is left is kept for the next pull
 * and counted in Settings. Nothing stops the link and nothing is dropped
 * unseen.
 */
export async function applyRemoteBatch(
  db: AppDatabase,
  incoming: SyncChange[],
  opts: { chunk?: number; pause?: () => Promise<void> } = {},
): Promise<BatchApplyResult> {
  const chunk = opts.chunk ?? APPLY_CHUNK;
  const pause = opts.pause ?? (() => new Promise<void>((r) => setImmediate(r)));
  const kept = readParked(db);
  if (kept.length === 0 && incoming.length === 0) return { applied: 0, stale: 0, waiting: 0, dropped: 0, settingsChanged: false };

  interface Item {
    seq: number;
    change: SyncChange;
    prior: ParkedChange | null;
    reason: string;
  }
  let pending: Item[] = [
    ...kept.map((p, i) => ({ seq: i, change: p.change, prior: p, reason: p.reason })),
    ...incoming.map((c, i) => ({ seq: kept.length + i, change: c, prior: null, reason: '' })),
  ];
  const left: Item[] = [];
  let applied = 0;
  let stale = 0;
  let settingsChanged = false;
  const applyOne = db.transaction((c: SyncChange) => applyRemoteChange(db, c));

  for (let pass = 0; pass < APPLY_PASSES && pending.length > 0; pass++) {
    const failed: Item[] = [];
    let progress = 0;
    for (let i = 0; i < pending.length; i += chunk) {
      const slice = pending.slice(i, i + chunk);
      db.transaction(() => {
        for (const item of slice) {
          let r: ApplyResult;
          try {
            r = applyOne(item.change);
          } catch (e) {
            failed.push({ ...item, reason: e instanceof Error ? e.message : String(e) });
            continue;
          }
          if (r.applied) {
            applied++;
            progress++;
            if (item.change.entityType === 'business_settings') settingsChanged = true;
          } else if (r.reason === 'stale') {
            stale++;
          } else {
            // Will not change within this batch: keep it for a later pull
            // (a till update can make an unknown table or column known).
            left.push({ ...item, reason: r.reason ?? 'not applied' });
          }
        }
      })();
      if (i + chunk < pending.length) await pause();
    }
    pending = failed;
    if (progress === 0) break;
  }
  left.push(...pending);
  left.sort((a, b) => a.seq - b.seq);

  const now = new Date().toISOString();
  const nextKept: ParkedChange[] = left.map((item) => ({
    change: item.change,
    reason: item.reason,
    at: item.prior?.at ?? now,
    tries: (item.prior?.tries ?? 0) + 1,
  }));
  const dropped = kept.length > 0 || nextKept.length > 0 ? writeParked(db, nextKept) : 0;
  return { applied, stale, waiting: nextKept.length - dropped, dropped, settingsChanged };
}

// -----------------------------------------------------------------------------
// Older domain-shaped payloads
// -----------------------------------------------------------------------------

interface RemoteTableHandler {
  tableName: string;
  upsert: (db: AppDatabase, payload: Row, change: SyncChange) => void;
}

/**
 * Mapping from entity_type (as recorded in sync_queue) → upsert routine, for
 * the domain-shaped payloads a till before row images still sends.
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
 * The entity types the older domain-shaped payloads can be applied for. Row
 * images cover every replicable table.
 */
export function listKnownRemoteEntities(): string[] {
  return Object.keys(REMOTE_TABLES);
}
