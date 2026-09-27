/**
 * "Use the sheet's price" in Inventory → Ingredients (costing spec Phase 6):
 * the question it asks before replacing the till's price. Since Phase 6 the
 * till owns ingredient prices — a price from a delivery bill or a purchase is
 * what the menu import now protects — so the question always says what the
 * sheet's price REPLACES and where that came from, never only the sheet's
 * figure. Pure, so the words are tested (made-up prices only).
 */
import { effectivePack, unitCostMc } from '@cheeseoclock/pos-domain';
import type { Ingredient, PriceSource } from '@cheeseoclock/shared-types';
import { formatUnitPrice } from '../costing/costingFormat';
import { priceText } from './price-view';

type SheetIngredient = Pick<
  Ingredient,
  'name' | 'unit' | 'priceKind' | 'costPerUnitCents' | 'packSize' | 'packPriceCents' | 'latestPrice' | 'sheetPrice'
>;

/** Where the till's price came from, as the end of a sentence. */
const FROM_WORDS: Record<PriceSource, string> = {
  seed: 'the price it had when the till started keeping price history',
  manual: 'typed on the till',
  delivery: 'from a delivery bill',
  purchase: 'from a purchase bill',
  import: 'from an earlier costing sheet',
  batch: 'worked out from its batch recipe',
  convert: 'kept through a unit change',
};

const dayText = (iso: string) => new Date(iso).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' });

/** The till's price comes from a bill (a delivery or a purchase): what the shop really paid. */
export function tillPriceIsFromBill(i: Pick<Ingredient, 'unit' | 'latestPrice'>): boolean {
  const tag = i.latestPrice ?? null;
  return !!tag && tag.unit === i.unit && (tag.source === 'delivery' || tag.source === 'purchase');
}

/** "Rs 1,300 / kg from a delivery bill on 20 Sep 2026", "no price yet", "free (typed on the till …)". */
export function tillPriceText(i: SheetIngredient): string {
  const tag = i.latestPrice ?? null;
  // After a Convert the newest line is in the unit now; one in another unit is not this price.
  if (tag && tag.unit === i.unit) {
    const price = priceText(tag);
    if (tag.source === 'seed') return `${price} (${FROM_WORDS.seed})`;
    return `${price} ${FROM_WORDS[tag.source]} on ${dayText(tag.effectiveAt)}`;
  }
  return priceText({
    unitCostMc: i.priceKind === 'unset' || i.priceKind === 'free' ? 0 : unitCostMc(effectivePack(i)),
    unit: i.unit,
    priceKind: i.priceKind,
  });
}

/**
 * The question before "Use the sheet's price": the sheet's figure, the
 * till's price it replaces and where that came from; a price from a bill
 * gets one more plain sentence (it is what was really paid). Null when the
 * sheet has no price for it.
 */
export function sheetPriceQuestion(i: SheetIngredient): string | null {
  const sheet = i.sheetPrice ?? null;
  if (!sheet || sheet.priceKind === 'unset') return null;
  const sheetText = formatUnitPrice(sheet.unitCostMc, i.unit);
  const lines = [
    `Use the costing sheet's price for "${i.name}"?`,
    `The sheet's ${sheetText} replaces the till's ${tillPriceText(i)}.`,
  ];
  if (tillPriceIsFromBill(i)) {
    lines.push("The till's price is what the shop last paid; the sheet's may be older.");
  }
  lines.push("Every dish that uses it is costed at the sheet's price from now (kept in its price history as typed).");
  return lines.join('\n\n');
}
