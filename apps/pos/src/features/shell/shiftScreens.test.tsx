/**
 * The shift on screen (audit of the till's daily workflows, 2026-09-27),
 * rendered to static markup (react-dom/server, no browser; nothing calls the
 * till). Radix's dialog is stood in for by plain elements: a server render
 * has no portal, and these tests are about what the boxes say and when they
 * are there.
 *
 *   1. The close result (Expected, Counted, Over / Short) stays up until
 *      Done. Closing refreshes the shift status and the pill turns to "Open
 *      shift"; the result used to live inside the "shift open" branch and
 *      went with it at once. Only the login that closed sees it, and only
 *      Done closes it. Closed by a manager's PIN on a cashier's login: no
 *      expected cash, and it goes by itself after a minute.
 *   3. A cashier's tap on the shift pill says who can close and how they
 *      sign in (it was a disabled button with a hover-only title).
 *   5. "No shift is open" on Checkout and Live Orders, with "Open shift" for
 *      a login that may open one — sending to the kitchen is not blocked.
 *      When closing the last shift paused website orders on this till
 *      (v0.7.33), the banner, the top bar and the Open shift box say so.
 *   4. (the card) The Live Orders card shows the order's note: the counter's
 *      "Order notes" box and a website customer's note alike.
 *
 * Every name and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_ALERT_WATCH,
  type AlertWatch,
  type AuthenticatedUser,
  type OrderSnapshot,
  type Shift,
  type ShiftSummary,
  type UUID,
  type WebOrdersPauseView,
} from '@cheeseoclock/shared-types';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { OrderDetails } from '../checkout/OrderDetails';
import { OrdersBoardPage } from '../orders/OrdersBoardPage';
import { ALERT_WATCH_KEY } from '../notifications/useAlertWatch';
import {
  CASHIER_CANNOT_CLOSE,
  CASHIER_CLOSE_HOW,
  CloseShiftNotAllowedDialog,
  CloseShiftResultDialog,
  OpenShiftDialog,
  PIN_CLOSE_RESULT_NOTE,
  ShiftWidget,
} from './ShiftWidget';
import { NO_SHIFT_TEXT, NoShiftBanner } from './NoShiftBanner';
import {
  CLOSE_PAUSES_WEBSITE_NOTE,
  CLOSE_PAUSES_WEBSITE_TEXT,
  OPEN_RESUMES_WEBSITE_TEXT,
  WEB_PAUSED_BANNER_TEXT,
  WEB_PAUSED_LOGIN_TEXT,
  WEB_PAUSED_PILL,
  WEB_PAUSED_PILL_TITLE,
  WEB_PAUSED_TITLE,
} from './webOrdersPause';
import {
  dismissShiftCloseOutcome,
  PIN_CLOSE_RESULT_MS,
  showShiftCloseOutcome,
  useShiftCloseOutcome,
  type ShiftCloseOutcome,
} from './shiftCloseOutcome';

// What the last dialog was given to close itself with (Root's onOpenChange,
// Content's outside-tap and Escape handlers): Radix calls these on a tap on
// the dimmed area or on Escape.
const radix = vi.hoisted(() => ({ root: {} as Record<string, unknown>, content: {} as Record<string, unknown> }));

// A server render has no portal: the dialog's parts render in place.
vi.mock('@radix-ui/react-dialog', async () => {
  const React = await import('react');
  const h = React.createElement;
  type P = { children?: ReactNode; className?: string };
  const pass = ({ children }: P) => h(React.Fragment, null, children);
  const tag =
    (t: string, extra: Record<string, string> = {}) =>
    ({ children, className }: P) =>
      h(t, { className, ...extra }, children);
  const content = tag('div', { role: 'dialog' });
  return {
    Root: (props: P & Record<string, unknown>) => {
      radix.root = props;
      return pass(props);
    },
    Portal: pass,
    Overlay: () => null,
    Content: (props: P & Record<string, unknown>) => {
      radix.content = props;
      return content(props);
    },
    Title: tag('h2'),
    Description: tag('p'),
    Close: pass,
    Trigger: pass,
  };
});

// A server render reads a zustand store's server snapshot, which is the
// store's INITIAL state (nobody signed in, no close result). The till's
// window reads each store as it is now, and so do these renders.
vi.mock('zustand', async (importOriginal) => {
  const z = await importOriginal<typeof import('zustand')>();
  type Hook = ((select?: (state: unknown) => unknown) => unknown) & { getState: () => unknown };
  const live = (hook: Hook) =>
    Object.assign((select: (state: unknown) => unknown = (state) => state) => select(hook.getState()), hook);
  const make = (init: unknown) => live(z.create(init as Parameters<typeof z.create>[0]) as unknown as Hook);
  return { ...z, create: (init?: unknown) => (init === undefined ? make : make(init)) };
});

function signIn(role: AuthenticatedUser['role'], sessionId = 's1') {
  useSessionStore.setState({ user: { id: 'u1' as UUID, fullName: 'Test', role, sessionId: sessionId as UUID }, status: 'authenticated' });
}

function render(node: ReactNode, seed: Array<[readonly unknown[], unknown]> = []): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [key, data] of seed) qc.setQueryData(key, data);
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

/** The opening tag of the first button whose words include `label`. */
function buttonWith(markup: string, label: string): string {
  const buttons = markup.split('<button').slice(1);
  const hit = buttons.find((b) => text(`<x${b}`).includes(label));
  if (!hit) throw new Error(`No button "${label}"`);
  return `<button${hit.slice(0, hit.indexOf('>') + 1)}`;
}

