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
 *   E. (v0.7.34, review fixes B) This shift's deliveries whose refused item
 *      is still to refund ("Customer refused an item" at Delivered + Pay) are
 *      listed — "#0042: customer refused an item - refund not done yet" — so
 *      the manager sees why the drawer is short. A note, never a gate.
 *   F. (v0.7.35) The drawer is counted note by note (owner, 2 Oct 2026:
 *      Rs 5,000, 1,000, 500, 100, 50, 20, 10, plus coins and other; closing
 *      only, always by note): eight rows, a pad beside them, the total the
 *      till adds up, still blind. Leaving a started count asks first; the
 *      result shows the notes under Counted.
 *   G. (v0.7.35) The shift report prints at every close (owner, 2 Oct
 *      2026): the result says what became of it — printing, with Print
 *      again; did not print, in amber, with Try again; off, with Print it;
 *      no printer; not made — on the PIN result too, which still shows no
 *      figures. The result's figures are the close's own (its reply).
 *
 * Radix's dialog is stood in for by plain elements (a server render has no
 * portal). Every name and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CASH_NOTE_FACE_CENTS,
  type AuthenticatedUser,
  type CashCount,
  type ReportShiftLine,
  type ShiftCloseCheck,
  type ShiftSummary,
  type UUID,
} from '@cheeseoclock/shared-types';
import { cashCountJson } from '@cheeseoclock/pos-domain';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { shiftCarryOverText, shiftDetailLines } from '../reports/reportFormat';
import { TeamLeakageTab } from '../reports/tabs/TeamLeakageTab';
import {
  CASHIER_CANNOT_CLOSE,
  CLOSE_HINT_CHECKING,
  CLOSE_HINT_COINS_LARGE,
  CLOSE_HINT_NOT_STARTED,
  CLOSE_HINT_REASON,
  CLOSE_SHIFT_DESCRIPTION,
  closeShiftHint,
  confirmClearAll,
  closeShiftRequest,
  CloseShiftDialog,
  CloseShiftNotAllowedDialog,
  CloseShiftResultDialog,
  hasNewUnpaid,
  leaveCloseShift,
  MANAGER_CLOSES_LABEL,
  PIN_CLOSE_RESULT_NOTE,
  REFUSED_ITEMS_OWED_NOTE,
  SHIFT_REPORT_NO_PRINTER,
  SHIFT_REPORT_NOT_MADE,
  SHIFT_REPORT_OFF,
  SHIFT_REPORT_PRINTING,
  shiftReportLine,
  STOP_CLOSING_QUESTION,
  UnpaidCarryOver,
} from './ShiftWidget';
import { CLEAR_ALL_QUESTION, NOTE_COUNTER_FIRST_ROW, NoteCounter, noteCounterKeyAction } from './NoteCounter';
import { noteCounterInitial, noteCounterKey, noteCounterToCount, type NoteCounterState } from './noteCounterState';
import {
  dismissShiftCloseOutcome,
  noteShiftReportFailed,
  PIN_CLOSE_RESULT_MS,
  showShiftCloseOutcome,
  useShiftCloseOutcome,
  type ShiftCloseOutcome,
} from './shiftCloseOutcome';
import { CLOSE_PAUSES_WEBSITE_NOTE, CLOSE_PAUSES_WEBSITE_TEXT } from './webOrdersPause';

// What the last dialog was given to close itself with (Root's onOpenChange,
// Content's Escape and outside-tap handlers): Radix calls these on Escape
// and on a tap on the dimmed area.
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

// The in-window "Are you sure?" (never the browser's confirm()): what it was
// asked, and the answer it gives.
const confirmAsk = vi.hoisted(() => ({ answer: false, calls: [] as Array<[string, unknown]> }));
vi.mock('../../components/confirm/ConfirmHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/confirm/ConfirmHost')>()),
  askConfirm: (message: string, opts: unknown) => {
    confirmAsk.calls.push([message, opts]);
    return Promise.resolve(confirmAsk.answer);
  },
}));

// What each render asked the till for (a cashier's login must not ask for the shift's money).
// `closeReply` / `printReply`: what Close shift and the shift report's print answer (unset: no answer yet).
const asked = vi.hoisted(() => ({
  calls: [] as string[],
  closeReply: null as unknown,
  printReply: null as unknown,
  printRequests: [] as unknown[],
}));
vi.mock('../../ipc/client', () => {
  const record = (name: string) => (..._args: unknown[]) => {
    asked.calls.push(name);
    return new Promise(() => {});
  };
  class IpcError extends Error {
    readonly code: string;
    readonly details?: Record<string, unknown>;
    constructor(e: { code: string; message: string; details?: Record<string, unknown> }) {
      super(e.message);
      this.code = e.code;
      if (e.details) this.details = e.details;
    }
  }
  return {
    IpcError,
    ipc: {
      shifts: {
        summary: record('summary'),
        closeCheck: record('closeCheck'),
        close: (...args: unknown[]) => (asked.closeReply ? Promise.resolve(asked.closeReply) : record('close')(...args)),
        openDrawer: record('openDrawer'),
        printReport: (request: unknown) => {
          asked.calls.push('printReport');
          asked.printRequests.push(request);
          return asked.printReply ? Promise.resolve(asked.printReply) : new Promise(() => {});
        },
      },
      alerts: {
        getWatch: record('getWatch'),
      },
    },
    onAlertWatchChanged: () => () => {},
  };
});

