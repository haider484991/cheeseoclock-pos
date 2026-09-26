import { describe, expect, it } from 'vitest';
import { keypadDigits, signInKey, signInProblemTitle, type SignInMode } from './signInKeys';

const k = (key: string, code?: string, mods: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) => ({
  key,
  ...(code ? { code } : {}),
  ...mods,
});

const NUMPAD_SYMBOL: Record<string, string> = {
  '+': 'NumpadAdd',
  '.': 'NumpadDecimal',
  '-': 'NumpadSubtract',
  '/': 'NumpadDivide',
  '*': 'NumpadMultiply',
};

/** Keys as a physical keyboard sends them: digits and + - * / . from the numeric keypad, letters from the main one. */
function numpadKeys(text: string): Array<[string, string]> {
  return [...text].map((c) => {
    if (c >= '0' && c <= '9') return [c, `Numpad${c}`];
    if (NUMPAD_SYMBOL[c]) return [c, NUMPAD_SYMBOL[c]!];
    if (c === ' ') return [c, 'Space'];
    return [c, `Key${c.toUpperCase()}`];
  });
}

/**
 * The sign-in screen as LoginPage drives it: keys go through signInKey until
 * it switches to the password box, which then has focus and types for itself.
 * `sent` is what Enter would sign in with.
 */
function typeOnSignIn(keys: Array<[string, string]>) {
  let mode: SignInMode = 'pin';
  let value = '';
  let sent: string | null = null;
  for (const [key, code] of keys) {
    if (mode === 'password') {
      if (key === 'Enter') sent = value;
      else value = key === 'Backspace' ? value.slice(0, -1) : value + key;
      continue;
    }
    const a = signInKey(mode, value, k(key, code));
    if (a.type === 'set') value = a.value;
    else if (a.type === 'switch') {
      mode = 'password';
      value = a.value;
    } else if (a.type === 'submit') sent = keypadDigits(value);
  }
  return { mode, shown: mode === 'pin' ? keypadDigits(value) : value, sent };
}

const ENTER: [string, string] = ['Enter', 'NumpadEnter'];