/** A button's `disabled` attribute (not the `disabled:` styles in its class). */
const DISABLED = /\sdisabled(=|\s|>)/;

const OPEN_SHIFT = {
  id: 'shift-1',
  openedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
  openedByName: 'Ali',
} as unknown as Shift;

const SUMMARY = {
  shiftId: 'shift-1',
  paidOrderCount: 24,
  refundedOrderCount: 1,
  cashSalesCents: 1_234_000,
  cashRefundsCents: 50_000,
  cashInCents: 0,
  cashOutCents: 20_000,
} as unknown as ShiftSummary;

/** Closed Rs 100 short. */
const SHORT: ShiftCloseOutcome = {
  sessionId: 's1',
  shiftId: 'shift-1',
  expectedCents: 1_664_000,
  countedCents: 1_654_000,
  varianceCents: -10_000,
  summary: SUMMARY,
  closedByName: 'Sara',
  carriedUnpaidCount: 0,
  viaManagerPin: false,
};

const CURRENT = ['shifts', 'current'] as const;

afterEach(() => {
  dismissShiftCloseOutcome();
  useSessionStore.setState({ user: null, status: 'idle' });
});

// React warns that layout effects (the router's) do nothing in a server render: expected here.
const consoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (String(msg).includes('useLayoutEffect does nothing on the server')) return;
    consoleError(msg, ...rest);
  });
});
afterAll(() => vi.restoreAllMocks());

// ------------------------------------------------------------- 1. close result --