// A server render reads a zustand store's server snapshot, which is the
// store's INITIAL state (nobody signed in, no close result). The till's
// window reads each store as it is now, and so do these renders (the close
// box keeps the result for the login that closed it).
vi.mock('zustand', async (importOriginal) => {
  const z = await importOriginal<typeof import('zustand')>();
  type Hook = ((select?: (state: unknown) => unknown) => unknown) & { getState: () => unknown };
  const live = (hook: Hook) =>
    Object.assign((select: (state: unknown) => unknown = (state) => state) => select(hook.getState()), hook);
  const make = (init: unknown) => live(z.create(init as Parameters<typeof z.create>[0]) as unknown as Hook);
  return { ...z, create: (init?: unknown) => (init === undefined ? make : make(init)) };
});

// Each Button as rendered, with its words and its tap; and every toast.
const seen = vi.hoisted(() => ({
  buttons: [] as Array<{ words: string; tap: (() => void) | undefined; disabled: boolean }>,
  toasts: [] as Array<{ title: string; description?: string; variant?: string }>,
}));
vi.mock('@cheeseoclock/ui', async (importOriginal) => {
  const ui = await importOriginal<typeof import('@cheeseoclock/ui')>();
  const React = await import('react');
  const words = (n: unknown): string =>
    typeof n === 'string' || typeof n === 'number'
      ? String(n)
      : Array.isArray(n)
        ? n.map(words).join('')
        : React.isValidElement(n)
          ? words((n.props as { children?: unknown }).children)
          : '';
  type Props = React.ComponentProps<typeof ui.Button>;
  const Button = React.forwardRef<HTMLButtonElement, Props>(function Button(props, ref) {
    const onClick = props.onClick;
    seen.buttons.push({
      words: words(props.children).trim(),
      tap: onClick ? () => onClick({ preventDefault() {}, stopPropagation() {} } as never) : undefined,
      disabled: props.disabled === true,
    });
    return React.createElement(ui.Button, { ...props, ref });
  });
  return { ...ui, Button };
});
vi.mock('../../components/toast/ToastProvider', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../components/toast/ToastProvider')>();
  const toast = (t: { title: string; description?: string; variant?: string }) => {
    seen.toasts.push(t);
  };
  return { ...real, useToast: () => ({ toast }) };
});

/** The last rendered Button with these words. */
function tapButton(words: string): void {
  const hit = [...seen.buttons].reverse().find((b) => b.words === words);
  if (!hit?.tap) throw new Error(`No button "${words}" to tap`);
  hit.tap();
}

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

