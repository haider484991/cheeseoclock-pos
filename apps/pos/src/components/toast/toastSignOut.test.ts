/**
 * The till's notes and who is signed in (e2e v0.7.35, 3 Oct 2026): the
 * owner's sticky red "The shift report did not print" stayed up through Log
 * out, and the cashier who signed in next found it over the header's "Open
 * shift" until it was closed with X. A note is the login's: when the person
 * signed in changes, the notes go — except a note about the shop itself (a
 * website order's), kept on purpose. And a note with its own id is replaced
 * by the next with that id, or closed by it (a shift report that printed in
 * the end takes its "did not print" away). Every name is made up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthenticatedUser, UUID } from '@cheeseoclock/shared-types';
import { useSessionStore } from '../../stores/sessionStore';
import { onSignedInPersonChange } from './ToastProvider';
import {
  addToast,
  removeToast,
  signedInPersonChanged,
  toastDuration,
  toastsAfterSignOut,
  type ToastItem,
  type ToastVariant,
} from './toastQueue';

const person = (id: string, sessionId = `sess-${id}`): AuthenticatedUser =>
  ({ id: id as UUID, fullName: `Test ${id}`, role: 'manager', sessionId: sessionId as UUID }) as AuthenticatedUser;

const note = (id: string, variant: ToastVariant, title: string, more: Partial<ToastItem> = {}): ToastItem => ({
  id,
  title,
  variant,
  duration: toastDuration(variant),
  ...more,
});

afterEach(() => {
  useSessionStore.setState({ user: null, status: 'idle' });
});

describe('notes go with the login', () => {
  it('the person signed in changed: logged out, locked, handed back, or someone else signed in — not the same login read again', () => {
    expect(signedInPersonChanged(person('owner'), null)).toBe(true);
    expect(signedInPersonChanged(person('owner'), person('cashier'))).toBe(true);
    // The till's 30-second check reads the same login again; a held step-in kept by its own PIN is still that person.
    expect(signedInPersonChanged(person('owner'), person('owner'))).toBe(false);
    expect(signedInPersonChanged(person('owner'), person('owner', 'sess-new'))).toBe(false);
    // Nobody was signed in: the PIN pad's own notes stay for whoever signs in.
    expect(signedInPersonChanged(null, person('cashier'))).toBe(false);
    expect(signedInPersonChanged(null, null)).toBe(false);
  });

  it('the owner’s red "did not print" goes at the log-out; a website order’s note stays', () => {
    let list: ToastItem[] = [];
    list = addToast(list, note('shift-report-print:s-5', 'error', 'The shift report did not print'));
    list = addToast(list, note('n-2', 'warning', 'Cash drawer may not have opened — check it'));
    list = addToast(list, note('n-3', 'warning', 'Online order #0042: the total changed', { duration: Infinity, keepOnLogout: true }));
    expect(toastsAfterSignOut(list).map((t) => t.title)).toEqual(['Online order #0042: the total changed']);
    expect(toastsAfterSignOut([])).toEqual([]);
  });

  it('the screen’s notes are cleared each time the person changes (the provider listens to the sign-in)', () => {
    let cleared = 0;
    const stop = onSignedInPersonChange(() => {
      cleared += 1;
    });
    try {
      useSessionStore.setState({ user: person('owner'), status: 'authenticated' });
      expect(cleared, 'signing in on the PIN pad').toBe(0);
      useSessionStore.setState({ user: person('owner') });
      expect(cleared, 'the same login read again').toBe(0);
      useSessionStore.setState({ user: null, status: 'idle' });
      expect(cleared, 'Log out').toBe(1);
      useSessionStore.setState({ user: person('cashier'), status: 'authenticated' });
      expect(cleared, 'the cashier signs in').toBe(1);
      useSessionStore.setState({ user: person('manager') });
      expect(cleared, 'a manager signs in over the cashier').toBe(2);
    } finally {
      stop();
    }
    useSessionStore.setState({ user: null });
    expect(cleared, 'stopped').toBe(2);
  });
});

describe('a note with its own id', () => {
  it('is replaced by the next with that id (one note per shift’s report), and closed by it', () => {
    let list: ToastItem[] = [];
    list = addToast(list, note('shift-report-failed:s-5', 'error', 'Shift report did not print', { description: 'connect ECONNREFUSED 127.0.0.1:9101.' }));
    list = addToast(list, note('shift-report-print:s-5', 'error', 'The shift report did not print', { description: 'Printer did not answer.' }));
    list = addToast(list, note('other', 'error', 'Receipt for Order #0041 did not print'));
    // Try again printed it: the print's note takes the place of the last one…
    list = addToast(list, note('shift-report-print:s-5', 'success', 'Shift report sent to the printer.'));
    expect(list.map((t) => [t.id, t.title])).toEqual([
      ['shift-report-failed:s-5', 'Shift report did not print'],
      ['other', 'Receipt for Order #0041 did not print'],
      ['shift-report-print:s-5', 'Shift report sent to the printer.'],
    ]);
    // …and the till's red note for that shift is closed by its id.
    list = removeToast(list, 'shift-report-failed:s-5');
    expect(list.map((t) => t.id)).toEqual(['other', 'shift-report-print:s-5']);
    // Closing an id that is not up changes nothing.
    expect(removeToast(list, 'shift-report-failed:s-9')).toEqual(list);
  });
});