describe('the close result stays on screen until Done', () => {
  it('after the close the pill says "Open shift", and the result is still there: Expected, Counted, Short, Done', () => {
    signIn('manager');
    showShiftCloseOutcome(SHORT);
    // The shift status has refreshed: no shift open on this till now.
    const words = text(render(<ShiftWidget />, [[CURRENT, null]]));
    expect(words).toContain('Open shift');
    expect(words).toContain(`Expected cash ${formatCents(1_664_000)}`);
    expect(words).toContain(`Counted ${formatCents(1_654_000)}`);
    expect(words).toContain(`Variance ${formatCents(-10_000)}`);
    expect(words).toContain('Short (less than expected)');
    // The shift's cash, as the close box has always shown it once the count is in.
    expect(words).toContain(`Cash sales ${formatCents(1_234_000)}`);
    expect(words).toContain(`Cash taken out − ${formatCents(20_000)}`);
    expect(words).toContain('Done');
  });

  it('is there whatever the shift status says meanwhile: still loading, or the old answer (shift open) not refreshed yet', () => {
    signIn('admin');
    showShiftCloseOutcome({ ...SHORT, varianceCents: 0, countedCents: 1_664_000 });
    for (const seed of [[], [[CURRENT, OPEN_SHIFT]]] as Array<Array<[readonly unknown[], unknown]>>) {
      const words = text(render(<ShiftWidget />, seed));
      expect(words).toContain('Matches expected');
      expect(words).toContain('Done');
    }
  });

  it('an over shows as Over, amber', () => {
    signIn('manager');
    showShiftCloseOutcome({ ...SHORT, countedCents: 1_669_000, varianceCents: 5_000 });
    const out = render(<ShiftWidget />, [[CURRENT, null]]);
    expect(text(out)).toContain(`Variance +${formatCents(5_000)} Over (more than expected)`);
    expect(out).toContain('bg-amber-50');
  });

  it('Done takes it away; with nothing closed there is no result', () => {
    signIn('manager');
    showShiftCloseOutcome(SHORT);
    dismissShiftCloseOutcome();
    const words = text(render(<ShiftWidget />, [[CURRENT, null]]));
    expect(words).toContain('Open shift');
    expect(words).not.toContain('Expected cash');
    expect(words).not.toContain('Variance');
  });

  it('only the login that closed sees it: someone else signing in (the cashier after a hand-back) never gets it', () => {
    signIn('manager', 's1');
    showShiftCloseOutcome(SHORT);
    // The manager hands the till back; the cashier signs in.
    signIn('cashier', 's2');
    expect(useShiftCloseOutcome.getState().outcome).toBeNull();
    expect(text(render(<ShiftWidget />, [[CURRENT, null]]))).not.toContain('Expected cash');
    // Even a result left in the store for another login is not shown to this one.
    useShiftCloseOutcome.setState({ outcome: SHORT });
    expect(text(render(<ShiftWidget />, [[CURRENT, null]]))).not.toContain('Expected cash');
  });

  it('Done is the only way out: a tap on the dimmed area or Escape does not throw the numbers away', () => {
    const onDone = vi.fn();
    render(<CloseShiftResultDialog outcome={SHORT} onDone={onDone} />);
    // Radix's dismiss (outside tap, Escape) goes through onOpenChange: the result box has none.
    expect(radix.root['onOpenChange']).toBeUndefined();
    for (const handler of ['onPointerDownOutside', 'onInteractOutside', 'onEscapeKeyDown']) {
      const fn = radix.content[handler];
      expect(typeof fn, handler).toBe('function');
      const event = { preventDefault: vi.fn() };
      (fn as (e: typeof event) => void)(event);
      expect(event.preventDefault, handler).toHaveBeenCalled();
    }
    expect(onDone).not.toHaveBeenCalled();
  });

  describe('closed with a manager’s PIN on the cashier’s login', () => {
    // The till's reply leaves the expected cash out on this path (shifts-handlers).
    const VIA_PIN: ShiftCloseOutcome = { ...SHORT, expectedCents: null, summary: null, closedByName: 'Sara Manager', viaManagerPin: true };
    afterEach(() => vi.useRealTimers());

    it('the manager sees Counted and Over / Short — never the expected cash or the takings', () => {
      signIn('cashier');
      showShiftCloseOutcome(VIA_PIN);
      const words = text(render(<ShiftWidget />, [[CURRENT, null]]));
      expect(words).toContain(`Counted ${formatCents(1_654_000)}`);
      expect(words).toContain('Short (less than expected)');
      expect(words).toContain('Closed by Sara Manager.');
      expect(words).not.toContain('Expected cash');
      expect(words).not.toMatch(/Cash sales|Paid orders/);
      expect(words).toContain(PIN_CLOSE_RESULT_NOTE);
    });

    it('it goes by itself after a minute: not left up on the cashier’s login once the manager walks off', () => {
      vi.useFakeTimers();
      signIn('cashier');
      showShiftCloseOutcome(VIA_PIN);
      vi.advanceTimersByTime(PIN_CLOSE_RESULT_MS - 1);
      expect(useShiftCloseOutcome.getState().outcome).toBe(VIA_PIN);
      vi.advanceTimersByTime(1);
      expect(useShiftCloseOutcome.getState().outcome).toBeNull();
      expect(text(render(<ShiftWidget />, [[CURRENT, null]]))).not.toContain('Counted');
    });

    it('a manager’s own close stays until Done, however long it takes', () => {
      vi.useFakeTimers();
      signIn('manager');
      showShiftCloseOutcome(SHORT);
      vi.advanceTimersByTime(60 * PIN_CLOSE_RESULT_MS);
      expect(useShiftCloseOutcome.getState().outcome).toBe(SHORT);
      expect(text(render(<ShiftWidget />, [[CURRENT, null]]))).not.toContain(PIN_CLOSE_RESULT_NOTE);
    });
  });
});

