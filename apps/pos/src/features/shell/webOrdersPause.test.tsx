/**
 * "Website orders are paused" on the PIN screen (v0.7.33): closing the last
 * shift on this till pauses website orders, and on 30 Sep – 1 Oct nobody at
 * the counter could see that the website was not taking orders. Rendered to
 * static markup (react-dom/server, no browser; nothing calls the till): the
 * till's answer is seeded where alerts:getWatch keeps it.
 *
 * The PIN screen's other words say "Sign in", like its own button.
 *
 * On a short window (the 1024×700 minimum, the usual 1366×768) the notice is
 * one line and the PIN screen trims its tagline, footer and spacing, so the
 * keypad's Enter row stays on screen with the "login ended on its own" note
 * showing too (measured in Segoe UI and Inter: Enter row ends at 668 px of
 * 700; it was 782).
 *
 * Every name and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EMPTY_ALERT_WATCH, type AlertWatch, type WebOrdersPauseView } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { LoginBrand, LoginPage, SHORT_SCREEN_MAX_HEIGHT } from '../auth/LoginPage';
import { AlertBanner } from '../notifications/AlertBanner';
import { EMPTY_ALERT_STATE, receiveOrder } from '../notifications/alertState';
import { ALERT_WATCH_KEY } from '../notifications/useAlertWatch';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  showWebOrdersPaused,
  WEB_PAUSED_LOGIN_LINE,
  WEB_PAUSED_LOGIN_TEXT,
  WEB_PAUSED_TITLE,
  WebOrdersPausedNotice,
} from './webOrdersPause';

// A server render reads a zustand store's server snapshot, which is the
// store's INITIAL state. The till's window reads each store as it is now,
// and so do these renders (the "why the till is back here" note).
vi.mock('zustand', async (importOriginal) => {
  const z = await importOriginal<typeof import('zustand')>();
  type Hook = ((select?: (state: unknown) => unknown) => unknown) & { getState: () => unknown };
  const live = (hook: Hook) =>
    Object.assign((select: (state: unknown) => unknown = (state) => state) => select(hook.getState()), hook);
  const make = (init: unknown) => live(z.create(init as Parameters<typeof z.create>[0]) as unknown as Hook);
  return { ...z, create: (init?: unknown) => (init === undefined ? make : make(init)) };
});

const PAUSED: WebOrdersPauseView = { paused: true, since: '2026-10-01T18:42:00.000Z', websiteLinkSet: true };
const watch = (webOrders: WebOrdersPauseView): AlertWatch => ({ ...EMPTY_ALERT_WATCH, webOrders });

type Seed = Array<[readonly unknown[], unknown]>;

function render(node: ReactNode, seed: Seed = [], afterSeed?: (qc: QueryClient) => void): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [key, data] of seed) qc.setQueryData(key, data);
  afterSeed?.(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>{node}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The page's words without its markup. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

afterEach(() => useSessionStore.setState({ user: null, status: 'idle', endedNote: null }));

// React warns that layout effects (the router's) do nothing in a server render: expected here.
const consoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (String(msg).includes('useLayoutEffect does nothing on the server')) return;
    consoleError(msg, ...rest);
  });
});
afterAll(() => vi.restoreAllMocks());

describe('the PIN screen says when website orders are paused', () => {
  it('the words, exactly: one line that says what to do', () => {
    // v0.7.33 review: two lines ("No shift is open on this till. Sign in and
    // open a shift.") pushed the keypad's Enter row off a 700 px window.
    expect(WEB_PAUSED_TITLE).toBe('Website orders are paused');
    expect(WEB_PAUSED_LOGIN_TEXT).toBe('sign in and open a shift.');
    expect(WEB_PAUSED_LOGIN_LINE).toBe('Website orders are paused — sign in and open a shift.');
  });

  it('a status note of one line, on the till’s yes', () => {
    const out = render(<WebOrdersPausedNotice />, [[ALERT_WATCH_KEY, watch(PAUSED)]]);
    expect(out).toContain('role="status"');
    expect(text(out)).toBe(WEB_PAUSED_LOGIN_LINE);
    // One block of words, centred (no second paragraph); tighter on a short window.
    expect(out).not.toContain('<p');
    const classes = /class="([^"]*)"/.exec(out)![1]!.split(' ');
    for (const c of ['text-center', 'py-2', 'mb-3', '[@media(max-height:820px)]:py-1.5', '[@media(max-height:820px)]:mb-2']) {
      expect(classes).toContain(c);
    }
  });

  it('nothing when not paused, when the website link is not set, or before the till has answered', () => {
    for (const out of [
      render(<WebOrdersPausedNotice />, [[ALERT_WATCH_KEY, watch({ paused: false, websiteLinkSet: true })]]),
      render(<WebOrdersPausedNotice />, [[ALERT_WATCH_KEY, watch({ ...PAUSED, websiteLinkSet: false })]]),
      render(<WebOrdersPausedNotice />, [[ALERT_WATCH_KEY, EMPTY_ALERT_WATCH]]),
      render(<WebOrdersPausedNotice />),
    ]) {
      expect(text(out)).toBe('');
      expect(out).not.toContain('role="status"');
    }
  });

  it('nothing when the last read failed: an old yes is not shown as if it were true now', () => {
    const out = render(<WebOrdersPausedNotice />, [[ALERT_WATCH_KEY, watch(PAUSED)]], (qc) => {
      const q = qc.getQueryCache().find({ queryKey: ALERT_WATCH_KEY })!;
      q.setState({ ...q.state, status: 'error', error: new Error('The till did not answer') });
    });
    expect(text(out)).toBe('');
    expect(out).not.toContain('role="status"');
  });

  it('showWebOrdersPaused: only paused AND the website link set', () => {
    expect(showWebOrdersPaused(undefined)).toBe(false);
    expect(showWebOrdersPaused(null)).toBe(false);
    expect(showWebOrdersPaused({ paused: true, websiteLinkSet: true })).toBe(true);
    expect(showWebOrdersPaused({ paused: true, websiteLinkSet: false })).toBe(false);
    expect(showWebOrdersPaused({ paused: false, websiteLinkSet: true })).toBe(false);
    expect(showWebOrdersPaused({ paused: false, websiteLinkSet: false })).toBe(false);
  });

  it('is on the PIN screen, in the card under the "why the till is back here" note, above the keypad', () => {
    useSessionStore.setState({ endedNote: 'Signed out after 10 minutes with no taps.' });
    const words = text(render(<LoginPage />, [[ALERT_WATCH_KEY, watch(PAUSED)]]));
    expect(words).toContain(WEB_PAUSED_TITLE);
    expect(words).toContain(WEB_PAUSED_LOGIN_TEXT);
    const ended = words.indexOf('Signed out after 10 minutes with no taps.');
    const paused = words.indexOf(WEB_PAUSED_TITLE);
    expect(ended).toBeGreaterThan(-1);
    expect(paused).toBeGreaterThan(ended);
    expect(words.indexOf('Enter your PIN')).toBeGreaterThan(paused);
    expect(words).toContain('Use a password');
  });

  it('not on the PIN screen without the till’s yes', () => {
    expect(text(render(<LoginPage />))).not.toContain(WEB_PAUSED_TITLE);
    expect(text(render(<LoginPage />, [[ALERT_WATCH_KEY, EMPTY_ALERT_WATCH]]))).not.toContain(WEB_PAUSED_TITLE);
  });

  it('a short window trims the PIN screen: no tagline or footer line, tighter card, notes and keypad', () => {
    useSessionStore.setState({ endedNote: "Test Cashier's login ended on its own. Sign in again to carry on." });
    const qc: Seed = [
      [ALERT_WATCH_KEY, watch(PAUSED)],
      [['system', 'branding'], { storeName: 'Test Shop', storeTagline: 'Made-up tagline' }],
    ];
    const out = render(<LoginPage />, qc);
    const short = (c: string) => `[@media(max-height:${SHORT_SCREEN_MAX_HEIGHT}px)]:${c}`;
    /** The class list of the element that holds exactly these words. */
    const classesOf = (words: string) => {
      const at = out.indexOf(`>${words}<`);
      expect(at).toBeGreaterThan(-1);
      const open = out.lastIndexOf('class="', at);
      return out.slice(open + 7, out.indexOf('"', open + 7)).split(' ');
    };
    expect(text(out)).toContain('Made-up tagline'); // still there on a tall window
    expect(classesOf('Made-up tagline')).toContain(short('hidden'));
    expect(classesOf('Built for restaurants · Offline-first · FBR-ready')).toContain(short('hidden'));
    expect(classesOf('Test Shop')).toContain(short('mt-0'));
    expect(classesOf("Test Cashier's login ended on its own. Sign in again to carry on.".replace("'", '&#x27;'))).toEqual(
      expect.arrayContaining([short('py-1.5'), short('mb-2')]),
    );
    expect(classesOf('Enter your PIN')).toContain(short('mb-2'));
    expect(out).toContain(`p-8 shadow-soft-lg ring-1 ring-stone-200/60 dark:ring-stone-700/60 ${short('p-6')}`);
    expect(out).toMatch(/class="flex flex-col gap-4 \[@media\(max-height:820px\)\]:gap-2"/);
    expect(out.slice(0, out.indexOf('>') + 1)).toContain(short('py-2'));
    // The same line as Checkout's "short screens" in globals.css.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'styles', 'globals.css'), 'utf8');
    expect(css).toContain(`@media (max-height: ${SHORT_SCREEN_MAX_HEIGHT}px)`);
  });

  it('the Branding settings preview keeps the tagline on any window: only the PIN screen trims it', () => {
    const out = renderToStaticMarkup(<LoginBrand storeName="Test Shop" tagline="Made-up tagline" />);
    expect(out).toContain('Made-up tagline');
    expect(out).not.toContain('max-height');
  });

  it('the PIN screen scrolls rather than clipping the keypad on a short window', () => {
    const out = render(<LoginPage />, [[ALERT_WATCH_KEY, watch(PAUSED)]]);
    const outer = out.slice(0, out.indexOf('>') + 1);
    expect(outer).toContain('overflow-y-auto');
    expect(outer).not.toContain('overflow-hidden');
    expect(outer).not.toContain('items-center');
    expect(out).toContain('my-auto w-[460px]');
  });
});

describe('the PIN screen says "Sign in", like its own button', () => {
  it('a new website order rung on the PIN screen: "Sign in to open Live Orders"', () => {
    const state = receiveOrder(
      EMPTY_ALERT_STATE,
      {
        orderId: 'o42',
        orderNumber: 'CO-20261001-0042',
        customerName: 'Ali',
        webOrderId: 'w42',
        fulfilment: 'delivery',
        totalCents: 185_000,
        totalMismatch: null,
      },
      0,
    );
    const banner = (loggedIn: boolean) =>
      text(
        renderToStaticMarkup(
          <AlertBanner
            state={state}
            notes={[]}
            loggedIn={loggedIn}
            canView={loggedIn}
            compact={false}
            formatMoney={(c) => `Rs ${c / 100}`}
            onView={() => {}}
            onSeen={() => {}}
            onCloseFailure={() => {}}
          />,
        ),
      );
    expect(banner(false)).toContain('· sign in to open Live Orders');
    expect(banner(false)).not.toMatch(/log in/i);
    expect(banner(true)).not.toContain('sign in');
  });
});
