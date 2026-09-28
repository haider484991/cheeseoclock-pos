import { z } from 'zod';
import { publishedSettingsSchema } from '@cheeseoclock/shared-schemas/web-settings';

/**
 * The shapes a till sends to the bridge (PUT /api/bridge/menu, PUT
 * /api/bridge/settings): one definition for both routes, so an item the
 * block alone carries is checked exactly as one inside a menu publish.
 */
export const ModifierSchema = z.object({
  posModifierId: z.string(),
  name: z.string(),
  priceDeltaCents: z.number().int(),
  isDefault: z.boolean(),
  sortOrder: z.number(),
});
export const GroupSchema = z.object({
  posGroupId: z.string(),
  name: z.string(),
  selectionType: z.enum(['single', 'multi']),
  minSelect: z.number().int().min(0),
  maxSelect: z.number().int().min(0),
  isRequired: z.boolean(),
  sortOrder: z.number(),
  modifiers: z.array(ModifierSchema),
});
export const ItemSchema = z.object({
  posItemId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  basePriceCents: z.number().int().min(0),
  taxRateBps: z.number().int().min(0),
  imageUrl: z.string().nullable(),
  sortOrder: z.number(),
  modifierGroups: z.array(GroupSchema),
  /**
   * Set "Pick-up only" on the till (v0.7.30, shared-types web-bridge.ts:
   * SELLING ON THE WEBSITE): sent only as true, absent on every other item —
   * so a menu without it is stored exactly as before. Without this line the
   * flag would be stripped here and a delivery with the item let through.
   */
  pickupOnly: z.boolean().optional(),
});
export const MenuSchema = z.object({
  categories: z.array(
    z.object({
      posCategoryId: z.string(),
      name: z.string(),
      displayOrder: z.number(),
      items: z.array(ItemSchema),
    }),
  ),
  publishedAt: z.string(),
  store: z.object({
    name: z.string(),
    phone: z.string().nullable(),
    whatsapp: z.string().nullable(),
    addressLine: z.string().nullable(),
    tagline: z.string().nullable(),
  }),
  /**
   * The owner's settings (Settings step 3): delivery areas and fees, the
   * pick-up offer. Absent from a till older than the block. Checked with the
   * menu: a malformed block fails the whole publish ('validation').
   */
  settings: publishedSettingsSchema.optional(),
});

/** PUT /api/bridge/settings: the block alone, with its areas' fee items (shared-types THE BLOCK ALONE). */
export const SettingsAloneSchema = z.object({
  settings: publishedSettingsSchema,
  feeItems: z
    .array(
      z.object({
        category: z.object({ posCategoryId: z.string(), name: z.string(), displayOrder: z.number() }),
        item: ItemSchema,
      }),
    )
    .max(200),
});
