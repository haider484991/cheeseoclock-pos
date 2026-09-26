/**
 * The one set of rules for a sign-in secret — a number PIN (4-12 digits) or
 * a password (6-64 characters with a letter) — and every entry point that
 * uses it: login, manager approval (discount / cancel), users create and
 * update, and first-time setup. They must accept and refuse the same things.
 */
import { describe, expect, it } from 'vitest';
import {
  applyDiscountInputSchema,
  createUserInputSchema,
  loginInputSchema,
  onboardingAdminSchema,
  secretKindOf,
  secretProblem,
  secretProblemFor,
  signInSecretSchema,
  updateUserInputSchema,
  voidOrderInputSchema,
} from '@cheeseoclock/shared-schemas';

const ORDER = '0192f1a0-0000-7000-8000-000000000001';
const USER = '0192f1a0-0000-7000-8000-000000000002';

describe('sign-in secret: accepted', () => {
  it.each([
    ['1234', 'pin', '1234'],
    ['12345', 'pin', '12345'], // five digits keep working
    ['12345678', 'pin', '12345678'],
    ['123456789012', 'pin', '123456789012'],
    [' 4321 ', 'pin', '4321'],
    ['123456', 'pin', '123456'], // digits only is a PIN, never a password
    ['۱۲۳۴', 'pin', '1234'], // Urdu keyboard digits
    ['١٢٣٤٥', 'pin', '12345'], // Arabic-Indic digits
    ['pizza1', 'password', 'pizza1'],
    ['Cheese O Clock', 'password', 'Cheese O Clock'],
    ['P@ss w0rd!', 'password', 'P@ss w0rd!'],
    ['ABCDEF', 'password', 'ABCDEF'],
    ['  secret99  ', 'password', 'secret99'],
    ['2024pizza', 'password', '2024pizza'],
    ['a'.repeat(64), 'password', 'a'.repeat(64)],
  ])('%j is a %s', (typed, kind, stored) => {
    expect(secretProblem(typed)).toBeNull();
    expect(secretKindOf(typed)).toBe(kind);
    expect(signInSecretSchema.parse(typed)).toBe(stored);
  });

  it('keeps capital and small letters apart', () => {
    expect(signInSecretSchema.parse('Pizza1')).not.toBe(signInSecretSchema.parse('pizza1'));
  });
});

describe('sign-in secret: refused, in plain words', () => {
  it.each([
    ['', 'Type a PIN or password'],
    ['   ', 'Type a PIN or password'],
    [123, 'Type a PIN or password'],
    [undefined, 'Type a PIN or password'],
    [null, 'Type a PIN or password'],
    ['123', 'A PIN is 4 to 12 numbers'],
    ['1234567890123', 'A PIN is 4 to 12 numbers'],
    ['12 34', 'A PIN is numbers only, with no spaces'],
    ['abc12', 'A password is at least 6 characters'],
    ['!@#$%^&', 'A password needs at least one letter'],
    ['12-34-56', 'A password needs at least one letter'],
    ['a'.repeat(65), 'A password is at most 64 characters'],
    ['a'.repeat(300), 'A password is at most 64 characters'],
    ['pässwort', 'Use English letters, numbers and symbols only'],
    ['پاسورڈ123', 'Use English letters, numbers and symbols only'],
    ['abc\tdef', 'Use English letters, numbers and symbols only'],
  ])('%j → %s', (typed, message) => {
    expect(secretProblem(typed)).toBe(message);
    const parsed = signInSecretSchema.safeParse(typed);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toBe(message);
  });

  it('never repeats what was typed', () => {
    for (const typed of ['123', 'abc12', 'pässwort', 'zz!!', '1234567890123', 'a'.repeat(65)]) {
      const message = secretProblem(typed) ?? '';
      expect(message).not.toContain(typed);
    }
  });
});

describe('sign-in secret: when the kind was chosen on purpose', () => {
  it('says a PIN is numbers only, and a password needs a letter', () => {
    expect(secretProblemFor('password', '123456')).toBe('A password needs at least one letter (or choose Number PIN)');
    expect(secretProblemFor('pin', '12ab')).toBe('A PIN is numbers only');
    expect(secretProblemFor('pin', '12345')).toBeNull();
    expect(secretProblemFor('password', 'pizza1')).toBeNull();
    expect(secretProblemFor('password', 'abc')).toBe('A password is at least 6 characters');
  });
});

describe('every entry point takes the same secrets', () => {
  const entryPoints = [
    ['login', (pin: unknown) => loginInputSchema.safeParse({ pin })],
    ['users create', (pin: unknown) => createUserInputSchema.safeParse({ fullName: 'Ali', role: 'cashier', pin })],
    ['users update', (pin: unknown) => updateUserInputSchema.safeParse({ id: USER, pin })],
    ['first-time setup', (pin: unknown) => onboardingAdminSchema.safeParse({ fullName: 'Owner', pin })],
    [
      'discount approval',
      (approverPin: unknown) =>
        applyDiscountInputSchema.safeParse({ orderId: ORDER, discountType: 'percent', value: 20, approverPin }),
    ],
    [
      'cancel approval',
      (approverPin: unknown) => voidOrderInputSchema.safeParse({ orderId: ORDER, reason: 'Wrong order', approverPin }),
    ],
  ] as const;

  it.each(entryPoints)('%s accepts a 5-digit PIN and a password, trimmed', (_name, parse) => {
    for (const [typed, stored] of [
      ['12345', '12345'],
      [' Manager pass 1 ', 'Manager pass 1'],
    ] as const) {
      const r = parse(typed);
      expect(r.success).toBe(true);
      const data = r.success ? (r.data as { pin?: string; approverPin?: string }) : {};
      expect(data.pin ?? data.approverPin).toBe(stored);
    }
  });

  it.each(entryPoints)('%s refuses what the rules refuse', (_name, parse) => {
    for (const bad of ['123', '12 34', 'abc12', '!@#$%^&', 'a'.repeat(65), 'pässwort']) {
      expect(parse(bad).success).toBe(false);
    }
  });

  it('first-time setup also needs a name', () => {
    const r = onboardingAdminSchema.safeParse({ fullName: '  ', pin: '12345' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('Type your name');
  });
});
