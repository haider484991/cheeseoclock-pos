/**
 * The watch's notes on the alert banner (v0.7.33), rendered to static markup
 * (react-dom/server, no browser; nothing calls the till):
 *   - a note alone is an amber row read out politely (role=status), with no
 *     Seen: it goes when what it is about is dealt with;
 *   - "View" (Live Orders) only for someone signed in who may open it;
 *   - the alarm beats new orders, new orders beat notes, and "+N more"
 *     counts what waits behind;
 *   - while a popup is open the banner is the small pill, which a note alone
 *     does not get (OrderAlerts watches for popups while a note shows too);
 *   - signed in, a note has "Hide" and sits low on the left, clear of
 *     Checkout's order-type buttons, ticket and Pay button at every window
 *     width (measured against globals.css); on the PIN screen it stays put,
 *     with no Hide;
 *   - a failure card's words take two lines, so the phone at their end shows;
 *   - so do a note's on the PIN screen, never cut with "…", and the taller
 *     row stays clear of the PIN keypad (measured in Chromium, Inter 14 px);
 *   - the pill says which order: "New order #0044", "2 new orders",
 *     "Cancelled #0045", "Order not in", whole within its width.
 * Every name and amount is made up.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AlertBanner, NOTE_ROW_SIGNED_IN, PILL_MAX_WIDTH, type AlertBannerProps } from './AlertBanner';
import { EMPTY_ALERT_STATE, describePill, receiveFailure, receiveOrder, silenceFailures, type AlertState } from './alertState';
import type { WatchNote } from './watchNotes';

const TICKET: WatchNote = {
  kind: 'ticket',
  keys: ['ticket:o42'],
  orderIds: ['o42'],
  title: 'Kitchen ticket for Order #0042 did not print',
  detail: 'Sign in and reprint it.',
};
const UNCONFIRMED: WatchNote = {
  kind: 'unconfirmed',
  keys: ['unconfirmed:o43'],
  orderIds: ['o43'],
  title: 'The website has not confirmed order #0043',
  detail: 'The till keeps trying. Check the internet.',
};

const withOrder = receiveOrder(
  EMPTY_ALERT_STATE,
  {
    orderId: 'o44',
    orderNumber: 'CO-20261001-0044',
    customerName: 'Test Customer',
    webOrderId: 'w44',
    fulfilment: 'delivery',
    totalCents: 185_000,
    totalMismatch: null,
  },
  0,
);
const withAlarm = receiveFailure(
  withOrder,
  {
    webOrderId: 'w45',
    customerName: 'Test Customer',
    customerPhone: null,
    orderNumber: 'CO-20261001-0045',
    message: 'cancelled on the website while the kitchen had it',
    reason: 'cancelled_on_site',
    silenced: false,
    at: new Date(0).toISOString(),
  },
  0,
);

function banner(o: Partial<AlertBannerProps> & { state?: AlertState } = {}): string {
  return renderToStaticMarkup(
    <AlertBanner
      state={EMPTY_ALERT_STATE}
      notes={[]}
      loggedIn={false}
      canView={false}
      compact={false}
      formatMoney={(c) => `Rs ${c / 100}`}
      onView={() => {}}
      onSeen={() => {}}
      onCloseFailure={() => {}}
      {...o}
    />,
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
/** The banner's outer box: its class list and its style. */
const box = (html: string) => {
  const m = /^<div[^>]*?style="([^"]*)"[^>]*?class="([^"]*)"/.exec(html);
  if (!m) throw new Error(`no banner box in ${html.slice(0, 120)}`);
  return { style: m[1]!, classes: m[2]!.split(' ') };
};
/** The class list of the element holding exactly these words. */
const classesOf = (html: string, words: string) => {
  const at = html.indexOf(`>${words}<`);
  if (at < 0) throw new Error(`"${words}" not found`);
  const open = html.lastIndexOf('<div class="', at);
  return html.slice(open + '<div class="'.length, html.indexOf('"', open + '<div class="'.length)).split(' ');
};
/** Press the button with these words, as a tap would (the element tree, no browser). */
function press(o: Partial<AlertBannerProps>, words: string): void {
  const find = (n: ReactNode): ReactElement<{ onClick?: () => void; children?: ReactNode }> | null => {
    if (Array.isArray(n)) {
      for (const c of n) {
        const hit = find(c as ReactNode);
        if (hit) return hit;
      }
      return null;
    }
    if (!isValidElement<{ onClick?: () => void; children?: ReactNode }>(n)) return null;
    if (n.props.children === words && n.props.onClick) return n;
    return find(n.props.children);
  };
  const tree = AlertBanner({
    state: EMPTY_ALERT_STATE,
    notes: [],
    loggedIn: false,
    canView: false,
    compact: false,
    formatMoney: (c) => `Rs ${c / 100}`,
    onView: () => {},
    onSeen: () => {},
    onCloseFailure: () => {},
    ...o,
  });
  const button = find(tree);
  if (!button) throw new Error(`no "${words}" button`);
  button.props.onClick!();
}

describe('a note alone', () => {
  it('nothing at all: no banner', () => {
    expect(banner()).toBe('');
  });

  it('the amber row, read out politely, with its words and no Seen', () => {
    const html = banner({ notes: [TICKET] });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('bg-amber-100');
    expect(text(html)).toBe('Kitchen ticket for Order #0042 did not print Sign in and reprint it.');
    expect(buttons(html)).toEqual([]);
  });

  it('View for someone signed in who may open Live Orders; still no Seen', () => {
    expect(buttons(banner({ notes: [UNCONFIRMED], loggedIn: true, canView: true }))).toEqual(['View']);
    expect(buttons(banner({ notes: [UNCONFIRMED], loggedIn: true, canView: false }))).toEqual([]);
  });

  it('two notes: the first shows, "+1 more" counts the other', () => {
    const t = text(banner({ notes: [TICKET, UNCONFIRMED] }));
    expect(t).toContain('Kitchen ticket for Order #0042 did not print');
    expect(t).toContain('+1 more');
    expect(t).not.toContain('has not confirmed');
  });
});

describe('what wins the row', () => {
  it('a new order beats the notes, and "+1 more" counts the note', () => {
    const html = banner({ state: withOrder, notes: [TICKET] });
    const t = text(html);
    expect(t).toContain('New online order #0044');
    expect(t).toContain('+1 more');
    expect(t).not.toContain('did not print');
    expect(html).toContain('role="alert"');
    expect(buttons(html)).toEqual(['Seen']);
  });

  it('the alarm beats both', () => {
    const t = text(banner({ state: withAlarm, notes: [TICKET] }));
    expect(t).toContain('Website cancelled order #0045');
    expect(t).toContain('+2 more');
    expect(t).not.toContain('New online order');
    expect(t).not.toContain('did not print');
  });

  it('a note beats the light-red "call the customer" note left after Seen', () => {
    const quiet = receiveFailure(
      EMPTY_ALERT_STATE,
      {
        webOrderId: 'w46',
        customerName: 'Test Customer',
        customerPhone: null,
        message: 'gave up after 5 attempts',
        reason: 'gave_up',
        silenced: true,
        at: new Date(0).toISOString(),
      },
      0,
    );
    const t = text(banner({ state: quiet, notes: [UNCONFIRMED] }));
    expect(t).toContain('The website has not confirmed order #0043');
    expect(t).toContain('+1 more');
    expect(text(banner({ state: quiet }))).toContain('did not come in');
  });
});

describe('Hide, signed in', () => {
  it('a signed-in note has Hide next to View; tapping it hides that note', () => {
    const hid: WatchNote[] = [];
    const props = { notes: [UNCONFIRMED], loggedIn: true, canView: true, onHideNote: (n: WatchNote) => hid.push(n) };
    expect(buttons(banner(props))).toEqual(['View', 'Hide']);
    expect(banner(props)).toContain('title="Hide this note until it changes"');
    press(props, 'Hide');
    expect(hid).toEqual([UNCONFIRMED]);
    // Someone who may not open Live Orders: Hide alone.
    expect(buttons(banner({ ...props, canView: false }))).toEqual(['Hide']);
  });

  it('on the PIN screen notes stay as they are: no Hide, under the toast slot', () => {
    const html = banner({ notes: [TICKET, UNCONFIRMED] });
    expect(buttons(html)).toEqual([]);
    expect(box(html).style).toContain('top:4.875rem');
    expect(box(html).classes).toContain('left-1/2');
  });

  it('Hide is only on a note: never on a new order or an alarm', () => {
    const onHideNote = () => {};
    expect(buttons(banner({ state: withOrder, notes: [UNCONFIRMED], loggedIn: true, canView: true, onHideNote }))).toEqual([
      'View',
      'Seen',
    ]);
    expect(buttons(banner({ state: withAlarm, notes: [UNCONFIRMED], loggedIn: true, onHideNote }))).toEqual(['Seen']);
  });
});

describe('signed in, a note never covers Checkout’s order-type buttons', () => {
  it('it sits low on the left, not under the top bar; every other row stays where it was', () => {
    const note = box(banner({ notes: [UNCONFIRMED], loggedIn: true, canView: true, onHideNote: () => {} }));
    expect(note.style).not.toContain('top:');
    for (const c of NOTE_ROW_SIGNED_IN.split(' ')) expect(note.classes).toContain(c);
    expect(note.classes).not.toContain('left-1/2');
    // Its title and words may take two lines each (it grows upwards).
    const html = banner({ notes: [UNCONFIRMED], loggedIn: true, canView: true, onHideNote: () => {} });
    expect(classesOf(html, UNCONFIRMED.title)).toContain('line-clamp-2');
    expect(classesOf(html, UNCONFIRMED.detail)).toContain('line-clamp-2');
    // New orders and alarms: under the top bar as before.
    for (const state of [withOrder, withAlarm]) {
      const top = box(banner({ state, notes: [UNCONFIRMED], loggedIn: true, canView: true }));
      expect(top.style).toContain('top:4.5rem');
      expect(top.classes).toContain('left-1/2');
    }
  });

  it('at every window width from the 1024 px minimum, it stays over the menu: clear of the ticket and its Pay button', () => {
    const rem = 16;
    const num = (re: RegExp) => {
      const m = re.exec(NOTE_ROW_SIGNED_IN);
      if (!m) throw new Error(`${re} not in ${NOTE_ROW_SIGNED_IN}`);
      return Number(m[1]) * rem;
    };
    const left = num(/(?:^| )left-\[([\d.]+)rem\]/);
    const leftXl = num(/xl:left-\[([\d.]+)rem\]/);
    const widthMax = num(/w-\[min\(([\d.]+)rem,/);
    const widthGap = num(/calc\(100vw-([\d.]+)rem\)/);
    const bottom = num(/bottom-(\d+)(?: |$)/) / 4; // Tailwind's bottom-10 is 2.5rem: 40 px
    // Checkout's layout (globals.css): the sidebar rail, and the ticket column for each container width.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'styles', 'globals.css'), 'utf8');
    const rail = Number(/\.app-shell--compact \.app-sidebar \{ width: (\d+)px; \}/.exec(css)![1]);
    const fullSidebar = 240; // w-60, from 1280 px (the rail's media query stops at 1279 px)
    const columns = css
      .split('@container')
      .map((chunk) => /^ \(min-width: (\d+)px\) \{[\s\S]*?\.checkout \{ grid-template-columns: minmax\(0, 1fr\) (\d+)px/.exec(chunk))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ from: Number(m[1]), ticket: Number(m[2]) }));
    expect(columns.map((c) => c.ticket)).toEqual([360, 400, 440]);
    const ticketAt = (viewport: number) =>
      columns.filter((c) => viewport - rail >= c.from).reduce((w, c) => c.ticket, 0);
    for (let viewport = 1024; viewport <= 2560; viewport += 1) {
      const x = viewport >= 1280 ? leftXl : left;
      const right = x + Math.min(widthMax, viewport - widthGap);
      // Past the sidebar (full width from 1280 px; the rail on Checkout), 8 px short of the ticket column.
      expect(x).toBeGreaterThanOrEqual((viewport >= 1280 ? fullSidebar : rail) + 8);
      expect(right).toBeLessThanOrEqual(viewport - ticketAt(viewport) - 8);
    }
    // Low: above the "sound off" pill (bottom 0.5rem, 24 px tall); the order-type
    // buttons sit just under the top bar (64 + 10 px down, 42 px tall).
    expect(bottom).toBe(40);
    const maxHeight = num(/max-h-\[([\d.]+)rem\]/);
    for (const height of [700, 768]) expect(height - bottom - maxHeight).toBeGreaterThan(64 + 10 + 42);
  });
});

describe('a failure card shows the whole phone number', () => {
  const cancelled = (phone: string | null): AlertState =>
    receiveFailure(
      EMPTY_ALERT_STATE,
      {
        webOrderId: 'w47',
        customerName: 'Test Customer',
        customerPhone: phone,
        orderNumber: 'CO-20261001-0047',
        message: 'cancelled on the website while the kitchen had it',
        reason: 'cancelled_on_site',
        silenced: false,
        at: new Date(0).toISOString(),
      },
      0,
    );
  const WORDS = 'The customer was told it did not go through, but the kitchen has it. Call 0300-1234567.';

  it('signed in, the loud card’s words take up to two lines, the phone at their end', () => {
    const html = banner({ state: cancelled('0300-1234567'), loggedIn: true });
    expect(text(html)).toContain(`Website cancelled order #0047 ${WORDS} Seen`);
    // 536 px of words in Segoe UI 14 px (572 in Inter) against 459 px on the card: two lines, never cut.
    expect(classesOf(html, WORDS)).toContain('line-clamp-2');
    expect(classesOf(html, WORDS)).not.toContain('truncate');
    expect(box(html).classes).toContain('max-h-[5.5rem]');
    // After Seen (the light-red card that stays until closed) the same.
    const quiet = banner({ state: silenceFailures(cancelled('0300-1234567')).state, loggedIn: true });
    expect(classesOf(quiet, WORDS)).toContain('line-clamp-2');
    expect(box(quiet).classes).toContain('max-h-[5.5rem]');
  });

  it('signed out the card still shows no phone', () => {
    const html = banner({ state: cancelled('0300-1234567') });
    expect(text(html)).toContain('The customer was told it did not go through, but the kitchen has it. Sign in and call them.');
    expect(html).not.toContain('0300');
    expect(html).not.toContain('Test Customer');
  });

  it('a new order keeps its one-line row', () => {
    const html = banner({ state: withOrder, loggedIn: true });
    expect(box(html).classes).toContain('max-h-[4.5rem]');
    expect(classesOf(html, 'Delivery · Rs 1850 · Test Customer')).toContain('truncate');
  });
});

describe('a popup is open (the small pill)', () => {
  it('a note alone shows nothing; a ringing order still gets the pill', () => {
    expect(banner({ notes: [TICKET, UNCONFIRMED], compact: true })).toBe('');
    const pill = banner({ state: withOrder, notes: [TICKET], compact: true });
    expect(text(pill)).toBe('New order #0044 Seen');
  });

  it('OrderAlerts watches for popups while a note alone shows, so the row never covers a payment', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'OrderAlerts.tsx'), 'utf8');
    expect(src).toMatch(/usePopupOpen\(hasPending \|\| notes\.length > 0\)/);
    expect(src).toMatch(/<AlertBanner[\s\S]*?notes=\{notes\}/);
  });
});

