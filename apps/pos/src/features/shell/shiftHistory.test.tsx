/**
 * Shift history on screen (the owner, 2026-09-27: "I can't see the shift
 * history"), rendered to static markup (react-dom/server, no browser;
 * nothing calls the till):
 *   - the top bar's "Shift history" is the owner's alone (whoever may open
 *     Reports): not there for a manager or a cashier, shift open or not;
 *   - it opens Reports on Team & leakage over the last 7 days (the one-shot
 *     Reports link, the same one a finished stock take uses), aimed at the
 *     shift history panel;
 *   - the panel's words: its name, a shift still open, the drawer banner,
 *     and an empty period.
 * Every name and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, ReportShiftLine, ReportTeamTab, Shift, UUID } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { presetSessionState } from '../../components/list';
import { useSessionStore } from '../../stores/sessionStore';
import { openShiftHistory, openStockVariance, REPORTS_DEEP_LINK } from '../costing/deepLinks';
import { ReportsPage } from '../reports/ReportsPage';
import { SHIFT_HISTORY_ANCHOR } from '../reports/reportTabs';
import { periodFor } from '../reports/dateRange';
import { shiftDrawerBanner, shiftHistoryNote, TeamLeakageTab } from '../reports/tabs/TeamLeakageTab';
import { shiftCarryOverText, shiftDetailLines } from '../reports/reportFormat';
import { ShiftWidget } from './ShiftWidget';

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

/** The page's words without its markup. */
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

/** A button's opening tag, found by its label. */
function buttonFor(markup: string, label: string): string {
  const at = markup.indexOf(`${label}</button>`);
  if (at < 0) throw new Error(`No button "${label}"`);
  return markup.slice(markup.lastIndexOf('<button', at), at);
}

const OPEN_SHIFT = {
  id: 'shift-1',
  openedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
  openedByName: 'Ali',
} as unknown as Shift;

// A link preset but not read (a server render runs no effects) is taken away again.
afterEach(() => {
  presetSessionState(REPORTS_DEEP_LINK, undefined);
  useSessionStore.setState({ user: null, status: 'idle' });
});

// React warns that layout effects (the router's, Radix's) do nothing in a server render: expected here.
const consoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (String(msg).includes('useLayoutEffect does nothing on the server')) return;
    consoleError(msg, ...rest);
  });
});
afterAll(() => vi.restoreAllMocks());

