import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { requireSettingsManage } from '../guards.js';
import {
  ok,
  PUBLISHED_SETTING_KEYS,
  SHOP_PUBLISHED_KEYS,
  type AnyShopSettingCard,
  type ShopSettingCard,
  type ShopSettingKey,
} from '@cheeseoclock/shared-types';
import {
  getShopSettingInputSchema,
  getTillSettingInputSchema,
  saveDeliveryChargeTaxInputSchema,
  saveDeliveryZonesInputSchema,
  setShopSettingInputSchema,
  setTillSettingInputSchema,
} from '@cheeseoclock/shared-schemas';
import { getCurrentSession } from '../../services/auth-service.js';
import { checkoutRules, getShopSettingCard, putBackValue } from '../../services/shop-settings.js';
import { setBusinessSettings, type BusinessSettingEntry } from '../../db/repositories/business-settings-repo.js';
import { readTillLink } from '../../services/till-link.js';
import { broadcastShopSettingsChanged } from '../../services/shop-settings-events.js';
import { websiteSettingsChanged } from '../../services/website-settings-events.js';
import { nudgeMenuDeploy } from '../../services/menu-deploy-events.js';
import { tillPowerSettingsChanged } from '../../services/till-power-events.js';
import { saveDeliveryZones } from '../../db/repositories/delivery-zones-repo.js';
import { readDeliveryChargeTax, saveDeliveryChargeTax } from '../../db/repositories/delivery-charge-tax-repo.js';
import { anyTillSettingCard, setTillSetting } from '../../services/till-settings.js';
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
 *  - settings:deliveryChargeTax / settings:saveDeliveryChargeTax: the owner
 *    alone too — "Tax on the delivery charge" (owner, 10 Oct 2026): every
 *    "Delivery Charge (Rs N)" item onto one tax, and the areas saved again
 *    as they are so the website gets the charges with it
 *    (delivery-charge-tax-repo, one transaction).
 *  - settings:getTill / settings:setTill: the settings that belong to THIS
 *    till (its receipt's extra lines, its opening float, this computer:
 *    keep it awake, start with Windows; till-settings.ts), the owner alone
 *    the same way. Never synced. "This computer" is applied at once.
 *  - checkout:getRules: any signed-in login; the deal's % and label and
 *    what Pay asks, the areas and fees, never the commission, fees or costs.
 *
 * A Save the website needs (the areas, the pick-up offer, the website's
 * messages and minimum) tells the web bridge, which sends the newer settings
 * block ALONE, with only its areas' charge items (never the till's
 * unpublished menu changes); a Save of the shop's details (Shop & logo →
 * "Website: shop details") sends the shop block alone the same way.
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
    // "Put in by themselves / wait for my OK": the menu files from the costing PC look again soon.
    if (req.key === 'menu.autoUpdate') nudgeMenuDeploy();
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

  defineHandler('settings:deliveryChargeTax', ctx, () => {
    requireSettingsManage();
    return ok(readDeliveryChargeTax(ctx.db));
  });

  defineHandler('settings:saveDeliveryChargeTax', ctx, (_ctx, payload) => {
    const s = requireSettingsManage();
    const parsed = saveDeliveryChargeTaxInputSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcGuardError({ code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Which tax on the delivery charge?' });
    }
    let saved;
    try {
      saved = saveDeliveryChargeTax(ctx.db, parsed.data.choice, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      // The repository's own words ("Add a tax in Menu → Tax first…") — a database error stays hidden.
      if (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype) {
        throw new IpcGuardError({ code: 'validation_failed', message: e.message });
      }
      throw e;
    }
    if (saved.changed) broadcastShopSettingsChanged();
    // The areas went again with their charge items: the bridge sends them to the website (the block alone).
    if (saved.sentToWebsite) websiteSettingsChanged();
    return ok(saved);
  });

  defineHandler('settings:getTill', ctx, (_ctx, payload) => {
    requireSettingsManage();
    const parsed = getTillSettingInputSchema.safeParse(payload);
    if (!parsed.success) throw new IpcGuardError({ code: 'validation_failed', message: 'Which setting?' });
    return ok(anyTillSettingCard(ctx.db, parsed.data.key));
  });

  defineHandler('settings:setTill', ctx, (_ctx, payload) => {
    const s = requireSettingsManage();
    const parsed = setTillSettingInputSchema.safeParse(payload);
    if (!parsed.success) throw new IpcGuardError({ code: 'validation_failed', message: 'Which setting, and what to save?' });
    try {
      // The key's schema checks the value; "Put back the default" writes the default's values.
      setTillSetting(ctx.db, parsed.data, s.id);
    } catch (e) {
      // The schema's own words ("Keep each extra line to 64 letters") — a database error stays hidden.
      if (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype) {
        throw new IpcGuardError({ code: 'validation_failed', message: e.message });
      }
      throw e;
    }
    // Save and "Put back the default" alike: kept awake or not, the start-up entry, now.
    if (parsed.data.key === 'pc.power') tillPowerSettingsChanged();
    return ok(anyTillSettingCard(ctx.db, parsed.data.key));
  });

  defineHandler('checkout:getRules', ctx, () => {
    if (!getCurrentSession()) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
    return ok(checkoutRules(ctx.db));
  });
}

/**
 * The keys the website's blocks carry: the settings block's (shared-types
 * PUBLISHED_SETTING_KEYS: the areas, the pick-up offer and — since v0.7.30 —
 * 'online.options', the website's messages and minimum) and the shop block's
 * (SHOP_PUBLISHED_KEYS: the shop's details, hours, website words and home
 * lineup). A Save of one sends ITS newer block alone — never the menu.
 */
const WEBSITE_KEYS: ReadonlySet<ShopSettingKey> = new Set<ShopSettingKey>([...PUBLISHED_SETTING_KEYS, ...SHOP_PUBLISHED_KEYS]);

function card(db: AppDatabase, key: ShopSettingKey): AnyShopSettingCard {
  return getShopSettingCard(db, key, readTillLink(db)) as AnyShopSettingCard;
}