/** A count by note: how many of each note (by its value in cents; the rest 0), and coins and other. */
function byNote(counts: Partial<Record<number, number>>, otherCents = 0): CashCount {
  return { notes: CASH_NOTE_FACE_CENTS.map((faceCents) => ({ faceCents, count: counts[faceCents] ?? 0 })), otherCents };
}

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
  asked.closeReply = null;
  asked.printReply = null;
  asked.printRequests.length = 0;
  seen.buttons.length = 0;
  seen.toasts.length = 0;
  confirmAsk.calls.length = 0;
  confirmAsk.answer = false;
  dismissShiftCloseOutcome();
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
    // Nothing of the count before the PIN: no total, no note rows.
    expect(words).not.toContain('Counted cash');
    expect(out).not.toContain('data-note-row');
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
    // The count is by note (v0.7.35): the rows, and a total that starts at 0.
    expect(out).toContain('data-note-row="5000"');
    expect(words).toContain('Counted cash Rs 0');
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
    countedNotes: null,
    varianceCents: -10_000,
    summary: null,
    closedByName: 'Sara Manager',
    carriedUnpaidCount: 2,
    viaManagerPin: false,
    reportPrint: null,
    reportError: null,
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
    // Rs 4,900: four Rs 1,000 notes, one Rs 500 and four Rs 100.
    const rs4900 = byNote({ 100_000: 4, 50_000: 1, 10_000: 4 });
    expect(
      closeShiftRequest({
        shiftId: 'shift-1',
        count: rs4900,
        notes: '  Rs 100 short  ',
        unpaid: UNPAID,
        carryOverReason: '  Rider still out ',
        approverPin: 'Manager-pass-7',
      }),
    ).toEqual({
      shiftId: 'shift-1',
      countedCashCents: 490_000,
      countedNotes: rs4900,
      notes: 'Rs 100 short',
      carryOverReason: 'Rider still out',
      carryOverOrderIds: ['o1', 'o2'],
      approverPin: 'Manager-pass-7',
    });
    // None shown: an empty list (the till refuses a close that would carry one), no reason, no PIN.
    const rs5000 = byNote({ 500_000: 1 });
    expect(closeShiftRequest({ shiftId: 'shift-1', count: rs5000, notes: '', unpaid: [], carryOverReason: 'x' })).toEqual({
      shiftId: 'shift-1',
      countedCashCents: 500_000,
      countedNotes: rs5000,
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

describe('E. refused items still to refund: listed in the close box, never a gate', () => {
  const OWED: NonNullable<ShiftCloseCheck['refusedItemRefundsOwed']> = [
    { orderId: 'o9' as UUID, orderNumber: '20261002-0042' },
    { orderId: 'o10' as UUID, orderNumber: '20261002-0051' },
  ];
  const closeButton = (node: ReactNode, seed: Array<[readonly unknown[], unknown]> = []) =>
    buttonWith(render(node, seed), 'Close shift');

  it('on a manager’s PIN (the cashier’s login): each order in the words, and why the drawer is short — and still no money', () => {
    signIn('cashier');
    const out = render(
      <CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={{ ...VIA_PIN, refusedItemRefundsOwed: OWED }} />,
    );
    const words = text(out);
    expect(words).toContain('#0042: customer refused an item - refund not done yet');
    expect(words).toContain('#0051: customer refused an item - refund not done yet');
    expect(REFUSED_ITEMS_OWED_NOTE).toBe('The drawer is short by each refused item until it is refunded. You can still close the shift.');
    expect(words).toContain(REFUSED_ITEMS_OWED_NOTE);
    expect(out).toContain('role="note"');
    expect(words.indexOf('#0042: customer refused')).toBeLessThan(words.lastIndexOf('Close shift'));
    expect(words).not.toMatch(/Expected|Cash sales|Paid orders/);
  });

  it('a manager signed in: the same list, from the check the till sends', () => {
    signIn('manager');
    const words = text(
      render(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} />, [
        [['shifts', 'closeCheck', 'shift-1'], { closerName: 'Test', viaManagerPin: false, unpaidOrders: [], pausesWebsiteOrders: false, refusedItemRefundsOwed: OWED.slice(0, 1) }],
      ]),
    );
    expect(words).toContain('#0042: customer refused an item - refund not done yet');
    expect(words).not.toContain('#0051');
  });

  it('none owed: no such words', () => {
    signIn('manager');
    const words = text(render(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={VIA_PIN} />));
    expect(words).not.toContain('customer refused an item');
    expect(words).not.toContain(REFUSED_ITEMS_OWED_NOTE);
  });

  it('a note, not a gate: "Close shift" is exactly as it is without it', () => {
    signIn('manager');
    expect(
      closeButton(
        <CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={{ ...VIA_PIN, refusedItemRefundsOwed: OWED }} />,
      ),
    ).toBe(closeButton(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={VIA_PIN} />));
    // With unpaid orders too, it asks only for the carry-over reason, as before.
    const both = render(
      <CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={{ ...VIA_PIN, unpaidOrders: UNPAID, refusedItemRefundsOwed: OWED }} />,
    );
    expect(text(both)).toContain('Why are they carried over? (required)');
    expect(text(both)).toContain('#0042: customer refused an item - refund not done yet');
  });
});

describe('F. (v0.7.35) the drawer counted note by note at Close shift', () => {
  /** Keys pressed one after another on a fresh count. */
  const press = (...keys: string[]): NoteCounterState => keys.reduce(noteCounterKey, noteCounterInitial());
  // The owner's example: 5,000 × 2, 1,000 × 3, 500 × 1, 100 × 7, 50 and 20
  // left blank, 10 × 4, coins and other Rs 35 = Rs 14,275.
  const OWNER = press('2', 'Enter', '3', 'Enter', '1', 'Enter', '7', 'Enter', 'Enter', 'Enter', '4', 'Enter', '3', '5');
  const OWNER_COUNT = byNote({ 500_000: 2, 100_000: 3, 50_000: 1, 10_000: 7, 1_000: 4 }, 3_500);
  const MANAGER_CHECK: ShiftCloseCheck = { closerName: 'Test', viaManagerPin: false, unpaidOrders: [], pausesWebsiteOrders: false };
  /** Every row blank, in order: label, × the count (a grey 0), = the line ('—'). */
  const BLANK_ROWS =
    'Rs 5,000 × 0 = — Rs 1,000 × 0 = — Rs 500 × 0 = — Rs 100 × 0 = — Rs 50 × 0 = — Rs 20 × 0 = — ' +
    'Rs 10 note or coin × 0 = — Coins and other Rs 5, 2, 1 coins, in rupees Rs 0 = — Clear all Counted cash Rs 0';
  const rowsOf = (markup: string) => [...markup.matchAll(/data-note-row="([^"]+)"/g)].map((m) => m[1]);

  it('the manager’s box and the PIN box: the eight rows, the pad, Open drawer, the closing note — still blind, no total box', () => {
    signIn('cashier');
    const pin = render(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={VIA_PIN} />, [
      [['shifts', 'summary', 'shift-1'], { paidOrderCount: 24, refundedOrderCount: 1 }],
    ]);
    signIn('manager');
    const own = render(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} />, [
      [['shifts', 'summary', 'shift-1'], { paidOrderCount: 24, refundedOrderCount: 1 }],
      [['shifts', 'closeCheck', 'shift-1'], MANAGER_CHECK],
    ]);
    for (const out of [pin, own]) {
      const words = text(out);
      expect(words).toContain(CLOSE_SHIFT_DESCRIPTION);
      expect(rowsOf(out)).toEqual(['5000', '1000', '500', '100', '50', '20', '10', 'other']);
      expect(words).toContain(BLANK_ROWS);
      // The pad beside the rows: no display of its own (the rows show the figures), Next for Enter.
      expect(out).toContain('aria-label="Number pad for the note count"');
      expect(out).not.toContain('PIN entry');
      expect(words).toContain('0 Next');
      expect(words).toContain('Open drawer to count');
      expect(words).toContain('Closing note (optional)');
      // Always by note: no box to type the total, no shortcut to one.
      expect(out).not.toMatch(/inputmode="decimal"/i);
      expect(out).not.toContain('<input inputMode');
      expect(words).not.toMatch(/type the total/i);
      // Blind: nothing of what the drawer should hold.
      expect(words).not.toMatch(/Expected|Cash sales|takings/i);
      // The keyboard starts on the Rs 5,000 row, which is the one chosen.
      expect(out).toContain('data-note-row="5000" aria-pressed="true"');
      expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    }
    expect(text(pin)).toContain("Closing as Sara Manager (manager's PIN).");
    expect(text(pin)).not.toContain('Paid orders');
    expect(text(own)).toContain('Paid orders 24 · Refunds 1');
    // On the cashier's login the shift's totals are never asked for.
    expect(asked.calls).not.toContain('summary');
  });

  it('the rows: label × count = line, coins and other in rupees, and the total the till adds up', () => {
    const words = text(render(<NoteCounter state={OWNER} onSelect={() => {}} onClear={() => {}} />));
    expect(words).toBe(
      'Rs 5,000 × 2 = Rs 10,000 Rs 1,000 × 3 = Rs 3,000 Rs 500 × 1 = Rs 500 Rs 100 × 7 = Rs 700 ' +
        'Rs 50 × 0 = — Rs 20 × 0 = — Rs 10 note or coin × 4 = Rs 40 ' +
        'Coins and other Rs 5, 2, 1 coins, in rupees Rs 35 = Rs 35 Clear all Counted cash Rs 14,275',
    );
    const out = render(<NoteCounter state={OWNER} onSelect={() => {}} onClear={() => {}} />);
    // The row being typed in: coins and other, after the last Enter.
    expect(out).toContain('data-note-row="other" aria-pressed="true"');
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    // Clear all once something is typed; nothing to clear on a fresh count.
    expect(buttonWith(out, 'Clear all')).not.toMatch(DISABLED);
    expect(buttonWith(render(<NoteCounter state={noteCounterInitial()} onSelect={() => {}} onClear={() => {}} />), 'Clear all')).toMatch(
      DISABLED,
    );
    expect(NOTE_COUNTER_FIRST_ROW).toBe('[data-note-row="5000"]');
  });

  it('Clear all asks first, in the window, with "Keep counting" as the safe answer', async () => {
    expect(CLEAR_ALL_QUESTION).toBe('Clear every row of this count?');
    confirmAsk.answer = true;
    await expect(confirmClearAll()).resolves.toBe(true);
    confirmAsk.answer = false;
    await expect(confirmClearAll()).resolves.toBe(false);
    expect(confirmAsk.calls).toEqual([
      [CLEAR_ALL_QUESTION, { safeDefault: true, yesLabel: 'Clear all', noLabel: 'Keep counting' }],
      [CLEAR_ALL_QUESTION, { safeDefault: true, yesLabel: 'Clear all', noLabel: 'Keep counting' }],
    ]);
  });

  it('the website pause line sits under the title, before the count and the footer', () => {
    signIn('cashier');
    const out = render(
      <CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={{ ...VIA_PIN, pausesWebsiteOrders: true }} />,
    );
    const note = out.indexOf('role="note"');
    expect(note).toBeGreaterThan(out.indexOf(CLOSE_SHIFT_DESCRIPTION));
    expect(note).toBeLessThan(out.indexOf('data-note-row'));
    expect(note).toBeLessThan(out.lastIndexOf('Close shift'));
    expect(text(out)).toContain(`${CLOSE_PAUSES_WEBSITE_TEXT} ${CLOSE_PAUSES_WEBSITE_NOTE}`);
  });

  it('unpaid orders: said on the line over the count, listed with the reason below it', () => {
    signIn('manager');
    const words = text(
      render(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={{ ...VIA_PIN, unpaidOrders: UNPAID }} />),
    );
    expect(words).toContain("Closing as Sara Manager (manager's PIN). 2 unpaid orders: give a reason below");
    expect(words.indexOf('give a reason below')).toBeLessThan(words.indexOf('Rs 5,000'));
    expect(words.indexOf('Why are they carried over? (required)')).toBeGreaterThan(words.indexOf('Counted cash'));
    const one = text(
      render(
        <CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={{ ...VIA_PIN, unpaidOrders: UNPAID.slice(0, 1) }} />,
      ),
    );
    expect(one).toContain('1 unpaid order: give a reason below');
  });

  it('the footer says why Close shift waits, first match wins; a lot of coins is said in amber and never stops it', () => {
    expect(CLOSE_HINT_NOT_STARTED).toBe('Type a count in at least one row (0 if the drawer is empty).');
    expect(CLOSE_HINT_CHECKING).toBe('Checking the orders on this till…');
    expect(CLOSE_HINT_REASON).toBe('Give a reason for the unpaid orders (below the count).');
    expect(CLOSE_HINT_COINS_LARGE).toBe('Rs 1,000 or more in coins and other: count the notes in their own rows.');
    const all = { started: true, checked: true, reasonMissing: false, otherIsLarge: false };
    expect(closeShiftHint({ ...all, started: false, checked: false, reasonMissing: true, otherIsLarge: true })).toEqual({
      text: CLOSE_HINT_NOT_STARTED,
      amber: false,
    });
    expect(closeShiftHint({ ...all, checked: false, reasonMissing: true, otherIsLarge: true })).toEqual({ text: CLOSE_HINT_CHECKING, amber: false });
    expect(closeShiftHint({ ...all, reasonMissing: true, otherIsLarge: true })).toEqual({ text: CLOSE_HINT_REASON, amber: false });
    expect(closeShiftHint({ ...all, otherIsLarge: true })).toEqual({ text: CLOSE_HINT_COINS_LARGE, amber: true });
    expect(closeShiftHint(all)).toBeNull();

    // On screen: nothing typed yet, so it says so beside a Close shift that waits.
    signIn('manager');
    const out = render(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={VIA_PIN} />);
    expect(text(out)).toContain(`${CLOSE_HINT_NOT_STARTED} Cancel Close shift`);
    expect(buttonWith(out, 'Close shift')).toMatch(DISABLED);
    expect(buttonWith(out, 'Cancel')).not.toMatch(DISABLED);
  });

  it('the close sends the notes and the total they add up to: the owner’s example is Rs 14,275', () => {
    const request = closeShiftRequest({ shiftId: 'shift-1', count: noteCounterToCount(OWNER), notes: '', unpaid: [], carryOverReason: '' });
    expect(request.countedCashCents).toBe(1_427_500);
    expect(request.countedNotes).toEqual(OWNER_COUNT);
    expect(request.countedNotes).toEqual({
      notes: [
        { faceCents: 500_000, count: 2 },
        { faceCents: 100_000, count: 3 },
        { faceCents: 50_000, count: 1 },
        { faceCents: 10_000, count: 7 },
        { faceCents: 5_000, count: 0 },
        { faceCents: 2_000, count: 0 },
        { faceCents: 1_000, count: 4 },
      ],
      otherCents: 3_500,
    });
    // Kept on the shift as exactly this text (shift-repo writes it with cashCountJson).
    expect(cashCountJson(request.countedNotes as CashCount)).toBe(
      '{"notes":[{"faceCents":500000,"count":2},{"faceCents":100000,"count":3},{"faceCents":50000,"count":1},{"faceCents":10000,"count":7},{"faceCents":5000,"count":0},{"faceCents":2000,"count":0},{"faceCents":1000,"count":4}],"otherCents":3500}',
    );
    // An empty drawer is a count too: a single 0 sends seven rows of 0 and Rs 0.
    const empty = closeShiftRequest({ shiftId: 'shift-1', count: noteCounterToCount(press('0')), notes: '', unpaid: [], carryOverReason: '' });
    expect(empty.countedCashCents).toBe(0);
    expect(empty.countedNotes).toEqual(byNote({}));
  });

  it('the keyboard: digits, Backspace, Delete, Enter and the arrows count; a held digit, Ctrl, typing in a box and Tab do not', () => {
    const k = { key: '5', ctrlKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false, typing: false, ownsEnter: false, onRow: false };
    for (const key of ['0', '5', '9', 'Backspace', 'Delete', 'Enter', 'ArrowUp', 'ArrowDown']) {
      expect(noteCounterKeyAction({ ...k, key }), key).toBe('count');
    }
    // A held digit would type 5555 notes: stopped. A held Backspace still clears.
    expect(noteCounterKeyAction({ ...k, repeat: true })).toBe('held');
    expect(noteCounterKeyAction({ ...k, key: 'Backspace', repeat: true })).toBe('count');
    for (const key of ['Tab', 'Escape', '-', '.', ',', 'e', 'a', ' ', 'F1']) {
      expect(noteCounterKeyAction({ ...k, key }), key).toBeNull();
    }
    expect(noteCounterKeyAction({ ...k, ctrlKey: true })).toBeNull();
    expect(noteCounterKeyAction({ ...k, altKey: true })).toBeNull();
    expect(noteCounterKeyAction({ ...k, metaKey: true })).toBeNull();
    expect(noteCounterKeyAction({ ...k, isComposing: true })).toBeNull();
    // The closing note and the reason are text boxes: their keys are theirs.
    expect(noteCounterKeyAction({ ...k, typing: true })).toBeNull();
    expect(noteCounterKeyAction({ ...k, key: 'Enter', typing: true })).toBeNull();
    // Enter on Cancel or Close shift reached with Tab presses it; on a row it goes to the next row.
    expect(noteCounterKeyAction({ ...k, key: 'Enter', ownsEnter: true })).toBeNull();
    expect(noteCounterKeyAction({ ...k, key: 'Enter', ownsEnter: true, onRow: true })).toBe('count');

    // The box itself hands them on that way.
    signIn('manager');
    render(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={VIA_PIN} />);
    const onKeyDown = radix.content['onKeyDown'] as (e: unknown) => void;
    const stopped = (key: string, target: Record<string, unknown> = { tagName: 'DIV', dataset: {} }, more: Record<string, unknown> = {}) => {
      const preventDefault = vi.fn();
      onKeyDown({ key, ctrlKey: false, altKey: false, metaKey: false, repeat: false, nativeEvent: { isComposing: false }, target, preventDefault, ...more });
      return preventDefault.mock.calls.length > 0;
    };
    expect(stopped('5')).toBe(true);
    expect(stopped('Enter', { tagName: 'BUTTON', dataset: { noteRow: '500' }, matches: () => true })).toBe(true);
    expect(stopped('Enter', { tagName: 'BUTTON', dataset: {}, matches: () => true })).toBe(false);
    expect(stopped('5', { tagName: 'INPUT', dataset: {} })).toBe(false);
    expect(stopped('5', undefined, { ctrlKey: true })).toBe(false);
    expect(stopped('Tab')).toBe(false);
  });

  it('leaving: nothing typed closes at once; a started count asks first ("Keep counting" stays); while saving nothing happens', async () => {
    expect(STOP_CLOSING_QUESTION).toBe('Stop closing the shift? The count you typed is not kept.');
    const onClose = vi.fn();
    await leaveCloseShift({ saving: false, started: false, onClose });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirmAsk.calls).toEqual([]);

    onClose.mockClear();
    confirmAsk.answer = false;
    await leaveCloseShift({ saving: false, started: true, onClose });
    expect(confirmAsk.calls).toEqual([[STOP_CLOSING_QUESTION, { safeDefault: true, yesLabel: 'Stop', noLabel: 'Keep counting' }]]);
    expect(onClose).not.toHaveBeenCalled();
    confirmAsk.answer = true;
    await leaveCloseShift({ saving: false, started: true, onClose });
    expect(onClose).toHaveBeenCalledTimes(1);

    // The close is on its way: Cancel, the X, Escape and a tap outside do nothing.
    onClose.mockClear();
    confirmAsk.calls.length = 0;
    for (const started of [false, true]) await leaveCloseShift({ saving: true, started, onClose });
    expect(onClose).not.toHaveBeenCalled();
    expect(confirmAsk.calls).toEqual([]);
  });

  it('Escape, a tap outside and the dimmed area all leave that way; the box opens on the Rs 5,000 row', () => {
    signIn('manager');
    const onClose = vi.fn();
    render(<CloseShiftDialog shiftId="shift-1" onClose={onClose} approverPin="Manager-pass-7" check={VIA_PIN} />);
    for (const handler of ['onEscapeKeyDown', 'onPointerDownOutside']) {
      const event = { preventDefault: vi.fn() };
      (radix.content[handler] as (e: typeof event) => void)(event);
      // Radix is stopped from closing it: leaving is the box's own decision.
      expect(event.preventDefault, handler).toHaveBeenCalled();
    }
    (radix.root['onOpenChange'] as (open: boolean) => void)(false);
    // Nothing typed: no question, it just closes.
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(confirmAsk.calls).toEqual([]);

    const row = { focus: vi.fn() };
    const open = { preventDefault: vi.fn(), currentTarget: { querySelector: vi.fn(() => row) } };
    (radix.content['onOpenAutoFocus'] as (e: typeof open) => void)(open);
    expect(open.preventDefault).toHaveBeenCalled();
    expect(open.currentTarget.querySelector).toHaveBeenCalledWith('[data-note-row="5000"]');
    expect(row.focus).toHaveBeenCalled();
  });

  it('the result: Counted, then the notes on one line — on the manager’s close and the PIN close; none without notes', () => {
    const closed: ShiftCloseOutcome = {
      sessionId: 's1',
      shiftId: 'shift-1',
      expectedCents: 1_437_500,
      countedCents: 1_427_500,
      countedNotes: OWNER_COUNT,
      varianceCents: -10_000,
      summary: null,
      closedByName: 'Sara Manager',
      carriedUnpaidCount: 0,
      viaManagerPin: false,
      reportPrint: null,
      reportError: null,
    };
    const line = '5,000 × 2 · 1,000 × 3 · 500 × 1 · 100 × 7 · 10 × 4 · coins and other Rs 35';
    const own = text(render(<CloseShiftResultDialog outcome={closed} onDone={() => {}} />));
    expect(own).toContain('Expected cash Rs 14,375');
    expect(own).toContain('Counted Rs 14,275');
    expect(own).toContain(line);
    expect(own.indexOf(line)).toBeGreaterThan(own.indexOf('Counted Rs 14,275'));
    expect(own.indexOf(line)).toBeLessThan(own.indexOf('Variance'));

    const pin = text(render(<CloseShiftResultDialog outcome={{ ...closed, expectedCents: null, viaManagerPin: true }} onDone={() => {}} />));
    expect(pin).toContain('Counted Rs 14,275');
    expect(pin).toContain(line);
    expect(pin).not.toContain('Expected cash');

    for (const countedNotes of [null, byNote({})]) {
      const words = text(render(<CloseShiftResultDialog outcome={{ ...closed, countedNotes }} onDone={() => {}} />));
      expect(words).toContain('Counted Rs 14,275');
      expect(words).not.toContain('×');
    }
  });
});