describe('OrderAlerts beeps only for what the banner shows', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'OrderAlerts.tsx'), 'utf8');

  it('the beep is planned on the notes on the banner, with whether a popup covers it and whether a shift is open', () => {
    expect(src).toMatch(/planWatchTone\(shownNotes\(next, alerts\.getHiddenNotes\(\), signedIn\), \{/);
    expect(src).toMatch(/notesOnScreen: !popupOpen\(\),/);
    expect(src).toMatch(/shiftOpen: data\.shiftOpen,/);
  });

  it('Hide only signed in, kept in the alert store; a sign-in or sign-out brings hidden notes back', () => {
    expect(src).toMatch(/const notes = shownNotes\(allNotes, hiddenNotes, signedIn\);/);
    expect(src).toMatch(/onHideNote=\{signedIn \? \(n\) => alerts\.hideNote\(n\) : undefined\}/);
    expect(src).toMatch(/signedInChangedAt\.current = Date\.now\(\);[\s\S]{0,120}alerts\.showHiddenNotes\(\);/);
  });
});

describe('on the PIN screen a note’s words take two lines, clear of the keypad', () => {
  // The two the hands-on test of the packaged till saw cut with "…" (v0.7.33).
  const LATE: WatchNote = {
    kind: 'unconfirmed',
    keys: ['unconfirmed:o2'],
    orderIds: ['o2'],
    title: 'The website has not confirmed order #0002',
    detail: 'The till keeps trying. Check the internet — at 12:39 am the website cancels it and tells the customer.',
  };
  const WAITING: WatchNote = {
    kind: 'waiting',
    keys: ['waiting:o2:30', 'waiting:o3:30', 'waiting:o4:30', 'waiting:o1:30'],
    orderIds: ['o2', 'o3', 'o4', 'o1'],
    title: '4 orders are waiting too long',
    detail: 'Not started: #0002, #0003, #0004 · over 30 min: #0001 — sign in and open Live Orders.',
  };

  it('the words take up to two lines, never cut with "…"; the title keeps one; the row may be 5.5rem', () => {
    for (const note of [LATE, WAITING, TICKET, UNCONFIRMED]) {
      const html = banner({ notes: [note] });
      expect(classesOf(html, note.detail)).toContain('line-clamp-2');
      expect(classesOf(html, note.detail)).not.toContain('truncate');
      expect(classesOf(html, note.title)).toContain('truncate');
      expect(box(html).classes).toContain('max-h-[5.5rem]');
      expect(box(html).classes).not.toContain('max-h-[4.5rem]');
      // Where it was: centred under the toast slot.
      expect(box(html).style).toContain('top:4.875rem');
      expect(box(html).classes).toContain('left-1/2');
    }
    // A new order on the PIN screen keeps its one line.
    const order = banner({ state: withOrder });
    expect(box(order).classes).toContain('max-h-[4.5rem]');
  });

  it('two lines fit the row, and the row stays above the PIN keypad as one line did', () => {
    const rem = 16;
    const html = banner({ notes: [LATE] });
    const top = Number(/top:([\d.]+)rem/.exec(box(html).style)![1]) * rem;
    const capClass = box(html).classes.find((c) => c.startsWith('max-h-'))!;
    const cap = Number(/^max-h-\[([\d.]+)rem\]$/.exec(capClass)![1]) * rem;
    expect(top).toBe(78);
    // The words' box: 38rem less the 2 px border each side, pl-4, pr-2, the 24 px icon and its
    // 12 px gap (no buttons on the PIN screen): 544 px (544.8 measured).
    const wordsBox = 38 * rem - 2 * 2 - 16 - 8 - 24 - 12;
    expect(wordsBox).toBe(544);
    // Measured in Chromium (Electron 32): Inter 14 px, the till's font, and Segoe UI, its fallback.
    const inter = { late: 658.7, waiting: 584.5 };
    const segoe = { late: 613.6, waiting: 537 };
    for (const w of [inter.late, inter.waiting, segoe.late]) {
      expect(w).toBeGreaterThan(wordsBox); // one line cut them
      expect(w).toBeLessThan(2 * wordsBox - 120); // two lines hold them, a long word left over included
    }
    expect(segoe.waiting).toBeLessThan(wordsBox);
    // Height: border 4 + padding 16 + the title (18 px × 1.375) + two lines of words (14 px × 1.375).
    const twoLines = 4 + 16 + 18 * 1.375 + 2 * 14 * 1.375;
    expect(twoLines).toBe(83.25); // 82.45 measured
    expect(twoLines).toBeLessThanOrEqual(cap);
    // The PIN box, the keypad's top, at its highest: a short window with the card at the
    // top (LoginPage.tsx): 8 page + 24 card + 80 logo + 12 + 36 name + 12 + 24 "Enter your PIN".
    // (243 px measured at 1024 × 700 with the paused notice.)
    const keypadTop = 8 + 24 + 80 + 12 + 36 + 12 + 24;
    expect(top + cap).toBeLessThan(keypadTop); // 166 < 196: clear, even at the cap
    // One line ended by 78 + 72 = 150 (141.2 measured); two by 166 (160.45): still clear.
    expect(top + 4.5 * rem).toBeLessThan(keypadTop);
  });
});

