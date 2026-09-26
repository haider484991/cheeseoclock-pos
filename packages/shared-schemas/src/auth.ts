import { z } from 'zod';
import type { SecretKind } from '@cheeseoclock/shared-types';
import { uuidSchema } from './common.js';
import { SECRET_MISSING, normalizeSecret, secretProblem } from './sign-in-secret.js';

export const roleSchema = z.enum(['admin', 'manager', 'cashier']);

export const secretKindSchema = z.enum(['pin', 'password']) satisfies z.ZodType<SecretKind>;

/**
 * THE sign-in secret: a number PIN (4-12 digits) or a password (6-64
 * characters with a letter). Used by login, manager approval (approverPin),
 * users create/update and first-time setup, so every box that takes one
 * accepts and refuses the same things. The output is normalized
 * (surrounding spaces dropped, Urdu digits as 0-9): that is what gets hashed.
 * We hash with argon2id; the rules themselves are in sign-in-secret.ts.
 */
export const signInSecretSchema = z
  .string({ required_error: SECRET_MISSING, invalid_type_error: SECRET_MISSING })
  .superRefine((s, ctx) => {
    const problem = secretProblem(s);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  })
  .transform(normalizeSecret);

export const userSchema = z.object({
  id: uuidSchema,
  fullName: z.string().min(1).max(120),
  role: roleSchema,
  isActive: z.boolean(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Null: made on the other till, no PIN or password set on this one yet. */
  secretKind: secretKindSchema.nullable(),
});

export const createUserInputSchema = z.object({
  fullName: z.string().min(1).max(120),
  role: roleSchema,
  /** A PIN or a password (the name stayed `pin` so the IPC contract did not change). */
  pin: signInSecretSchema,
});

export const updateUserInputSchema = z.object({
  id: uuidSchema,
  fullName: z.string().min(1).max(120).optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
  /** A PIN or a password; replaces the hash and its kind. */
  pin: signInSecretSchema.optional(),
});

export const loginInputSchema = z.object({
  /** A PIN or a password. */
  pin: signInSecretSchema,
});

/** The owner's own login, made in first-time setup (system:completeOnboarding). */
export const onboardingAdminSchema = z.object({
  fullName: z.string().trim().min(1, 'Type your name').max(120, 'That name is too long'),
  pin: signInSecretSchema,
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
export type OnboardingAdminInput = z.infer<typeof onboardingAdminSchema>;
export type AuthenticatedUserZ = z.infer<typeof authenticatedUserSchema>;
