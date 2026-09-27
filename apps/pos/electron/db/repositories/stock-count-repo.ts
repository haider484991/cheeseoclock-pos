/**
 * Stock takes (costing spec Phase 8, migration 0038): start, count shelf by
 * shelf, finish — or cancel.
 *
 *  - start:  a stock_counts row ('open') and one line per ingredient on the
 *            sheet (the whole store room, the key items, or picked ones),
 *            blank;
 *  - save:   what the cook counted so far (a shelf at a time), in the
 *            ingredient's unit, with when it was counted (counted_at);
 *  - finish: ONE transaction. For every counted line: the count carried
 *            forward from when its shelf was counted to the finish by every
 *            till's stock rows in between (the till kept selling while the
 *            cook counted), SHOP stock at the finish (the last stock take
 *            plus every till's stock rows since, costing spec 4.6) as
 *            `expected_qty`, this till's own count as `till_qty`, the price
 *            then and what the counted stock is worth, and a 'count' stock
 *            row (detail 'stock_take', ref_group_id = the stock take) that
 *            sets this till's count to what is on the shelf. Finishing again
 *            writes nothing (it answers with what was written the first
 *            time). Left as it is: an order sent between a shelf's count and
 *            the finish, then cancelled "not made" after the finish, is
 *            booked "already in the stock take" (its food was taken off the
 *            carried count, and is on the shelf) — 1 order's worth low until
 *            the next count, where the old way was 1 order's worth high for
 *            every such order that WAS made;
 *  - cancel: the stock take is dropped ('cancelled'); nothing is written to
 *            stock, no count moves.
 * The Stock button's "Stock take" is a one-line stock take ('custom'),
 * started, counted and finished in one go.
 *
 * Every write here is its row, its sync entry and a hash-chained audit row,
 * in one transaction (CLAUDE.md "the repositories rule"); the 'count' stock
 * rows go through recordStockMovement, which does the same for each.
 */
import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { recordStockMovement } from './stock-movement-repo.js';
import { loadPriceBook, priceOfBook, safeStockValue } from '../price-book.js';
import { shopMovesBetween, shopStockAt } from '../stock-ledger-read.js';
import { guessIngredientCategory, isIngredientCategory, mulDivRound, unitFactor } from '@cheeseoclock/pos-domain';
import {
  STOCK_COUNT_SCOPE_LABEL,
  isStockCountScope,
  isStockCountStatus,
  type StockCountDetail,
  type StockCountLine,
  type StockCountScope,
  type StockCountStatus,
  type StockCountSummary,
} from '@cheeseoclock/shared-types';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface CountRow {
  id: string;
  scope: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  counted_by_user_id: string | null;
  counted_by_name: string | null;
  notes: string | null;
  device_id: string;
}

const COUNT_SELECT = `
  c.id, c.scope, c.status, c.started_at, c.finished_at, c.counted_by_user_id, c.notes, c.device_id,
  u.full_name AS counted_by_name`;

interface LineRow {
  id: string;
  ingredient_id: string;
  counted_qty: number | null;
  unit: string | null;
  counted_at: string | null;
  expected_qty: number | null;
  till_qty: number | null;
  unit_cost_mc: number | null;
  value_cents: number | null;
  movement_id: string | null;
  version: number;
  name: string | null;
  ing_unit: string | null;
  category: string | null;
  pack_size: number | null;
  ing_deleted: string | null;
  current_qty: number | null;
}

const LINE_SELECT = `
  l.id, l.ingredient_id, l.counted_qty, l.unit, l.counted_at, l.expected_qty, l.till_qty, l.unit_cost_mc, l.value_cents,
  l.movement_id, l.version, i.name, i.unit AS ing_unit, i.category, i.pack_size, i.deleted_at AS ing_deleted,
  i.current_qty`;

function readCount(db: AppDatabase, id: string): CountRow | undefined {
  return db
    .prepare(`SELECT ${COUNT_SELECT} FROM stock_counts c LEFT JOIN users u ON u.id = c.counted_by_user_id WHERE c.id = ? AND c.deleted_at IS NULL`)
    .get(id) as CountRow | undefined;
}

function readLines(db: AppDatabase, countId: string): LineRow[] {
  return db
    .prepare(
      `SELECT ${LINE_SELECT} FROM stock_count_lines l LEFT JOIN ingredients i ON i.id = l.ingredient_id
        WHERE l.stock_count_id = ? AND l.deleted_at IS NULL
        ORDER BY i.name, l.ingredient_id`,
    )
    .all(countId) as LineRow[];
}

