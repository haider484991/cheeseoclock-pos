/**
 * The owner's settings that belong to this till (shared-types
 * till-settings.ts): the receipt's extra lines, the opening float and what
 * the till does with this computer (keep it awake, start with Windows). Each
 * lives in this till's own `settings` table (never synced), saved through
 * settings-repo setSetting (audited: who, before and after); the Settings
 * card shows the value in use, whether it is the default, who changed it
 * last and its History — from this till's audit trail.
 *
 * Read-only apart from setTillSetting.
 */
import {
  TILL_SETTING_DEFAULTS,
  type AnyTillSettingCard,
  type OpeningFloatSetting,
  type TillSettingCard,
  type TillSettingHistoryLine,
  type TillSettingKey,
  type TillSettingValues,
} from '@cheeseoclock/shared-types';
import { TILL_SETTING_SCHEMAS } from '@cheeseoclock/shared-schemas';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import { BRANDING_KEY, getReceiptExtraLines, setReceiptExtraLines } from './printer-config.js';
import { sameSettingValue } from './shop-settings.js';

/** The opening float's own row in this till's settings table. */
export const OPENING_FLOAT_KEY = 'drawer.openingFloat';
/** This computer's row: keep it awake, start the till with Windows (till-power-hub.ts applies it). */
export const PC_POWER_KEY = 'pc.power';

/**
 * Where each key is kept: its own row, or (the extra lines) one field of the
 * receipt branding, next to the thank-you line they print under.
 */
const STORED_AS: { readonly [K in TillSettingKey]: { row: string; field: string | null } } = {
  'receipt.extraLines': { row: BRANDING_KEY, field: 'extraLines' },
  'drawer.openingFloat': { row: OPENING_FLOAT_KEY, field: null },
  'pc.power': { row: PC_POWER_KEY, field: null },
};

/** Changes shown under a card. */
const HISTORY_CAP = 20;

/** The value in use: the saved one, or the default (also when what is saved does not pass the check). */
export function readTillSetting<K extends TillSettingKey>(db: AppDatabase, key: K): TillSettingValues[K] {
  if (key === 'receipt.extraLines') return getReceiptExtraLines(db) as TillSettingValues[K];
  const parsed = TILL_SETTING_SCHEMAS[key].safeParse(getSettingRaw(db, STORED_AS[key].row));
  return parsed.success ? parsed.data : copyOf(TILL_SETTING_DEFAULTS[key] as TillSettingValues[K]);
}

/** This till's opening float setting (the last count, by default). */
export function readOpeningFloat(db: AppDatabase): OpeningFloatSetting {
  return readTillSetting(db, 'drawer.openingFloat');
}

/**
 * Save a till setting, or put its default back (which writes the default's
 * values). The key's schema checks the value first: a value that does not
 * fit is refused with the reason (a plain Error) and nothing is written.
 */
export function setTillSetting(
  db: AppDatabase,
  req: { key: TillSettingKey; value?: unknown } | { key: TillSettingKey; useDefault: true },
  actorUserId: string | null,
): void {
  const value = 'useDefault' in req ? copyOf(TILL_SETTING_DEFAULTS[req.key]) : req.value;
  const parsed = TILL_SETTING_SCHEMAS[req.key].safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'That does not fit this setting');
  if (req.key === 'receipt.extraLines') {
    setReceiptExtraLines(db, parsed.data as string[], actorUserId);
    return;
  }
  setSetting(db, STORED_AS[req.key].row, parsed.data, { actorUserId });
}

/** One "this till" Settings card: the value in use, whether it is the default, who changed it last, its History. */
export function getTillSettingCard<K extends TillSettingKey>(db: AppDatabase, key: K): TillSettingCard<K> {
  const value = readTillSetting(db, key);
  const defaultValue = copyOf(TILL_SETTING_DEFAULTS[key] as TillSettingValues[K]);
  const history = historyOf(db, key);
  return {
    key,
    value,
    defaultValue,
    isDefault: sameSettingValue(value, defaultValue),
    readOnly: false,
    lastChanged: history[0] ? { at: history[0].at, byName: history[0].byName, onThisTill: true } : null,
    notOnOtherTillYet: false,
    history,
  };
}

export function anyTillSettingCard(db: AppDatabase, key: TillSettingKey): AnyTillSettingCard {
  return getTillSettingCard(db, key) as AnyTillSettingCard;
}

/**
 * The key's changes on this till, newest first. For a field of another row
 * (the extra lines in the receipt branding), only the saves that changed
 * that field: a Shop details save that left them alone is not one of them.
 */
function historyOf<K extends TillSettingKey>(db: AppDatabase, key: K): Array<TillSettingHistoryLine<K>> {
  const { row, field } = STORED_AS[key];
  const rows = db
    .prepare(
      `SELECT actor_user_id, before_json, after_json, created_at FROM audit_log
        WHERE entity_type = 'settings' AND entity_id = ?
        ORDER BY created_at DESC, rowid DESC`,
    )
    .all(row) as Array<{ actor_user_id: string | null; before_json: string | null; after_json: string | null; created_at: string }>;
  const names = userNames(db);
  const out: Array<TillSettingHistoryLine<K>> = [];
  for (const r of rows) {
    if (out.length >= HISTORY_CAP) break;
    const after = parseJson(r.after_json);
    const before = parseJson(r.before_json);
    const pick = (v: unknown): unknown =>
      field === null ? v : v !== null && typeof v === 'object' && !Array.isArray(v) ? ((v as Record<string, unknown>)[field] ?? []) : [];
    const was = pick(before);
    const now = pick(after);
    if (field !== null && sameSettingValue(was, now)) continue;
    const parsed = TILL_SETTING_SCHEMAS[key].safeParse(now);
    out.push({
      at: r.created_at,
      byName: r.actor_user_id ? (names.get(r.actor_user_id) ?? null) : null,
      onThisTill: true,
      value: parsed.success ? (parsed.data as TillSettingValues[K]) : null,
    });
  }
  return out;
}

function copyOf<T>(v: T): T {
  return structuredClone(v) as T;
}

function userNames(db: AppDatabase): Map<string, string> {
  const rows = db.prepare(`SELECT id, full_name FROM users`).all() as Array<{ id: string; full_name: string }>;
  return new Map(rows.map((r) => [r.id, r.full_name]));
}

function parseJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