/** The Reports page, rendered: its trend strip asks whether the window is on screen (a stand-in: it is not). */
function renderReports(): string {
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  try {
    return render(<ReportsPage />);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('the top bar’s "Shift history"', () => {
  it('is there for the owner, shift open or not', () => {
    signIn('admin');
    expect(render(<ShiftWidget />, [[['shifts', 'current'], OPEN_SHIFT]])).toContain('Shift history');
    expect(render(<ShiftWidget />, [[['shifts', 'current'], null]])).toContain('Shift history');
  });

  it('is not there for a manager or a cashier', () => {
    for (const role of ['manager', 'cashier'] as const) {
      signIn(role);
      for (const current of [OPEN_SHIFT, null]) {
        const out = render(<ShiftWidget />, [[['shifts', 'current'], current]]);
        // The widget itself is there (a manager still closes shifts)…
        expect({ role, open: current !== null, widget: out.includes(current ? 'Shift ' : 'Open shift') }).toEqual({ role, open: current !== null, widget: true });
        // …but no way into past shifts.
        expect({ role, open: current !== null, history: out.includes('Shift history') }).toEqual({ role, open: current !== null, history: false });
      }
    }
  });

  it('opens Reports on Team & leakage over the last 7 days, aimed at the shift history', () => {
    const navigate = vi.fn();
    openShiftHistory(navigate);
    expect(navigate).toHaveBeenCalledWith('/reports');
    signIn('admin');
    const out = renderReports();
    expect(buttonFor(out, 'Team &amp; leakage')).toContain('aria-current="page"');
    expect(buttonFor(out, 'Last 7 days')).toContain('aria-pressed="true"');
    expect(buttonFor(out, 'Today')).toContain('aria-pressed="false"');
    expect(buttonFor(out, 'Overview')).not.toContain('aria-current');
    expect(SHIFT_HISTORY_ANCHOR).toBe('shift-history');
  });

  it('without a link, Reports opens on Today as before; a stock take’s link still opens Food cost & stock between stock takes', () => {
    signIn('admin');
    const plain = renderReports();
    expect(buttonFor(plain, 'Today')).toContain('aria-pressed="true"');
    expect(buttonFor(plain, 'Last 7 days')).toContain('aria-pressed="false"');
    expect(buttonFor(plain, 'Overview')).toContain('aria-current="page"');

    openStockVariance(vi.fn(), { fromCountId: 's0', toCountId: 's1' });
    const stock = renderReports();
    expect(buttonFor(stock, 'Food cost &amp; stock')).toContain('aria-current="page"');
    expect(buttonFor(stock, 'Between stock takes')).toContain('aria-pressed="true"');
  });
});

// ------------------------------------------------------------------ the panel --

const line = (p: Partial<ReportShiftLine> & Pick<ReportShiftLine, 'id' | 'openedAt'>): ReportShiftLine => ({
  closedAt: null,
  openedBy: 'Ali',
  closedBy: null,
  openingCashCents: 500_000,
  expectedCashCents: null,
  countedCashCents: null,
  varianceCents: null,
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

const closedLine = (id: string, openedAt: string, closedAt: string, varianceCents: number) =>
  line({ id, openedAt, closedAt, closedBy: 'Sara', expectedCashCents: 600_000, countedCashCents: 600_000 + varianceCents, varianceCents });

const team = (shifts: ReportShiftLine[]): ReportTeamTab => ({
  sinceIso: '2026-09-20T00:00:00.000Z',
  untilIso: '2026-09-27T00:00:00.000Z',
  engine: 'worker',
  kpis: { netSalesCents: 0, menuSalesCents: 0, partialRefundCents: 0, fullRefundCents: 0, voidCount: 0, voidCents: 0 },
  staff: [],
  shifts,
  discounts: { totalCount: 0, totalCents: 0, byReason: [], byPerson: [], recent: [] },
  refunds: [],
  voids: [],
  drawerOpens: [],
  drawerOpenCount: 0,
  foodCost: { hasCosts: true },
});

describe('the shift history panel', () => {
  const NOW = new Date('2026-09-26T10:00:00.000Z');

  it('is named for what it is, can be scrolled to, and a shift still open says so, by whom and since when', () => {
    const out = render(
      <TeamLeakageTab
        now={NOW}
        data={team([
          closedLine('s2', '2026-09-25T15:00:00.000Z', '2026-09-26T01:30:00.000Z', -10_000),
          line({ id: 's1', openedAt: '2026-09-24T07:00:00.000Z', cashMovementCount: 2 }),
        ])}
      />,
    );
    expect(out).toContain('Shift history — cash in the drawer');
    expect(out).toContain(`id="${SHIFT_HISTORY_ANCHOR}"`);
    const words = text(out);
    expect(words).toContain('still open · opened by Ali, 2 days 3 h ago · cash in/out 2×');
    expect(words).toContain('to 26 Sep, 6:30 am · closed by Sara');
    // How Expected is worked out is still said.
    expect(words).toContain('Expected = float + cash sales − cash refunds + cash put in − cash taken out.');
    // Only the closed shift is summed; the open one is waiting for its count.
    expect(words).toContain('Short Rs 100 in all, over 1 closed shift. 1 shift still open: counted when it closes.');
    expect(words).not.toContain('Shifts — cash in the drawer');
  });

  it('names the period it covers, so a link that lands on it (past the page’s own period line) still says which days', () => {
    const last7 = periodFor('last7', NOW);
    const words = text(render(<TeamLeakageTab now={NOW} period={last7} data={team([])} />));
    expect(words).toContain(`Every shift that was open at any time in this period (${last7.dates}, so far), newest first.`);
    expect(shiftHistoryNote(periodFor('yesterday', NOW))).toContain(`in this period (${periodFor('yesterday', NOW).dates}), newest first.`);
    // Without a period (another screen showing the section), it reads as before.
    expect(shiftHistoryNote()).toMatch(/^Every shift that was open at any time in this period, newest first\. Expected = /);
  });

  it('shows the note typed at opening and the one typed at closing, each on its own line; a shift with neither shows no note line', () => {
    const out = render(
      <TeamLeakageTab
        now={NOW}
        data={team([
          line({
            id: 's3',
            openedAt: '2026-09-25T07:00:00.000Z',
            closedAt: '2026-09-25T20:00:00.000Z',
            closedBy: 'Sara',
            expectedCashCents: 600_000,
            countedCashCents: 590_000,
            varianceCents: -10_000,
            openingNote: 'Morning shift, Ali on register',
            closingNote: 'Rs 100 short, change given wrong',
          }),
          line({ id: 's2', openedAt: '2026-09-24T07:00:00.000Z', openingNote: 'Only an opening note' }),
          line({ id: 's1', openedAt: '2026-09-23T07:00:00.000Z' }),
        ])}
      />,
    );
    const words = text(out);
    expect(words).toContain('Opening note: Morning shift, Ali on register Closing note: Rs 100 short, change given wrong');
    expect(words).toContain('Opening note: Only an opening note');
    expect(words.match(/Opening note:/g)).toHaveLength(2);
    expect(words.match(/Closing note:/g)).toHaveLength(1);
  });

  it('with the drawer log (0042) and deleted test orders (0043), one layout: each shift keeps its notes and carry-over, adds its deleted-test notes and its own Drawer log; the period’s whole log sits right under the history', () => {
    const out = render(
      <TeamLeakageTab
        now={NOW}
        data={team([
          line({
            id: 's3',
            openedAt: '2026-09-25T07:00:00.000Z',
            closedAt: '2026-09-25T20:00:00.000Z',
            closedBy: 'Sara',
            expectedCashCents: 620_000,
            countedCashCents: 620_000,
            varianceCents: 0,
            noSaleOpens: 1,
            drawerOpenCount: 6,
            testDeletedCashCents: 120_000,
            openingNote: 'Morning shift, Ali on register',
            closingNote: 'All good',
            carriedUnpaidCount: 2,
            carryOverReason: 'Rider still out',
            carriedTestDeletedCount: 1,
          }),
        ])}
      />,
    );
    const words = text(out);
    const at = (s: string) => {
      const i = words.indexOf(s);
      if (i < 0) throw new Error(`Not on screen: ${s}`);
      return i;
    };
    // In this order, inside the shift history: the row's facts, its notes, the
    // carry-over (and the carried test deleted later), the test cash deleted
    // after the close, its own drawer log; then the period's whole log.
    const order = [
      'Shift history — cash in the drawer',
      'to 26 Sep, 1:00 am · closed by Sara · drawer used 6× (1 no sale)',
      'Opening note: Morning shift, Ali on register',
      'Closing note: All good',
      '2 unpaid orders carried over — Rider still out — approved by Sara (1 of them later deleted as a test order)',
      'Includes Rs 1,200 of test orders deleted after this shift closed.',
      'Drawer log',
      'Cash drawer log — used',
    ].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out.indexOf(`id="${SHIFT_HISTORY_ANCHOR}"`)).toBeLessThan(out.indexOf('Drawer log</button>'));
    // The hand-opened list is folded into the drawer log, not shown twice.
    expect(words).not.toContain('Cash drawer opened by hand');
    // The owner's deleted test orders have their own section, after the refunds.
    expect(at('Refunds and cancelled orders')).toBeLessThan(at('Orders made to test the till that the owner deleted.'));
  });

  it('a carried order the owner deleted as a test later: the saved count stays, and says so', () => {
    const carried = (n: number, deleted?: number) =>
      line({ id: 'sc', openedAt: '2026-09-25T07:00:00.000Z', closedAt: '2026-09-25T20:00:00.000Z', closedBy: 'Sara', carriedUnpaidCount: n, carryOverReason: 'Rider still out', ...(deleted === undefined ? {} : { carriedTestDeletedCount: deleted }) });
    expect(shiftCarryOverText(carried(1, 1))).toBe('1 unpaid order carried over — Rider still out — approved by Sara (later deleted as a test order)');
    expect(shiftCarryOverText(carried(3, 2))).toBe('3 unpaid orders carried over — Rider still out — approved by Sara (2 of them later deleted as test orders)');
    // None deleted, or a till before 0043: as 0.7.21 said it.
    expect(shiftCarryOverText(carried(2, 0))).toBe('2 unpaid orders carried over — Rider still out — approved by Sara');
    expect(shiftCarryOverText(carried(2))).toBe('2 unpaid orders carried over — Rider still out — approved by Sara');
    // Never more than were carried; nothing carried, nothing said.
    expect(shiftCarryOverText(carried(1, 4))).toBe('1 unpaid order carried over — Rider still out — approved by Sara (later deleted as a test order)');
    expect(shiftCarryOverText(carried(0, 1))).toBeNull();
    // Paper and file carry the same words.
    expect(shiftDetailLines(carried(2, 1))).toEqual(['2 unpaid orders carried over — Rider still out — approved by Sara (1 of them later deleted as a test order)']);
  });

  it('shows To riders right after Taken out, and Taken out as the rest of the cash taken out (v0.7.34)', () => {
    const out = render(
      <TeamLeakageTab
        now={NOW}
        data={team([
          // Rs 480 taken out in all: Rs 400 to outside riders (a kept charge and a trip), Rs 80 typed by hand and rider tips.
          line({ ...closedLine('s5', '2026-09-25T07:00:00.000Z', '2026-09-25T20:00:00.000Z', 0), cashOutCents: 48_000, riderChargesCents: 40_000, cashMovementCount: 2 }),
          // Only riders: nothing else was taken out.
          line({ ...closedLine('s4', '2026-09-24T07:00:00.000Z', '2026-09-24T20:00:00.000Z', 0), cashOutCents: 20_000, riderChargesCents: 20_000 }),
          // A shift line with no rider figure (before 0.7.34): all of it under Taken out.
          line({ ...closedLine('s3', '2026-09-23T07:00:00.000Z', '2026-09-23T20:00:00.000Z', 0), cashOutCents: 20_000 }),
        ])}
      />,
    );
    const words = text(out);
    expect(words).toContain('Shift Float Taken out To riders Expected Counted Result');
    // Float, Taken out, To riders, Expected, Counted, Result — row by row.
    expect(words).toContain('Rs 5,000 Rs 80 Rs 400 Rs 6,000 Rs 6,000 Matched');
    expect(words).toContain('Rs 5,000 — Rs 200 Rs 6,000 Rs 6,000 Matched');
    expect(words).toContain('Rs 5,000 Rs 200 — Rs 6,000 Rs 6,000 Matched');
    // The cash in / out count is the entries typed by hand (the till sends it so).
    expect(words).toContain('closed by Sara · cash in/out 2×');
    // The note says what the two columns are.
    // In the close result's words (e2e, 2 Oct 2026): "Paid to outside riders (5): 4 delivery charges kept, 1 trip".
    expect(words).toContain('Cash taken out = Taken out + To riders (paid to outside riders: delivery charges kept, and trips).');
    expect(words).not.toContain('trips paid for cancelled orders');
  });

  it('an empty period says so plainly', () => {
    const out = text(render(<TeamLeakageTab now={NOW} data={team([])} />));
    expect(out).toContain('No shifts in this period.');
    expect(out).not.toContain('No shifts were opened');
  });

  it('the banner sums closed drawers only', () => {
    const open = line({ id: 'o', openedAt: '2026-09-26T07:00:00.000Z' });
    expect(shiftDrawerBanner([])).toBeNull();
    // Only a shift still open: nothing counted yet, so no banner.
    expect(shiftDrawerBanner([open])).toBeNull();
    expect(shiftDrawerBanner([closedLine('a', '2026-09-25T07:00:00.000Z', '2026-09-25T20:00:00.000Z', 0)])).toEqual({
      text: 'Every closed drawer matched (1 shift).',
      tone: 'matched',
    });
    expect(
      shiftDrawerBanner([
        open,
        closedLine('a', '2026-09-25T07:00:00.000Z', '2026-09-25T20:00:00.000Z', 5_000),
        closedLine('b', '2026-09-24T07:00:00.000Z', '2026-09-24T20:00:00.000Z', 2_500),
      ]),
    ).toEqual({ text: 'Over Rs 75 in all, over 2 closed shifts. 1 shift still open: counted when it closes.', tone: 'over' });
  });
});
