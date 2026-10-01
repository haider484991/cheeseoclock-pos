/**
 * The watch's notes on the alert banner (v0.7.33), rendered to static markup
 * (react-dom/server, no browser; nothing calls the till):
 *   - a note alone is an amber row read out politely (role=status), with no
 *     Seen: it goes when what it is about is dealt with;
 *   - "View" (Live Orders) only for someone signed in who may open it;
 *   - the alarm beats new orders, new orders beat notes, and "+N more"
 *     counts what waits behind;
 *   - while a popup is open the banner is the small pill, which a note alone
 *     does not get (OrderAlerts watches for popups while a note shows too).
 * Every name and amount is made up.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AlertBanner, type AlertBannerProps } from './AlertBanner';
import { EMPTY_ALERT_STATE, receiveFailure, receiveOrder, type AlertState } from './alertState';
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

describe('a popup is open (the small pill)', () => {
  it('a note alone shows nothing; a ringing order still gets the pill', () => {
    expect(banner({ notes: [TICKET, UNCONFIRMED], compact: true })).toBe('');
    const pill = banner({ state: withOrder, notes: [TICKET], compact: true });
    expect(text(pill)).toBe('New order Seen');
  });

  it('OrderAlerts watches for popups while a note alone shows, so the row never covers a payment', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'OrderAlerts.tsx'), 'utf8');
    expect(src).toMatch(/usePopupOpen\(hasPending \|\| notes\.length > 0\)/);
    expect(src).toMatch(/<AlertBanner[\s\S]*?notes=\{notes\}/);
  });
});
