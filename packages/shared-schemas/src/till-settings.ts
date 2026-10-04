import { z } from 'zod';
import {
  DELIVERY_CITY_MAX_CHARS,
  OPENING_FLOAT_MAX_CENTS,
  RECEIPT_EXTRA_LINE_MAX_CHARS,
  RECEIPT_EXTRA_LINES_MAX,
  TILL_SETTING_KEYS,
} from '@cheeseoclock/shared-types';
import type { OpeningFloatSetting, PcPowerSetting, TillSettingKey, TillSettingValues } from '@cheeseoclock/shared-types';

/**
 * The owner's settings that belong to one till (shared-types
 * till-settings.ts). Each key's schema is checked in the main process when
 * the owner saves it (settings:setTill), and again when it is read back: a
 * stored value that does not fit reads as the default, never trusted.
 */

// Control characters: C0, DEL and C1. A receipt line with one would send
// the printer a command instead of a letter.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * One extra line under the thank-you line. Spaces at its ends are dropped;
 * an empty line is refused (leave it out instead). A letter the printer has
 * no glyph for (Urdu, an emoji) is NOT refused: it prints as "?", and the
 * card warns about it (printer-core unprintableChars) — like the other
 * receipt lines.
 */
export const receiptExtraLineSchema = z
  .string()
  .trim()
  .min(1, { message: "An extra line can't be empty: take it off instead" })
  .max(RECEIPT_EXTRA_LINE_MAX_CHARS, { message: `Keep each extra line to ${RECEIPT_EXTRA_LINE_MAX_CHARS} letters` })
  .refine((l) => !CONTROL_CHARS.test(l), { message: 'An extra line has a character the printer would take as a command' });

/** 'receipt.extraLines': none to three lines. */
export const receiptExtraLinesSchema = z
  .array(receiptExtraLineSchema)
  .max(RECEIPT_EXTRA_LINES_MAX, { message: `At most ${RECEIPT_EXTRA_LINES_MAX} extra lines` });

/**
 * 'drawer.openingFloat': the last count, or a fixed amount in whole rupees
 * from Rs 0 to Rs 100,000. The last count carries no amount: one sent (or
 * stored) with it is dropped, so it reads, saves and compares as the
 * default itself — the card says Default when the till does what the
 * default does.
 */
export const openingFloatSchema = z
  .object({
    mode: z.enum(['lastCount', 'fixed'], { errorMap: () => ({ message: "The last shift's count, or a fixed amount" }) }),
    fixedCents: z
      .number({ invalid_type_error: 'The fixed float is an amount in rupees' })
      .int({ message: 'The fixed float is in whole rupees' })
      .min(0, { message: "The fixed float can't be below Rs 0" })
      .max(OPENING_FLOAT_MAX_CENTS, {
        message: `The fixed float is at most Rs ${(OPENING_FLOAT_MAX_CENTS / 100).toLocaleString('en-PK')}`,
      })
      .refine((c) => c % 100 === 0, { message: 'The fixed float is in whole rupees' }),
  })
  .strict()
  .transform((s): OpeningFloatSetting => (s.mode === 'lastCount' ? { mode: 'lastCount', fixedCents: 0 } : s));

/** 'delivery.city': one city name for this till's delivery addresses. */
const deliveryCitySchema = z
  .string()
  .trim()
  .min(1, { message: 'Give the city a name' })
  .max(DELIVERY_CITY_MAX_CHARS, { message: `Keep the city to ${DELIVERY_CITY_MAX_CHARS} letters` });

/** 'pc.power': two yes/no answers, nothing else. */
export const pcPowerSchema = z
  .object({
    keepAwake: z.boolean({ invalid_type_error: 'Keep this computer awake: yes or no' }),
    startWithWindows: z.boolean({ invalid_type_error: 'Start the till with Windows: yes or no' }),
  })
  .strict();

/** Every till key and its schema. */
export const TILL_SETTING_SCHEMAS: { readonly [K in TillSettingKey]: z.ZodType<TillSettingValues[K], z.ZodTypeDef, unknown> } = {
  'receipt.extraLines': receiptExtraLinesSchema,
  'drawer.openingFloat': openingFloatSchema,
  'pc.power': pcPowerSchema,
  'delivery.city': deliveryCitySchema,
};

/** settings:setTill: a key and its value, or "Put back the default". The value is checked by the key's schema. */
export const setTillSettingInputSchema = z.union([
  z.object({ key: z.enum(TILL_SETTING_KEYS), useDefault: z.literal(true) }).strict(),
  z.object({ key: z.enum(TILL_SETTING_KEYS), value: z.unknown() }).strict(),
]);

/** settings:getTill */
export const getTillSettingInputSchema = z.object({ key: z.enum(TILL_SETTING_KEYS) }).strict();

// The types (shared-types) and these schemas must describe the same shape.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _openingFloatShape: Same<z.infer<typeof openingFloatSchema>, OpeningFloatSetting> = true;
const _extraLinesShape: Same<z.infer<typeof receiptExtraLinesSchema>, string[]> = true;
const _pcPowerShape: Same<z.infer<typeof pcPowerSchema>, PcPowerSetting> = true;
