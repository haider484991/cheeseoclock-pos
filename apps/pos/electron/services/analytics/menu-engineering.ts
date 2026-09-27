/**
 * The menu map (costing spec 4.8, Phase 9, profit.view): each category's
 * dishes by how popular and how profitable they are, at menu price and the
 * cost each sale kept, in plain words ("Popular, low profit: Rs 60 more on
 * the price brings it to your average"). The last 28 days unless another
 * period is asked for. Worked out in the Reports worker thread for the
 * orders on THIS till; pos-domain menuMap does the placing.
 *
 * The dishes of a category: every food item on the menu now, plus any sold
 * in the period. Each size and each deal is its own dish. Delivery charges
 * and categories marked "not food" are left out.
 *
 * Read-only; never loads Electron (the worker loads it).
 */
import { isDeliveryChargeName, type MenuMapCategory, type MenuMapRequest, type ReportMenuMap } from '@cheeseoclock/shared-types';
import { DEFAULT_PRICE_STEP_CENTS, menuMap, type MenuMapDishInput } from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../../db/connection.js';
import { getBusinessSetting } from '../../db/business-settings-read.js';
import { costingStartedAt } from '../business-report.js';
import { readSales } from './profit.js';
import { DAY_MS } from './sql.js';

/** The default window: the last 28 days (costing spec 4.8). */
export const MENU_MAP_DAYS = 28;

/** The period the map is for: the one asked, or the last 28 days up to now. */
export function menuMapRange(req: MenuMapRequest | undefined, now: Date): { sinceIso: string; untilIso: string; lastDays: boolean } {
  if (req?.sinceIso && req.untilIso) return { sinceIso: req.sinceIso, untilIso: req.untilIso, lastDays: false };
  return { sinceIso: new Date(now.getTime() - MENU_MAP_DAYS * DAY_MS).toISOString(), untilIso: now.toISOString(), lastDays: true };
}

export function buildMenuMap(db: AppDatabase, req: MenuMapRequest | undefined, now: Date): Omit<ReportMenuMap, 'engine'> {
  const range = menuMapRange(req, now);
  const pass = readSales(db, range, { estimates: false });
  const step = getBusinessSetting(db, 'costing.priceStep')?.value ?? DEFAULT_PRICE_STEP_CENTS;
  const categories = db
    .prepare(`SELECT id, name FROM categories WHERE deleted_at IS NULL ORDER BY display_order, name`)
    .all() as Array<{ id: string; name: string }>;
  const live = db
    .prepare(`SELECT id, name, category_id AS categoryId FROM menu_items WHERE deleted_at IS NULL AND is_active = 1`)
    .all() as Array<{ id: string; name: string; categoryId: string }>;

  // Every food dish on the menu now, and any sold in the period, per category.
  const dishes = new Map<string, Map<string, MenuMapDishInput>>();
  const add = (categoryId: string, d: MenuMapDishInput) => {
    let m = dishes.get(categoryId);
    if (!m) dishes.set(categoryId, (m = new Map()));
    m.set(d.id, d);
  };
  for (const it of pass.items.values()) {
    if (it.isFee || !it.itemId) continue;
    const categoryId = pass.menu.item(it.itemId)?.categoryId;
    if (!categoryId || pass.menu.nonFoodCategoryIds.has(categoryId)) continue;
    add(categoryId, {
      id: it.itemId,
      name: it.name,
      units: it.units,
      knownUnits: it.knownUnits,
      knownMenuSalesCents: it.knownMenuSalesCents,
      knownCostCents: it.costCents,
    });
  }
  for (const i of live) {
    if (pass.menu.nonFoodCategoryIds.has(i.categoryId) || isDeliveryChargeName(i.name)) continue;
    if (dishes.get(i.categoryId)?.has(i.id)) continue;
    add(i.categoryId, { id: i.id, name: i.name, units: 0, knownUnits: 0, knownMenuSalesCents: 0, knownCostCents: 0 });
  }

  const out: MenuMapCategory[] = [];
  for (const c of categories) {
    const list = dishes.get(c.id);
    if (!list || list.size === 0) continue;
    const m = menuMap([...list.values()], step);
    out.push({
      categoryId: c.id,
      name: c.name,
      state: m.state,
      units: m.units,
      items: m.dishes.map((d) => ({
        menuItemId: d.id,
        name: d.name,
        units: d.units,
        mixBps: d.mixBps,
        profitPerSaleCents: d.profitPerSaleCents,
        priceCents: d.priceCents,
        costCents: d.costCents,
        popular: d.popular,
        profitable: d.profitable,
        class: d.class,
        belowAverageCents: d.belowAverageCents,
        raiseToAverageCents: d.raiseToAverageCents,
      })),
      cantPlace: m.cantPlace.map((x) => ({ menuItemId: x.id, name: x.name, units: x.units, costedShareBps: x.costedShareBps })),
      notSold: m.notSold.map((x) => ({ menuItemId: x.id, name: x.name })).sort((a, b) => a.name.localeCompare(b.name)),
      popularLineBps: m.popularLineBps,
      averageProfitCents: m.averageProfitCents,
    });
  }
  return { sinceIso: range.sinceIso, untilIso: range.untilIso, lastDays: range.lastDays, priceStepCents: step, categories: out, costingStartedAt: costingStartedAt(db) };
}
