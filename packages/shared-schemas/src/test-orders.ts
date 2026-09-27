import { z } from 'zod';
import { uuidSchema } from './common.js';
import { liveOrderStatusSchema } from './order.js';

/**
 * Deleting a test order (the owner only; migration 0043): what the dialog
 * sends. The main process checks it again, in the same words, before
 * anything is written (order-repo checkTestDelete).
 */

/** Longest "why this was a test" kept. */
export const TEST_DELETE_REASON_MAX = 200;

/** The owner's PIN or password, typed again in the dialog (checked as a secret, never stored). */
const ownerSecretSchema = z.string().min(1, { message: "Type the owner's PIN or password" }).max(128);

export const deleteTestOrderInputSchema = z
  .object({
    orderId: uuidSchema,
    /** Why it was a test ("Printer test", "Staff training", …). */
    reason: z
      .string()
      .transform((v) => v.replace(/\s+/g, ' ').trim())
      .pipe(
        z
          .string()
          .min(1, { message: 'Write why this was a test order.' })
          .max(TEST_DELETE_REASON_MAX, { message: `Keep the reason to ${TEST_DELETE_REASON_MAX} letters.` }),
      ),
    /**
     * "Put the stock back?": true — yes (the food was not made); false — no,
     * count it as waste (the food was made); null — the order holds no stock
     * (then no answer is needed; one given is ignored).
     */
    restock: z.boolean().nullable(),
    ownerSecret: ownerSecretSchema,
    /** The status the dialog showed: refused when the order moved on since. */
    expectStatus: liveOrderStatusSchema,
  })
  .strict();

/** The dialog's read: what deleting this order would do (no secret, nothing written). */
export const testDeletePreviewInputSchema = z.object({ orderId: uuidSchema }).strict();

/** The owner's list of deleted test orders, by when the order was taken. */
export const listDeletedTestsInputSchema = z
  .object({
    sinceIso: z.string().datetime({ offset: true }),
    untilIso: z.string().datetime({ offset: true }),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict()
  .refine((v) => v.untilIso > v.sinceIso, { message: 'The end must be after the start' });

export type DeleteTestOrderInput = z.infer<typeof deleteTestOrderInputSchema>;
export type ListDeletedTestsInput = z.infer<typeof listDeletedTestsInputSchema>;
