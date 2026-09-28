/**
 * FROZEN: what a v0.7.29 till (release commit 4201067) knows of two shop
 * rules — 'discounts.approval' and 'foodpanda.checks' — copied from that
 * commit's packages/shared-types/src/shop-settings.ts and
 * packages/shared-schemas/src/business-settings.ts: the same code, cut down
 * to these two keys. It stands for the tills already in the shop, so it is
 * never edited to follow this version (old-till-formats.test.ts checks what
 * such a till makes of the values this version writes, and the other way).
 * Not a test file itself.
 */
import { z } from 'zod';

// ---- packages/shared-types/src/shop-settings.ts (4201067) ------------------

type OldKey = 'foodpanda.checks' | 'discounts.approval';

export const APPROVAL_MAX_PERCENT = 50;
export const APPROVAL_MAX_FLAT_CENTS = 500_000;

export const SHOP_SETTING_FORMAT: Readonly<Record<OldKey, number>> = Object.freeze({
  'foodpanda.checks': 1,
  'discounts.approval': 1,
});

// ---- packages/shared-schemas/src/business-settings.ts (4201067) ------------

/** `v`: the format this version writes (write) or any format from 1 (read). */
const writesFormat = (key: OldKey) =>
  z
    .number()
    .int()
    .refine((v) => v === SHOP_SETTING_FORMAT[key], {
      message: 'Saved by a different version of the app — update this till to change it',
    });
const readsFormat = z.number().int().min(1);

/** Whole rupees in paisa, from Rs 0 up to `maxRupees`. */
const wholeRupees = (maxRupees: number, what: string) =>
  z
    .number()
    .int({ message: `${what} is in whole rupees` })
    .min(0, { message: `${what} can't be below Rs 0` })
    .max(maxRupees * 100, { message: `${what} is at most Rs ${maxRupees.toLocaleString('en-PK')}` })
    .refine((c) => c % 100 === 0, { message: `${what} is in whole rupees` });

const discountApprovalShape = {
  percentOver: z
    .number()
    .int({ message: 'The % limit is a whole %' })
    .min(0, { message: "The % limit can't be below 0%" })
    .max(APPROVAL_MAX_PERCENT, { message: `The % limit is at most ${APPROVAL_MAX_PERCENT}%` }),
  flatOverCents: wholeRupees(APPROVAL_MAX_FLAT_CENTS / 100, 'The rupee limit'),
};
/** 'discounts.approval' as this version writes it. */
export const discountApprovalSchema = z.object({ v: writesFormat('discounts.approval'), ...discountApprovalShape }).strict();
const discountApprovalReadSchema = z.object({ v: readsFormat, ...discountApprovalShape });

const checkRule = z.enum(['optional', 'required'], { errorMap: () => ({ message: 'Optional or required' }) });
const foodpandaChecksShape = { orderCode: checkRule, tabletTotal: checkRule };
/** 'foodpanda.checks' as this version writes it. */
export const foodpandaChecksSchema = z.object({ v: writesFormat('foodpanda.checks'), ...foodpandaChecksShape }).strict();
const foodpandaChecksReadSchema = z.object({ v: readsFormat, ...foodpandaChecksShape });

export const BUSINESS_SETTING_SCHEMAS = {
  'foodpanda.checks': foodpandaChecksSchema,
  'discounts.approval': discountApprovalSchema,
} as const;

/** The shop rules are read leniently: fields this version does not know are dropped, any format from 1 up is taken. */
export const BUSINESS_SETTING_READ_SCHEMAS = {
  'foodpanda.checks': foodpandaChecksReadSchema,
  'discounts.approval': discountApprovalReadSchema,
} as const;

/** The fields each shop rule has in the format this version writes. */
const SHOP_SETTING_FIELDS: { readonly [K in OldKey]: ReadonlySet<string> } = {
  'foodpanda.checks': new Set(['v', ...Object.keys(foodpandaChecksShape)]),
  'discounts.approval': new Set(['v', ...Object.keys(discountApprovalShape)]),
};

/**
 * A stored shop rule saved by a newer version of the app: a higher format,
 * or fields this version does not know. This till uses what it knows but
 * shows the card read-only and refuses to save over it (it would silently
 * drop the rest).
 */
export function storedFormatIsNewer(key: OldKey, raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const v = (raw as { v?: unknown }).v;
  if (typeof v === 'number' && v > SHOP_SETTING_FORMAT[key]) return true;
  const known = SHOP_SETTING_FIELDS[key];
  if (Object.keys(raw).some((f) => !known.has(f))) return true;
  return false;
}
