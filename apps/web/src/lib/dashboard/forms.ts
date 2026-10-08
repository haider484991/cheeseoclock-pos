import { z } from 'zod';
import { DASH_PASSWORD_MAX, DASH_PASSWORD_MIN, normalizeDashUsername } from '@cheeseoclock/shared-types';

/**
 * What the dashboard's own pages post (never a till): sign in, first-time
 * setup with the till's code, a new password. Strict — an unknown field is
 * refused — and every string has a ceiling.
 */

const username = z.string().max(40).transform(normalizeDashUsername).pipe(z.string().min(1));

/** A password the person picks: 8–200 characters, not the username, not one character repeated. */
export function passwordProblem(password: string, username: string): string | null {
  if (password.length < DASH_PASSWORD_MIN) return `Use at least ${DASH_PASSWORD_MIN} characters.`;
  if (password.length > DASH_PASSWORD_MAX) return `Use at most ${DASH_PASSWORD_MAX} characters.`;
  if (password.trim().toLowerCase() === username.trim().toLowerCase()) return 'Pick a password that is not your username.';
  if (new Set(password).size === 1) return 'Pick a password that is not one character over and over.';
  return null;
}

export const signInBodySchema = z
  .object({ username, password: z.string().min(1).max(DASH_PASSWORD_MAX) })
  .strict();

export const setupBodySchema = z
  .object({ username, code: z.string().min(1).max(40), password: z.string().min(1).max(DASH_PASSWORD_MAX) })
  .strict();

export const passwordBodySchema = z
  .object({ current: z.string().min(1).max(DASH_PASSWORD_MAX), next: z.string().min(1).max(DASH_PASSWORD_MAX) })
  .strict();

export const signOutBodySchema = z.object({ everywhere: z.boolean().optional() }).strict();
