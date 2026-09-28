import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { requireSettingsManage } from '../guards.js';
import { ok, type AnyShopSettingCard, type ShopSettingKey } from '@cheeseoclock/shared-types';
import {
  getShopSettingInputSchema,
  getTillSettingInputSchema,
  setShopSettingInputSchema,
  setTillSettingInputSchema,
} from '@cheeseoclock/shared-schemas';
import { getCurrentSession } from '../../services/auth-service.js';
import { checkoutRules, getShopSettingCard, putBackValue } from '../../services/shop-settings.js';
import { setBusinessSettings, type BusinessSettingEntry } from '../../db/repositories/business-settings-repo.js';
import { readTillLink } from '../../services/till-link.js';
import { broadcastShopSettingsChanged } from '../../services/shop-settings-events.js';
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
 *  - settings:getTill / settings:setTill: the settings that belong to THIS
 *    till (its receipt's extra lines, its opening float; till-settings.ts),
 *    the owner alone the same way. Never synced.
 *  - checkout:getRules: any signed-in login; the deal's % and label and
 *    what Pay asks, never the commission, fees or costs.
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
    return ok(card(ctx.db, req.key));
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
    return ok(anyTillSettingCard(ctx.db, parsed.data.key));
  });

  defineHandler('checkout:getRules', ctx, () => {
    if (!getCurrentSession()) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
    return ok(checkoutRules(ctx.db));
  });
}

function card(db: AppDatabase, key: ShopSettingKey): AnyShopSettingCard {
  return getShopSettingCard(db, key, readTillLink(db)) as AnyShopSettingCard;
}