describe('sign-in keys on the keypad screen', () => {
  it('adds digits up to 12; a 13th can only be a password, so it goes to the password box', () => {
    let v = '';
    for (const d of '123456789012') {
      const a = signInKey('pin', v, k(d, `Digit${d}`));
      expect(a.type).toBe('set');
      if (a.type === 'set') v = a.value;
    }
    expect(v).toBe('123456789012');
    expect(signInKey('pin', v, k('3', 'Digit3'))).toEqual({ type: 'switch', value: '1234567890123' });
    // The owner's password: a 13-digit CNIC and a letter, typed straight in.
    expect(typeOnSignIn([...numpadKeys('4210112345671a'), ENTER])).toEqual({
      mode: 'password',
      shown: '4210112345671a',
      sent: '4210112345671a',
    });
  });

  it('five digits work, as they always did', () => {
    expect(signInKey('pin', '1234', k('5', 'Digit5'))).toEqual({ type: 'set', value: '12345' });
    expect(signInKey('pin', '12345', k('Enter', 'Enter'))).toEqual({ type: 'submit' });
  });

  it('takes digits from the numeric keypad and the Urdu layout', () => {
    expect(signInKey('pin', '12', k('3', 'Numpad3'))).toEqual({ type: 'set', value: '123' });
    expect(signInKey('pin', '12', k('۳', 'Digit3'))).toEqual({ type: 'set', value: '123' });
    expect(signInKey('pin', '12', k('٣'))).toEqual({ type: 'set', value: '123' });
  });

  it('Backspace deletes one, Escape clears, Enter (either one) signs in', () => {
    expect(signInKey('pin', '123', k('Backspace'))).toEqual({ type: 'set', value: '12' });
    expect(signInKey('pin', '', k('Backspace'))).toEqual({ type: 'set', value: '' });
    expect(signInKey('pin', '123', k('Escape'))).toEqual({ type: 'set', value: '' });
    expect(signInKey('pin', '1234', k('Enter', 'NumpadEnter'))).toEqual({ type: 'submit' });
  });

  it('a letter switches to the password box, keeping what was typed', () => {
    expect(signInKey('pin', '2024', k('a', 'KeyA'))).toEqual({ type: 'switch', value: '2024a' });
    expect(signInKey('pin', '', k('P', 'KeyP'))).toEqual({ type: 'switch', value: 'P' });
    expect(signInKey('pin', '12', k('!', 'Digit1'))).toEqual({ type: 'switch', value: '12!' });
    expect(signInKey('pin', '12', k('-', 'Minus'))).toEqual({ type: 'switch', value: '12-' });
  });

  it.each(Object.entries(NUMPAD_SYMBOL))(
    'the numeric keypad %s (%s) stays on the keypad, held out of sight',
    (key, code) => {
      const a = signInKey('pin', '1234', k(key, code));
      expect(a).toEqual({ type: 'set', value: `1234${key}` });
      if (a.type === 'set') expect(keypadDigits(a.value)).toBe('1234');
    },
  );

  it('a numeric-keypad slip next to Enter or 0 does not change the PIN', () => {
    expect(typeOnSignIn([...numpadKeys('1234+'), ENTER])).toEqual({ mode: 'pin', shown: '1234', sent: '1234' });
    expect(typeOnSignIn([...numpadKeys('12+34'), ENTER])).toEqual({ mode: 'pin', shown: '1234', sent: '1234' });
    expect(typeOnSignIn([...numpadKeys('24680.'), ENTER])).toEqual({ mode: 'pin', shown: '24680', sent: '24680' });
  });

  it('numeric-keypad symbols before the first letter stay in a password', () => {
    expect(typeOnSignIn([...numpadKeys('1.5pizza'), ENTER]).sent).toBe('1.5pizza');
    expect(typeOnSignIn([...numpadKeys('12/05/1990ali'), ENTER]).sent).toBe('12/05/1990ali');
    expect(typeOnSignIn([...numpadKeys('12-05 x'), ENTER]).sent).toBe('12-05 x');
  });

  it('Backspace deletes the last digit shown, with any held symbol after it', () => {
    expect(signInKey('pin', '12+', k('Backspace'))).toEqual({ type: 'set', value: '1' });
    expect(signInKey('pin', '12+3', k('Backspace'))).toEqual({ type: 'set', value: '12+' });
    expect(signInKey('pin', '+', k('Backspace'))).toEqual({ type: 'set', value: '' });
  });

  it('a held-down keypad symbol cannot grow past the longest password', () => {
    const full = '1234' + '+'.repeat(60);
    expect(signInKey('pin', full, k('+', 'NumpadAdd'))).toEqual({ type: 'block' });
  });

  it('Space never presses the focused keypad button again', () => {
    expect(signInKey('pin', '', k(' ', 'Space'))).toEqual({ type: 'block' });
    expect(signInKey('pin', '+', k(' ', 'Space'))).toEqual({ type: 'block' });
    // After digits it can only be a password ("12 pizza"); a trailing one is trimmed.
    expect(signInKey('pin', '12', k(' ', 'Space'))).toEqual({ type: 'switch', value: '12 ' });
  });

  it('leaves shortcuts, Tab and function keys alone', () => {
    expect(signInKey('pin', '12', k('a', 'KeyA', { ctrlKey: true }))).toEqual({ type: 'ignore' });
    expect(signInKey('pin', '12', k('v', 'KeyV', { metaKey: true }))).toEqual({ type: 'ignore' });
    expect(signInKey('pin', '12', k('1', 'Digit1', { altKey: true }))).toEqual({ type: 'ignore' });
    expect(signInKey('pin', '12', k('Tab', 'Tab'))).toEqual({ type: 'ignore' });
    expect(signInKey('pin', '12', k('F5', 'F5'))).toEqual({ type: 'ignore' });
    expect(signInKey('pin', '12', k('Shift', 'ShiftLeft'))).toEqual({ type: 'ignore' });
  });
});

describe('sign-in keys on the password screen (box not focused)', () => {
  it('puts a character back into the box', () => {
    expect(signInKey('password', 'piz', k('z', 'KeyZ'))).toEqual({ type: 'focus', value: 'pizz' });
    expect(signInKey('password', 'piz', k('1', 'Numpad1'))).toEqual({ type: 'focus', value: 'piz1' });
    expect(signInKey('password', 'piz', k(' ', 'Space'))).toEqual({ type: 'focus', value: 'piz ' });
    expect(signInKey('password', 'piz', k('Backspace'))).toEqual({ type: 'focus', value: 'pi' });
  });

  it('Enter signs in; other keys are left alone', () => {
    expect(signInKey('password', 'pizza1', k('Enter'))).toEqual({ type: 'submit' });
    expect(signInKey('password', 'pizza1', k('Escape'))).toEqual({ type: 'ignore' });
    expect(signInKey('password', 'pizza1', k('c', 'KeyC', { ctrlKey: true }))).toEqual({ type: 'ignore' });
  });
});

describe('the title over a "check what you typed" warning', () => {
  it('Enter with nothing typed asks for what the screen asks for — never "password" on the keypad', () => {
    expect(signInProblemTitle('pin', '')).toBe('Enter your PIN');
    expect(signInProblemTitle('password', '   ')).toBe('Type your password');
  });

  it('names a PIN for digits and a password otherwise', () => {
    expect(signInProblemTitle('pin', '12')).toBe('Check your PIN');
    expect(signInProblemTitle('password', '12')).toBe('Check your PIN');
    expect(signInProblemTitle('password', 'abc')).toBe('Check your password');
  });
});
