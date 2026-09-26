import type { SecretKind } from '@cheeseoclock/shared-types';

/**
 * The one set of rules for what a person types to sign in or to approve
 * something as a manager: a number PIN or a password.
 *
 *   - PIN: 4 to 12 digits (the keypad). 5 digits works, as it always did.
 *   - Password: 6 to 64 characters with at least one letter. English letters,
 *     numbers, spaces and the usual symbols; capital and small letters count.
 *
 * Digits only is always a PIN and a password always has a letter, so what was
 * typed says which kind it is: the till never has to ask. Surrounding spaces
 * are dropped, and Urdu or Arabic digits (a keyboard left on the Urdu layout)
 * count as 0-9, before anything is checked or hashed.
 *
 * No zod here, so the till's screens can check a PIN box as the person types
 * without bundling it (package subpath `@cheeseoclock/shared-schemas/sign-in-secret`).
 * The zod schema built on these rules is `signInSecretSchema` (auth.ts).
 *
 * Messages are plain words for the counter and never repeat what was typed.
 */

export const PIN_MIN_DIGITS = 4;
export const PIN_MAX_DIGITS = 12;
export const PASSWORD_MIN_CHARS = 6;
export const PASSWORD_MAX_CHARS = 64;
/** Anything longer is refused before it is looked at (a pasted page, a stuck key). */
export const SECRET_MAX_INPUT = 256;

export const SECRET_MISSING = 'Type a PIN or password';

const DIGITS = /^[0-9]+$/;
const DIGITS_AND_SPACES = /^[0-9 ]+$/;
/** Printable ASCII: English letters, digits, space and the keyboard's symbols. */
const PRINTABLE = /^[\x20-\x7E]+$/;
const LETTER = /[A-Za-z]/;
/** Arabic-Indic (U+0660-0669) and Extended Arabic-Indic / Urdu (U+06F0-06F9) digits. */
const EASTERN_DIGITS = /[٠-٩۰-۹]/g;

/** ۱۲۳ / ١٢٣ → 123. Every other character is left as it is. */
export function toAsciiDigits(s: string): string {
  return s.replace(EASTERN_DIGITS, (d) => String(d.charCodeAt(0) & 0x0f));
}

/**
 * What is checked, hashed and compared: Urdu/Arabic digits as 0-9, surrounding
 * spaces dropped. Internal spaces and letter case are kept.
 */
export function normalizeSecret(raw: string): string {
  return toAsciiDigits(raw).trim();
}

/** Digits only = a number PIN; anything else = a password. */
export function secretKindOf(secret: string): SecretKind {
  return DIGITS.test(normalizeSecret(secret)) ? 'pin' : 'password';
}

/** True when the text holds characters an English keyboard doesn't type (Urdu letters, "ä"). */
export function hasNonEnglishChars(s: string): boolean {
  return /[^\x20-\x7E]/.test(toAsciiDigits(s).trim());
}

/** Why this can't be anyone's PIN or password, in plain words — or null when it can. */
export function secretProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return SECRET_MISSING;
  if (raw.length > SECRET_MAX_INPUT) return `A password is at most ${PASSWORD_MAX_CHARS} characters`;
  const s = normalizeSecret(raw);
  if (s === '') return SECRET_MISSING;
  if (DIGITS.test(s)) {
    return s.length < PIN_MIN_DIGITS || s.length > PIN_MAX_DIGITS
      ? `A PIN is ${PIN_MIN_DIGITS} to ${PIN_MAX_DIGITS} numbers`
      : null;
  }
  if (DIGITS_AND_SPACES.test(s)) return 'A PIN is numbers only, with no spaces';
  if (!PRINTABLE.test(s)) return 'Use English letters, numbers and symbols only';
  if (!LETTER.test(s)) return 'A password needs at least one letter';
  if (s.length < PASSWORD_MIN_CHARS) return `A password is at least ${PASSWORD_MIN_CHARS} characters`;
  if (s.length > PASSWORD_MAX_CHARS) return `A password is at most ${PASSWORD_MAX_CHARS} characters`;
  return null;
}

/**
 * The same rules when the owner has picked the kind on purpose (Users page,
 * first-time setup): digits in a password box, or a letter in a PIN box, get
 * a message about the choice they made.
 */
export function secretProblemFor(kind: SecretKind, raw: string): string | null {
  const s = normalizeSecret(raw);
  if (kind === 'pin' && s !== '' && !DIGITS.test(s)) return 'A PIN is numbers only';
  if (kind === 'password' && s !== '' && DIGITS.test(s)) {
    return 'A password needs at least one letter (or choose Number PIN)';
  }
  return secretProblem(raw);
}
