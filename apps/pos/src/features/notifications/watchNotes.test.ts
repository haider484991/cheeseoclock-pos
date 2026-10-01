/**
 * The PIN screen's notes from the watch (alerts:getWatch) and when they beep
 * (watchNotes.ts): the exact words, which notes show signed in and signed out
 * (a held step-in is signed out), Hide on a signed-in note (away until
 * another order joins it), and the beeps — at once for something new, then
 * every 5 minutes until someone signs in, never two within a minute, never
 * over the new-order chime, never for a note a popup hides, a kitchen ticket
 * only on the printer switch, orders waiting only while a shift is open, and
 * never with the sound switched off (the note stays). Every order number is
 * made up.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALERT_SOUND_SETTINGS,
  EMPTY_ALERT_WATCH,
  type AlertSoundSettings,
  type AlertWatch,
  type WatchOrder,
} from '@cheeseoclock/shared-types';
import { orderTimeLabel } from '../orders/historyFilters';
import { PIN_REMIND_EVERY_MS } from './waitingReminders';
import {
  NO_HIDDEN_NOTES,
  PIN_TONE_MIN_GAP_MS,
  hideNote,
  notesSignedIn,
  planWatchTone,
  shownNotes,
  watchNotes,
  type WatchNote,
  type WatchNotesContext,
} from './watchNotes';

const NOW = Date.parse('2026-10-01T14:00:00.000Z'); // 7:00 pm in Karachi
const S: AlertSoundSettings = DEFAULT_ALERT_SOUND_SETTINGS;
const num = (n: number) => `CO-20261001-${String(n).padStart(4, '0')}`;

function watchOf(parts: Partial<AlertWatch> = {}): AlertWatch {
  return {
    ...EMPTY_ALERT_WATCH,
    orders: [],
    ticketsNotPrinted: [],
    unconfirmed: [],
    timing: { notStartedMin: 10, notDoneMin: 30 },
    ...parts,
  };
}

function order(n: number, minutes: number, o: Partial<WatchOrder> = {}): WatchOrder {
  return { orderId: `o${n}`, orderNumber: num(n), status: 'sent_to_kitchen', source: 'web', minutes, ...o };
}
const ticket = (n: number) => ({ orderId: `o${n}`, orderNumber: num(n), failedAt: new Date(NOW - 60_000).toISOString() });
const unconfirmed = (n: number, cancelsAt: string | null) => ({ orderId: `o${n}`, orderNumber: num(n), minutes: 6, cancelsAt });

const ctx = (extra: Partial<WatchNotesContext> = {}): WatchNotesContext => ({
  signedIn: false,
  includeCounter: false,
  ringing: new Set(),
  now: NOW,
  formatTime: (iso) => orderTimeLabel(iso, new Date(NOW)),
  ...extra,
});
const words = (notes: readonly WatchNote[]) => notes.map((n) => [n.kind, n.title, n.detail]);

describe('signed in, for the notes', () => {
  it('someone signed in is; nobody, or a held step-in (a cashier was using the till), is not', () => {
    expect(notesSignedIn({})).toBe(true);
    expect(notesSignedIn({ stepInHeld: false })).toBe(true);
    expect(notesSignedIn(null)).toBe(false);
    expect(notesSignedIn({ stepInHeld: true })).toBe(false);
  });

  it('a held step-in gets the PIN screen’s notes', () => {
    const w = watchOf({ orders: [order(42, 12)], ticketsNotPrinted: [ticket(43)] });
    const held = watchNotes(w, ctx({ signedIn: notesSignedIn({ stepInHeld: true }) }));
    expect(held.map((n) => n.kind)).toEqual(['ticket', 'waiting']);
    expect(watchNotes(w, ctx({ signedIn: notesSignedIn({}) }))).toEqual([]);
  });
});

describe('orders waiting too long, on the PIN screen', () => {
  it('a website order in New for 12 minutes: one note that sends someone to sign in', () => {
    expect(words(watchNotes(watchOf({ orders: [order(42, 12)] }), ctx()))).toEqual([
      ['waiting', 'Order #0042 not started — 12 min', 'Sign in and open Live Orders.'],
    ]);
  });

  it('none while it still rings as a new online order; after Seen, the note is back', () => {
    const w = watchOf({ orders: [order(42, 12)] });
    expect(watchNotes(w, ctx({ ringing: new Set(['o42']) }))).toEqual([]);
    expect(watchNotes(w, ctx({ ringing: new Set() })).map((n) => n.kind)).toEqual(['waiting']);
  });

  it('it stays for as long as the order is late (no 10-minute window), and goes once it is out of the kitchen', () => {
    for (const minutes of [10, 25, 90, 179]) {
      expect(watchNotes(watchOf({ orders: [order(42, minutes)] }), ctx())).toHaveLength(1);
    }
    expect(watchNotes(watchOf({ orders: [order(42, 9)] }), ctx())).toEqual([]);
    expect(watchNotes(watchOf({ orders: [] }), ctx())).toEqual([]);
  });

  it('counter orders only with "counter orders too"', () => {
    const w = watchOf({ orders: [order(42, 35, { source: 'pos', status: 'preparing' })] });
    expect(watchNotes(w, ctx())).toEqual([]);
    expect(words(watchNotes(w, ctx({ includeCounter: true })))).toEqual([
      ['waiting', 'Order #0042 waiting 35 min', 'Sign in and open Live Orders.'],
    ]);
  });

  it('5 orders in New for 20 minutes or more: the board is not being used, so no note', () => {
    const w = watchOf({ orders: [40, 41, 42, 43, 44].map((n) => order(n, 21)) });
    expect(watchNotes(w, ctx())).toEqual([]);
    expect(watchNotes(watchOf({ orders: [40, 41, 42, 43].map((n) => order(n, 21)) }), ctx())).toHaveLength(1);
  });

  it('several: one note, the order numbers and one way in', () => {
    const w = watchOf({
      orders: [order(40, 35, { status: 'preparing' }), order(42, 12), order(43, 11)],
    });
    expect(words(watchNotes(w, ctx()))).toEqual([
      ['waiting', '3 orders are waiting too long', 'Not started: #0042, #0043 · over 30 min: #0040 — sign in and open Live Orders.'],
    ]);
  });

  it('the owner’s minutes come with the watch', () => {
    const w = watchOf({ orders: [order(42, 6)], timing: { notStartedMin: 5, notDoneMin: 20 } });
    expect(watchNotes(w, ctx())[0]!.title).toBe('Order #0042 not started — 6 min');
  });
});

describe('kitchen tickets that did not print, on the PIN screen', () => {
  it('first of the notes, in these words', () => {
    const notes = watchNotes(
      watchOf({ orders: [order(41, 12)], ticketsNotPrinted: [ticket(42)], unconfirmed: [unconfirmed(43, null)] }),
      ctx(),
    );
    expect(notes.map((n) => n.kind)).toEqual(['ticket', 'unconfirmed', 'waiting']);
    expect(words(notes)[0]).toEqual(['ticket', 'Kitchen ticket for Order #0042 did not print', 'Sign in and reprint it.']);
  });

  it('several', () => {
    expect(words(watchNotes(watchOf({ ticketsNotPrinted: [ticket(42), ticket(43)] }), ctx()))).toEqual([
      ['ticket', '2 kitchen tickets did not print', '#0042, #0043 — sign in and reprint them.'],
    ]);
  });

  it('signed in, Live Orders shows it on the card instead', () => {
    expect(watchNotes(watchOf({ ticketsNotPrinted: [ticket(42)] }), ctx({ signedIn: true }))).toEqual([]);
  });
});

describe('website orders the website has not confirmed: on every screen', () => {
  const at745 = '2026-10-01T14:45:00.000Z'; // 7:45 pm in Karachi

  it('signed in it is the only note, with the time the website cancels the order', () => {
    const w = watchOf({ orders: [order(41, 40)], ticketsNotPrinted: [ticket(44)], unconfirmed: [unconfirmed(42, at745)] });
    expect(words(watchNotes(w, ctx({ signedIn: true })))).toEqual([
      [
        'unconfirmed',
        'The website has not confirmed order #0042',
        'The till keeps trying. Check the internet — at 7:45 pm the website cancels it and tells the customer.',
      ],
    ]);
    expect(watchNotes(w, ctx()).map((n) => n.kind)).toEqual(['ticket', 'unconfirmed', 'waiting']);
  });

  it('with no website time (imported before this update), and past it', () => {
    expect(watchNotes(watchOf({ unconfirmed: [unconfirmed(42, null)] }), ctx())[0]!.detail).toBe(
      'The till keeps trying. Check the internet.',
    );
    const past = watchNotes(watchOf({ unconfirmed: [unconfirmed(42, at745)] }), ctx({ now: Date.parse(at745) + 60_000 }));
    expect(past[0]!.detail).toBe('The till keeps trying. Check the internet — the website may have cancelled it at 7:45 pm.');
  });

  it('several', () => {
    expect(words(watchNotes(watchOf({ unconfirmed: [unconfirmed(42, at745), unconfirmed(43, null)] }), ctx()))).toEqual([
      ['unconfirmed', 'The website has not confirmed 2 orders', '#0042, #0043 — the till keeps trying. Check the internet.'],
    ]);
  });
});

it('a watch that somehow carried names would still not put one on screen: only numbers and minutes are read', () => {
  const named = {
    ...order(42, 12),
    customerName: 'Ali Testname',
    customerPhone: '0300-5550142',
  } as unknown as WatchOrder;
  const w = watchOf({
    orders: [named],
    ticketsNotPrinted: [{ ...ticket(43), customerName: 'Ali Testname' } as never],
    unconfirmed: [{ ...unconfirmed(44, null), customerPhone: '0300-5550142' } as never],
  });
  const text = JSON.stringify(watchNotes(w, ctx()));
  expect(text).not.toContain('Ali');
  expect(text).not.toContain('5550142');
});

// ---------------------------------------------------------------------------
// The beeps

/**
 * The watch's rounds (every 30 s from `from`), as OrderAlerts plays them:
 * when each beep plays, and which. `popupUntil`: a popup covers the banner
 * until then; `shiftOpen`: whether a shift is open on this till (open unless
 * said).
 */
