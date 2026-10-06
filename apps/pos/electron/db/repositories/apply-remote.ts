/**
 * Apply a remote SyncChange to the local DB. These writes bypass the
 * sync_queue (re-enqueueing would echo every change around the ring forever);
 * those side effects happened on the origin device. One exception: an order
 * image refused because this till took money on the order sends this till's
 * row back (sendOrderBack), once.
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
 * device's local copy is newer). Two exceptions, whatever the versions say:
 * deletion wins for orders and payments (DELETE_WINS), and on an order a
 * cancel or refund is never undone by the other till's status tap, while
 * money taken beats a cancel or a tap (orderRace).
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
import { quoteIdent, readRowImage, replicableTables } from '../replicable-schema.js';
import { writeAudit } from './audit-repo.js';
import { enqueueSync, readParked, writeParked, type ParkedChange } from './sync-repo.js';

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

/**
 * Deletion wins, both ways, for orders and their payments (a test order the
 * owner deleted, 0043): the two tills must never disagree about whether a
 * sale exists.
 *  - A delete that arrives stale (this till changed the row since) is still
 *    applied — only deleted_at and the delete_* columns, the version left
 *    alone — and noted in this till's audit trail ('remote_delete_applied').
 *  - A newer change that arrives for a row deleted here is applied, but the
 *    row stays deleted ('remote_change_kept_deleted').
 * Only the older domain-shaped handlers (menu, customers) ever clear
 * deleted_at, and they are not these tables.
 */
const DELETE_WINS: ReadonlySet<string> = new Set(['orders', 'payments']);
const DELETE_COLUMNS = ['deleted_at', 'deleted_by', 'delete_reason', 'delete_kind', 'delete_stock'] as const;

/** The delete columns this table has (orders: all of them; payments: deleted_at). */
function deleteColumnsOf(table: { columns: ReadonlyArray<{ name: string }> }): string[] {
  const have = new Set(table.columns.map((c) => c.name));
  return DELETE_COLUMNS.filter((c) => have.has(c));
}

/**
 * A cancel or a refund, and the other till (orders only; order-edit finding
 * #9, v0.7.34). Rows settle by last write, so a status tap on one till (Send
 * out, Preparing, Delivered) could bring back an order the other till had
 * cancelled, and a cancel — validateVoid sees only its own till's unpaid
 * copy — could land on an order the other till had just taken money for
 * (Rider paid, Delivered + Pay), leaving a payment, the rider's payout and a
 * drawer row on a cancelled order. Checked after DELETE_WINS, whatever the
 * versions say, in this order:
 *  (1) money beats a cancel:
 *      - a cancel ('void') for an order paid here: nothing of it is written
 *        ('remote_cancel_refused_paid');
 *      - a paid image for an order cancelled here with nothing paid: applied
 *        in full, the cancel's columns cleared as the image has them
 *        ('remote_payment_overrode_cancel', listing this till's live cash
 *        movements for the order — a trip paid at the cancel — and the
 *        cancel's stock answer). Nothing is reversed: the money already left
 *        the drawer, and the owner sees it in the drawer log;
 *  (2) money taken is never wiped by a tap (two-tills review, v0.7.34): Rider
 *      paid or Delivered + Pay on one till, and Back to Ready, Assign rider or
 *      any status tap the other till made before it heard of the money. Which
 *      row holds more money facts is read from the two rows alone (moneyFacts),
 *      so both tills give the same answer:
 *      - a newer image that would undo money taken here — clear paid_at, or
 *        clear what the outside rider kept on a live order whose money with
 *        him is settled — is refused: nothing of it is written but a delete
 *        (DELETE_WINS), and this till's row goes back to the other till
 *        ('remote_change_refused_paid');
 *      - an older image that carries money this till's row has not got is
 *        applied in full, over this till's newer tap ('remote_payment_overrode_change').
 *        (Newer, it is plain last write wins.)
 *      Nothing clears paid_at on purpose, and Assign rider and Back to Ready
 *      refuse once the rider's money is settled, so no real change is lost;
 *  (3) an older image that is cancelled or refunded, for an order still live
 *      here: only its status and cancel columns are written, the version and
 *      every other column stay ('remote_cancel_applied');
 *  (4) a newer image with a live status, for an order cancelled or refunded
 *      here: applied, but the status and cancel columns stay
 *      ('remote_change_kept_cancelled');
 *  (5) cancelled or refunded on both: last write wins, as for any row.
 * A cancelled order may so keep a racing rider_keeps_cents or dispatched_at;
 * every reader of those skips cancelled and refunded orders.
 *
 * Both tills end with the same row: the row with more money facts is a fixed
 * point (refused on its own till, taken on the other whatever the versions
 * say), and a refusal sends it back once, so it reaches the other till even
 * when its first image did not. It never echoes: the other till takes it.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['void', 'refunded']);
const CANCEL_COLUMNS = ['status', 'voided_at', 'voided_by', 'void_reason'] as const;

/** What this till holds of an order, for orderRace. */
interface LocalOrder {
  status: string;
  paid_at: string | null;
  rider_keeps_cents: number | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
}