const scopeOf = (s: string): StockCountScope => (isStockCountScope(s) ? s : 'custom');
const statusOf = (s: string): StockCountStatus => (isStockCountStatus(s) ? s : 'open');

/** A quantity stored in `from` as the ingredient's unit now (1 when unconvertible: shown as stored). */
function inUnitNow(qty: number | null, from: string | null, unitNow: string): number | null {
  if (qty === null) return null;
  return Number(qty) * (unitFactor(from, unitNow) ?? 1);
}

/**
 * What a difference is worth at the price the stock take was finished at:
 * its quantity × the price of one unit then (millicents), rounded once.
 */
function differenceCents(diff: number, unitCostMc: number | null): number | null {
  return unitCostMc === null ? null : mulDivRound(diff, unitCostMc, 1000);
}

function toLine(l: LineRow, earlier: ReadonlySet<string>, done: boolean): StockCountLine {
  const unitNow = l.ing_unit ?? l.unit ?? '';
  const counted = inUnitNow(l.counted_qty, l.unit, unitNow);
  const valued = done && counted !== null && l.expected_qty !== null;
  // Counted, expected, the till's count and the price per unit were all
  // written in the unit of the finish (the line's own unit); shown in the unit now.
  const expected = valued ? inUnitNow(l.expected_qty, l.unit, unitNow) : null;
  const till = valued ? inUnitNow(l.till_qty, l.unit, unitNow) : null;
  const factor = unitFactor(l.unit, unitNow) ?? 1;
  const diffStored = valued ? Number(l.counted_qty) - Number(l.expected_qty) : null;
  const name = l.name ?? 'Deleted ingredient';
  return {
    ingredientId: l.ingredient_id,
    name,
    unit: unitNow,
    shelf: isIngredientCategory(l.category) ? l.category : guessIngredientCategory(name),
    packSize: l.pack_size === null ? null : Number(l.pack_size),
    countedQty: counted,
    expectedQty: expected,
    expectedFrom: valued ? (earlier.has(l.ingredient_id) ? 'shop' : 'till') : null,
    tillQty: till,
    differenceQty: diffStored === null ? null : diffStored * factor,
    differenceCents: diffStored === null ? null : differenceCents(diffStored, l.unit_cost_mc === null ? null : Number(l.unit_cost_mc)),
    valueCents: valued && l.value_cents !== null ? Number(l.value_cents) : null,
    unitCostMc: valued && l.unit_cost_mc !== null ? Number(l.unit_cost_mc) : null,
  };
}