// ------------------------------------------------------ 3. the cashier's tap --

describe('a cashier taps the shift pill', () => {
  it('the pill can be tapped (not a disabled button) and opens a box, with no arrow for a cashier', () => {
    signIn('cashier');
    const out = render(<ShiftWidget />, [[CURRENT, OPEN_SHIFT]]);
    const pill = buttonWith(out, 'Shift 1h 30m');
    expect(pill).not.toMatch(DISABLED);
    expect(pill).toContain('aria-haspopup="dialog"');
    // The hover title stays for a mouse.
    expect(pill).toContain('title="Only a manager or the owner can close the shift"');
    // Nothing is open until the tap.
    expect(text(out)).not.toContain(CASHIER_CANNOT_CLOSE);
  });

  it('the tap says who can close, and how they sign in on this till', () => {
    const words = text(render(<CloseShiftNotAllowedDialog shiftId="shift-1" onClose={() => {}} onManagerApproved={() => {}} />));
    expect(CASHIER_CANNOT_CLOSE).toBe('Only a manager or the owner can close the shift. Ask them to sign in and count the drawer.');
    expect(words).toContain(CASHIER_CANNOT_CLOSE);
    expect(words).toContain(CASHIER_CLOSE_HOW);
    expect(words).toContain('OK');
  });

  it('a manager’s pill still opens the close (the arrow is theirs)', () => {
    signIn('manager');
    const pill = buttonWith(render(<ShiftWidget />, [[CURRENT, OPEN_SHIFT]]), 'Shift 1h 30m');
    expect(pill).not.toMatch(DISABLED);
    expect(pill).toContain('title="Close shift + count cash"');
  });
});

// ------------------------------------------------------ 5. no shift open ------

