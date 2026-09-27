import { z } from 'zod';
import { STOCK_COUNT_SCOPES } from '@cheeseoclock/shared-types';

/**
 * Stock takes (costing spec Phase 8, migration 0038): what the count sheet
 * sends. Quantities are whole base units in the ingredient's unit (the
 * sheet turns "2.5 kg" or "3 packs + 250 g" into grams before it sends), so
 * a fraction never reaches an INTEGER column.
 */
const idSchema = z.string().min(1).max(64);

/** On the shelf: zero or more whole units, at most 100 million (a typing slip, not a count). */
export const countedQtySchema = z
  .number()
  .int({ message: 'A count is a whole number of grams, ml or pieces' })
  .min(0, { message: 'A count cannot be below zero' })
  .max(100_000_000, { message: 'That count is too large' });

const notesSchema = z
  .string()
  .max(200, { message: 'Keep the note to 200 letters' })
  .nullish()
  .transform((v) => {
    const t = (v ?? '').replace(/\s+/g, ' ').trim();
    return t === '' ? null : t;
  });

/** "Start a stock take": the whole store room, the key items, or picked ones. */
export const startStockCountInputSchema = z
  .object({
    scope: z.enum(STOCK_COUNT_SCOPES, { errorMap: () => ({ message: 'Pick what to count' }) }),
    /** 'custom' only: the ingredients to count. */
    ingredientIds: z.array(idSchema).max(2_000).optional(),
    notes: notesSchema,
  })
  .strict()
  .refine((s) => s.scope !== 'custom' || (s.ingredientIds?.length ?? 0) > 0, {
    message: 'Pick at least one ingredient to count',
    path: ['ingredientIds'],
  });

/** Counts typed on the sheet so far (a shelf at a time). null clears a line. */
export const saveStockCountLinesInputSchema = z
  .object({
    countId: idSchema,
    lines: z
      .array(z.object({ ingredientId: idSchema, countedQty: countedQtySchema.nullable() }).strict())
      .min(1, { message: 'Nothing to save' })
      .max(2_000),
  })
  .strict();

/** Finish or cancel a stock take; read one. */
export const stockCountIdInputSchema = z.object({ countId: idSchema }).strict();

/** The list of stock takes, newest first. */
export const listStockCountsInputSchema = z
  .object({ limit: z.number().int().min(1).max(500).optional() })
  .strict();

/** The Stock button's "Stock take": one ingredient, counted and finished at once. */
export const countOneInputSchema = z
  .object({ ingredientId: idSchema, countedQty: countedQtySchema, notes: notesSchema })
  .strict();

/** reports:variance: the two stock takes (omitted: the latest finished, and the one before it). */
export const varianceInputSchema = z
  .object({ fromCountId: idSchema.nullish(), toCountId: idSchema.nullish() })
  .strict();