function rounds(
  notesAt: (t: number) => WatchNote[],
  o: {
    from?: number;
    minutes: number;
    signedIn?: boolean;
    settings?: AlertSoundSettings;
    chimeUntil?: number;
    popupUntil?: number;
    shiftOpen?: boolean | ((t: number) => boolean);
  },
): Array<[number, string]> {
  const played: Array<[number, string]> = [];
  let lastToneAt = 0;
  let announced = new Set<string>();
  const from = o.from ?? NOW;
  for (let t = from; t <= from + o.minutes * 60_000; t += 30_000) {
    const notes = notesAt(t);
    const plan = planWatchTone(notes, {
      signedIn: o.signedIn ?? false,
      settings: o.settings ?? S,
      now: t,
      lastToneAt,
      announced,
      chimeRinging: o.chimeUntil !== undefined && t < o.chimeUntil,
      notesOnScreen: !(o.popupUntil !== undefined && t < o.popupUntil),
      shiftOpen: typeof o.shiftOpen === 'function' ? o.shiftOpen(t) : (o.shiftOpen ?? true),
    });
    const shown = new Set(notes.flatMap((n) => n.keys));
    announced = new Set([...[...announced].filter((k) => shown.has(k)), ...plan.announce]);
    if (plan.sound) {
      lastToneAt = t;
      played.push([(t - from) / 60_000, plan.sound]);
    }
  }
  return played;
}

