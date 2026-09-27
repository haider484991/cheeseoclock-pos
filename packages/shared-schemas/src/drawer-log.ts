import { z } from 'zod';

/**
 * reports:drawerLog — the cash drawer log's page request (Reports → Team &
 * leakage, and one shift's list). The period is ISO instants; a page is at
 * most 200 rows; the cursor is the previous page's nextCursor.
 */
export const drawerLogGroupSchema = z.enum(['all', 'sales', 'cash', 'nosale', 'problems']);

export const drawerLogInputSchema = z
  .object({
    sinceIso: z.string().datetime({ offset: true }),
    untilIso: z.string().datetime({ offset: true }),
    shiftId: z.string().min(1).max(64).optional(),
    group: drawerLogGroupSchema.optional(),
    cursor: z.string().min(3).max(200).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => Date.parse(v.untilIso) > Date.parse(v.sinceIso), { message: 'The end must be after the start' });

export type DrawerLogInput = z.infer<typeof drawerLogInputSchema>;
