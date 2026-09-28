/**
 * The owner's settings that belong to ONE till (owner, 2026-09-27:
 * "everything should be editable for admin"). Each lives in that till's own
 * `settings` table, never synced, like its printers and its receipt
 * branding: two tills can differ on purpose (each has its own drawer and its
 * own receipt printer). Saved through settings-repo setSetting (audited:
 * who, before and after). The Settings card is the same as a shop rule's
 * (SettingCard) but says "this till".
 *
 * FROZEN DEFAULTS, as for the shop rules: a key never saved reads as its
 * DEFAULT_* below, which is exactly what the till did before the setting
 * existed, so installing the version changes nothing.
 *
 * No format number: a per-till value never meets another version of the app
 * except this till's own upgrade, and each schema below reads a value an
 * older version saved.
 */

/** The keys the "this till" Settings cards edit (settings:getTill / settings:setTill). */
export const TILL_SETTING_KEYS = ['receipt.extraLines', 'drawer.openingFloat'] as const;
export type TillSettingKey = (typeof TILL_SETTING_KEYS)[number];

export function isTillSettingKey(key: unknown): key is TillSettingKey {
  return typeof key === 'string' && (TILL_SETTING_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Receipt extra lines (Settings → Shop & logo)
// ---------------------------------------------------------------------------

/**
 * Up to this many lines of the owner's own under the thank-you line of a
 * customer's receipt and bill (Instagram, the Wi-Fi password, an offer).
 * Kept in this till's receipt branding (`receipt.branding`.extraLines).
 */
export const RECEIPT_EXTRA_LINES_MAX = 3;
/** Each line at most this many letters: it wraps onto the next row like the thank-you line. */
export const RECEIPT_EXTRA_LINE_MAX_CHARS = 64;

/** Today: no extra lines. */
export const DEFAULT_RECEIPT_EXTRA_LINES: readonly string[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// Opening float (Settings → Staff & kitchen)
// ---------------------------------------------------------------------------

/**
 * What the Open shift box starts the count on:
 *  - 'lastCount': what this till's last shift closed with (the cash that
 *    stayed in the drawer overnight) — today;
 *  - 'fixed': the same amount every shift (`fixedCents`).
 * Only a starting figure: the float is still counted and typed, and the
 * close stays a blind count.
 */
export type OpeningFloatMode = 'lastCount' | 'fixed';

export interface OpeningFloatSetting {
  mode: OpeningFloatMode;
  /** The fixed amount (paisa, whole rupees, Rs 0 to OPENING_FLOAT_MAX_CENTS); kept when the mode is 'lastCount'. */
  fixedCents: number;
}

/** The most a fixed opening float can be: Rs 100,000. */
export const OPENING_FLOAT_MAX_CENTS = 10_000_000;

/** Today: the last shift's count. */
export const DEFAULT_OPENING_FLOAT: Readonly<OpeningFloatSetting> = Object.freeze({ mode: 'lastCount', fixedCents: 0 });

/** What the Open shift box starts on (shifts:openingFloat), any signed-in login. */
export interface OpeningFloatPrefill {
  /** The figure the count starts on, paisa; null when there is none (a first shift: the box starts at 0). */
  prefillCents: number | null;
  /** Where it came from: the last count, the owner's fixed amount, or nothing. */
  from: 'last_count' | 'fixed' | 'none';
  /** This till's last closed shift's count, whatever the setting (null on a first shift). */
  lastCount: { countedCashCents: number; closedAt: string } | null;
}

// ---------------------------------------------------------------------------
// The cards
// ---------------------------------------------------------------------------

export interface TillSettingValues {
  'receipt.extraLines': string[];
  'drawer.openingFloat': OpeningFloatSetting;
}

export const TILL_SETTING_DEFAULTS: { readonly [K in TillSettingKey]: Readonly<TillSettingValues[K]> } = Object.freeze({
  'receipt.extraLines': DEFAULT_RECEIPT_EXTRA_LINES,
  'drawer.openingFloat': DEFAULT_OPENING_FLOAT,
});

/** One change to a till setting, for the card's History (this till's audit trail). */
export interface TillSettingHistoryLine<K extends TillSettingKey = TillSettingKey> {
  at: string;
  byName: string | null;
  /** Always this till: the setting never leaves it. */
  onThisTill: true;
  value: TillSettingValues[K] | null;
}

/** A "this till" Settings card: the same shape SettingCard shows for a shop rule. */
export interface TillSettingCard<K extends TillSettingKey = TillSettingKey> {
  key: K;
  /** The value in use: the saved one, or the default when nothing is saved. */
  value: TillSettingValues[K];
  /** What "Put back the default" writes. */
  defaultValue: TillSettingValues[K];
  /** The value in use is the default's. */
  isDefault: boolean;
  /** Never: nothing but this till's own version reads it. */
  readOnly: false;
  /** Who saved it last and when; null when never saved. */
  lastChanged: { at: string; byName: string | null; onThisTill: true } | null;
  /** Never: it does not go to the other till. */
  notOnOtherTillYet: false;
  /** Newest first, capped. */
  history: Array<TillSettingHistoryLine<K>>;
}

export type AnyTillSettingCard = { [K in TillSettingKey]: TillSettingCard<K> }[TillSettingKey];

/** settings:setTill: a new value for a key, or "Put back the default". */
export type SetTillSettingRequest =
  | { [K in TillSettingKey]: { key: K; value: TillSettingValues[K] } }[TillSettingKey]
  | { key: TillSettingKey; useDefault: true };
