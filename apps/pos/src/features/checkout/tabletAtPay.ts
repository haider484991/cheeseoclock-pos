import { expectedTabletCents, tabletDiffers } from '@cheeseoclock/pos-domain';
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