describe('"No shift is open" on Checkout and Live Orders', () => {
  it('says so, with "Open shift", once the till has said there is no shift', () => {
    signIn('cashier');
    const out = render(<NoShiftBanner />, [[CURRENT, null]]);
    expect(out).toContain('role="alert"');
    expect(NO_SHIFT_TEXT).toBe('No shift is open — open the shift (count the float) before taking payment');
    expect(text(out)).toContain(NO_SHIFT_TEXT);
    expect(buttonWith(out, 'Open shift')).not.toMatch(DISABLED);
  });

  it('nothing while a shift is open, or while the till has not answered yet', () => {
    signIn('cashier');
    for (const out of [render(<NoShiftBanner />, [[CURRENT, OPEN_SHIFT]]), render(<NoShiftBanner />)]) {
      expect(out).not.toContain(NO_SHIFT_TEXT);
      expect(out).not.toContain('role="alert"');
    }
  });

  it('no "Open shift" for a login that may not open one', () => {
    useSessionStore.setState({ user: null, status: 'idle' });
    const words = text(render(<NoShiftBanner />, [[CURRENT, null]]));
    expect(words).toContain(NO_SHIFT_TEXT);
    expect(words).not.toContain('Open shift');
  });

  it('is on Checkout (under the order type) and on Live Orders; gone once a shift is open', () => {
    signIn('cashier');
    expect(text(render(<OrderDetails />, [[CURRENT, null]]))).toContain(NO_SHIFT_TEXT);
    expect(text(render(<OrderDetails />, [[CURRENT, OPEN_SHIFT]]))).not.toContain(NO_SHIFT_TEXT);
    const board = [['orders', 'active', 'all'], []] as [readonly unknown[], unknown];
    expect(text(render(<OrdersBoardPage />, [[CURRENT, null], board]))).toContain(NO_SHIFT_TEXT);
    expect(text(render(<OrdersBoardPage />, [[CURRENT, OPEN_SHIFT], board]))).not.toContain(NO_SHIFT_TEXT);
  });
});

// ------------------------------------- 5b. website orders paused (v0.7.33) ----

describe('website orders paused because no shift is open on this till', () => {
  const PAUSED: WebOrdersPauseView = { paused: true, since: '2026-10-01T18:42:00.000Z', websiteLinkSet: true };
  const watch = (webOrders: WebOrdersPauseView): [readonly unknown[], unknown] => [
    ALERT_WATCH_KEY,
    { ...EMPTY_ALERT_WATCH, webOrders } satisfies AlertWatch,
  ];
  const NOT_SAID: Array<Array<[readonly unknown[], unknown]>> = [
    [watch({ ...PAUSED, websiteLinkSet: false })],
    [watch({ paused: false, websiteLinkSet: true })],
    [],
  ];

  it('the words, exactly', () => {
    expect(WEB_PAUSED_TITLE).toBe('Website orders are paused');
    expect(WEB_PAUSED_LOGIN_TEXT).toBe('No shift is open on this till. Sign in and open a shift.');
    expect(WEB_PAUSED_BANNER_TEXT).toBe('Website orders are paused too. Opening the shift starts them again.');
    expect(WEB_PAUSED_PILL).toBe('Website paused');
    expect(WEB_PAUSED_PILL_TITLE).toBe(
      'Website orders are paused: no shift is open on this till. Open a shift to take them again.',
    );
    expect(OPEN_RESUMES_WEBSITE_TEXT).toBe('Opening the shift starts website orders again.');
    expect(CLOSE_PAUSES_WEBSITE_TEXT).toBe('Closing this shift pauses website orders until a shift is opened again.');
    expect(CLOSE_PAUSES_WEBSITE_NOTE).toBe('Orders already placed still come in and print.');
  });

  it('the no-shift banner says so under its own words, and the same "Open shift" starts them again', () => {
    signIn('cashier');
    const out = render(<NoShiftBanner />, [[CURRENT, null], watch(PAUSED)]);
    const words = text(out);
    expect(words).toContain(`${NO_SHIFT_TEXT} ${WEB_PAUSED_BANNER_TEXT}`);
    expect(buttonWith(out, 'Open shift')).not.toMatch(DISABLED);
  });

  it('the banner keeps to its own words when the link is not set, when not paused, or before the till has answered', () => {
    signIn('cashier');
    for (const seed of NOT_SAID) {
      const words = text(render(<NoShiftBanner />, [[CURRENT, null], ...seed]));
      expect(words).toContain(NO_SHIFT_TEXT);
      expect(words).not.toContain(WEB_PAUSED_BANNER_TEXT);
    }
    // A shift open: no banner at all, whatever the watch says.
    expect(text(render(<NoShiftBanner />, [[CURRENT, OPEN_SHIFT], watch(PAUSED)]))).toBe('');
  });

  it('the top bar: an amber "Website paused" pill beside "Open shift", with the reason as its title', () => {
    signIn('cashier');
    const out = render(<ShiftWidget />, [[CURRENT, null], watch(PAUSED)]);
    const pill = buttonWith(out, WEB_PAUSED_PILL);
    expect(pill).toContain(`title="${WEB_PAUSED_PILL_TITLE}"`);
    expect(pill).not.toMatch(DISABLED);
    expect(pill).toContain('bg-amber-100');
    // Beside "Open shift", after it.
    expect(text(out).indexOf(WEB_PAUSED_PILL)).toBeGreaterThan(text(out).indexOf('Open shift'));
  });

  it('no pill while a shift is open, when not paused, when the link is not set, or before the till has answered', () => {
    signIn('manager');
    expect(text(render(<ShiftWidget />, [[CURRENT, OPEN_SHIFT], watch(PAUSED)]))).not.toContain(WEB_PAUSED_PILL);
    for (const seed of NOT_SAID) {
      const words = text(render(<ShiftWidget />, [[CURRENT, null], ...seed]));
      expect(words).toContain('Open shift');
      expect(words).not.toContain(WEB_PAUSED_PILL);
    }
  });

  it('the Open shift box says opening starts website orders again, only while they are paused', () => {
    signIn('cashier');
    const words = text(render(<OpenShiftDialog onClose={() => {}} />, [watch(PAUSED)]));
    expect(words).toContain(OPEN_RESUMES_WEBSITE_TEXT);
    // At the top, before the float.
    expect(words.indexOf(OPEN_RESUMES_WEBSITE_TEXT)).toBeLessThan(words.indexOf('Opening cash (Rs)'));
    for (const seed of NOT_SAID) {
      expect(text(render(<OpenShiftDialog onClose={() => {}} />, seed))).not.toContain(OPEN_RESUMES_WEBSITE_TEXT);
    }
  });
});