const waitingNotes = (n = 42) => watchNotes(watchOf({ orders: [order(n, 12)] }), ctx());
const ticketNotes = () => watchNotes(watchOf({ ticketsNotPrinted: [ticket(42)] }), ctx());

describe('the PIN screen’s beep', () => {
  it('at once for something new, then every 5 minutes until someone signs in', () => {
    expect(PIN_REMIND_EVERY_MS).toBe(5 * 60_000);
    expect(rounds(() => waitingNotes(), { minutes: 16 })).toEqual([
      [0, 'waiting'],
      [5, 'waiting'],
      [10, 'waiting'],
      [15, 'waiting'],
    ]);
  });

  it('something new beeps at once, but never within a minute of the last beep', () => {
    expect(PIN_TONE_MIN_GAP_MS).toBe(60_000);
    // A second order turns late 30 s after the first beep: its beep waits for the minute.
    const notesAt = (t: number) =>
      watchNotes(watchOf({ orders: t >= NOW + 30_000 ? [order(42, 12), order(43, 10)] : [order(42, 12)] }), ctx());
    expect(rounds(notesAt, { minutes: 7 })).toEqual([
      [0, 'waiting'],
      [1, 'waiting'],
      [6, 'waiting'],
    ]);
  });

  it('the printer sound while a ticket note shows; the waiting one otherwise', () => {
    expect(rounds(() => ticketNotes(), { minutes: 5 })).toEqual([
      [0, 'printer'],
      [5, 'printer'],
    ]);
    expect(rounds(() => [...ticketNotes(), ...waitingNotes()], { minutes: 0 })).toEqual([[0, 'printer']]);
  });

  it('a kitchen ticket follows only the "Printer problem" switch, as Settings → Sounds says', () => {
    // v0.7.33 review: with the printer sound off, a ticket note alone beeped
    // the waiting sound. Off now means silent (this used to expect 'waiting').
    const noPrinter = { ...S, events: { ...S.events, printerProblem: false } };
    expect(rounds(() => ticketNotes(), { minutes: 12, settings: noPrinter })).toEqual([]);
    expect(ticketNotes()).toHaveLength(1); // the note stays
    // An order waiting too long still beeps on its own switch, the printer one off.
    expect(rounds(() => [...ticketNotes(), ...waitingNotes()], { minutes: 5, settings: noPrinter })).toEqual([
      [0, 'waiting'],
      [5, 'waiting'],
    ]);
    // A ticket turning up later, printer sound off: no beep for it.
    const later = (t: number) => (t >= NOW + 2 * 60_000 ? [...ticketNotes(), ...waitingNotes()] : waitingNotes());
    expect(rounds(later, { minutes: 4, settings: noPrinter })).toEqual([[0, 'waiting']]);
    // The reminder sound off and the printer one on: the ticket still beeps its own sound.
    const noWaiting = { ...S, events: { ...S.events, waitingTooLong: false } };
    expect(rounds(() => [...ticketNotes(), ...waitingNotes()], { minutes: 0, settings: noWaiting })).toEqual([
      [0, 'printer'],
    ]);
    expect(rounds(() => waitingNotes(), { minutes: 6, settings: noWaiting })).toEqual([]);
  });

  it('never for a note a popup hides (a held step-in, "Close the till?"): it beeps once it shows', () => {
    // The popup is up for the first 7 minutes: no beep, and nothing counted as heard.
    expect(rounds(() => waitingNotes(), { minutes: 13, popupUntil: NOW + 7 * 60_000 })).toEqual([
      [7, 'waiting'],
      [12, 'waiting'],
    ]);
    expect(rounds(() => ticketNotes(), { minutes: 30, popupUntil: NOW + 31 * 60_000 })).toEqual([]);
    expect(
      planWatchTone(waitingNotes(), {
        signedIn: false,
        settings: S,
        now: NOW,
        lastToneAt: 0,
        announced: new Set(),
        chimeRinging: false,
        notesOnScreen: false,
        shiftOpen: true,
      }),
    ).toEqual({ sound: null, announce: [] });
  });

  it('orders waiting while no shift is open on this till: the note shows, no beep; the others still beep', () => {
    // A website order left in Ready after closing: the shop is closed.
    const left = watchNotes(watchOf({ orders: [order(42, 95, { status: 'ready' })], shiftOpen: false }), ctx());
    expect(words(left)).toEqual([['waiting', 'Order #0042 waiting 95 min', 'Sign in and open Live Orders.']]);
    expect(rounds(() => left, { minutes: 180, shiftOpen: false })).toEqual([]);
    // A kitchen ticket, or a website order not confirmed, still beeps with no shift open.
    expect(rounds(() => [...ticketNotes(), ...left], { minutes: 5, shiftOpen: false })).toEqual([
      [0, 'printer'],
      [5, 'printer'],
    ]);
    const notConfirmed = watchNotes(watchOf({ unconfirmed: [unconfirmed(43, null)] }), ctx());
    expect(rounds(() => [...notConfirmed, ...left], { minutes: 0, shiftOpen: false })).toEqual([[0, 'waiting']]);
    // A shift opened at 10 minutes (signed out again): it beeps at once, then every 5 minutes.
    expect(rounds(() => left, { minutes: 16, shiftOpen: (t) => t >= NOW + 10 * 60_000 })).toEqual([
      [10, 'waiting'],
      [15, 'waiting'],
    ]);
  });

  it('sounds off, or the reminder and printer sounds off: the notes stay and nothing plays', () => {
    const off = { ...S, enabled: false };
    expect(rounds(() => [...ticketNotes(), ...waitingNotes()], { minutes: 12, settings: off })).toEqual([]);
    const silent = { ...S, events: { ...S.events, printerProblem: false, waitingTooLong: false } };
    expect(rounds(() => [...ticketNotes(), ...waitingNotes()], { minutes: 12, settings: silent })).toEqual([]);
    expect(rounds(() => waitingNotes(), { minutes: 12, settings: { ...S, volume: 0 } })).toEqual([]);
    expect(waitingNotes()).toHaveLength(1); // the note is the same either way
  });

  it('no beep while the new-order chime rings; the note beeps once it stops', () => {
    expect(rounds(() => waitingNotes(), { minutes: 6, chimeUntil: NOW + 2 * 60_000 })).toEqual([[2, 'waiting']]);
  });

  it('nothing to say, nothing plays', () => {
    expect(
      planWatchTone([], {
        signedIn: false,
        settings: S,
        now: NOW,
        lastToneAt: 0,
        announced: new Set(),
        chimeRinging: false,
        notesOnScreen: true,
        shiftOpen: true,
      }),
    ).toEqual({
      sound: null,
      announce: [],
    });
  });
});