/** Ingredients of the stock take counted on an earlier finished stock take (their "expected" was shop stock). */
function countedBefore(db: AppDatabase, ingredientIds: string[], beforeIso: string, countId: string): Set<string> {
  if (ingredientIds.length === 0) return new Set();
  return new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT l.ingredient_id AS id
             FROM stock_count_lines l JOIN stock_counts c ON c.id = l.stock_count_id
            WHERE l.ingredient_id IN (SELECT value FROM json_each(?)) AND l.deleted_at IS NULL AND l.counted_qty IS NOT NULL
              AND c.status = 'done' AND c.deleted_at IS NULL AND c.id <> ? AND c.finished_at < ?`,
        )
        .all(JSON.stringify(ingredientIds), countId, beforeIso) as Array<{ id: string }>
    ).map((r) => r.id),
  );
}

function summaryOf(c: CountRow, lines: readonly StockCountLine[], deviceId: string): StockCountSummary {
  const done = statusOf(c.status) === 'done';
  let short = 0;
  let over = 0;
  for (const l of lines) {
    const v = l.differenceCents ?? 0;
    if (v < 0) short += -v;
    else over += v;
  }
  return {
    id: c.id,
    scope: scopeOf(c.scope),
    status: statusOf(c.status),
    startedAt: c.started_at,
    finishedAt: c.finished_at,
    countedByName: c.counted_by_name,
    notes: c.notes,
    lineCount: lines.length,
    countedCount: lines.filter((l) => l.countedQty !== null).length,
    shortCents: done ? short : null,
    overCents: done ? over : null,
    thisTill: c.device_id === deviceId,
  };
}

/** One stock take with its sheet; null when there is no such stock take. */
export function getStockCount(db: AppDatabase, id: string, deviceId: string): StockCountDetail | null {
  const c = readCount(db, id);
  if (!c) return null;
  const rows = readLines(db, id);
  const done = statusOf(c.status) === 'done';
  const earlier = done && c.finished_at ? countedBefore(db, rows.map((r) => r.ingredient_id), c.finished_at, id) : new Set<string>();
  const lines = rows.map((r) => toLine(r, earlier, done));
  return { ...summaryOf(c, lines, deviceId), lines };
}

/** The stock takes, open ones first, then the newest; cancelled ones too (they are history). */
export function listStockCounts(db: AppDatabase, deviceId: string, opts: { limit?: number } = {}): StockCountSummary[] {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 60)));
  const counts = db
    .prepare(
      `SELECT ${COUNT_SELECT} FROM stock_counts c LEFT JOIN users u ON u.id = c.counted_by_user_id
        WHERE c.deleted_at IS NULL
        ORDER BY (c.status = 'open') DESC, COALESCE(c.finished_at, c.started_at) DESC, c.id DESC
        LIMIT ?`,
    )
    .all(limit) as CountRow[];
  if (counts.length === 0) return [];
  // Every listed stock take's lines in one read: the figures the list shows.
  const lines = db
    .prepare(
      `SELECT l.stock_count_id AS countId, l.counted_qty, l.unit, l.expected_qty, l.unit_cost_mc, i.unit AS ing_unit
         FROM stock_count_lines l LEFT JOIN ingredients i ON i.id = l.ingredient_id
        WHERE l.stock_count_id IN (SELECT value FROM json_each(?)) AND l.deleted_at IS NULL`,
    )
    .all(JSON.stringify(counts.map((c) => c.id))) as Array<{
    countId: string;
    counted_qty: number | null;
    unit: string | null;
    expected_qty: number | null;
    unit_cost_mc: number | null;
    ing_unit: string | null;
  }>;
  const byCount = new Map<string, typeof lines>();
  for (const l of lines) {
    let list = byCount.get(l.countId);
    if (!list) byCount.set(l.countId, (list = []));
    list.push(l);
  }
  return counts.map((c) => {
    const done = statusOf(c.status) === 'done';
    const own = byCount.get(c.id) ?? [];
    const shown: StockCountLine[] = own.map((l) => {
      const diff = done && l.counted_qty !== null && l.expected_qty !== null ? Number(l.counted_qty) - Number(l.expected_qty) : null;
      return {
        ingredientId: '',
        name: '',
        unit: l.ing_unit ?? '',
        shelf: 'other',
        packSize: null,
        countedQty: l.counted_qty,
        expectedQty: null,
        expectedFrom: null,
        tillQty: null,
        differenceQty: diff,
        // Both in the line's own unit, as its price per unit.
        differenceCents: diff === null ? null : differenceCents(diff, l.unit_cost_mc === null ? null : Number(l.unit_cost_mc)),
        valueCents: null,
        unitCostMc: null,
      };
    });
    return summaryOf(c, shown, deviceId);
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface StartStockCountInput {
  scope: StockCountScope;
  /** 'custom' only. */
  ingredientIds?: string[];
  notes?: string | null;
}

/** The till's refusals, as the manager reads them. */
export const NO_KEY_ITEMS = 'There are no key items yet: tick "Key item" on the ingredients you count every week.';
export const PICK_SOMETHING = 'Pick at least one ingredient to count.';

/** The ingredients a new stock take of `scope` counts. */
function sheetIngredients(db: AppDatabase, input: StartStockCountInput): Array<{ id: string; unit: string }> {
  if (input.scope === 'full') {
    return db.prepare(`SELECT id, unit FROM ingredients WHERE deleted_at IS NULL AND is_active = 1 ORDER BY name`).all() as Array<{ id: string; unit: string }>;
  }
  if (input.scope === 'key_items') {
    return db
      .prepare(`SELECT id, unit FROM ingredients WHERE deleted_at IS NULL AND is_active = 1 AND count_weekly = 1 ORDER BY name`)
      .all() as Array<{ id: string; unit: string }>;
  }
  const wanted = [...new Set(input.ingredientIds ?? [])];
  if (wanted.length === 0) return [];
  return db
    .prepare(`SELECT id, unit FROM ingredients WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY name`)
    .all(JSON.stringify(wanted)) as Array<{ id: string; unit: string }>;
}

/**
 * Start a stock take: its row ('open') and a blank line for every
 * ingredient it counts, synced, with one audit row — one transaction.
 */
export function startStockCount(db: AppDatabase, input: StartStockCountInput, actor: Actor): StockCountDetail {
  const id = uuidv7();
  const notes = (input.notes ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  db.transaction(() => {
    const ings = sheetIngredients(db, input);
    if (ings.length === 0) throw new Error(input.scope === 'key_items' ? NO_KEY_ITEMS : PICK_SOMETHING);
    const now = nowIso();
    db.prepare(
      `INSERT INTO stock_counts (id, scope, status, started_at, finished_at, counted_by_user_id, notes, created_at, updated_at, device_id, version)
       VALUES (?, ?, 'open', ?, NULL, ?, ?, ?, ?, ?, 1)`,
    ).run(id, input.scope, now, actor.userId, notes, now, now, actor.deviceId);
    enqueueSync(db, { entityType: 'stock_counts', entityId: id, op: 'upsert', payload: { id } });
    const insertLine = db.prepare(
      `INSERT INTO stock_count_lines (id, stock_count_id, ingredient_id, counted_qty, unit, created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 1)`,
    );
    for (const ing of ings) {
      const lineId = uuidv7();
      insertLine.run(lineId, id, ing.id, ing.unit, now, now, actor.deviceId);
      enqueueSync(db, { entityType: 'stock_count_lines', entityId: lineId, op: 'upsert', payload: { id: lineId } });
    }
    writeAudit(db, {
      entityType: 'stock_counts',
      entityId: id,
      action: 'stock_count_start',
      actorUserId: actor.userId,
      before: null,
      after: { scope: input.scope, lines: ings.length, notes, deviceId: actor.deviceId },
    });
  })();
  return getStockCount(db, id, actor.deviceId)!;
}

function refuseUnlessOpen(c: CountRow | undefined): CountRow {
  if (!c) throw new Error('That stock take is not on this till');
  if (c.status === 'done') throw new Error('This stock take is finished. Start a new one to count again.');
  if (c.status === 'cancelled') throw new Error('This stock take was cancelled.');
  return c;
}

/**
 * Save what was counted so far (a shelf at a time), in each ingredient's
 * unit now; null clears a line. Only lines that change are written, each
 * with its sync entry, and one audit row for the save — one transaction.
 */
export function saveStockCountLines(
  db: AppDatabase,
  input: { countId: string; lines: ReadonlyArray<{ ingredientId: string; countedQty: number | null }> },
  actor: Actor,
): { lineCount: number; countedCount: number } {
  db.transaction(() => {
    refuseUnlessOpen(readCount(db, input.countId));
    const lines = new Map(readLines(db, input.countId).map((l) => [l.ingredient_id, l]));
    const now = nowIso();
    const update = db.prepare(`UPDATE stock_count_lines SET counted_qty = ?, unit = ?, counted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`);
    const changes: Array<{ ingredientId: string; from: number | null; to: number | null }> = [];
    for (const want of input.lines) {
      const l = lines.get(want.ingredientId);
      if (!l) throw new Error(`${want.ingredientId} is not on this stock take`);
      if (want.countedQty !== null && (!Number.isSafeInteger(want.countedQty) || want.countedQty < 0)) {
        throw new Error('A count is a whole number, zero or more');
      }
      const unitNow = l.ing_unit ?? l.unit;
      const from = inUnitNow(l.counted_qty, l.unit, unitNow ?? '');
      if (from === want.countedQty && l.unit === unitNow) continue;
      // When the shelf was counted: the finish carries the figure forward from here.
      update.run(want.countedQty, unitNow, want.countedQty === null ? null : now, now, l.id);
      enqueueSync(db, { entityType: 'stock_count_lines', entityId: l.id, op: 'upsert', payload: { id: l.id } });
      changes.push({ ingredientId: want.ingredientId, from, to: want.countedQty });
    }
    if (changes.length > 0) {
      writeAudit(db, {
        entityType: 'stock_counts',
        entityId: input.countId,
        action: 'stock_count_save',
        actorUserId: actor.userId,
        before: null,
        after: { changes },
      });
    }
  })();
  const lines = readLines(db, input.countId);
  return { lineCount: lines.length, countedCount: lines.filter((l) => l.counted_qty !== null).length };
}

/** The till's refusals when finishing. */
export const NOTHING_COUNTED = 'Count at least one item before finishing, or cancel the stock take.';

/**
 * When a line's shelf was counted, as the finish uses it: its save time,
 * kept within the stock take (not before it started, not after the finish —
 * a save on the other till, whose clock may run ahead). No time: the finish.
 */
function countedAtOf(countedAt: string | null, startedAt: string, finishedAt: string): string {
  if (!countedAt || !Number.isFinite(Date.parse(countedAt))) return finishedAt;
  if (countedAt > finishedAt) return finishedAt;
  return countedAt < startedAt ? startedAt : countedAt;
}

/**
 * What every till's stock rows moved one ingredient by between the moment
 * its shelf was counted and the finish (shop stock's own rule, 'count' rows
 * left out), in its unit now. A row whose unit can't be turned into it
 * (never written by the till) is left out.
 */
function movedSince(db: AppDatabase, ingredientId: string, afterIso: string, atIso: string, unitNow: string): number {
  let moved = 0;
  for (const s of shopMovesBetween(db, ingredientId, afterIso, atIso)) {
    const f = unitFactor(s.unit, unitNow);
    if (f !== null) moved += s.qty * f;
  }
  return moved;
}

/**
 * Finish a stock take — ONE transaction (costing spec Phase 8). For every
 * counted line: SHOP stock now as `expected_qty` (costing spec 4.6), this
 * till's count as `till_qty`, the price now and what the counted stock is
 * worth, and a 'count' stock row that sets this till's count to what was
 * counted. Lines left blank stay blank (not counted); a full stock take
 * finished with blanks becomes 'custom' (it is not a whole count any more).
 *
 * Idempotent: a stock take already finished is answered as it stands and
 * nothing is written; a cancelled one is refused.
 */
export function finishStockCount(
  db: AppDatabase,
  countId: string,
  actor: Actor,
): { count: StockCountDetail; alreadyFinished: boolean } {
  let alreadyFinished = false;
  db.transaction(() => {
    const c = readCount(db, countId);
    if (c?.status === 'done') {
      alreadyFinished = true;
      return;
    }
    refuseUnlessOpen(c);
    const lines = readLines(db, countId);
    const counted = lines.filter((l) => l.counted_qty !== null && l.ing_deleted === null && l.ing_unit !== null);
    if (counted.length === 0) throw new Error(NOTHING_COUNTED);
    for (const l of counted) {
      if (unitFactor(l.unit, l.ing_unit!) === null) {
        throw new Error(`${l.name ?? 'An ingredient'} changed its unit since it was counted: count it again.`);
      }
    }
    const finishedAt = nowIso();
    const shop = shopStockAt(
      db,
      counted.map((l) => ({ id: l.ingredient_id, unit: l.ing_unit!, currentQty: Number(l.current_qty ?? 0) })),
      finishedAt,
    );
    const priceOf = priceOfBook(loadPriceBook(db));
    const scope = scopeOf(c!.scope);
    const blanks = lines.length - counted.length;
    const finalScope: StockCountScope = scope === 'full' && blanks > 0 ? 'custom' : scope;
    const updateLine = db.prepare(
      `UPDATE stock_count_lines
          SET counted_qty = ?, unit = ?, expected_qty = ?, till_qty = ?, unit_cost_mc = ?, value_cents = ?, movement_id = ?,
              updated_at = ?, version = version + 1
        WHERE id = ?`,
    );
    const audited: Array<{
      ingredientId: string;
      counted: number;
      expected: number;
      till: number;
      from: 'shop' | 'till';
      /** When the shelf was counted, and what moved it from then to the finish (only when something did). */
      countedAt?: string;
      movedSince?: number;
    }> = [];
    let short = 0;
    let over = 0;
    for (const l of counted) {
      const unit = l.ing_unit!;
      // What was on the shelf when it was counted, carried forward to the
      // finish by every till's stock rows since (a pizza sent after the cheese
      // shelf was counted took its cheese from what was counted): the count
      // is the shelf AT finished_at, which shop stock and "used vs should
      // have used" start from. A figure saved on another till's clock, or
      // with no time, is taken as counted at the finish.
      const at = countedAtOf(l.counted_at, c!.started_at, finishedAt);
      const carried = at < finishedAt ? movedSince(db, l.ingredient_id, at, finishedAt, unit) : 0;
      const qty = Math.round(Number(l.counted_qty) * (unitFactor(l.unit, unit) ?? 1) + carried);
      // This till's count right now (read inside the transaction, as the stock row will move it).
      const till = Number((db.prepare(`SELECT current_qty AS q FROM ingredients WHERE id = ?`).get(l.ingredient_id) as { q: number }).q);
      const expected = shop.get(l.ingredient_id) ?? { qty: till, from: 'till' as const, unconvertible: false };
      const price = priceOf(l.ingredient_id);
      const value = safeStockValue(qty, price);
      // The stock row moves this till's count by the difference, valued at the same price.
      const moved = safeStockValue(qty - till, price);
      const movement = recordStockMovement(
        db,
        {
          ingredientId: l.ingredient_id,
          deltaQty: qty - till,
          reason: 'count',
          detail: 'stock_take',
          refGroupId: countId,
          occurredAtIso: finishedAt,
          notes: `Stock take (${STOCK_COUNT_SCOPE_LABEL[finalScope].toLowerCase()})`,
          value: moved.basis === 'price' ? { ...moved, basis: 'count' } : moved,
        },
        actor,
      );
      updateLine.run(qty, unit, expected.qty, till, value.unitCostMc, value.valueCents, movement.movementId, finishedAt, l.id);
      enqueueSync(db, { entityType: 'stock_count_lines', entityId: l.id, op: 'upsert', payload: { id: l.id } });
      const diffCents = differenceCents(qty - expected.qty, value.unitCostMc) ?? 0;
      if (diffCents < 0) short += -diffCents;
      else over += diffCents;
      audited.push({
        ingredientId: l.ingredient_id,
        counted: qty,
        expected: expected.qty,
        till,
        from: expected.from,
        ...(carried !== 0 ? { countedAt: at, movedSince: carried } : {}),
      });
    }
    db.prepare(
      `UPDATE stock_counts SET status = 'done', finished_at = ?, scope = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(finishedAt, finalScope, finishedAt, countId);
    enqueueSync(db, { entityType: 'stock_counts', entityId: countId, op: 'upsert', payload: { id: countId } });
    writeAudit(db, {
      entityType: 'stock_counts',
      entityId: countId,
      action: 'stock_count_finish',
      actorUserId: actor.userId,
      before: { status: c!.status, scope },
      after: { status: 'done', scope: finalScope, counted: counted.length, blank: blanks, shortCents: short, overCents: over, lines: audited },
    });
  })();
  return { count: getStockCount(db, countId, actor.deviceId)!, alreadyFinished };
}

