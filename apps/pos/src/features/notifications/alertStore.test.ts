/**
 * Hide on a signed-in note (v0.7.33): kept in the alert store only — never
 * saved, never sent to the main process — and a sign-in or sign-out brings
 * every hidden note back. Every order number is made up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WatchNote } from './watchNotes';

const acknowledge = vi.fn(async () => ({ orders: [], failures: [] }));
vi.mock('../../ipc/client', () => ({ ipc: { alerts: { acknowledge } } }));

const { alerts, useAlertStore } = await import('./alertStore');
const { NO_HIDDEN_NOTES, shownNotes } = await import('./watchNotes');

const NOTE: WatchNote = {
  kind: 'unconfirmed',
  keys: ['unconfirmed:o42'],
  orderIds: ['o42'],
  title: 'The website has not confirmed order #0042',
  detail: 'The till keeps trying. Check the internet.',
};

/** A storage that records every write. */
function spyStorage() {
  const setItem = vi.fn();
  return { store: { getItem: () => null, setItem, removeItem: setItem, clear: setItem, key: () => null, length: 0 }, setItem };
}

afterEach(() => {
  alerts.showHiddenNotes();
  vi.unstubAllGlobals();
});

describe('Hide on a signed-in note, in the alert store', () => {
  it('hides that note until it changes, and leaves the rest of the store alone', () => {
    const before = useAlertStore.getState().state;
    expect(alerts.getHiddenNotes()).toBe(NO_HIDDEN_NOTES);
    alerts.hideNote(NOTE);
    expect(alerts.getHiddenNotes()).toEqual({ unconfirmed: ['unconfirmed:o42'] });
    expect(shownNotes([NOTE], alerts.getHiddenNotes(), true)).toEqual([]);
    expect(useAlertStore.getState().state).toBe(before);
  });

  it('is not saved anywhere and not sent to the main process', () => {
    const local = spyStorage();
    const session = spyStorage();
    vi.stubGlobal('localStorage', local.store);
    vi.stubGlobal('sessionStorage', session.store);
    alerts.hideNote(NOTE);
    alerts.showHiddenNotes();
    expect(local.setItem).not.toHaveBeenCalled();
    expect(session.setItem).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('a sign-in or sign-out (showHiddenNotes) brings it back', () => {
    alerts.hideNote(NOTE);
    alerts.showHiddenNotes();
    expect(alerts.getHiddenNotes()).toBe(NO_HIDDEN_NOTES);
    expect(shownNotes([NOTE], alerts.getHiddenNotes(), true)).toEqual([NOTE]);
  });
});