describe('signed in', () => {
  const at745 = '2026-10-01T14:45:00.000Z';
  const notConfirmed = (ns: number[]) =>
    watchNotes(watchOf({ unconfirmed: ns.map((n) => unconfirmed(n, at745)) }), ctx({ signedIn: true }));

  it('one beep for each website order newly not confirmed, never again for it', () => {
    expect(rounds(() => notConfirmed([42]), { minutes: 20, signedIn: true })).toEqual([[0, 'waiting']]);
    const notesAt = (t: number) => notConfirmed(t >= NOW + 10 * 60_000 ? [42, 43] : [42]);
    expect(rounds(notesAt, { minutes: 20, signedIn: true })).toEqual([
      [0, 'waiting'],
      [10, 'waiting'],
    ]);
  });

  it('with the reminder sound off, nothing plays', () => {
    const quiet = { ...S, events: { ...S.events, waitingTooLong: false } };
    expect(rounds(() => notConfirmed([42]), { minutes: 5, signedIn: true, settings: quiet })).toEqual([]);
  });

  it('under a popup (a payment, "Close the till?") no beep: the new order beeps once the note shows', () => {
    expect(rounds(() => notConfirmed([42]), { minutes: 20, signedIn: true, popupUntil: NOW + 3 * 60_000 })).toEqual([
      [3, 'waiting'],
    ]);
  });

  it('a no-shift till still beeps for a website order not confirmed (the internet is the problem)', () => {
    expect(rounds(() => notConfirmed([42]), { minutes: 5, signedIn: true, shiftOpen: false })).toEqual([[0, 'waiting']]);
  });
});

