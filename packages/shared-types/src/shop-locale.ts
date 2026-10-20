/**
 * The shop's locale: the one place that knows what country a till is in.
 *
 * The till was written for one shop in Karachi, so the rupee, the 'en-PK'
 * number format, Pakistan's clock and its phone rules are spelled out across
 * the codebase. They move here, behind one setting, so a shop somewhere else
 * can run the same till.
 *
 * THE RULE THAT MATTERS: DEFAULT_SHOP_LOCALE is today's behaviour, exactly.
 * A till that has never saved the setting reads this default and behaves byte
 * for byte as it did before any of this existed. Nothing is backfilled. The
 * two live tills at Cheese O'Clock must not be able to tell the difference,
 * and the oracle tests in pos-domain and printer-core prove it.
 *
 * Stored as 'shop.locale' in business_settings, which syncs to the second
 * till and goes through business-settings-repo (sync_queue + a chained audit
 * row, as every business write does). Onboarding writes it from a preset and
 * it locks once the till has taken its first order: a shop cannot change
 * currency halfway through its history.
 *
 * v1 is two-decimal currencies only. About 205 lines assume money is cents
 * times one hundred, so JPY (none) and KWD (three) wait for their own pass.
 */
import type { PaymentMethod } from './order.js';

/** How the date reads on paper: day first (26/09/2026) or month first (09/26/2026). */
export type DateOrder = 'dmy' | 'mdy';

/** Whether the shelf price already has the tax in it. */
export type TaxMode = 'exclusive' | 'inclusive';

export interface ShopLocale {
  /** ISO 3166-1 alpha-2, e.g. 'PK', 'US'. */
  readonly country: string;
  /** ISO 4217, e.g. 'PKR', 'USD'. */
  readonly currency: string;
  /** Minor units per major unit. v1 supports 2 only. */
  readonly minorUnits: 2;
  /** What the money is called on a screen: 'Rs', '$'. */
  readonly symbol: string;
  /**
   * What goes between the symbol and the figure. Pakistan writes "Rs 4,000"
   * with a space; the United States writes "$4,000" without one. It is a
   * setting rather than a rule because it follows the symbol, not the country.
   */
  readonly symbolSeparator: string;
  /**
   * What the money is called on PAPER. ASCII only: the thermal printer's code
   * page has no pound or euro sign and prints them as '?', so GB and the euro
   * countries print their ISO code until Phase 3 adds a code page.
   */
  readonly paperSymbol: string;
  /**
   * The Intl tag used to group and punctuate numbers on screen. It also
   * carries the grouping rule, so Indian 3-2-2 grouping comes free with an
   * Indian tag rather than needing its own setting.
   */
  readonly numberLocale: string;
  /** Whether the shelf price already includes tax. */
  readonly taxMode: TaxMode;
  /** What the tax is called on a receipt: 'Tax', 'Sales tax', 'VAT'. */
  readonly taxLabel: string;
  /** A registration line a receipt must carry (a VAT number, a TRN), or null. */
  readonly taxRegistrationLine: string | null;
  /** The receipt's own heading: 'RECEIPT', 'TAX INVOICE'. */
  readonly receiptTitle: string;
  /** IANA zone, e.g. 'Asia/Karachi', 'America/New_York'. */
  readonly timeZone: string;
  readonly dateOrder: DateOrder;
  /**
   * The hour the trading day rolls over, in the shop's own clock. Cheese
   * O'Clock closes after midnight, so its day starts at 05:00 and a 2 a.m.
   * order belongs to the night before.
   */
  readonly tradingDayStartHour: number;
  /** ISO 3166-1 alpha-2 for reading and writing phone numbers. */
  readonly phoneCountry: string;
  /** The note rows of the Close shift count, largest first, in cents. */
  readonly cashFacesCents: readonly number[];
  /** The notes a customer is likely to hand over, for the one-tap cash buttons. */
  readonly quickCashFacesCents: readonly number[];
  /** The ways this shop can be paid. Never includes platform-settled methods. */
  readonly tenders: readonly PaymentMethod[];
  /** What the money is called in words, for the amount written out in full. */
  readonly words: { readonly major: string; readonly minor: string };
}

