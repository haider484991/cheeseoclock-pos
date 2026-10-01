/**
 * Closing the shift on screen, as the owner decided on 27 Sep 2026 (rendered
 * to static markup — react-dom/server, no browser; nothing calls the till):
 *
 *   A. A cashier's tap on the shift pill offers "A manager closes the shift":
 *      the manager's PIN or password first (the same approval box as a refund
 *      or a cash out), then the close box — which, on a cashier's login,
 *      fetches and shows nothing of the shift's money before the count.
 *   B. The manager sees Over / Short after the count, until Done.
 *   C. Unpaid orders on this till are listed in the close box with a
 *      required reason; the result and Shift history say how many were
 *      carried over, why, and who approved it.
 *   D. (v0.7.33) When the close pauses website orders on this till, the
 *      close box says so before "Close shift" — a warning, not a gate.
 *
 * Radix's dialog is stood in for by plain elements (a server render has no
 * portal). Every name and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, ReportShiftLine, ShiftCloseCheck, ShiftSummary, UUID } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { shiftCarryOverText, shiftDetailLines } from '../reports/reportFormat';
import { TeamLeakageTab } from '../reports/tabs/TeamLeakageTab';
import {
  CASHIER_CANNOT_CLOSE,
  closeShiftRequest,
  CloseShiftDialog,
  CloseShiftNotAllowedDialog,
  CloseShiftResultDialog,
  hasNewUnpaid,
  MANAGER_CLOSES_LABEL,
  PIN_CLOSE_RESULT_NOTE,
  UnpaidCarryOver,
} from './ShiftWidget';
import type { ShiftCloseOutcome } from './shiftCloseOutcome';
import { CLOSE_PAUSES_WEBSITE_NOTE, CLOSE_PAUSES_WEBSITE_TEXT } from './webOrdersPause';

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
  return {
    Root: pass,
    Portal: pass,
    Overlay: () => null,
    Content: tag('div', { role: 'dialog' }),
    Title: tag('h2'),
    Description: tag('p'),
    Close: pass,
    Trigger: pass,
  };
});

// What each render asked the till for (a cashier's login must not ask for the shift's money).
const asked = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../ipc/client', () => {
  const record = (name: string) => (..._args: unknown[]) => {
    asked.calls.push(name);
    return new Promise(() => {});
  };
  return {
    ipc: {
      shifts: {
        summary: record('summary'),
        closeCheck: record('closeCheck'),
        close: record('close'),
        openDrawer: record('openDrawer'),
      },
      alerts: {
        getWatch: record('getWatch'),
      },
    },
    onAlertWatchChanged: () => () => {},
  };
});

function signIn(role: AuthenticatedUser['role']) {
  useSessionStore.setState({ user: { id: 'u1' as UUID, fullName: 'Test', role, sessionId: 's1' as UUID }, status: 'authenticated' });
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
const DISABLED = /\sdisabled(=|\s|>)/;

const UNPAID: ShiftCloseCheck['unpaidOrders'] = [
  { orderId: 'o1' as UUID, orderNumber: '20260925-0042', createdAt: '2026-09-25T15:00:00.000Z', totalCents: 124_000 as never, takenBy: 'Ali' },
  { orderId: 'o2' as UUID, orderNumber: '20260927-0007', createdAt: '2026-09-27T16:30:00.000Z', totalCents: 86_000 as never, takenBy: 'Website' },
];
const VIA_PIN: ShiftCloseCheck = { closerName: 'Sara Manager', viaManagerPin: true, unpaidOrders: [], pausesWebsiteOrders: false };

const consoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (String(msg).includes('useLayoutEffect does nothing on the server')) return;
    consoleError(msg, ...rest);
  });
});
afterAll(() => vi.restoreAllMocks());
afterEach(() => {
  asked.calls.length = 0;
  useSessionStore.setState({ user: null, status: 'idle' });
});

describe('A. a cashier’s tap on the shift pill: "A manager closes the shift"', () => {
  it('first says who can close, and offers the manager’s way in', () => {
    signIn('cashier');
    const out = render(<CloseShiftNotAllowedDialog shiftId="shift-1" onClose={() => {}} onManagerApproved={() => {}} />);
    expect(text(out)).toContain(CASHIER_CANNOT_CLOSE);
    expect(text(out)).toContain(MANAGER_CLOSES_LABEL);
    expect(MANAGER_CLOSES_LABEL).toBe('A manager closes the shift');
    // Nothing asked of the till yet: no PIN, no shift, no money.
    expect(asked.calls).toEqual([]);
  });

  it('then the manager’s PIN or password, the same approval box as a refund — the close box is not open yet', () => {
    signIn('cashier');
    const out = render(
      <CloseShiftNotAllowedDialog shiftId="shift-1" onClose={() => {}} onManagerApproved={() => {}} initialStep="pin" />,
    );
    const words = text(out);
    expect(words).toContain('Manager approval required');
    expect(out).toContain('aria-label="Manager PIN or password"');
    expect(words).toContain('the shift is closed in your name');
    // Nothing typed yet: the button waits for it.
    expect(buttonWith(out, 'Count the drawer')).toMatch(DISABLED);
    expect(words).not.toContain('Counted cash in drawer');
    expect(words).not.toMatch(/Expected|Cash sales/);
  });

  it('the close box on a cashier’s login (after the PIN): who closes, the blind count, and no request for the shift’s money', () => {
    signIn('cashier');
    // Even with the shift's totals in the screen's memory, a PIN close shows none of them.
    const totals = { paidOrderCount: 24, refundedOrderCount: 1 } as unknown as ShiftSummary;
    const out = render(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={VIA_PIN} />, [
      [['shifts', 'summary', 'shift-1'], totals],
    ]);
    const words = text(out);
    expect(words).toContain("Closing as Sara Manager (manager's PIN).");
    expect(words).toContain('Counted cash in drawer (Rs)');
    expect(words).toContain('Open drawer to count');
    expect(words).not.toMatch(/Expected|Cash sales|Paid orders/);
    // The till was asked for nothing on the way in: the PIN step already checked, and no totals.
    expect(asked.calls).not.toContain('summary');
    expect(asked.calls).not.toContain('closeCheck');
    // No unpaid orders: no reason asked.
    expect(words).not.toContain('Why are they carried over?');
  });

  it('a manager signed in closes as before: the totals they always saw, no PIN line', () => {
    signIn('manager');
    const summary = { paidOrderCount: 24, refundedOrderCount: 1 } as unknown as ShiftSummary;
    const out = render(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} />, [
      [['shifts', 'summary', 'shift-1'], summary],
      [['shifts', 'closeCheck', 'shift-1'], { closerName: 'Test', viaManagerPin: false, unpaidOrders: [], pausesWebsiteOrders: false }],
    ]);
    const words = text(out);
    expect(words).toContain('Paid orders 24');
    expect(words).not.toContain("manager's PIN");
    // Still blind: no expected cash before the count.
    expect(words).not.toContain('Expected');
  });
});

describe('B. the manager sees Over / Short after the count, until Done', () => {
  const outcome: ShiftCloseOutcome = {
    sessionId: 's1',
    shiftId: 'shift-1',
    expectedCents: 500_000,
    countedCents: 490_000,
    varianceCents: -10_000,
    summary: null,
    closedByName: 'Sara Manager',
    carriedUnpaidCount: 2,
    viaManagerPin: false,
  };
  it('Expected, Counted, Short, who closed it and what was carried over', () => {
    const words = text(render(<CloseShiftResultDialog outcome={outcome} onDone={() => {}} />));
    expect(words).toContain('Expected cash Rs 5,000');
    expect(words).toContain('Counted Rs 4,900');
    expect(words).toContain('Short (less than expected)');
    expect(words).toContain('Closed by Sara Manager. 2 unpaid orders were carried over to the next shift.');
    expect(words).toContain('Done');
  });

  it('by the manager’s PIN on the cashier’s login: Over / Short, but no expected cash on the cashier’s screen', () => {
    const words = text(
      render(<CloseShiftResultDialog outcome={{ ...outcome, expectedCents: null, viaManagerPin: true }} onDone={() => {}} />),
    );
    expect(words).toContain('Counted Rs 4,900');
    expect(words).toContain('Short (less than expected)');
    expect(words).toContain('Closed by Sara Manager.');
    expect(words).not.toContain('Expected cash');
    expect(words).toContain(PIN_CLOSE_RESULT_NOTE);
  });
});

describe('C. unpaid orders: listed, a reason required, then carried over', () => {
  it('the close box lists each unpaid order (number, when, taken by, total) and asks why', () => {
    signIn('manager');
    const out = render(
      <CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={{ ...VIA_PIN, unpaidOrders: UNPAID }} />,
    );
    const words = text(out);
    expect(words).toContain('2 orders on this till are not paid yet.');
    expect(words).toContain('They stay unpaid and carry over to the next shift; the money goes to whichever shift takes it.');
    expect(words).toMatch(/#0042 · 25 Sep, .+ · Ali Rs 1,240/);
    expect(words).toMatch(/#0007 · 27 Sep, .+ · Website Rs 860/);
    expect(words).toContain('Why are they carried over? (required)');
    // Nothing counted and no reason yet: the close waits.
    expect(buttonWith(out, 'Close shift')).toMatch(DISABLED);
  });

  it('the close sends the orders it showed, so one that came in during the count is refused, not carried', () => {
    expect(
      closeShiftRequest({
        shiftId: 'shift-1',
        counted: '4900',
        notes: '  Rs 100 short  ',
        unpaid: UNPAID,
        carryOverReason: '  Rider still out ',
        approverPin: 'Manager-pass-7',
      }),
    ).toEqual({
      shiftId: 'shift-1',
      countedCashCents: 490_000,
      notes: 'Rs 100 short',
      carryOverReason: 'Rider still out',
      carryOverOrderIds: ['o1', 'o2'],
      approverPin: 'Manager-pass-7',
    });
    // None shown: an empty list (the till refuses a close that would carry one), no reason, no PIN.
    expect(closeShiftRequest({ shiftId: 'shift-1', counted: '5000', notes: '', unpaid: [], carryOverReason: 'x' })).toEqual({
      shiftId: 'shift-1',
      countedCashCents: 500_000,
      notes: null,
      carryOverOrderIds: [],
    });
  });

  it('after a refused close the list is asked again; a new unpaid order means the reason is typed again', () => {
    const now = (ids: string[]): ShiftCloseCheck => ({
      ...VIA_PIN,
      unpaidOrders: ids.map((id) => ({ ...UNPAID[0]!, orderId: id as UUID })),
    });
    expect(hasNewUnpaid(UNPAID, now(['o1', 'o2', 'o3']))).toBe(true);
    expect(hasNewUnpaid([], now(['o3']))).toBe(true);
    // The same orders, or one paid off meanwhile: the reason given still stands.
    expect(hasNewUnpaid(UNPAID, now(['o1', 'o2']))).toBe(false);
    expect(hasNewUnpaid(UNPAID, now(['o2']))).toBe(false);
  });

  it('one order reads as one', () => {
    const words = text(render(<UnpaidCarryOver orders={UNPAID.slice(0, 1)} reason="" onReason={() => {}} />));
    expect(words).toContain('1 order on this till is not paid yet.');
    expect(words).toContain('It stays unpaid and carries over to the next shift');
  });

  const shiftLine = (p: Partial<ReportShiftLine>): ReportShiftLine => ({
    id: 's1',
    openedAt: '2026-09-26T07:00:00.000Z',
    closedAt: '2026-09-26T20:00:00.000Z',
    openedBy: 'Ali',
    closedBy: 'Sara Manager',
    openingCashCents: 500_000,
    expectedCashCents: 500_000,
    countedCashCents: 500_000,
    varianceCents: 0,
    cashInCents: 0,
    cashOutCents: 0,
    cashMovementCount: 0,
    noSaleOpens: 0,
    openingNote: null,
    closingNote: null,
    carriedUnpaidCount: 0,
    carryOverReason: null,
    ...p,
  });

  it('Shift history says how many, why and who approved — and nothing when none were carried', () => {
    expect(shiftCarryOverText(shiftLine({}))).toBeNull();
    expect(shiftCarryOverText(shiftLine({ carriedUnpaidCount: 2, carryOverReason: 'Rider still out' }))).toBe(
      '2 unpaid orders carried over — Rider still out — approved by Sara Manager',
    );
    expect(shiftCarryOverText(shiftLine({ carriedUnpaidCount: 1, carryOverReason: 'Pays tomorrow' }))).toBe(
      '1 unpaid order carried over — Pays tomorrow — approved by Sara Manager',
    );
    // The print and CSV lines: the notes, then the carry-over.
    expect(
      shiftDetailLines(shiftLine({ openingNote: 'Evening', closingNote: 'All good', carriedUnpaidCount: 2, carryOverReason: 'Rider still out' })),
    ).toEqual(['Opening note: Evening', 'Closing note: All good', '2 unpaid orders carried over — Rider still out — approved by Sara Manager']);

    const team = {
      sinceIso: '2026-09-20T00:00:00.000Z',
      untilIso: '2026-09-27T00:00:00.000Z',
      engine: 'worker',
      kpis: { netSalesCents: 0, menuSalesCents: 0, partialRefundCents: 0, fullRefundCents: 0, voidCount: 0, voidCents: 0 },
      staff: [],
      shifts: [shiftLine({ carriedUnpaidCount: 2, carryOverReason: 'Rider still out' })],
      discounts: { totalCount: 0, totalCents: 0, byReason: [], byPerson: [], recent: [] },
      refunds: [],
      voids: [],
      drawerOpens: [],
      drawerOpenCount: 0,
      foodCost: { hasCosts: true },
    } as unknown as Parameters<typeof TeamLeakageTab>[0]['data'];
    expect(text(render(<TeamLeakageTab now={new Date('2026-09-27T10:00:00.000Z')} data={team} />))).toContain(
      '2 unpaid orders carried over — Rider still out — approved by Sara Manager',
    );
  });
});

describe('D. the close box says when the close pauses website orders', () => {
  const both = (words: string) => words.includes(CLOSE_PAUSES_WEBSITE_TEXT) && words.includes(CLOSE_PAUSES_WEBSITE_NOTE);
  /** The close box's "Close shift" button, as rendered. */
  const closeButton = (node: ReactNode, seed: Array<[readonly unknown[], unknown]> = []) =>
    buttonWith(render(node, seed), 'Close shift');

  it('on a manager’s PIN (the cashier’s login): both lines, before "Close shift"', () => {
    signIn('cashier');
    const out = render(
      <CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={{ ...VIA_PIN, pausesWebsiteOrders: true }} />,
    );
    const words = text(out);
    expect(both(words)).toBe(true);
    expect(out).toContain('role="note"');
    expect(words.indexOf(CLOSE_PAUSES_WEBSITE_TEXT)).toBeLessThan(words.lastIndexOf('Close shift'));
    // Still no money before the count.
    expect(words).not.toMatch(/Expected|Cash sales|Paid orders/);
  });

  it('a manager signed in: the same two lines', () => {
    signIn('manager');
    const words = text(
      render(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} />, [
        [['shifts', 'closeCheck', 'shift-1'], { closerName: 'Test', viaManagerPin: false, unpaidOrders: [], pausesWebsiteOrders: true }],
      ]),
    );
    expect(both(words)).toBe(true);
  });

  it('neither line when the close does not pause them', () => {
    signIn('manager');
    const pin = text(render(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={VIA_PIN} />));
    const own = text(
      render(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} />, [
        [['shifts', 'closeCheck', 'shift-1'], { closerName: 'Test', viaManagerPin: false, unpaidOrders: [], pausesWebsiteOrders: false }],
      ]),
    );
    for (const words of [pin, own]) {
      expect(words).not.toContain(CLOSE_PAUSES_WEBSITE_TEXT);
      expect(words).not.toContain(CLOSE_PAUSES_WEBSITE_NOTE);
    }
  });

  it('a warning, not a gate: "Close shift" is exactly as it is without it', () => {
    signIn('manager');
    // A static render cannot type the count, so the button waits for it in
    // both; what matters is that the warning changes nothing about it.
    expect(
      closeButton(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={{ ...VIA_PIN, pausesWebsiteOrders: true }} />),
    ).toBe(closeButton(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={VIA_PIN} />));
    const seeded = (pausesWebsiteOrders: boolean): Array<[readonly unknown[], unknown]> => [
      [['shifts', 'closeCheck', 'shift-1'], { closerName: 'Test', viaManagerPin: false, unpaidOrders: [], pausesWebsiteOrders }],
    ];
    expect(closeButton(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} />, seeded(true))).toBe(
      closeButton(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} />, seeded(false)),
    );
  });
});
