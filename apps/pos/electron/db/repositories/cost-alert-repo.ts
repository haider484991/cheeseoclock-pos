import { v5 as uuidv5 } from 'uuid';
import log from 'electron-log/main';
import type { AppDatabase } from '../connection.js';
import { nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { loadPriceBook, type PriceBook } from '../price-book.js';
import {
  COC_ID_NAMESPACE,
  type BatchUnpricedAlert,
  type CostAlertItemMove,
  type CostAlertKind,
  type CostAlertPrice,
  type PriceJumpAlert,
  type PriceSource,
  type WeeklyDigestAlert,
} from '@cheeseoclock/shared-types';
import {
  bandWithHysteresis,
  batchesUsing,
  effectivePrices,
  isPriceJump,
  mcToCents,
  priceChangeAlerts,
  priceChangeBps,
  requiredPicks,
  shareBps,
  tradingWeekOf,
  unitCostMc,
  weeklyImpactCents,
  type EffectivePrice,
  type FoodCostBand,
  type PickMix,
  type PriceOf,
  type StoredPrice,
} from '@cheeseoclock/pos-domain';
import {
  MOVES_KEPT,
  dishesMovedBy,
  itemsOnMenu,
  loadAlertSettings,
  loadCostingContext,
  pickMixOf,
  plateAt,
  targetFor,
  type CostingContext,
} from '../../services/costing-service.js';

/**
 * Price alerts (costing spec Phase 6, migration 0036 cost_alerts): what
 * Costing → Alerts tells the owner, in plain words — which dishes a price
 * change moved and what it costs per week at this till's sales.
 *
 *  - 'price_jump': after a price is written on THIS till (setIngredientPrice
 *    calls evaluatePriceAlerts; a delivery or purchase calls it once for all
 *    its lines), when a key ingredient — or a key batch made from it — moved
 *    more than the jump threshold, or the change comes to at least the
 *    weekly threshold (default Rs 1,000) either way.
 *  - 'batch_unpriced_input': a batch made here could not take its price
 *    from its recipe (something in it has no price), so it kept the one it
 *    had: after a price change of something in it, and after a menu file.
 *    One at a time per batch: none while one for it is still unseen.
 *  - 'weekly_digest': from each Monday (trading day), once a week, the
 *    dishes a price change moved across their target, with a 1-point margin
 *    (plate-cost bandWithHysteresis) and the customers' picks FROZEN at the
 *    last digest, so what people order never alerts on its own. The first
 *    digest only notes where every dish stands.
 *
 * Only on the till that wrote the price: apply-remote never comes here (a
 * price arriving from the other till is a row, not a change made here). Ids
 * are name-based (costing spec D13) — kind | subject | the row that set it
 * off (the price history row; for the digest, its week) — so the same
 * alert on both tills is ONE row, settled by id. Each alert, and each
 * "Seen", is written with its sync entry and audit row in one transaction.
 *
 * Working an alert out never stands in the way of the price: it runs in its
 * own savepoint, and a failure there is logged and dropped (the price, the
 * delivery, the import go ahead).
 */

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** An alert's name-based id: the same alert gets the same id on every till. */
export function costAlertId(kind: CostAlertKind, subject: string, trigger: string): string {
  return uuidv5(`cost_alerts:${kind}|${subject}|${trigger}`, COC_ID_NAMESPACE);
}

export interface NewCostAlert {
  id: string;
  kind: CostAlertKind;
  ingredientId: string | null;
  menuItemId: string | null;
  /** The price history row that set it off (it must be there), or null. */
  ingredientCostId: string | null;
  impactWeekCents: number;
  before: unknown;
  /** The figures (shared-types CostAlertDetail), plus for the digest its saved state. */
  after: { kind: CostAlertKind } & Record<string, unknown>;
  /** Written seen (a digest with nothing to say). */
  seen?: boolean;
}

function alertExists(db: AppDatabase, id: string): boolean {
  return db.prepare(`SELECT 1 AS x FROM cost_alerts WHERE id = ?`).get(id) !== undefined;
}

/**
 * Write an alert, once: an alert already there with that id (the other
 * till's, or this till's from before) is left exactly as it is. The row,
 * its sync entry and its audit row in one transaction. True when written.
 */
export function writeCostAlert(db: AppDatabase, a: NewCostAlert, actor: Actor): boolean {
  if (!Number.isSafeInteger(a.impactWeekCents)) throw new Error('An alert costs a whole number of paisa a week');
  return db.transaction((): boolean => {
    if (alertExists(db, a.id)) return false;
    const now = nowIso();
    db.prepare(
      `INSERT INTO cost_alerts
         (id, kind, ingredient_id, menu_item_id, ingredient_cost_id, impact_week_cents, before_json, after_json,
          seen_at, seen_by_user_id, created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1)`,
    ).run(
      a.id,
      a.kind,
      a.ingredientId,
      a.menuItemId,
      a.ingredientCostId,
      a.impactWeekCents,
      a.before === null || a.before === undefined ? null : JSON.stringify(a.before),
      JSON.stringify(a.after),
      a.seen ? now : null,
      now,
      now,
      actor.deviceId,
    );
    enqueueSync(db, { entityType: 'cost_alerts', entityId: a.id, op: 'upsert', payload: { id: a.id, kind: a.kind } });
    // The audit row says what was raised; the digest's saved bands and picks stay in the row.
    const shown: Record<string, unknown> = { ...a.after };
    delete shown['state'];
    writeAudit(db, {
      entityType: 'cost_alerts',
      entityId: a.id,
      action: 'create',
      actorUserId: actor.userId,
      before: null,
      after: {
        kind: a.kind,
        ingredientId: a.ingredientId,
        menuItemId: a.menuItemId,
        ingredientCostId: a.ingredientCostId,
        impactWeekCents: a.impactWeekCents,
        seen: !!a.seen,
        detail: shown,
      },
    });
    return true;
  })();
}

/**
 * "Seen" (Costing → Alerts): each alert not seen yet gets who and when,
 * synced and audited, in one transaction. Already seen, or not there:
 * left alone. Returns how many were marked.
 */
export function markCostAlertsSeen(db: AppDatabase, ids: readonly string[], actor: Actor): number {
  return db.transaction((): number => {
    const now = nowIso();
    let marked = 0;
    for (const id of new Set(ids)) {
      const row = db.prepare(`SELECT seen_at, deleted_at FROM cost_alerts WHERE id = ?`).get(id) as
        | { seen_at: string | null; deleted_at: string | null }
        | undefined;
      if (!row || row.deleted_at !== null || row.seen_at !== null) continue;
      db.prepare(
        `UPDATE cost_alerts SET seen_at = ?, seen_by_user_id = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(now, actor.userId, now, id);
      enqueueSync(db, { entityType: 'cost_alerts', entityId: id, op: 'upsert', payload: { id, seenAt: now } });
      writeAudit(db, {
        entityType: 'cost_alerts',
        entityId: id,
        action: 'seen',
        actorUserId: actor.userId,
        before: { seenAt: null },
        after: { seenAt: now, seenByUserId: actor.userId },
      });
      marked += 1;
    }
    return marked;
  })();
}

// ---------------------------------------------------------------------------
// After a price is written (on this till)
// ---------------------------------------------------------------------------

/** A price written on this till, for the alerts to look at. */
export interface PriceWritten {
  ingredientId: string;
  /** Its own price columns just before the write. */
  before: StoredPrice;
  /** The price history row the write added: what sets an alert off. */
  entryId: string;
  source: PriceSource;
}

/**
 * Look at prices just written on this till for alerts (see the top of this
 * file), and write the ones due. Several writes to one ingredient count as
 * one change (its price before the first, the row of the last). Each
 * ingredient's effect is its own: the other prices are as they are now.
 * Never throws: a failure is logged and nothing is written. Returns the
 * alerts written.
 */
export function evaluatePriceAlerts(db: AppDatabase, writes: readonly PriceWritten[], actor: Actor, now = new Date()): string[] {
  if (writes.length === 0) return [];
  try {
    return db.transaction((): string[] => evaluate(db, writes, actor, now))();
  } catch (err) {
    log.warn('Costing: the price alerts could not be worked out; the price itself is saved', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

const isPriced = (p: EffectivePrice | undefined): p is EffectivePrice => !!p && (p.kind === 'set' || p.kind === 'estimate');

function priceOfPrices(prices: ReadonlyMap<string, EffectivePrice>): PriceOf {
  return (id) => {
    const p = prices.get(id);
    return p ? { pack: p.pack, kind: p.kind } : undefined;
  };
}

function alertPrice(p: EffectivePrice): CostAlertPrice {
  return { unitCostMc: p.kind === 'unset' ? 0 : unitCostMc(p.pack), priceKind: p.kind };
}

function evaluate(db: AppDatabase, writes: readonly PriceWritten[], actor: Actor, now: Date): string[] {
  const byIngredient = new Map<string, PriceWritten>();
  for (const w of writes) {
    const first = byIngredient.get(w.ingredientId);
    byIngredient.set(w.ingredientId, first ? { ...w, before: first.before } : w);
  }
  const book = loadPriceBook(db);
  const settings = loadAlertSettings(db, book.ingredients.values());
  let ctx: CostingContext | null = null;
  const context = (): CostingContext => (ctx ??= loadCostingContext(db, now));
  const written: string[] = [];
  for (const w of byIngredient.values()) {
    const ing = book.ingredients.get(w.ingredientId);
    if (!ing) continue;
    // The prices as they were before this one change: only its own columns go back.
    const before = effectivePrices(
      [...book.ingredients.values()].map((i) =>
        i.id === w.ingredientId
          ? { ...i, costPerUnitCents: w.before.costPerUnitCents, packSize: w.before.packSize, packPriceCents: w.before.packPriceCents, priceKind: w.before.priceKind }
          : i,
      ),
      book.batchLines,
    );
    const jump = priceJumpAlert(book, before, w, settings, context);
    if (jump && writeCostAlert(db, jump, actor)) written.push(jump.id);
    written.push(
      ...unpricedBatchAlerts(db, book, [w.ingredientId], { key: w.entryId, rowId: w.entryId, because: 'price', changedName: ing.name, parents: true }, actor),
    );
  }
  return written;
}

function priceJumpAlert(
  book: PriceBook,
  before: ReadonlyMap<string, EffectivePrice>,
  w: PriceWritten,
  settings: ReturnType<typeof loadAlertSettings>,
  context: () => CostingContext,
): NewCostAlert | null {
  const id = w.ingredientId;
  const p0 = before.get(id);
  const p1 = book.prices.get(id);
  // A jump needs a price before (not "no price yet", not free) and one after.
  if (!isPriced(p0) || !p1 || p1.kind === 'unset') return null;
  const u0 = unitCostMc(p0.pack);
  const u1 = alertPrice(p1).unitCostMc;
  if (!(u0 > 0) || u0 === u1) return null;
  const changeBps = priceChangeBps(u0, u1);
  const batches = batchesUsing([id], book.batchLines);
  const keyBatches: PriceJumpAlert['keyBatches'] = [];
  for (const b of batches) {
    if (!settings.keyIds.has(b)) continue;
    const b0 = before.get(b);
    const b1 = book.prices.get(b);
    if (!b0 || !b1) continue;
    const bu0 = alertPrice(b0).unitCostMc;
    const bu1 = alertPrice(b1).unitCostMc;
    if (bu0 === bu1) continue;
    keyBatches.push({
      ingredientId: b,
      name: book.ingredients.get(b)?.name ?? '',
      unit: book.ingredients.get(b)?.unit ?? '',
      before: alertPrice(b0),
      after: alertPrice(b1),
      changeBps: priceChangeBps(bu0, bu1),
    });
  }
  const key =
    (settings.keyIds.has(id) && isPriceJump(changeBps, settings.jumpBps)) ||
    keyBatches.some((k) => isPriceJump(k.changeBps, settings.jumpBps));
  const moves = dishesMovedBy(context(), priceOfPrices(before), priceOfPrices(book.prices), new Set([id, ...batches]));
  const impact = moves.reduce((s, m) => s + m.impactWeekCents, 0);
  if (!priceChangeAlerts({ keyJump: key, impactWeekCents: impact }, settings)) return null;
  const ing = book.ingredients.get(id)!;
  const detail: PriceJumpAlert = {
    kind: 'price_jump',
    ingredientId: id,
    ingredientName: ing.name,
    unit: ing.unit,
    before: alertPrice(p0),
    after: alertPrice(p1),
    changeBps,
    source: w.source,
    key,
    keyBatches,
    items: moves.slice(0, MOVES_KEPT),
    itemsMoved: moves.length,
  };
  return {
    id: costAlertId('price_jump', id, w.entryId),
    kind: 'price_jump',
    ingredientId: id,
    menuItemId: moves.length === 1 ? moves[0]!.menuItemId : null,
    ingredientCostId: w.entryId,
    impactWeekCents: impact,
    before: alertPrice(p0),
    after: { ...detail },
  };
}

// ---------------------------------------------------------------------------
// A batch that kept its old price
// ---------------------------------------------------------------------------

export interface UnpricedTrigger {
  /** What set it off, for the id: the price history row, or the menu file's row key. */
  key: string;
  /** The price history row, when there is one (it must be there). */
  rowId: string | null;
  because: 'import' | 'price';
  /** The ingredient whose price changed ('price'). */
  changedName: string | null;
  /** Also the batches made from these (a price change); the menu file names the batches themselves. */
  parents: boolean;
}

function unseenFor(db: AppDatabase, kind: CostAlertKind, ingredientId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 AS x FROM cost_alerts
          WHERE ingredient_id = ? AND kind = ? AND seen_at IS NULL AND deleted_at IS NULL LIMIT 1`,
      )
      .get(ingredientId, kind) !== undefined
  );
}

function costRowThere(db: AppDatabase, id: string | null): string | null {
  if (!id) return null;
  return db.prepare(`SELECT 1 AS x FROM ingredient_costs WHERE id = ?`).get(id) !== undefined ? id : null;
}

function unpricedBatchAlerts(db: AppDatabase, book: PriceBook, ids: readonly string[], t: UnpricedTrigger, actor: Actor): string[] {
  // A price change: the batches made FROM it — never the one whose price was
  // just written (a price typed on a batch its recipe can't price is that
  // price, not one it "kept"). The menu file: the batches it names.
  const candidates = t.parents
    ? batchesUsing(ids, book.batchLines).filter((b) => !ids.includes(b))
    : [...new Set(ids.filter((id) => book.batchLines.has(id)))];
  const written: string[] = [];
  for (const b of candidates) {
    const p = book.prices.get(b);
    const ing = book.ingredients.get(b);
    if (!p?.batch || !ing || p.batch.complete || p.batch.unpricedInputIds.length === 0) continue;
    if (unseenFor(db, 'batch_unpriced_input', b)) continue;
    const detail: BatchUnpricedAlert = {
      kind: 'batch_unpriced_input',
      ingredientId: b,
      ingredientName: ing.name,
      unit: ing.unit,
      unpricedInputs: p.batch.unpricedInputIds.map((id) => ({
        ingredientId: id,
        name: book.ingredients.get(id)?.name ?? 'an ingredient that was deleted',
      })),
      kept: p.kind === 'unset' ? null : alertPrice(p),
      because: t.because,
      changedName: t.changedName,
    };
    const id = costAlertId('batch_unpriced_input', b, t.key);
    const ok = writeCostAlert(
      db,
      {
        id,
        kind: 'batch_unpriced_input',
        ingredientId: b,
        menuItemId: null,
        ingredientCostId: costRowThere(db, t.rowId),
        impactWeekCents: 0,
        before: null,
        after: { ...detail },
      },
      actor,
    );
    if (ok) written.push(id);
  }
  return written;
}

/**
 * The menu file's batches (made here) that could not take their price from
 * their recipe: one 'batch_unpriced_input' each, named after the file's row
 * for it, so importing the same file on both tills gives one alert. Never
 * throws (see evaluatePriceAlerts).
 */
export function raiseBatchUnpricedAlerts(
  db: AppDatabase,
  batchIds: readonly string[],
  trigger: (batchId: string) => Omit<UnpricedTrigger, 'parents'>,
  actor: Actor,
): string[] {
  if (batchIds.length === 0) return [];
  try {
    return db.transaction((): string[] => {
      const book = loadPriceBook(db);
      return batchIds.flatMap((b) => unpricedBatchAlerts(db, book, [b], { ...trigger(b), parents: false }, actor));
    })();
  } catch (err) {
    log.warn('Costing: the batch alerts could not be worked out; the import itself is saved', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// The weekly digest
// ---------------------------------------------------------------------------

/** What a digest keeps for the next one, per dish. */
interface DigestItemState {
  /** Its band then (null: not colored — target a suggestion, a price missing…). */
  band: FoodCostBand | null;
  /**
   * The target and "close" width that band was worked out against (bps).
   * When the owner changes them, the next digest re-bands last week's plate
   * against the new lines first, so a target change is never listed as a
   * price change. Absent (an older state): taken as unchanged.
   */
  targetBps?: number;
  amberBps?: number;
  /** Its typical plate then, at that week's picks and prices. */
  costMc: number;
  priceMc: number;
  /** The picks it was costed with: units sold in the 28 days, and per choice of a required group. */
  units: number;
  picks: Array<[string, number]>;
  groupUnits: Array<[string, number]>;
}

interface DigestState {
  v: 1;
  items: Record<string, DigestItemState>;
}

/** The latest digest before `weekOf`, with the state it saved (null: none, or not readable). */
function lastDigest(db: AppDatabase, weekOf: string): { weekOf: string; state: DigestState } | null {
  const rows = db
    .prepare(
      `SELECT after_json FROM cost_alerts
        WHERE kind = 'weekly_digest' AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 12`,
    )
    .all() as Array<{ after_json: string | null }>;
  let best: { weekOf: string; state: DigestState } | null = null;
  for (const r of rows) {
    try {
      const a = JSON.parse(r.after_json ?? 'null') as { weekOf?: unknown; state?: DigestState } | null;
      if (!a || typeof a.weekOf !== 'string' || a.weekOf >= weekOf) continue;
      if (!a.state || a.state.v !== 1 || typeof a.state.items !== 'object') continue;
      if (!best || a.weekOf > best.weekOf) best = { weekOf: a.weekOf, state: a.state };
    } catch {
      // A row this till can't read: not a baseline.
    }
  }
  return best;
}

const BANDS: readonly FoodCostBand[] = ['green', 'amber', 'red'];
const bandOf = (v: unknown): FoodCostBand | null => (BANDS.includes(v as FoodCostBand) ? (v as FoodCostBand) : null);

/** The lines a saved band was worked out against differ from today's (an older state without them: unchanged). */
function targetChanged(s: DigestItemState, targetBps: number, amberBps: number): boolean {
  return (typeof s.targetBps === 'number' && s.targetBps !== targetBps) || (typeof s.amberBps === 'number' && s.amberBps !== amberBps);
}

function mixOfState(s: DigestItemState): PickMix {
  return { units: s.units, picks: new Map(s.picks), groupUnits: new Map(s.groupUnits) };
}

/** The picks worth keeping for the next digest: those of the item's required groups (the only ones a plate is weighted by). */
function stateMix(ctx: CostingContext, itemId: string): Pick<DigestItemState, 'units' | 'picks' | 'groupUnits'> {
  const mix = pickMixOf(ctx, itemId);
  if (!mix) return { units: 0, picks: [], groupUnits: [] };
  const groups = (ctx.menu.groups.get(itemId) ?? []).filter((g) => requiredPicks(g, g.options.length) !== null);
  const options = new Set(groups.flatMap((g) => g.options.map((o) => o.id)));
  const groupIds = new Set(groups.map((g) => g.id));
  return {
    units: mix.units,
    picks: [...mix.picks].filter(([id]) => options.has(id)).sort(([a], [b]) => (a < b ? -1 : 1)),
    groupUnits: [...(mix.groupUnits ?? new Map<string, number>())].filter(([id]) => groupIds.has(id)).sort(([a], [b]) => (a < b ? -1 : 1)),
  };
}

/** The Monday digest's id: one per trading week, the same on both tills. */
export function weeklyDigestId(weekOf: string): string {
  return costAlertId('weekly_digest', 'shop', weekOf);
}

/**
 * Write this week's digest if it is not there yet (from Monday, trading
 * day; see the top of this file). Returns its id when written, else null.
 * Never throws.
 */
export function runWeeklyDigestIfDue(db: AppDatabase, actor: Actor, now = new Date()): string | null {
  const weekOf = tradingWeekOf(now.toISOString());
  const id = weeklyDigestId(weekOf);
  if (alertExists(db, id)) return null;
  try {
    return db.transaction((): string | null => (writeDigest(db, id, weekOf, actor, now) ? id : null))();
  } catch (err) {
    log.warn('Costing: the weekly digest could not be worked out; trying again later', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function writeDigest(db: AppDatabase, id: string, weekOf: string, actor: Actor, now: Date): boolean {
  const prev = lastDigest(db, weekOf);
  const ctx = loadCostingContext(db, now);
  const amberBps = ctx.targets.amberBps;
  const items: Record<string, DigestItemState> = {};
  const changes: CostAlertItemMove[] = [];
  for (const item of itemsOnMenu(ctx)) {
    const t = targetFor(ctx, item.categoryId);
    if (t.nonFood) continue;
    const coloured = (pc: { hasRecipe: boolean; missingLines: number; typicalPriceMc: number }) =>
      t.confirmed && pc.hasRecipe && pc.missingLines === 0 && pc.typicalPriceMc > 0;
    const was = prev?.state.items[item.id];
    let wasBand = was ? bandOf(was.band) : null;
    // The owner changed the target (or the "close" width) since: where last
    // week's plate stands against today's lines, so that is not listed as
    // prices moving it (as the picks are frozen, so what people order isn't).
    if (was && wasBand !== null && targetChanged(was, t.bps, amberBps)) {
      wasBand = bandWithHysteresis(null, { costMc: was.costMc, priceMc: was.priceMc }, { bps: t.bps, amberBps });
    }
    // This week's prices, at the picks the last digest froze: only prices move it.
    let moved: FoodCostBand | null = null;
    if (was && wasBand !== null) {
      const frozen = plateAt(ctx, item, ctx.priceOf, mixOfState(was));
      if (coloured(frozen)) {
        moved = bandWithHysteresis(wasBand, { costMc: frozen.typicalCostMc, priceMc: frozen.typicalPriceMc }, { bps: t.bps, amberBps });
        if (moved !== wasBand) {
          changes.push({
            menuItemId: item.id,
            name: item.name,
            priceCents: frozen.typicalPriceCents,
            costBeforeCents: mcToCents(was.costMc),
            costAfterCents: frozen.typicalCostCents,
            foodCostBeforeBps: shareBps(was.costMc, was.priceMc),
            foodCostAfterBps: frozen.foodCostBps,
            soldLast28: was.units,
            impactWeekCents: weeklyImpactCents(was.units, was.costMc, frozen.typicalCostMc),
            flagBefore: wasBand,
            flagAfter: moved,
            targetBps: t.bps,
          });
        }
      }
    }
    // What the next digest compares with: this week's picks, at this week's prices.
    const fresh = plateAt(ctx, item, ctx.priceOf);
    items[item.id] = {
      band: coloured(fresh)
        ? bandWithHysteresis(moved ?? wasBand, { costMc: fresh.typicalCostMc, priceMc: fresh.typicalPriceMc }, { bps: t.bps, amberBps })
        : null,
      targetBps: t.bps,
      amberBps,
      costMc: fresh.typicalCostMc,
      priceMc: fresh.typicalPriceMc,
      ...stateMix(ctx, item.id),
    };
  }
  changes.sort((a, b) => Math.abs(b.impactWeekCents) - Math.abs(a.impactWeekCents) || a.name.localeCompare(b.name));
  const detail: WeeklyDigestAlert = { kind: 'weekly_digest', weekOf, sinceWeekOf: prev?.weekOf ?? null, changes };
  const state: DigestState = { v: 1, items };
  return writeCostAlert(
    db,
    {
      id,
      kind: 'weekly_digest',
      ingredientId: null,
      menuItemId: changes.length === 1 ? changes[0]!.menuItemId : null,
      ingredientCostId: null,
      impactWeekCents: changes.reduce((s, c) => s + c.impactWeekCents, 0),
      before: null,
      after: { ...detail, state },
      // Nothing moved (or the first digest, which only notes where each dish stands): kept, not listed.
      seen: changes.length === 0,
    },
    actor,
  );
}
