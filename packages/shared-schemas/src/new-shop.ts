/**
 * First-time setup's Website step (shared-types new-shop.ts): the shape of
 * its answers — the main process checks the request with it, and a missing
 * or malformed answer is refused before anything is written — and the five
 * values checked with the keys' OWN write schemas: the same rules as every
 * Settings Save, so what setup stores always passes the website's check of
 * the shop block and the settings block too.
 */
import { z } from 'zod';
import {
  NEW_SHOP_KEYS,
  SHOP_DAYS,
  WEBSITE_PICKUP_MAX_PERCENT,
  newShopSettings,
  normalizePhone,
  type NewShopAnswers,
  type NewShopSettings,
} from '@cheeseoclock/shared-types';
import { BUSINESS_SETTING_SCHEMAS } from './business-settings.js';

/**
 * The answers as the setup screen sends them. Only their shape and size:
 * every bound that matters is the keys' own (checkedNewShop).
 */
export const newShopAnswersSchema = z
  .object({
    phone: z.string().max(60),
    whatsapp: z.string().max(60),
    street: z.string().max(400),
    areaLine: z.string().max(200),
    postalCode: z.string().max(20),
    priceRange: z.string().max(100),
    opens: z.string().max(5),
    closes: z.string().max(5),
    days: z.array(z.enum(SHOP_DAYS)).max(SHOP_DAYS.length),
    pickup: z
      .object({
        offered: z.boolean(),
        percent: z.number().int().min(0).max(WEBSITE_PICKUP_MAX_PERCENT),
      })
      .strict(),
  })
  .strict();

const PHONE_HINT = 'as it is dialled in Pakistan (like 0300 1234567)';
const PICKUP_PERCENT_HINT = `The pick-up discount is a whole % from 0 to ${WEBSITE_PICKUP_MAX_PERCENT}`;

/**
 * The five values a new shop starts with (shared-types newShopSettings),
 * or the first thing to fix, in the owner's words. `name` and `tagline` are
 * the business's own, as typed on the setup screen.
 */
export function checkedNewShop(
  name: string,
  tagline: string,
  answers: unknown,
): { value: NewShopSettings; problem: null } | { value: null; problem: string } {
  const parsed = newShopAnswersSchema.safeParse(answers);
  if (!parsed.success) {
    // A pick-up % that is not one says so; anything else is a screen that did not send the step.
    const percent = parsed.error.issues.some((i) => i.path[0] === 'pickup' && i.path[1] === 'percent');
    return { value: null, problem: percent ? PICKUP_PERCENT_HINT : 'Fill in what the website shows' };
  }
  const a: NewShopAnswers = parsed.data;
  if (!normalizePhone(a.phone)) return { value: null, problem: `Type the shop’s phone number ${PHONE_HINT}` };
  if (a.whatsapp.trim() !== '' && !normalizePhone(a.whatsapp)) {
    return { value: null, problem: `Type the WhatsApp number ${PHONE_HINT}, or leave it empty for the same number` };
  }
  const value = newShopSettings(name, tagline, a);
  for (const key of NEW_SHOP_KEYS) {
    const r = BUSINESS_SETTING_SCHEMAS[key].safeParse(value[key]);
    if (!r.success) return { value: null, problem: r.error.issues[0]?.message ?? 'Check what the website shows' };
  }
  return { value, problem: null };
}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _newShopAnswersShape: Same<z.infer<typeof newShopAnswersSchema>, NewShopAnswers> = true;
