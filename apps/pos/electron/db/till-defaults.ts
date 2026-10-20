/**
 * The default a till puts back ("Put back the default") and shows ("Default")
 * for each shop rule (services/shop-settings.ts putBackValue and the
 * Settings cards; the delivery areas' own Save, repositories/
 * delivery-zones-repo.ts).
 *
 *  - Cheese O'Clock's tills (edition 'cheeseoclock'): the built-in default,
 *    SHOP_SETTING_DEFAULTS, exactly as always — its own details, hours,
 *    greeting, home picks, 10% off a pick-up and DHA/Clifton areas.
 *  - Pixel & Oak POS (edition 'pixelandoak', shared-types edition.ts): for
 *    each rule first-time setup stores (NEW_SHOP_KEYS and the delivery areas)
 *    the default is what setup stored ON THIS TILL — the shop's own — read
 *    from its audit trail, so a put back never brings back the built-in
 *    values, which are Cheese O'Clock's. Every other rule keeps its built-in
 *    default: those name no shop.
 *
 * Read-only. Not loaded by the Reports worker (it never puts anything back).
 */
import { BUSINESS_SETTING_READ_SCHEMAS } from '@cheeseoclock/shared-schemas';
import { shopSettingDefault } from '@cheeseoclock/shared-types';
import {
  NEW_SHOP_KEYS,
  SHOP_SETTING_DEFAULTS,
  SHOP_SETTING_FORMAT,
  type ShopSettingKey,
  type ShopSettingValues,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from './connection.js';
import { businessSettingId } from './business-settings-ids.js';
import { readShopSetting } from './business-settings-read.js';
import { EDITION } from '../edition.js';

/** The rules first-time setup stores (system:completeOnboarding): on a Pixel & Oak POS till, their default is setup's. */
export const SETUP_KEYS: ReadonlySet<ShopSettingKey> = new Set<ShopSettingKey>([...NEW_SHOP_KEYS, 'delivery.zones']);

/**
 * What first-time setup stored for a key on this till: the value of the
 * key's first 'create' row in the audit trail (setup makes the row; a value
 * from the other till is a 'remote_apply'), in this version's format — a
 * field added since reads at its default, like any stored value. null when
 * there is none this version can read.
 */
export function setupValueOf<K extends ShopSettingKey>(db: AppDatabase, key: K): ShopSettingValues[K] | null {
  const row = db
    .prepare(
      `SELECT after_json FROM audit_log
        WHERE entity_type = 'business_settings' AND entity_id = ? AND action = 'create'
        ORDER BY created_at, rowid LIMIT 1`,
    )
    .get(businessSettingId(key)) as { after_json: string | null } | undefined;
  if (!row?.after_json) return null;
  let after: unknown;
  try {
    after = JSON.parse(row.after_json);
  } catch {
    return null;
  }
  const saved = after as { key?: unknown; value?: unknown } | null;
  if (!saved || saved.key !== key) return null;
  const parsed = BUSINESS_SETTING_READ_SCHEMAS[key].safeParse(saved.value);
  if (!parsed.success) return null;
  return { ...(parsed.data as object), v: SHOP_SETTING_FORMAT[key] } as unknown as ShopSettingValues[K];
}

/**
 * The default this till puts back and shows for a key (see above). A Pixel &
 * Oak POS till with no setup value to go back to (it should not happen:
 * setup stores them all) keeps the value it has — a put back changes
 * nothing — except the delivery areas, whose built-in Karachi list is the
 * preset setup itself offers: setup's own "Karachi" choice is a put back
 * made before any row exists.
 */
export function tillDefaultOf<K extends ShopSettingKey>(db: AppDatabase, key: K): Readonly<ShopSettingValues[K]> {
  if (EDITION.id === 'cheeseoclock' || !SETUP_KEYS.has(key)) return shopSettingDefault(key);
  const setup = setupValueOf(db, key);
  if (setup) return setup;
  return key === 'delivery.zones' ? shopSettingDefault(key) : readShopSetting(db, key).value;
}
