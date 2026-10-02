import { z } from 'zod';
import { CASH_COUNT_OTHER_MAX_CENTS, CASH_NOTE_COUNT_MAX, CASH_NOTE_FACE_CENTS } from '@cheeseoclock/shared-types';
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
const OTHER_WHOLE = 'Coins and other is in whole rupees';
const OTHER_BELOW_ZERO = "Coins and other can't be below Rs 0";
const OTHER_TOO_MUCH = 'Coins and other is at most Rs 99,999';
const NOTE_ROWS = 'The note rows are Rs 5,000, 1,000, 500, 100, 50, 20 and 10';

/** The read side's limits: wide, so a newer till's count still reads. */
const READ_MAX_ROWS = 20;
const READ_MAX_FACE_CENTS = 10_000_000;
const READ_MAX_OTHER_CENTS = 1_000_000_000;

// ---------------------------------------------------------------- write side

const noteCountInputSchema = z
  .object({
    faceCents: z.number({ required_error: NOTE_ROWS, invalid_type_error: NOTE_ROWS }).int({ message: NOTE_ROWS }),
    count: z
      .number({ required_error: COUNT_WHOLE, invalid_type_error: COUNT_WHOLE })
      .int({ message: COUNT_WHOLE })
      .min(0, { message: COUNT_BELOW_ZERO })
      .max(CASH_NOTE_COUNT_MAX, { message: COUNT_TOO_MANY }),
  })
  .strict(NOTE_ROWS);

/**
 * What a close may save: exactly the rows Rs 5,000, 1,000, 500, 100, 50, 20
 * and 10 in that order (CASH_NOTE_FACE_CENTS), each a whole number of notes
 * from 0 to 9,999, and 'Coins and other' in whole rupees from Rs 0 to
 * Rs 99,999. Nothing else: an extra key, row or paisa is refused.
 */
export const cashCountInputSchema = z
  .object({
    notes: z
      .array(noteCountInputSchema, { required_error: NOTE_ROWS, invalid_type_error: NOTE_ROWS })
      .superRefine((notes, ctx) => {
        const same =
          notes.length === CASH_NOTE_FACE_CENTS.length && notes.every((n, i) => n.faceCents === CASH_NOTE_FACE_CENTS[i]);
        if (!same) ctx.addIssue({ code: z.ZodIssueCode.custom, message: NOTE_ROWS });
      }),
    otherCents: z
      .number({ required_error: OTHER_WHOLE, invalid_type_error: OTHER_WHOLE })
      .int({ message: OTHER_WHOLE })
      .min(0, { message: OTHER_BELOW_ZERO })
      .max(CASH_COUNT_OTHER_MAX_CENTS, { message: OTHER_TOO_MUCH })
      .refine((c) => c % 100 === 0, { message: OTHER_WHOLE }),
  })
  .strict(NOTE_ROWS);

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
