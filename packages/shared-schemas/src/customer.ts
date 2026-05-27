import { z } from 'zod';
import { uuidSchema, pakPhoneSchema } from './common.js';

export const customerSchema = z.object({
  id: uuidSchema,
  phone: pakPhoneSchema,
  name: z.string().min(1).max(120).nullable(),
  email: z.string().email().max(200).nullable(),
  defaultAddress: z.string().max(500).nullable(),
  notes: z.string().max(500).nullable(),
  loyaltyPoints: z.number().int().min(0),
});

export const upsertCustomerInputSchema = z.object({
  phone: pakPhoneSchema,
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().max(200).optional(),
  notes: z.string().max(500).optional(),
});

export const addAddressInputSchema = z.object({
  customerId: uuidSchema,
  label: z.string().min(1).max(40),
  addressLine: z.string().min(1).max(500),
  area: z.string().max(80).optional(),
  city: z.string().max(80).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  isDefault: z.boolean().default(false),
});
