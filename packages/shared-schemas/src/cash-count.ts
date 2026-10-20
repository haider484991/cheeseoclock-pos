import { z } from 'zod';
import {
  CASH_COUNT_OTHER_MAX_CENTS,
  CASH_NOTE_COUNT_MAX,
  formatCents,
  getShopLocale,
} from '@cheeseoclock/shared-types';
import type { CashCount } from '@cheeseoclock/shared-types';

/**
 * The drawer counted by note at Close shift (shared-types shift.ts CashCount;
 * stored in shifts.counted_notes_json, migration 0050).
 *
 * Two schemas, one shape:
 *  - cashCountInputSchema (WRITE, strict): what a close may save. Exactly the
 *    owner's seven note rows in his order, whole numbers of notes, 'Coins and
 *    other' in whole rupees. shift-repo closeShift is the one place it runs.
 *  - cashCountSchema (READ, lenient): what a stored count may hold. Unknown
 *    keys are dropped and any whole number of cents is taken, so a newer
 *    till's extra key, row or paisa never wipes the breakdown.
 *
 * Money in cents throughout. counted_cash_cents stays the truth.
 */

const COUNT_WHOLE = 'A count is a whole number of notes';
const COUNT_BELOW_ZERO = "A count can't be below 0";
// The words name the limits CASH_NOTE_COUNT_MAX and CASH_COUNT_OTHER_MAX_CENTS.
const COUNT_TOO_MANY = 'At most 9,999 notes in one row';
/**
 * These read the shop's locale, so they are functions rather than consts: a
 * const here would be built when this module is first imported, which in the
 * till is startup — before the settings are read and the shop is known.
 */
const otherWhole = (): string => `Coins and other is in whole ${getShopLocale().words.major}`;
const otherBelowZero = (): string => `Coins and other can't be below ${formatCents(0)}`;
const otherTooMuch = (): string =>
  `Coins and other is at most ${formatCents(CASH_COUNT_OTHER_MAX_CENTS)}`;

/**
 * "The note rows are Rs 5,000, 1,000, 500, 100, 50, 20 and 10" — the shop's
 * own notes, largest first, with the symbol on the first one only. A US
 * drawer reads "$100, 50, 20, 10, 5 and 1".
 */
const noteRows = (): string => {
  const faces = getShopLocale().cashFacesCents;
  const bare = faces.slice(1).map((c) => formatCents(c, { showSymbol: false }));
  const last = bare.pop();
  const head = [formatCents(faces[0] ?? 0), ...bare].join(', ');
  return `The note rows are ${last === undefined ? head : `${head} and ${last}`}`;
};

/** The read side's limits: wide, so a newer till's count still reads. */
const READ_MAX_ROWS = 20;
const READ_MAX_FACE_CENTS = 10_000_000;
const READ_MAX_OTHER_CENTS = 1_000_000_000;

// ---------------------------------------------------------------- write side

const noteCountInputSchema = z
  .object({
    faceCents: z
      .number({
        errorMap: (issue, ctx) =>
          issue.code === z.ZodIssueCode.invalid_type ? { message: noteRows() } : { message: ctx.defaultError },
      })
      .int({ message: 'A note value is a whole number' }),
    count: z
      .number({ required_error: COUNT_WHOLE, invalid_type_error: COUNT_WHOLE })
      .int({ message: COUNT_WHOLE })
      .min(0, { message: COUNT_BELOW_ZERO })
      .max(CASH_NOTE_COUNT_MAX, { message: COUNT_TOO_MANY }),
  })
  .strict(noteRows());

/**
 * What a close may save: exactly the rows Rs 5,000, 1,000, 500, 100, 50, 20
 * and 10 in that order (CASH_NOTE_FACE_CENTS), each a whole number of notes
 * from 0 to 9,999, and 'Coins and other' in whole rupees from Rs 0 to
 * Rs 99,999. Nothing else: an extra key, row or paisa is refused.
 */
export const cashCountInputSchema = z
  .object({
    notes: z
      .array(noteCountInputSchema, {
        errorMap: (issue, ctx) =>
          issue.code === z.ZodIssueCode.invalid_type ? { message: noteRows() } : { message: ctx.defaultError },
      })
      .superRefine((notes, ctx) => {
        // The shop's own notes, not Pakistan's: a US drawer is counted in
        // $100 down to $1, and must be saveable.
        const faces = getShopLocale().cashFacesCents;
        const same = notes.length === faces.length && notes.every((n, i) => n.faceCents === faces[i]);
        if (!same) ctx.addIssue({ code: z.ZodIssueCode.custom, message: noteRows() });
      }),
    otherCents: z
      .number({
        errorMap: (issue, ctx) =>
          issue.code === z.ZodIssueCode.invalid_type ? { message: otherWhole() } : { message: ctx.defaultError },
      })
      .superRefine((value, ctx) => {
        const fail = (message: string): void => {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message });
        };
        if (!Number.isInteger(value)) fail(otherWhole());
        else if (value < 0) fail(otherBelowZero());
        else if (value > CASH_COUNT_OTHER_MAX_CENTS) fail(otherTooMuch());
        else if (value % 100 !== 0) fail(otherWhole());
      }),
  })
  .strict(noteRows());

// ----------------------------------------------------------------- read side

const noteCountSchema = z.object({
  faceCents: z.number().int().min(1).max(READ_MAX_FACE_CENTS),
  count: z.number().int().min(0).max(CASH_NOTE_COUNT_MAX),
});

/**
 * What a stored count may hold: 1 to 20 rows of a note value (whole cents,
 * each value once) and a whole number of notes up to 9,999, and 'Coins and
 * other' in whole cents. Unknown keys are dropped (zod's default strip).
 */
export const cashCountSchema = z.object({
  notes: z
    .array(noteCountSchema)
    .min(1)
    .max(READ_MAX_ROWS)
    .refine((notes) => new Set(notes.map((n) => n.faceCents)).size === notes.length, {
      message: 'Each note value is counted once',
    }),
  otherCents: z.number().int().min(0).max(READ_MAX_OTHER_CENTS),
});

/**
 * A stored counted_notes_json as a CashCount, or null when there is none or
 * it cannot be read (empty, not JSON, a shape the read schema refuses).
 * Never throws.
 */
export function parseCashCountJson(text: string | null | undefined): CashCount | null {
  if (typeof text !== 'string' || text === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = cashCountSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// The type (shared-types) and these schemas must describe the same shape.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _cashCountShape: Same<z.infer<typeof cashCountSchema>, CashCount> = true;
const _cashCountInputShape: Same<z.infer<typeof cashCountInputSchema>, CashCount> = true;