// ------------------------------------------------ 4. the Live Orders card -----

function order(p: { id: string; source: 'pos' | 'web'; mode: 'takeaway' | 'delivery'; notes: string | null; deliveryNotes?: string | null }): OrderSnapshot {
  return {
    order: {
      id: p.id,
      orderNumber: `20260927-00${p.id}`,
      mode: p.mode,
      status: 'sent_to_kitchen',
      tableId: null,
      customerId: null,
      cashierId: 'u1',
      shiftId: 'shift-1',
      source: p.source,
      notes: p.notes,
      subtotalCents: 150_000,
      discountCents: 0,
      taxCents: 0,
      totalCents: 150_000,
      createdAt: new Date().toISOString(),
      paidAt: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      assignedRiderId: null,
      dispatchedAt: null,
      deliveredAt: null,
    },
    items: [],
    discounts: [],
    payments: [],
    cashierName: 'Ali',
    tableLabel: null,
    customerName: null,
    customerPhone: null,
    deliveryAddress: null,
    deliveryNotes: p.deliveryNotes ?? null,
    rider: null,
  } as unknown as OrderSnapshot;
}

describe('the Live Orders card shows the order’s note', () => {
  it('the counter’s "Order notes" and a website customer’s note alike; the website tag alone is not a note', () => {
    signIn('cashier');
    const words = text(
      render(<OrdersBoardPage />, [
        [CURRENT, OPEN_SHIFT],
        [
          ['orders', 'active', 'all'],
          [
            order({ id: '41', source: 'pos', mode: 'takeaway', notes: null, deliveryNotes: 'Collect by 7pm' }),
            order({ id: '42', source: 'web', mode: 'delivery', notes: '[web] Near the park, ring the bell twice' }),
            order({ id: '43', source: 'web', mode: 'takeaway', notes: '[web pick-up order]' }),
          ],
        ],
      ]),
    );
    expect(words).toContain('Order note: Collect by 7pm');
    expect(words).toContain('Order note: Near the park, ring the bell twice');
    expect(words).not.toContain('[web');
    expect(words.match(/Order note:/g)).toHaveLength(2);
  });
});
