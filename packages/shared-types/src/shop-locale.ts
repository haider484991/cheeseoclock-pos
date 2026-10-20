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
   * What goes between the paper symbol and the figure. Separate from
   * symbolSeparator because the two symbols can differ: a GB shop shows "£10"
   * on screen but prints "GBP 10", since the printer has no pound sign.
   */
  readonly paperSymbolSeparator: string;
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
  /** The country in a sentence: "as it is dialled in Pakistan". */
  readonly countryName: string;
  /** The country as a word before a noun: "a Pakistani number". */
  readonly countryAdjective: string;
  /** A phone number as people here write it, for hints: "0300 1234567". */
  readonly phoneExample: string;
  /** How a number is dialled from anywhere: "+92 and ten digits". */
  readonly phoneE164Rule: string;
  /** The note rows of the Close shift count, largest first, in cents. */
  readonly cashFacesCents: readonly number[];
  /**
   * The coins counted together in the drawer's 'Coins and other' row, as the
   * screen names them under that row: "Rs 5, 2, 1 coins" in Pakistan.
   */
  readonly coinsLabel: string;
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
  paperSymbolSeparator: ' ',
  numberLocale: 'en-PK',
  taxMode: 'exclusive',
  taxLabel: 'Tax',
  taxRegistrationLine: null,
  receiptTitle: 'RECEIPT',
  timeZone: 'Asia/Karachi',
  dateOrder: 'dmy',
  tradingDayStartHour: 5,
  phoneCountry: 'PK',
  countryName: 'Pakistan',
  countryAdjective: 'Pakistani',
  phoneExample: '0300 1234567',
  phoneE164Rule: '+92 and ten digits',
  cashFacesCents: Object.freeze([500_000, 100_000, 50_000, 10_000, 5_000, 2_000, 1_000]),
  coinsLabel: 'Rs 5, 2, 1 coins',
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
  paperSymbolSeparator: '',
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
  countryName: 'the US',
  countryAdjective: 'US',
  phoneExample: '(415) 555-0123',
  phoneE164Rule: '+1 and ten digits',
  // $100, $50, $20, $10, $5, $1 — no cent rows: a drawer is counted in notes.
  cashFacesCents: Object.freeze([10_000, 5_000, 2_000, 1_000, 500, 100]),
  coinsLabel: 'Quarters, dimes, nickels and pennies',
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

// ---------------------------------------------------------------------------
// What a till stores, and how it becomes the locale the till runs as
// ---------------------------------------------------------------------------

/**
 * The United States zones a shop can pick at setup. A list rather than any
 * IANA name: each is a zone the till is tested on, and a US shop's paper and
 * trading day follow it (daylight saving included).
 */
export const US_TIME_ZONES = Object.freeze([
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
] as const);

/**
 * What 'shop.locale' holds: which preset the shop runs, and its own zone.
 *
 * Only the choice is stored, never a copy of the preset. A copy would freeze
 * today's presets into every till's database, so a later fix to a preset (a
 * new note, a better label) would never reach a shop that already chose it.
 */
export interface StoredShopLocale {
  readonly v: 1;
  /** A key of SHOP_LOCALE_PRESETS: 'PK' or 'US'. */
  readonly country: string;
  /** Pakistan is always Asia/Karachi; a US shop picks one of US_TIME_ZONES. */
  readonly timeZone: string;
}

/** The stored value that means "Pakistan, as every till has always been". */
export const DEFAULT_STORED_SHOP_LOCALE: StoredShopLocale = Object.freeze({
  v: 1,
  country: 'PK',
  timeZone: 'Asia/Karachi',
});

/**
 * The locale a till runs as, from whatever 'shop.locale' holds.
 *
 * Anything that is not a clean, known choice — nothing stored, a value a newer
 * till wrote that this one cannot read, an unknown country or zone — is
 * Pakistan. That is the safe direction: every till that existed before this
 * setting is Pakistani, and Pakistan comes back as DEFAULT_SHOP_LOCALE itself
 * (the same object), so nothing about a Pakistani till changes.
 */
export function resolveShopLocale(stored: unknown): ShopLocale {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_SHOP_LOCALE;
  const { country, timeZone } = stored as { country?: unknown; timeZone?: unknown };
  if (country === 'US' && typeof timeZone === 'string' && (US_TIME_ZONES as readonly string[]).includes(timeZone)) {
    return timeZone === US_SHOP_LOCALE.timeZone ? US_SHOP_LOCALE : (Object.freeze({ ...US_SHOP_LOCALE, timeZone }) as ShopLocale);
  }
  return DEFAULT_SHOP_LOCALE;
}
