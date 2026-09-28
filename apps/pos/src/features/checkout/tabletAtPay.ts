import { expectedTabletCents, formatCents, tabletDiffers } from '@cheeseoclock/pos-domain';
import { FOODPANDA_TABLET_TOLERANCE_CENTS, type CheckoutRules } from '@cheeseoclock/shared-types';

/** What Pay checks the foodpanda tablet's total against. */
export interface TabletAtPay {
  /** The till's total at foodpanda's prices: what the tablet should show. */
  expectedCents: number;
  /** The owner's tolerance (Settings → foodpanda → checks), the one Reports use. */
  toleranceCents: number;
  /** More than the tolerance apart: Pay asks "Pay anyway?". */
  differs: (tabletTotalCents: number) => boolean;
}

/**
 * Pay's tablet check (TenderDialog), from checkout:getRules: the expected
 * total at foodpanda's prices and the owner's tolerance, read in the main
 * process by the same reader Reports use (readTabletToleranceCents), and
 * tested by THE one rule (pos-domain tabletDiffers). Until the rules have
 * read, Rs 1 and no uplift — the till before the setting.
 */
export function tabletAtPay(
  foodpanda: Pick<CheckoutRules['foodpanda'], 'tabletToleranceCents' | 'upliftBps'> | undefined,
  tillTotalCents: number,
): TabletAtPay {
  const expectedCents = expectedTabletCents(tillTotalCents, foodpanda?.upliftBps ?? 0);
  const toleranceCents = foodpanda?.tabletToleranceCents ?? FOODPANDA_TABLET_TOLERANCE_CENTS;
  return { expectedCents, toleranceCents, differs: (tabletTotalCents) => tabletDiffers(expectedCents, tabletTotalCents, toleranceCents) };
}

/** The tablet total as typed ("1,920" / "1920.50") → paisa; '' → null; anything else → NaN. */
export function parseTabletCents(input: string): number | null {
  const t = input.trim().replace(/,/g, '');
  if (t === '') return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * 100);
}

/** What Pay does with a foodpanda order's two boxes when Confirm is pressed. */
export type FoodpandaPayStep =
  /** Not yet: this is said, nothing is paid. */
  | { kind: 'refuse'; message: string }
  /** The tablet is further from the till than the owner allows: "Pay anyway?" (Go back is the safe default). */
  | { kind: 'ask'; question: string; tabletTotalCents: number }
  /** Pay, keeping the tablet's total (null: none typed). */
  | { kind: 'pay'; tabletTotalCents: number | null };

/**
 * Pay's whole foodpanda check, decided in one place (TenderDialog only
 * carries it out): the owner's checks (order number / tablet total optional
 * or required; as before the settings until the rules have read) and the
 * tablet's total against the till's at foodpanda's prices, within the
 * owner's tolerance (tabletAtPay: the value and rule Reports use).
 */
export function foodpandaPayStep(
  foodpanda: Pick<CheckoutRules['foodpanda'], 'checks' | 'tabletToleranceCents' | 'upliftBps'> | undefined,
  tillTotalCents: number,
  orderCodeTyped: string,
  tabletTyped: string,
): FoodpandaPayStep {
  const checks = foodpanda?.checks ?? { orderCode: 'optional', tabletTotal: 'optional' };
  if (checks.orderCode === 'required' && !orderCodeTyped.trim()) {
    return { kind: 'refuse', message: "Type foodpanda's order number — the owner has made it required." };
  }
  const typed = parseTabletCents(tabletTyped);
  if (typed !== null && Number.isNaN(typed)) {
    return { kind: 'refuse', message: 'Type the tablet total in rupees, like 1920 or 1920.50.' };
  }
  if (checks.tabletTotal === 'required' && typed === null) {
    return { kind: 'refuse', message: 'Type the total on the foodpanda tablet — the owner has made it required.' };
  }
  if (typed === null) return { kind: 'pay', tabletTotalCents: null };
  const tablet = tabletAtPay(foodpanda, tillTotalCents);
  if (!tablet.differs(typed)) return { kind: 'pay', tabletTotalCents: typed };
  const expected =
    tablet.expectedCents === tillTotalCents
      ? `The till says ${formatCents(tillTotalCents)}`
      : `The tablet should say ${formatCents(tablet.expectedCents)} (the till's ${formatCents(tillTotalCents)} at foodpanda's prices)`;
  return {
    kind: 'ask',
    question: `${expected}, the tablet says ${formatCents(typed)} — check the items and the deal.\nPay anyway? The difference is kept, and Reports list this order to check.`,
    tabletTotalCents: typed,
  };
}