describe('G. (v0.7.35) the shift report at the close: the result’s line and its buttons, and the close’s own figures', () => {
  const MANAGER_CHECK: ShiftCloseCheck = { closerName: 'Sara Manager', viaManagerPin: false, unpaidOrders: [], pausesWebsiteOrders: false };
  /** The takings as the close box read them when it opened: 24 paid orders, Rs 12,000 cash sales. */
  const BOX_SUMMARY = {
    shiftId: 'shift-1',
    paidOrderCount: 24,
    refundedOrderCount: 1,
    openingCashCents: 500_000,
    cashSalesCents: 1_200_000,
    cashRefundsCents: 0,
    cashInCents: 0,
    cashOutCents: 0,
    riderChargesCents: 0,
    riderChargeCount: 0,
    riderTripCount: 0,
  } as unknown as ShiftSummary;
  /** As the close saved them: a Rs 1,500 cash payment came in while the drawer was being counted. */
  const CLOSE_SUMMARY = { ...BOX_SUMMARY, paidOrderCount: 25, cashSalesCents: 1_350_000 } as ShiftSummary;
  /** The till's reply to Close shift (a manager signed in): the shift, its report, the takings read after the close. */
  const REPLY = {
    id: 'shift-1',
    closedAt: '2026-10-02T20:00:00.000Z',
    expectedCashCents: 1_850_000,
    countedCashCents: 1_850_000,
    countedNotes: null,
    varianceCents: 0,
    closedByName: 'Sara Manager',
    carriedUnpaidCount: 0,
    reportPrint: 'printing',
    summary: CLOSE_SUMMARY,
  };
  const OFF = 'The printer is off, offline, out of paper or its lid is open.';
  const closed = (more: Partial<ShiftCloseOutcome> = {}): ShiftCloseOutcome => ({
    sessionId: 's1',
    shiftId: 'shift-1',
    expectedCents: 1_850_000,
    countedCents: 1_850_000,
    countedNotes: null,
    varianceCents: 0,
    summary: CLOSE_SUMMARY,
    closedByName: 'Sara Manager',
    carriedUnpaidCount: 0,
    viaManagerPin: false,
    reportPrint: 'printing',
    reportError: null,
    ...more,
  });
  const shown = () => useShiftCloseOutcome.getState().outcome;
  /** The result as on screen now (the buttons it drew are the last ones in seen.buttons). */
  const result = (outcome: ShiftCloseOutcome | null = shown()) => {
    if (!outcome) throw new Error('No close result');
    seen.buttons.length = 0;
    return render(<CloseShiftResultDialog outcome={outcome} onDone={() => {}} />);
  };
  const LINE_BUTTONS = ['Print again', 'Try again', 'Print it'];
  const lineButtons = () => seen.buttons.filter((b) => LINE_BUTTONS.includes(b.words)).map((b) => b.words);

  it('after a close: "Shift report printing", with Print again; the figures are the close’s own, not the box’s older ones', async () => {
    expect(SHIFT_REPORT_PRINTING).toBe('Shift report printing - keep it with the cash.');
    signIn('manager');
    asked.closeReply = REPLY;
    const box = text(
      render(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} />, [
        [['shifts', 'summary', 'shift-1'], BOX_SUMMARY],
        [['shifts', 'closeCheck', 'shift-1'], MANAGER_CHECK],
      ]),
    );
    expect(box).toContain('Paid orders 24');
    // A static render cannot type the count: the button's own tap sends the close.
    tapButton('Close shift');
    await vi.waitFor(() => expect(shown()).not.toBeNull());
    expect(shown()).toMatchObject({ shiftId: 'shift-1', expectedCents: 1_850_000, summary: CLOSE_SUMMARY, reportPrint: 'printing', reportError: null });

    const words = text(result());
    expect(words).toContain('Paid orders 25');
    expect(words).toContain('Cash sales Rs 13,500');
    expect(words).not.toContain('Rs 12,000');
    expect(words).toContain('Expected cash Rs 18,500');
    // Under the closed-by line, with its button.
    expect(words).toContain(`Closed by Sara Manager. ${SHIFT_REPORT_PRINTING} Print again Done`);
    expect(lineButtons()).toEqual(['Print again']);
  });

  it('a manager’s PIN on the cashier’s login: the same line and button, and still no figures', async () => {
    signIn('cashier');
    // Even were the reply to carry takings, the PIN result never shows them.
    asked.closeReply = { ...REPLY, expectedCashCents: null };
    render(<CloseShiftDialog shiftId="shift-1" onClose={() => {}} approverPin="Manager-pass-7" check={VIA_PIN} />);
    tapButton('Close shift');
    await vi.waitFor(() => expect(shown()).not.toBeNull());
    expect(shown()).toMatchObject({ viaManagerPin: true, expectedCents: null, summary: null, reportPrint: 'printing' });

    const words = text(result());
    expect(words).toContain(`${SHIFT_REPORT_PRINTING} Print again`);
    expect(words).toContain('Counted Rs 18,500');
    expect(words).not.toMatch(/Expected|Cash sales|Paid orders|Cash taken out|Opening float/);
    expect(words).toContain(PIN_CLOSE_RESULT_NOTE);
    expect(lineButtons()).toEqual(['Print again']);
  });

  it('a printer:failed note for this shift: the amber line and Try again, which asks for the original (again: false)', async () => {
    signIn('manager');
    showShiftCloseOutcome(closed());
    noteShiftReportFailed('shift-1', OFF);
    const out = result();
    expect(text(out)).toContain(`Closed by Sara Manager. The shift report did not print: ${OFF} Try again Done`);
    expect(out).toContain('text-amber-700');
    expect(lineButtons()).toEqual(['Try again']);

    asked.printReply = { printed: true, copy: 'original', reprintNo: 0, error: null };
    tapButton('Try again');
    await vi.waitFor(() => expect(seen.toasts).toHaveLength(1));
    expect(asked.printRequests).toEqual([{ shiftId: 'shift-1', again: false }]);
    expect(seen.toasts[0]).toMatchObject({ title: 'Shift report sent to the printer.', variant: 'success' });
    // It came out: the amber line goes.
    expect(shown()!.reportError).toBeNull();
    expect(text(result())).toContain(`${SHIFT_REPORT_PRINTING} Print again`);
  });

  it('a failure for another shift changes nothing', () => {
    signIn('manager');
    showShiftCloseOutcome(closed());
    const before = shown();
    noteShiftReportFailed('shift-2', OFF);
    expect(shown()).toBe(before);
    expect(text(result())).not.toContain('did not print');
  });

  it('Print again prints a DUPLICATE and says so; one that does not come out turns the line amber, with Try again', async () => {
    signIn('manager');
    showShiftCloseOutcome(closed());
    result();
    asked.printReply = { printed: true, copy: 'reprint', reprintNo: 1, error: null };
    tapButton('Print again');
    await vi.waitFor(() => expect(seen.toasts).toHaveLength(1));
    expect(asked.printRequests).toEqual([{ shiftId: 'shift-1', again: true }]);
    expect(seen.toasts[0]).toMatchObject({ title: 'Shift report sent to the printer - it says DUPLICATE.', variant: 'success' });
    expect(shown()!.reportError).toBeNull();

    result();
    asked.printReply = { printed: false, copy: 'reprint', reprintNo: 2, error: { code: 'offline', message: OFF } };
    tapButton('Print again');
    await vi.waitFor(() => expect(seen.toasts).toHaveLength(2));
    expect(seen.toasts[1]).toMatchObject({
      title: 'The shift report did not print',
      description: `${OFF} Check the receipt printer, then try again.`,
      variant: 'error',
    });
    expect(text(result())).toContain(`The shift report did not print: ${OFF} Try again`);
  });

  it('off: says so, with Print it (a DUPLICATE); no printer and not made: the words, no button; an older reply: no line', async () => {
    expect(SHIFT_REPORT_OFF).toBe('Printing the shift report is off (Settings → Printers).');
    expect(SHIFT_REPORT_NO_PRINTER).toBe('No receipt printer is set up - no shift report printed.');
    expect(SHIFT_REPORT_NOT_MADE).toBe('The shift report could not be made. The close is saved.');
    signIn('manager');

    showShiftCloseOutcome(closed({ reportPrint: 'off' }));
    expect(text(result())).toContain(`Closed by Sara Manager. ${SHIFT_REPORT_OFF} Print it Done`);
    expect(lineButtons()).toEqual(['Print it']);
    asked.printReply = { printed: true, copy: 'reprint', reprintNo: 1, error: null };
    tapButton('Print it');
    await vi.waitFor(() => expect(seen.toasts).toHaveLength(1));
    expect(asked.printRequests).toEqual([{ shiftId: 'shift-1', again: true }]);

    for (const [reportPrint, words] of [
      ['no_printer', SHIFT_REPORT_NO_PRINTER],
      ['not_made', SHIFT_REPORT_NOT_MADE],
    ] as const) {
      showShiftCloseOutcome(closed({ reportPrint }));
      expect(text(result())).toContain(`Closed by Sara Manager. ${words} Done`);
      expect(lineButtons()).toEqual([]);
    }

    showShiftCloseOutcome(closed({ reportPrint: null }));
    const none = text(result());
    expect(none).toContain('Closed by Sara Manager. Done');
    expect(none).not.toMatch(/shift report/i);
    expect(shiftReportLine({ reportPrint: null, reportError: null })).toBeNull();
    // A failure is said whatever the close said first.
    expect(shiftReportLine({ reportPrint: 'off', reportError: OFF })).toEqual({
      text: `The shift report did not print: ${OFF}`,
      amber: true,
      button: { label: 'Try again', again: false },
    });
  });

  it('"Cash taken out" is one row — payouts and rider tips — beside the outside riders’ row, as on the paper', () => {
    // The owner's sample paper: Cash taken out -3,750 (rider tips -600 among it), Paid to outside riders (8) -1,800.
    const summary = { ...CLOSE_SUMMARY, cashOutCents: 555_000, riderChargesCents: 180_000, riderChargeCount: 8, riderTripCount: 0 } as ShiftSummary;
    const words = text(result(closed({ summary })));
    expect(words.match(/Cash taken out/g)).toHaveLength(1);
    expect(words).toContain('Cash taken out − Rs 3,750');
    expect(words).toContain('Paid to outside riders (8): 8 delivery charges kept − Rs 1,800');
    expect(words).not.toMatch(/tips/i);
  });

  it('the PIN result still goes by itself after a minute when its line has changed', () => {
    vi.useFakeTimers();
    try {
      signIn('cashier');
      showShiftCloseOutcome(closed({ viaManagerPin: true, expectedCents: null, summary: null }));
      noteShiftReportFailed('shift-1', OFF);
      expect(shown()!.reportError).toBe(OFF);
      vi.advanceTimersByTime(PIN_CLOSE_RESULT_MS - 1);
      expect(shown()).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(shown()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failure that comes in before the result is up is shown on it, once', () => {
    signIn('manager');
    noteShiftReportFailed('shift-9', OFF);
    showShiftCloseOutcome(closed({ shiftId: 'shift-9' }));
    expect(shown()!.reportError).toBe(OFF);
    dismissShiftCloseOutcome();
    showShiftCloseOutcome(closed({ shiftId: 'shift-9' }));
    expect(shown()!.reportError).toBeNull();
  });
});
