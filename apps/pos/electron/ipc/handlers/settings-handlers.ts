import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { requireSettingsManage } from '../guards.js';
import { ok, type AnyShopSettingCard, type ShopSettingCard, type ShopSettingKey } from '@cheeseoclock/shared-types';
import {
  getShopSettingInputSchema,
  saveDeliveryZonesInputSchema,
  setShopSettingInputSchema,
} from '@cheeseoclock/shared-schemas';
import { getCurrentSession } from '../../services/auth-service.js';
import { checkoutRules, getShopSettingCard, putBackValue } from '../../services/shop-settings.js';
import { setBusinessSettings, type BusinessSettingEntry } from '../../db/repositories/business-settings-repo.js';
import { readTillLink } from '../../services/till-link.js';
import { broadcastShopSettingsChanged } from '../../services/shop-settings-events.js';
import { websiteSettingsChanged } from '../../services/website-settings-events.js';
import { saveDeliveryZones } from '../../db/repositories/delivery-zones-repo.js';
import type { AppDatabase } from '../../db/connection.js';

/**
 * The owner's shop rules (Settings → foodpanda …; shared-types
 * shop-settings.ts): one typed pair for every key, the key's Zod schema
 * checked here in the main process, and what the counter needs to take an
 * order.
 *
 *  - settings:getBusiness / settings:setBusiness: the owner alone
 *    (requireSettingsManage — settings.manage, owner-only since v0.7.18).
 *    A manager or a cashier is refused before anything is read or written.
 *  - settings:saveDeliveryZones: the owner alone too. The delivery areas
 *    have their own channel because their Save also makes the
 *    "Delivery Charge (Rs N)" menu items (delivery-zones-repo, one
 *    transaction); settings:setBusiness refuses 'delivery.zones'.
 *  - checkout:getRules: any signed-in login; the deal's % and label and
 *    what Pay asks, the areas and fees, never the commission, fees or costs.
 *
 * A Save the website needs (the areas, the pick-up offer) tells the web
 * bridge, which publishes the menu with the newer settings block.
 */
export function registerSettingsHandlers(ctx: HandlerContext): void {
  defineHandler('settings:getBusiness', ctx, (_ctx, payload) => {
    requireSettingsManage();
    const parsed = getShopSettingInputSchema.safeParse(payload);
    if (!parsed.success) throw new IpcGuardError({ code: 'validation_failed', message: 'Which setting?' });
    return ok(card(ctx.db, parsed.data.key));
  });

  defineHandler('settings:setBusiness', ctx, (_ctx, payload) => {
    const s = requireSettingsManage();
    const parsed = setShopSettingInputSchema.safeParse(payload);
    if (!parsed.success) throw new IpcGuardError({ code: 'validation_failed', message: 'Which setting, and what to save?' });
    const req = parsed.data;
    // "Put back the default" WRITES the default's values, so both tills hold
    // the same explicit row (a soft delete would leave each on its own idea).
    // (The stock rules keep every waste reason the owner added, hidden: putBackValue.)
    const value = 'useDefault' in req ? putBackValue(ctx.db, req.key) : req.value;
    try {
      // The key's schema checks the value, and a value saved by a newer
      // version of the app is never saved over (business-settings-repo).
      setBusinessSettings(ctx.db, [{ key: req.key, value } as BusinessSettingEntry], { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      // The schema's and the repository's own words ("The deal is at most 50%",
      // "Saved by a newer version…") — a database error stays hidden (defineHandler).
      if (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype) {
        throw new IpcGuardError({ code: 'validation_failed', message: e.message });
      }
      throw e;
    }
    broadcastShopSettingsChanged();
    if (WEBSITE_KEYS.has(req.key)) websiteSettingsChanged();
    return ok(card(ctx.db, req.key));
  });

  defineHandler('settings:saveDeliveryZones', ctx, (_ctx, payload) => {
    const s = requireSettingsManage();
    const parsed = saveDeliveryZonesInputSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcGuardError({ code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Which areas, and what to save?' });
    }
    try {
      saveDeliveryZones(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      // The list's own words ("DHA Phase 8 can't be removed: switch it off…") — a database error stays hidden.
      if (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype) {
        throw new IpcGuardError({ code: 'validation_failed', message: e.message });
      }
      throw e;
    }
    broadcastShopSettingsChanged();
    websiteSettingsChanged();
    return ok(getShopSettingCard(ctx.db, 'delivery.zones', readTillLink(ctx.db)) as ShopSettingCard<'delivery.zones'>);
  });

  defineHandler('checkout:getRules', ctx, () => {
    if (!getCurrentSession()) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
    return ok(checkoutRules(ctx.db));
  });
}

/** The keys the website's settings block carries: a Save of one sends the menu with a newer block. */
const WEBSITE_KEYS: ReadonlySet<ShopSettingKey> = new Set<ShopSettingKey>(['discounts.websitePickup', 'delivery.zones']);

function card(db: AppDatabase, key: ShopSettingKey): AnyShopSettingCard {
  return getShopSettingCard(db, key, readTillLink(db)) as AnyShopSettingCard;
}
