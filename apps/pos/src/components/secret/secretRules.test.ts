import { describe, expect, it } from 'vitest';
import { approvalProblem, pinBoxValue, secretFieldsReady, secretReady, secretsDiffer } from './secretRules';

describe('PIN and password boxes on the screen', () => {
  it('a manager box takes a PIN or a password, the same as the till', () => {
    expect(secretReady('1234')).toBe(true);
    expect(secretReady('12345')).toBe(true);
    expect(secretReady('Manager 1')).toBe(true);
    expect(secretReady('123')).toBe(false);
    expect(secretReady('abc12')).toBe(false);
  });

  it("says why a manager box isn't ready", () => {
    expect(approvalProblem('')).toBe("A manager's PIN or password is needed");
    expect(approvalProblem('   ')).toBe("A manager's PIN or password is needed");
    expect(approvalProblem('12')).toBe('A PIN is 4 to 12 numbers');
    expect(approvalProblem('!@#$%^&')).toBe('A password needs at least one letter');
    expect(approvalProblem('12 34')).toBe('A PIN is numbers only, with no spaces');
    expect(approvalProblem('pizza1')).toBeNull();
  });

  it('a number-PIN box keeps digits only, Urdu digits included, at most 12', () => {
    expect(pinBoxValue('12a3')).toBe('123');
    expect(pinBoxValue('۱۲۳۴')).toBe('1234');
    expect(pinBoxValue('1234567890123456')).toBe('123456789012');
  });

  it('a new secret is ready when it keeps the rules for its kind and both boxes match', () => {
    expect(secretFieldsReady('pin', '12345', '12345')).toBe(true);
    expect(secretFieldsReady('pin', '12345', '1234')).toBe(false);
    expect(secretFieldsReady('pin', '123', '123')).toBe(false);
    expect(secretFieldsReady('password', 'Cheese 99', 'Cheese 99')).toBe(true);
    expect(secretFieldsReady('password', 'Cheese 99 ', 'Cheese 99')).toBe(true);
    expect(secretFieldsReady('password', 'Cheese 99', 'cheese 99')).toBe(false);
    // Digits only is a PIN, never a password.
    expect(secretFieldsReady('password', '123456', '123456')).toBe(false);
    expect(secretsDiffer('pizza1', 'pizza2')).toBe(true);
    expect(secretsDiffer('pizza1', '')).toBe(false);
  });
});