/**
 * Drop a stock take still being counted. Nothing is written to stock and no
 * count moves: only its status, synced and audited. Cancelling it again does
 * nothing (false); a finished one can't be cancelled.
 */
export function cancelStockCount(db: AppDatabase, countId: string, actor: Actor): boolean {
  let cancelled = false;
  db.transaction(() => {
    const c = readCount(db, countId);
    if (!c) throw new Error('That stock take is not on this till');
    if (c.status === 'cancelled') return;
    if (c.status === 'done') throw new Error("A finished stock take can't be cancelled.");
    const now = nowIso();
    db.prepare(`UPDATE stock_counts SET status = 'cancelled', updated_at = ?, version = version + 1 WHERE id = ?`).run(now, countId);
    enqueueSync(db, { entityType: 'stock_counts', entityId: countId, op: 'upsert', payload: { id: countId } });
    writeAudit(db, {
      entityType: 'stock_counts',
      entityId: countId,
      action: 'stock_count_cancel',
      actorUserId: actor.userId,
      before: { status: c.status },
      after: { status: 'cancelled' },
    });
    cancelled = true;
  })();
  return cancelled;
}

/**
 * The Stock button's "Stock take" (costing spec Phase 8): one ingredient,
 * counted and finished at once — a 'custom' stock take of one line, in one
 * transaction, so its "expected" is shop stock like any other.
 */
export function countOneIngredient(
  db: AppDatabase,
  input: { ingredientId: string; countedQty: number; notes?: string | null },
  actor: Actor,
): { count: StockCountDetail; alreadyFinished: boolean } {
  return db.transaction(() => {
    const started = startStockCount(db, { scope: 'custom', ingredientIds: [input.ingredientId], notes: input.notes ?? null }, actor);
    if (started.lines.length !== 1) throw new Error('Ingredient not found');
    saveStockCountLines(db, { countId: started.id, lines: [{ ingredientId: input.ingredientId, countedQty: input.countedQty }] }, actor);
    return finishStockCount(db, started.id, actor);
  })();
}
