import {
  PASSWORD_MAX_CHARS,
  PIN_MAX_DIGITS,
  normalizeSecret,
  secretKindOf,
  toAsciiDigits,
} from '@cheeseoclock/shared-schemas/sign-in-secret';

/**
 * What a physical key press does on the sign-in screen when no text box has
 * focus (the keypad screen, or the password screen with the box left).
 * Pure, so the rules are tested without a screen.
 *
 * Keypad ("pin") mode:
 *   - a digit adds to the PIN (the number row, the numeric keypad, and the
 *     Urdu layout's digits), up to 12. A 13th can't be a PIN, so it goes to
 *     the password box with the rest ("4210112345671a" typed straight in);
 *   - Backspace deletes one, Escape clears, Enter signs in;
 *   - a letter or symbol from the main keyboard means a password is being
 *     typed: switch to the password box, carrying what was typed so far
 *     ("2024pizza" typed straight in just works);
 *   - the numeric keypad's + - * / . sit right next to Enter and 0, so they
 *     never throw a cashier out of the keypad: they are kept out of sight
 *     (the keypad shows digits only) and dropped if Enter follows, so a slip
 *     does not change the PIN. If a password follows ("12/05/1990ali",
 *     "1.5pizza" on the numeric keypad) they go to the password box with the
 *     rest, where they belong — dropping them changed the password;
 *   - Space is swallowed while nothing is typed (it would press the keypad
 *     button that has focus again); after digits it goes to the password box
 *     with them — a PIN never has a space, a password may.
 * Password mode (the box lost focus): a character goes back into the box.
 *
 * In keypad mode `value` is everything keyed: digits plus any held keypad
 * symbols. keypadDigits() is what the keypad shows and a PIN sign-in sends.
 *
 * 'ignore' leaves the key alone entirely (Tab, F-keys, shortcuts); 'block'
 * only stops the browser's default for it.
 */
export type SignInKeyAction =
  | { type: 'ignore' }
  | { type: 'block' }
  | { type: 'set'; value: string }
  | { type: 'submit' }
  | { type: 'switch'; value: string }
  | { type: 'focus'; value: string };

export type SignInMode = 'pin' | 'password';

export interface SignInKey {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

/** The digits of what was keyed on the keypad screen: what it shows, and what a PIN sign-in sends. */
export function keypadDigits(value: string): string {
  return value.replace(/[^0-9]/g, '');
}

export function signInKey(mode: SignInMode, value: string, e: SignInKey): SignInKeyAction {
  if (e.ctrlKey || e.altKey || e.metaKey) return { type: 'ignore' };
  if (e.key === 'Enter') return { type: 'submit' };
  const printable = e.key.length === 1;

  if (mode === 'password') {
    if (e.key === 'Backspace') return { type: 'focus', value: value.slice(0, -1) };
    return printable ? { type: 'focus', value: value + e.key } : { type: 'ignore' };
  }

  // Deletes the last digit shown, and any held keypad symbol after it.
  if (e.key === 'Backspace') return { type: 'set', value: value.replace(/[^0-9]*$/, '').slice(0, -1) };
  if (e.key === 'Escape') return { type: 'set', value: '' };
  if (!printable) return { type: 'ignore' };

  const digit = toAsciiDigits(e.key);
  if (digit >= '0' && digit <= '9') {
    return keypadDigits(value).length < PIN_MAX_DIGITS
      ? { type: 'set', value: value + digit }
      : { type: 'switch', value: value + digit };
  }
  // + - * / . on the numeric keypad (NumLock off gives no printable key at all).
  if (e.code?.startsWith('Numpad')) {
    return value.length < PASSWORD_MAX_CHARS ? { type: 'set', value: value + e.key } : { type: 'block' };
  }
  if (e.key === ' ') {
    return keypadDigits(value) === '' ? { type: 'block' } : { type: 'switch', value: value + ' ' };
  }
  return { type: 'switch', value: value + e.key };
}

/**
 * The title over "that can't be a PIN or password" on the sign-in screen.
 * Nothing typed is not a password problem: it gets the screen's own words.
 */
export function signInProblemTitle(mode: SignInMode, typed: string): string {
  if (normalizeSecret(typed) === '') return mode === 'pin' ? 'Enter your PIN' : 'Type your password';
  return mode === 'pin' || secretKindOf(typed) === 'pin' ? 'Check your PIN' : 'Check your password';
}
