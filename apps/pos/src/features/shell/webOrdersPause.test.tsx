/**
 * "Website orders are paused" on the PIN screen (v0.7.33): closing the last
 * shift on this till pauses website orders, and on 30 Sep – 1 Oct nobody at
 * the counter could see that the website was not taking orders. Rendered to
 * static markup (react-dom/server, no browser; nothing calls the till): the
 * till's answer is seeded where alerts:getWatch keeps it.
 *
 * The PIN screen's other words say "Sign in", like its own button.
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
import { LoginPage } from '../auth/LoginPage';
import { AlertBanner } from '../notifications/AlertBanner';
import { EMPTY_ALERT_STATE, receiveOrder } from '../notifications/alertState';
import { ALERT_WATCH_KEY } from '../notifications/useAlertWatch';
import {
  showWebOrdersPaused,
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
  it('the words, exactly: they name this till, and say what to do', () => {
    expect(WEB_PAUSED_TITLE).toBe('Website orders are paused');
    expect(WEB_PAUSED_LOGIN_TEXT).toBe('No shift is open on this till. Sign in and open a shift.');
  });

  it('a status note with both lines, on the till’s yes', () => {
    const out = render(<WebOrdersPausedNotice />, [[ALERT_WATCH_KEY, watch(PAUSED)]]);
    expect(out).toContain('role="status"');
    expect(text(out)).toBe(`${WEB_PAUSED_TITLE} ${WEB_PAUSED_LOGIN_TEXT}`);
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