type OrderRace =
  | { kind: 'refuse_cancel'; local: LocalOrder; incoming: string }
  | { kind: 'payment_over_cancel'; local: LocalOrder; incoming: string }
  | { kind: 'refuse_unpaying'; local: LocalOrder; incoming: string }
  | { kind: 'payment_over_change'; local: LocalOrder; incoming: string }
  | { kind: 'cancel_wins'; local: LocalOrder; incoming: string }
  | { kind: 'keep_cancelled'; local: LocalOrder; incoming: string };

const isSetText = (v: unknown): v is string => typeof v === 'string' && v !== '';

/**
 * On a paid order, the outside rider's money is settled when he kept
 * something (rider_keeps_cents above 0): he paid the shop while out (Rider
 * paid, Delivered + Pay), or the customer paid before and the drawer paid him
 * at Send out. Either way a payout to him stands.
 */
const keptByRider = (keeps: unknown): boolean => typeof keeps === 'number' && keeps > 0;

/**
 * Which row carries more money facts (orderRace (2)): 'here' when the
 * incoming image would undo money taken on this till's row, 'theirs' when it
 * carries money this till's row has not got, null when neither. Paid beats
 * unpaid, in any status; on two paid rows, both live, a settled outside
 * rider (keptByRider) beats a row without one. A key the image does not
 * carry (an older till) leaves that column alone, so it undoes nothing.
 */
function moneyFacts(local: LocalOrder, image: RowImage, incoming: string): 'here' | 'theirs' | null {
  const localPaid = local.paid_at !== null;
  const incomingPaid = isSetText(image['paidAt']);
  if (localPaid && !incomingPaid && Object.hasOwn(image, 'paidAt')) return 'here';
  if (!localPaid && incomingPaid) return 'theirs';
  if (!localPaid || !incomingPaid || TERMINAL_STATUSES.has(local.status) || TERMINAL_STATUSES.has(incoming)) return null;
  const settledHere = keptByRider(local.rider_keeps_cents);
  const settledThere = keptByRider(image['riderKeepsCents']);
  if (settledHere && !settledThere && Object.hasOwn(image, 'riderKeepsCents')) return 'here';
  if (!settledHere && settledThere) return 'theirs';
  return null;
}

