import type { SecretKind } from '@cheeseoclock/shared-types';
import {
  PIN_MAX_DIGITS,
  normalizeSecret,
  secretProblem,
  secretProblemFor,
  toAsciiDigits,
} from '@cheeseoclock/shared-schemas/sign-in-secret';

/**
 * Screen-side helpers for PIN and password boxes. The rules themselves are
 * the till's own (shared-schemas sign-in-secret.ts): what a box accepts here
 * is exactly what the till will accept when it is sent.
 */

/** Could this be someone's PIN or password? (Manager boxes, the sign-in screen.) */
export function secretReady(value: string): boolean {
  return secretProblem(value) === null;
}

/**
 * What a manager-approval box says when its button is pressed too early:
 * the broken rule when something was typed, else that one is needed.
 */
export function approvalProblem(value: string): string | null {
  if (value.trim() === '') return "A manager's PIN or password is needed";
  return secretProblem(value);
}

/** A number-PIN box as the person types: digits only (Urdu digits count), at most 12. */
export function pinBoxValue(typed: string): string {
  return toAsciiDigits(typed).replace(/[^0-9]/g, '').slice(0, PIN_MAX_DIGITS);
}

/** A new PIN or password and its "type it again" are good to save. */
export function secretFieldsReady(kind: SecretKind, secret: string, confirm: string): boolean {
  return secretProblemFor(kind, secret) === null && normalizeSecret(secret) === normalizeSecret(confirm);
}

/** Both boxes filled in and not the same (after dropping surrounding spaces). */
export function secretsDiffer(secret: string, confirm: string): boolean {
  return secret.trim() !== '' && confirm.trim() !== '' && normalizeSecret(secret) !== normalizeSecret(confirm);
}