describe('Hide on a signed-in note', () => {
  const at745 = '2026-10-01T14:45:00.000Z';
  const notConfirmed = (ns: number[]) =>
    watchNotes(watchOf({ unconfirmed: ns.map((n) => unconfirmed(n, at745)) }), ctx({ signedIn: true }));

  it('hides that note, and it stays away while nothing new joins it', () => {
    const hidden = hideNote(NO_HIDDEN_NOTES, notConfirmed([42])[0]!);
    expect(shownNotes(notConfirmed([42]), hidden, true)).toEqual([]);
    // Fewer orders (one got confirmed) is not something new.
    const two = hideNote(NO_HIDDEN_NOTES, notConfirmed([42, 43])[0]!);
    expect(shownNotes(notConfirmed([43]), two, true)).toEqual([]);
    expect(NO_HIDDEN_NOTES).toEqual({});
  });

  it('comes back when another order joins it, with all its orders', () => {
    const hidden = hideNote(NO_HIDDEN_NOTES, notConfirmed([42])[0]!);
    const back = shownNotes(notConfirmed([42, 43]), hidden, true);
    expect(words(back)).toEqual([
      ['unconfirmed', 'The website has not confirmed 2 orders', '#0042, #0043 — the till keeps trying. Check the internet.'],
    ]);
    // A different order in place of the hidden one is new too.
    expect(shownNotes(notConfirmed([44]), hidden, true)).toHaveLength(1);
  });

  it('a new note of another kind is not hidden by it', () => {
    const hidden = hideNote(NO_HIDDEN_NOTES, notConfirmed([42])[0]!);
    const both = [...ticketNotes(), ...notConfirmed([42])];
    expect(shownNotes(both, hidden, true).map((n) => n.kind)).toEqual(['ticket']);
  });

  it('signed out (the PIN screen, a held step-in) every note shows: nothing hides there', () => {
    const hidden = hideNote(NO_HIDDEN_NOTES, notConfirmed([42])[0]!);
    const pin = watchNotes(watchOf({ unconfirmed: [unconfirmed(42, at745)] }), ctx());
    expect(shownNotes(pin, hidden, false)).toEqual(pin);
  });

  it('the beep: a hidden note makes none; the order that brings it back beeps once', () => {
    let hidden = NO_HIDDEN_NOTES;
    const notesAt = (t: number) => {
      const all = notConfirmed(t >= NOW + 8 * 60_000 ? [42, 43] : [42]);
      // Hidden at 2 minutes, as it was then.
      if (t === NOW + 2 * 60_000) hidden = hideNote(hidden, all[0]!);
      return shownNotes(all, hidden, true);
    };
    expect(rounds(notesAt, { minutes: 20, signedIn: true })).toEqual([
      [0, 'waiting'],
      [8, 'waiting'],
    ]);
  });
});