/** Which of the rules above an order image meets here, or null for plain last-write-wins. */
function orderRace(db: AppDatabase, id: string, image: RowImage, stale: boolean): OrderRace | null {
  const incoming = image['status'];
  if (typeof incoming !== 'string') return null;
  const local = db
    .prepare(`SELECT status, paid_at, rider_keeps_cents, voided_at, voided_by, void_reason FROM orders WHERE id = ?`)
    .get(id) as LocalOrder | undefined;
  if (!local) return null;
  const incomingPaid = isSetText(image['paidAt']);
  const incomingTerminal = TERMINAL_STATUSES.has(incoming);
  const localTerminal = TERMINAL_STATUSES.has(local.status);
  if (incoming === 'void' && local.paid_at !== null) return { kind: 'refuse_cancel', local, incoming };
  if (incoming !== 'void' && incomingPaid && local.status === 'void' && local.paid_at === null) {
    return { kind: 'payment_over_cancel', local, incoming };
  }
  if (incoming !== 'void') {
    // Only where last write wins would get it wrong: an older image that
    // undoes money is dropped as stale anyway, a newer one with money applied.
    const money = moneyFacts(local, image, incoming);
    if (money === 'here') return stale ? null : { kind: 'refuse_unpaying', local, incoming };
    if (money === 'theirs') return stale ? { kind: 'payment_over_change', local, incoming } : null;
  }
  if (stale && incomingTerminal && !localTerminal) return { kind: 'cancel_wins', local, incoming };
  if (!stale && !incomingTerminal && localTerminal) return { kind: 'keep_cancelled', local, incoming };
  return null;
}

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
  const deleteWins = DELETE_WINS.has(table.name);
  const localRow = deleteWins
    ? ((db.prepare(`SELECT deleted_at FROM ${quoteIdent(table.name)} WHERE id = ?`).get(change.entityId) as
        | { deleted_at: string | null }
        | undefined) ?? null)
    : null;
  const incomingDeleted = typeof image['deletedAt'] === 'string' && image['deletedAt'] !== '';
  const stale = isStale(db, table.name, change.entityId, change.version, change.updatedAt);
  if (stale && deleteWins && incomingDeleted && localRow !== null && localRow.deleted_at === null) {
    return applyRemoteDelete(db, table, change, image);
  }
  // A cancel or refund and the other till's status tap or money (orders only).
  const race = table.name === 'orders' ? orderRace(db, change.entityId, image, stale) : null;
  if (race?.kind === 'refuse_cancel') {
    // A delete that comes with the cancel is still DELETE_WINS's: only its
    // delete columns, as when it arrives stale. The status stays as paid here.
    if (incomingDeleted && localRow !== null && localRow.deleted_at === null) {
      return applyRemoteDelete(db, table, change, image);
    }
    return refuseRemoteCancel(db, change, image, race);
  }
  if (race?.kind === 'refuse_unpaying') {
    // The same for a tap that would undo the money taken here.
    if (incomingDeleted && localRow !== null && localRow.deleted_at === null) {
      return applyRemoteDelete(db, table, change, image);
    }
    return refuseRemoteUnpaying(db, change, image, race);
  }
  if (stale && race?.kind === 'cancel_wins') return applyRemoteCancel(db, change, image, race);
  if (stale && race?.kind !== 'payment_over_cancel' && race?.kind !== 'payment_over_change') {
    return { applied: false, reason: 'stale' };
  }
  // A newer change for a row deleted here: applied, but it stays deleted.
  const keepDeleted = deleteWins && localRow !== null && localRow.deleted_at !== null && !incomingDeleted;
  // A newer live change for an order cancelled or refunded here: applied, but it stays so.
  const keepCancelled = race?.kind === 'keep_cancelled';

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
  // Money beats a cancel: a live order paid on the other till is not
  // cancelled here any more, even when its image does not carry the columns.
  if (race?.kind === 'payment_over_cancel' && !TERMINAL_STATUSES.has(race.incoming)) {
    for (const c of CANCEL_COLUMNS) {
      if (c === 'status') continue;
      const i = cols.indexOf(c);
      if (i === -1) {
        cols.push(c);
        vals.push(null);
      } else vals[i] = null;
    }
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
    const keepHere = new Set([
      'id',
      'created_at',
      ...(RECEIVER_KEEPS_ON_UPDATE[table.name] ?? []),
      ...(keepDeleted ? deleteColumnsOf(table) : []),
      ...(keepCancelled ? CANCEL_COLUMNS : []),
    ]);
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

  if (keepDeleted) {
    writeAudit(db, {
      entityType: table.name,
      entityId: change.entityId,
      action: 'remote_change_kept_deleted',
      actorUserId: null,
      before: { deletedAt: localRow?.deleted_at ?? null },
      after: { version: change.version, updatedAt: change.updatedAt, fromDeviceId: change.deviceId },
    });
  }
  if (race?.kind === 'keep_cancelled') {
    writeAudit(db, {
      entityType: 'orders',
      entityId: change.entityId,
      action: 'remote_change_kept_cancelled',
      actorUserId: null,
      before: { status: race.local.status },
      after: {
        status: race.local.status,
        remoteStatus: race.incoming,
        version: change.version,
        updatedAt: change.updatedAt,
        fromDeviceId: change.deviceId,
      },
    });
  }
  if (race?.kind === 'payment_over_cancel') notePaymentOverCancel(db, change, image, race);
  if (race?.kind === 'payment_over_change') {
    writeAudit(db, {
      entityType: 'orders',
      entityId: change.entityId,
      action: 'remote_payment_overrode_change',
      actorUserId: null,
      before: moneyNote(race.local.status, race.local.paid_at, race.local.rider_keeps_cents),
      after: {
        ...moneyNote(race.incoming, image['paidAt'], image['riderKeepsCents']),
        version: change.version,
        updatedAt: change.updatedAt,
        fromDeviceId: change.deviceId,
      },
    });
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
 * A delete from the other till that arrived after this till changed the row
 * (DELETE_WINS): only the delete columns are written — deleted_at and, on an
 * order, who deleted it, why, how and what it did to its stock — the rest of
 * this till's row and its version stay. Noted in this till's own audit trail.
 */
function applyRemoteDelete(
  db: AppDatabase,
  table: { name: string; columns: ReadonlyArray<{ name: string }> },
  change: SyncChange,
  image: RowImage,
): ApplyResult {
  const set: Array<{ c: string; v: string | null }> = [];
  for (const col of deleteColumnsOf(table)) {
    const v = image[columnKey(col)];
    if (col === 'deleted_at') {
      set.push({ c: col, v: String(v) });
      continue;
    }
    if (!Object.hasOwn(image, columnKey(col))) continue;
    if (v !== null && typeof v !== 'string') return { applied: false, reason: 'malformed' };
    set.push({ c: col, v });
  }
  db.prepare(
    `UPDATE ${quoteIdent(table.name)} SET ${set.map(({ c }) => `${quoteIdent(c)} = ?`).join(', ')}
      WHERE id = ? AND deleted_at IS NULL`,
  ).run(...set.map(({ v }) => v), change.entityId);
  writeAudit(db, {
    entityType: table.name,
    entityId: change.entityId,
    action: 'remote_delete_applied',
    actorUserId: null,
    before: { deletedAt: null },
    after: {
      ...Object.fromEntries(set.map(({ c, v }) => [columnKey(c), v])),
      remoteVersion: change.version,
      fromDeviceId: change.deviceId,
    },
  });
  return { applied: true };
}

/**
 * Money beats a cancel (orderRace (1)): the other till cancelled an order
 * this till has taken money for. Nothing of the image is written — the
 * order, its payment, the rider's payout and the drawer row stay as they are
 * here — and the refusal goes into this till's own audit trail. This till's
 * row goes back to the other till (sendOrderBack). Nothing to retry, so it
 * is reported as stale.
 */
function refuseRemoteCancel(
  db: AppDatabase,
  change: SyncChange,
  image: RowImage,
  race: Extract<OrderRace, { kind: 'refuse_cancel' }>,
): ApplyResult {
  writeAudit(db, {
    entityType: 'orders',
    entityId: change.entityId,
    action: 'remote_cancel_refused_paid',
    actorUserId: null,
    before: { status: race.local.status, paidAt: race.local.paid_at },
    after: {
      voidedAt: image['voidedAt'] ?? null,
      voidedBy: image['voidedBy'] ?? null,
      voidReason: image['voidReason'] ?? null,
      fromDeviceId: change.deviceId,
    },
  });
  sendOrderBack(db, change.entityId);
  return { applied: false, reason: 'stale' };
}

/**
 * Money taken is never wiped by a tap (orderRace (2)): a newer image from
 * the other till — Back to Ready, Assign rider, any status tap made before
 * it heard of the money — would clear this till's paid_at, or what a settled
 * outside rider kept. Nothing of it is written: the order, its payments, the
 * rider's payout and the drawer rows stay as they are here. The refusal goes
 * into this till's own audit trail with what each row said, and this till's
 * row goes back to the other till (sendOrderBack), which takes it whatever
 * the versions say. Reported as stale (nothing to retry).
 */
function refuseRemoteUnpaying(
  db: AppDatabase,
  change: SyncChange,
  image: RowImage,
  race: Extract<OrderRace, { kind: 'refuse_unpaying' }>,
): ApplyResult {
  writeAudit(db, {
    entityType: 'orders',
    entityId: change.entityId,
    action: 'remote_change_refused_paid',
    actorUserId: null,
    before: moneyNote(race.local.status, race.local.paid_at, race.local.rider_keeps_cents),
    after: {
      ...moneyNote(race.incoming, image['paidAt'], image['riderKeepsCents']),
      version: change.version,
      updatedAt: change.updatedAt,
      fromDeviceId: change.deviceId,
    },
  });
  sendOrderBack(db, change.entityId);
  return { applied: false, reason: 'stale' };
}

/** An order's money facts, for the audit rows of orderRace (2). */
function moneyNote(status: string, paidAt: unknown, riderKeepsCents: unknown): Record<string, unknown> {
  return {
    status,
    paidAt: typeof paidAt === 'string' ? paidAt : null,
    riderKeepsCents: typeof riderKeepsCents === 'number' ? riderKeepsCents : null,
  };
}

/**
 * After a refusal (orderRace (1) and (2)): queue this till's row of the
 * order, as it is now, for the other till — so it ends with the same row
 * even when the first image of the money never reached it. Skipped when the
 * newest unsent entry for the order already carries exactly this row. It
 * never echoes round: the other till takes a row with more money facts than
 * its own and refuses nothing it takes. The row is not touched here (its
 * version and updated_at stay as written).
 */
function sendOrderBack(db: AppDatabase, orderId: string): void {
  const image = readRowImage(db, 'orders', orderId);
  if (!image) return;
  const queued = db
    .prepare(
      `SELECT payload_json FROM sync_queue
        WHERE entity_type = 'orders' AND entity_id = ? AND synced_at IS NULL
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(orderId) as { payload_json: string } | undefined;
  if (queued?.payload_json === JSON.stringify(image)) return;
  enqueueSync(db, { entityType: 'orders', entityId: orderId, op: 'upsert', payload: image });
}

/**
 * A cancel or refund wins (orderRace (3)): an older image that cancelled or
 * refunded an order still live here. Only its status and cancel columns are
 * written (who, when, why); the version and every other column stay, so a
 * Send out made here keeps its rider_keeps_cents and dispatched_at.
 */
function applyRemoteCancel(
  db: AppDatabase,
  change: SyncChange,
  image: RowImage,
  race: Extract<OrderRace, { kind: 'cancel_wins' }>,
): ApplyResult {
  const set: Array<{ c: string; v: string | null }> = [{ c: 'status', v: race.incoming }];
  for (const c of CANCEL_COLUMNS) {
    if (c === 'status') continue;
    const key = columnKey(c);
    if (!Object.hasOwn(image, key)) continue;
    const v = image[key];
    if (v !== null && typeof v !== 'string') return { applied: false, reason: 'malformed' };
    set.push({ c, v });
  }
  db.prepare(`UPDATE orders SET ${set.map(({ c }) => `${quoteIdent(c)} = ?`).join(', ')} WHERE id = ?`).run(
    ...set.map(({ v }) => v),
    change.entityId,
  );
  writeAudit(db, {
    entityType: 'orders',
    entityId: change.entityId,
    action: 'remote_cancel_applied',
    actorUserId: null,
    before: { status: race.local.status },
    after: { status: race.incoming, fromDeviceId: change.deviceId },
  });
  return { applied: true };
}

/**
 * Money beats a cancel (orderRace (1)), the other way: this till cancelled
 * an order the other till has taken money for, and the paid image was
 * applied over the cancel. The audit row names what the cancel left here
 * that nobody reverses: this till's live cash movements for the order (a
 * trip paid to the outside rider at the cancel — the money already left the
 * drawer, and the drawer log shows it) and the cancel's answer about the
 * stock ('made' | 'not_made', null when it held none).
 */
function notePaymentOverCancel(
  db: AppDatabase,
  change: SyncChange,
  image: RowImage,
  race: Extract<OrderRace, { kind: 'payment_over_cancel' }>,
): void {
  const here = localDeviceId(db);
  const moves = (
    here !== null
      ? db
          .prepare(
            `SELECT id FROM cash_movements WHERE order_id = ? AND deleted_at IS NULL AND device_id = ? ORDER BY created_at, id`,
          )
          .all(change.entityId, here)
      : db
          .prepare(
            `SELECT id FROM cash_movements WHERE order_id = ? AND deleted_at IS NULL AND device_id != ? ORDER BY created_at, id`,
          )
          .all(change.entityId, change.deviceId)
  ) as Array<{ id: string }>;
  writeAudit(db, {
    entityType: 'orders',
    entityId: change.entityId,
    action: 'remote_payment_overrode_cancel',
    actorUserId: null,
    before: {
      status: race.local.status,
      voidedAt: race.local.voided_at,
      voidedBy: race.local.voided_by,
      voidReason: race.local.void_reason,
    },
    after: {
      status: race.incoming,
      paidAt: image['paidAt'] ?? null,
      fromDeviceId: change.deviceId,
      cashMovementIds: moves.map((m) => m.id),
      stockAnswer: cancelStockAnswer(db, change.entityId),
    },
  });
}

/**
 * The answer about the stock this till's cancel gave: its own order-level
 * audit row ('stock_to_waste' / 'stock_put_back', settleOrderStock), or null
 * when the order held none.
 */
function cancelStockAnswer(db: AppDatabase, orderId: string): 'made' | 'not_made' | null {
  const row = db
    .prepare(
      `SELECT action, after_json FROM audit_log
        WHERE entity_type = 'orders' AND entity_id = ? AND action IN ('stock_put_back', 'stock_to_waste')
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get(orderId) as { action: string; after_json: string | null } | undefined;
  if (!row) return null;
  const outcome = (parseJsonOr(row.after_json) as { outcome?: unknown } | null)?.outcome;
  if (outcome === 'made' || outcome === 'not_made') return outcome;
  return row.action === 'stock_to_waste' ? 'made' : 'not_made';
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
        `INSERT INTO tax_categories (id, name, rate_bps, digital_rate_bps, created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, rate_bps = excluded.rate_bps,
           digital_rate_bps = excluded.digital_rate_bps,
           updated_at = excluded.updated_at, version = excluded.version,
           deleted_at = NULL`,
      ).run(
        c.entityId,
        p.name,
        p.rateBps,
        // The card rate (0052); a till from before it sends none.
        typeof p.digitalRateBps === 'number' ? p.digitalRateBps : null,
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