describe('the pill says which order, whole', () => {
  const two = receiveOrder(withOrder, { orderId: 'o48', orderNumber: 'CO-20261001-0048', customerName: 'Test Customer' }, 1);
  const notIn = receiveFailure(
    EMPTY_ALERT_STATE,
    {
      webOrderId: 'w49',
      customerName: 'Test Customer',
      customerPhone: '0300-1234567',
      message: 'gave up after 5 attempts',
      reason: 'gave_up',
      silenced: false,
      at: new Date(0).toISOString(),
    },
    0,
  );
  const cancelledNoNumber = receiveFailure(
    EMPTY_ALERT_STATE,
    {
      webOrderId: 'w50',
      customerName: 'Test Customer',
      customerPhone: null,
      message: 'cancelled on the website while the kitchen had it',
      reason: 'cancelled_on_site',
      silenced: false,
      at: new Date(0).toISOString(),
    },
    0,
  );

  it('one new order by its number, several counted, the alarm by what happened', () => {
    expect(describePill(withOrder)).toBe('New order #0044');
    expect(describePill(two)).toBe('2 new orders');
    expect(describePill(withAlarm)).toBe('Cancelled #0045'); // the alarm beats the new order, as on the row
    expect(describePill(cancelledNoNumber)).toBe('Order cancelled');
    expect(describePill(notIn)).toBe('Order not in');
    expect(describePill(EMPTY_ALERT_STATE)).toBe('');
    // On the pill, the same words, with Seen.
    expect(text(banner({ state: two, compact: true }))).toBe('2 new orders Seen');
    expect(text(banner({ state: withAlarm, compact: true }))).toBe('Cancelled #0045 Seen');
    expect(text(banner({ state: notIn, compact: true }))).toBe('Order not in Seen');
    // Never a name or a phone, signed in or not: the pill shows on the PIN screen too.
    for (const state of [withOrder, two, withAlarm, notIn]) {
      for (const loggedIn of [false, true]) {
        const pill = banner({ state, compact: true, loggedIn });
        expect(pill).not.toContain('Test Customer');
        expect(pill).not.toContain('0300');
      }
    }
  });

  it('the words fit the pill whole (they were cut to "New or…" at 11rem)', () => {
    const pill = banner({ state: withOrder, compact: true });
    expect(box(pill).classes).toContain(PILL_MAX_WIDTH);
    expect(box(pill).classes).not.toContain('max-w-[11rem]');
    const max = Number(/^max-w-\[([\d.]+)rem\]$/.exec(PILL_MAX_WIDTH)![1]) * 16;
    // Around the words: pl-3, the 16 px bell, two 8 px gaps, Seen (px-3 and its word), pr-1.
    // Bold 14 px, measured in Chromium: Inter (the till's font), then Segoe UI.
    const seen = { inter: 34.6, segoe: 31.5 };
    const words: Record<string, { inter: number; segoe: number }> = {
      'New order #0044': { inter: 120.6, segoe: 113.9 },
      'Cancelled #0045': { inter: 118, segoe: 107.6 },
      '12 new orders': { inter: 94.9, segoe: 93.2 },
      'Order not in': { inter: 80.6, segoe: 80.6 },
    };
    for (const [w, width] of Object.entries(words)) {
      for (const font of ['inter', 'segoe'] as const) {
        const around = 12 + 16 + 8 + 8 + (24 + seen[font]) + 4;
        expect(around + width[font], `${w} in ${font}`).toBeLessThanOrEqual(max);
      }
    }
    // The old width cut even "New order" (70.8 px in Inter).
    expect(12 + 16 + 8 + 8 + 24 + seen.inter + 4 + 70.8).toBeGreaterThan(11 * 16);
    // Still a corner pill: at its widest it ends (6 px in) before the 460 px
    // "Close the till?" box starts at the 1024 px minimum window.
    expect(6 + max).toBeLessThan((1024 - 460) / 2);
  });
});
