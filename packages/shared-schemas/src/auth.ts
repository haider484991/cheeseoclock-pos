import { z } from 'zod';
import { uuidSchema } from './common.js';

export const roleSchema = z.enum(['admin', 'manager', 'cashier']);

/** PIN: 4-8 digits. We hash with argon2id; only digits to keep numpad UX clean. */
export const pinSchema = z
  .string()
  .regex(/^\d{4,8}$/, 'PIN must be 4-8 digits');

export const userSchema = z.object({
  id: uuidSchema,
  fullName: z.string().min(1).max(120),
  role: roleSchema,
  isActive: z.boolean(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const createUserInputSchema = z.object({
  fullName: z.string().min(1).max(120),
  role: roleSchema,
  pin: pinSchema,
});

export const updateUserInputSchema = z.object({
  id: uuidSchema,
  fullName: z.string().min(1).max(120).optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
  /** Setting pin replaces the existing hash. */
  pin: pinSchema.optional(),
});

export const loginInputSchema = z.object({
  pin: pinSchema,
});

export const authenticatedUserSchema = z.object({
  id: uuidSchema,
  fullName: z.string(),
  role: roleSchema,
  sessionId: uuidSchema,
});

export type RoleZ = z.infer<typeof roleSchema>;
export type UserZ = z.infer<typeof userSchema>;
export type CreateUserInput = z.infer<typeof createUserInputSchema>;
export type UpdateUserInput = z.infer<typeof updateUserInputSchema>;
export type LoginInput = z.infer<typeof loginInputSchema>;
export type AuthenticatedUserZ = z.infer<typeof authenticatedUserSchema>;
