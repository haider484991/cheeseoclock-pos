import { z } from 'zod';
import { uuidSchema, centsSchema, signedCentsSchema, bpsSchema } from './common.js';

export const prepStationSchema = z.enum(['kitchen', 'bar', 'cold']);
export const modifierSelectionTypeSchema = z.enum(['single', 'multi']);
export const comboSelectionTypeSchema = z.enum(['fixed', 'choice']);

export const categorySchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(80),
  displayOrder: z.number().int(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Invalid hex color'),
  isActive: z.boolean(),
});

export const menuItemSchema = z.object({
  id: uuidSchema,
  categoryId: uuidSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),
  basePriceCents: centsSchema,
  sku: z.string().max(40).nullable(),
  barcode: z.string().max(40).nullable(),
  imageUrl: z.string().max(500).nullable(),
  isActive: z.boolean(),
  prepStation: prepStationSchema,
  taxCategoryId: uuidSchema,
  sortOrder: z.number().int(),
  currentStock: z.number().int().nullable(),
  lowStockThreshold: z.number().int().nullable(),
});

export const taxCategorySchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(80),
  rateBps: bpsSchema,
});

export const modifierGroupSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(80),
  selectionType: modifierSelectionTypeSchema,
  minSelect: z.number().int().min(0),
  maxSelect: z.number().int().min(0),
  isRequired: z.boolean(),
});

export const modifierSchema = z.object({
  id: uuidSchema,
  modifierGroupId: uuidSchema,
  name: z.string().min(1).max(80),
  priceDeltaCents: signedCentsSchema,
  isDefault: z.boolean(),
  sortOrder: z.number().int(),
});

export const comboSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),
  priceCents: centsSchema,
  isActive: z.boolean(),
});