/**
 * PAKISTAN — the default, and today's behaviour to the character.
 *
 * Every value here is read off the v0.7.51 code, not chosen: 'en-PK' is the
 * tag formatCents already passes to Intl; the seven note rows are the owner's
 * own list from 2 Oct 2026; 05:00 is the trading day the till already keeps;
 * 'RECEIPT' is what receipt-renderer already prints. Changing anything in
 * this object changes the pilot, which is the one thing this work may not do.
 */
export const DEFAULT_SHOP_LOCALE: ShopLocale = Object.freeze({
  country: 'PK',
  currency: 'PKR',
  minorUnits: 2,
  symbol: 'Rs',
  symbolSeparator: ' ',
  paperSymbol: 'Rs',
  numberLocale: 'en-PK',
  taxMode: 'exclusive',
  taxLabel: 'Tax',
  taxRegistrationLine: null,
  receiptTitle: 'RECEIPT',
  timeZone: 'Asia/Karachi',
  dateOrder: 'dmy',
  tradingDayStartHour: 5,
  phoneCountry: 'PK',
  cashFacesCents: Object.freeze([500_000, 100_000, 50_000, 10_000, 5_000, 2_000, 1_000]),
  quickCashFacesCents: Object.freeze([10_000, 50_000, 100_000, 500_000]),
  tenders: Object.freeze<PaymentMethod[]>(['cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer']),
  words: Object.freeze({ major: 'rupees', minor: 'paisa' }),
}) as ShopLocale;

/**
 * UNITED STATES — the first foreign preset, and the reason the US was chosen
 * to go first: sales tax is added ON TOP of the shelf price, exactly as
 * Pakistan's is, so a US shop needs no change to how a total is worked out.
 *
 * Limits of v1, deliberate and written down: tax rates are whole basis points
 * so a rate like New York's 8.875% cannot be held yet, and there are no tips.
 * That makes this counter service in a state whose rate has at most two
 * decimals — which is what the pizza and delivery shops we are aiming at are.
 */
export const US_SHOP_LOCALE: ShopLocale = Object.freeze({
  country: 'US',
  currency: 'USD',
  minorUnits: 2,
  symbol: '$',
  symbolSeparator: '',
  paperSymbol: '$',
  numberLocale: 'en-US',
  taxMode: 'exclusive',
  taxLabel: 'Sales tax',
  taxRegistrationLine: null,
  receiptTitle: 'RECEIPT',
  // Set per shop at onboarding; this is only the preset's starting point.
  timeZone: 'America/New_York',
  dateOrder: 'mdy',
  tradingDayStartHour: 5,
  phoneCountry: 'US',
  // $100, $50, $20, $10, $5, $1 — no cent rows: a drawer is counted in notes.
  cashFacesCents: Object.freeze([10_000, 5_000, 2_000, 1_000, 500, 100]),
  quickCashFacesCents: Object.freeze([1_000, 2_000, 5_000, 10_000]),
  tenders: Object.freeze<PaymentMethod[]>(['cash', 'card']),
  words: Object.freeze({ major: 'dollars', minor: 'cents' }),
}) as ShopLocale;

/** The presets onboarding can start a shop from. */
export const SHOP_LOCALE_PRESETS = Object.freeze({
  PK: DEFAULT_SHOP_LOCALE,
  US: US_SHOP_LOCALE,
}) as Readonly<Record<string, ShopLocale>>;

/** The business_settings key the locale is stored under. */
export const SHOP_LOCALE_KEY = 'shop.locale';

/**
 * The locale this process is running as.
 *
 * There are 545 formatCents calls in 109 files. Threading a locale argument
 * through all of them would be a worse change than the one it enables, so the
 * till sets its shop's locale once at boot (from business_settings) and the
 * formatting functions read it here. An explicit argument still wins where a
 * caller genuinely needs another shop's format.
 *
 * It starts as Pakistan. A till that never calls setShopLocale behaves
 * exactly as it does today, which is what keeps the pilot safe.
 */
let currentShopLocale: ShopLocale = DEFAULT_SHOP_LOCALE;

/** Set the locale for this process. Called once at boot, after settings load. */
export function setShopLocale(locale: ShopLocale): void {
  currentShopLocale = locale;
}

/** The locale this process is running as; Pakistan until something says otherwise. */
export function getShopLocale(): ShopLocale {
  return currentShopLocale;
}

/** Put the process back to Pakistan. For tests, so one cannot leak into the next. */
export function resetShopLocale(): void {
  currentShopLocale = DEFAULT_SHOP_LOCALE;
}
