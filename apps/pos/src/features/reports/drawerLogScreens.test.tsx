/**
 * The cash drawer log on screen and in the file (migration 0042; the owner,
 * Reports → Team & leakage): why each opening happened, for how much, and
 * whether the drawer opened; the counts; a shift's note; the CSV. Static
 * renders (react-dom/server) with made-up figures; nothing calls the till.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { DrawerLogPage, ReportDrawerLogLine } from '@cheeseoclock/shared-types';
import { DrawerLogPanel, DRAWER_LOG_PAGE, withWholeShiftLog } from './tabs/DrawerLog';
import {
  DRAWER_LOG_GROUPS,
  drawerCash,
  drawerLogChips,
  drawerLogCsv,
  drawerLogSinceText,
  drawerLogTitle,
  drawerResult,
  drawerWhy,
  shiftDrawerUseNote,
  shiftTestDeletedNote,
} from './drawerLogFormat';
import { PapersPrinted, PAPERS_RULE_NOTE } from '../printing/PapersPrinted';

const line = (over: Partial<ReportDrawerLogLine>): ReportDrawerLogLine => ({
  id: 'd1',
  createdAt: '2026-09-27T14:00:00.000Z',
  till: 'this',
  kind: 'sale',
  orderNumber: '20260927-0042',
  orderDeletedAsTest: false,
  amountCents: 125_000,
  reason: null,
  openedBy: 'Test Cashier',
  approvedBy: null,
  outcome: 'opened',
  outcomeNote: null,
  outsideShift: false,
  shiftId: 's1',
  ...over,
});

describe('why the drawer opened, and whether it did', () => {
  it('each kind in the owner\'s words — an unknown one is "Other", never "No sale"', () => {
    expect(drawerWhy(line({}))).toBe('Cash sale — Order #0042');
    expect(drawerWhy(line({ orderDeletedAsTest: true }))).toBe('Cash sale — Order #0042 (deleted test order)');
    expect(drawerWhy(line({ kind: 'refund', orderNumber: '20260927-0031' }))).toBe('Refund — Order #0031');
    expect(drawerWhy(line({ kind: 'payin', orderNumber: null, reason: 'Change' }))).toBe('Cash in — Change');
    expect(drawerWhy(line({ kind: 'payout', orderNumber: null, reason: 'Ice' }))).toBe('Cash out — Ice');
    expect(drawerWhy(line({ kind: 'tip_out', orderNumber: null, reason: 'Test Rider' }))).toBe('Rider tip — Test Rider');
    expect(drawerWhy(line({ kind: 'float', orderNumber: null }))).toBe('Float at shift open');
    expect(drawerWhy(line({ kind: 'count', orderNumber: null }))).toBe('Opened to count');
    expect(drawerWhy(line({ kind: 'no_sale', orderNumber: null, reason: 'Change' }))).toBe('No sale — Change');
    expect(drawerWhy(line({ kind: 'test', orderNumber: null }))).toBe('Test (Settings)');
    expect(drawerWhy(line({ kind: 'something_new', orderNumber: null }))).toBe('Other');
  });

  it('the result: opened, already open, did not open, may not have, no printer; waiting only for two minutes; "—" before the log', () => {
    const now = Date.parse('2026-09-27T14:01:00.000Z');
    expect(drawerResult(line({ outcome: 'opened' }), now)).toBe('Opened');
    expect(drawerResult(line({ outcome: 'already_open' }), now)).toBe('Already open');
    expect(drawerResult(line({ outcome: 'not_opened' }), now)).toBe('Did not open — key used?');
    expect(drawerResult(line({ outcome: 'unsure' }), now)).toBe('May not have opened');
    expect(drawerResult(line({ outcome: 'no_printer' }), now)).toBe('No printer set up');
    expect(drawerResult(line({ outcome: null }), now)).toBe('Waiting…');
    expect(drawerResult(line({ outcome: null }), now + 5 * 60_000)).toBe('—');
  });

  it('cash signed into and out of the drawer; nothing for no sale', () => {
    expect(drawerCash(125_000)).toBe('+Rs 1,250');
    expect(drawerCash(-30_000)).toBe('−Rs 300');
    expect(drawerCash(0)).toBe('Rs 0');
    expect(drawerCash(null)).toBe('');
  });

  it('counts, pills, title, the footer and a shift\'s note', () => {
    const chips = drawerLogChips({ total: 7, byKind: { sale: 3, refund: 1, float: 1, no_sale: 2 }, byOutcome: { not_opened: 1, unsure: 1, opened: 5 } });
    expect(chips.filter((c) => c.n > 0).map((c) => `${c.label} ${c.n}`)).toEqual([
      'Cash sales 3',
      'Refunds 1',
      'Float 1',
      'No sale 2',
      'Did not open 1',
      'May not have opened 1',
    ]);
    expect(DRAWER_LOG_GROUPS.map((g) => g.label)).toEqual(['All', 'Sales & refunds', 'Cash in & out, float', 'No sale, count & test', 'Problems']);
    expect(drawerLogTitle(1)).toBe('Cash drawer log — used 1 time');
    expect(drawerLogTitle(12)).toBe('Cash drawer log — used 12 times');
    expect(drawerLogSinceText('2026-09-27T10:00:00.000Z')).toMatch(/^Drawer log started .+\. Before that only Open drawer, count and test were recorded\.$/);
    expect(shiftDrawerUseNote({ drawerOpenCount: 9, noSaleOpens: 1 })).toBe(' · drawer used 9× (1 no sale)');
    expect(shiftDrawerUseNote({ noSaleOpens: 2 })).toBe(' · drawer opened 2× with no sale');
    expect(shiftTestDeletedNote({ testDeletedCashCents: 125_000 })).toBe('Includes Rs 1,250 of test orders deleted after this shift closed.');
    expect(shiftTestDeletedNote({ testDeletedCashCents: 0 })).toBeNull();
    // Refunded in cash on this shift, the test deleted later: the saved
    // expected cash was LOWER because of it, and the note says so.
    expect(shiftTestDeletedNote({ testDeletedCashCents: -125_000 })).toBe(
      'Its expected cash was Rs 1,250 lower because of a test-order refund deleted after this shift closed.',
    );
  });

  it("a shift's log as a CSV: the same columns as Excel, formulas defused", () => {
    const csv = drawerLogCsv([line({}), line({ id: 'd2', kind: 'no_sale', orderNumber: null, amountCents: null, reason: 'Change', outcome: 'unsure', outcomeNote: '=cmd' })], Date.parse('2026-09-27T15:00:00.000Z'));
    const rows = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(rows[0]).toBe('When,Till,Why,Order,Cash Rs,By,Approved by,Result,Note');
    expect(rows[1]).toMatch(/,This till,Cash sale — Order #0042,20260927-0042,1250\.00,Test Cashier,,Opened,$/);
    expect(rows[2]).toContain('No sale — Change');
    // A cell that starts like a formula never runs as one in Excel.
    expect(rows[2]).toContain("May not have opened,'=cmd");
  });
});

describe('Reports → the drawer log panel', () => {
  it('opens on All, newest first, with the counts, the words and "Show 50 more" when there is more', () => {
    const page: DrawerLogPage = {
      rows: [
        line({}),
        line({ id: 'd2', kind: 'refund', orderNumber: '20260927-0031', amountCents: -20_000, approvedBy: 'Test Manager', outcome: 'not_opened', outcomeNote: 'The printer is off' }),
        line({ id: 'd3', kind: 'payin', orderNumber: null, reason: 'Change', till: 'other', outcome: null, createdAt: '2020-01-01T00:00:00.000Z' }),
      ],
      nextCursor: '2020-01-01T00:00:00.000Z|d3',
      counts: { total: 60, byKind: { sale: 1, refund: 1, payin: 58 }, byOutcome: { opened: 1, not_opened: 1, unknown: 58 } },
      logSince: '2026-09-27T10:00:00.000Z',
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['reports', 'drawerLog', 'A', 'B', null, 'all'], { pages: [page], pageParams: [null] });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <DrawerLogPanel sinceIso="A" untilIso="B" />
      </QueryClientProvider>,
    );
    for (const words of [
      'Cash drawer log — used 60 times',
      'Every time the till opened the cash drawer',
      'Opening it with the key is not recorded.',
      'Cash sales 1',
      'Did not open 1',
      'Cash sale — Order #0042',
      'Refund — Order #0031',
      '−Rs 200',
      'Test Manager',
      'Did not open — key used?',
      'The printer is off',
      'Cash in — Change',
      'Other till',
      'Before that only Open drawer, count and test were recorded.',
      `Show ${DRAWER_LOG_PAGE} more`,
    ]) {
      expect({ words, found: html.includes(words) }).toEqual({ words, found: true });
    }
    // 'All' is the one pressed.
    expect(html).toMatch(/aria-pressed="true"[^>]*>All</);
  });

  it("a shift's Print / Download CSV: a failed read is told, never swallowed; a good one is handed on", async () => {
    const handed: number[] = [];
    const told: string[] = [];
    await withWholeShiftLog(
      's1',
      (all) => handed.push(all.length),
      (m) => told.push(m),
      () => Promise.reject(new Error('Sign in again')),
    );
    expect(handed).toEqual([]);
    expect(told).toEqual(['Sign in again']);
    await withWholeShiftLog(
      's1',
      (all) => handed.push(all.length),
      (m) => told.push(m),
      () => Promise.resolve([line({}), line({ id: 'd2' })]),
    );
    expect(handed).toEqual([2]);
    expect(told).toEqual(['Sign in again']);
  });
});

describe('the order panel: "Papers printed"', () => {
  it('one line per paper with what it said; nothing when nothing printed', () => {
    const html = renderToStaticMarkup(
      <PapersPrinted
        orderCreatedAt="2026-09-27T14:30:00.000Z"
        papers={[
          { at: '2026-09-27T14:35:00.000Z', document: 'receipt', copy: 'customer', label: 'Original', duplicate: false, byName: 'Ali', approvedByName: null, reason: 'payment', otherTill: false },
          { at: '2026-09-27T14:52:00.000Z', document: 'receipt', copy: 'customer', label: 'Reprint #1', duplicate: true, byName: 'Sana', approvedByName: 'Owner', reason: 'reprint', otherTill: true },
        ]}
      />,
    );
    expect(html).toContain('Papers printed (2)');
    expect(html).toContain('19:35 RECEIPT — Original — at payment — Ali');
    expect(html).toContain('19:52 RECEIPT — DUPLICATE Reprint #1 — Sana (approved by Owner) (other till)');
    expect(html).toContain(PAPERS_RULE_NOTE);
    expect(renderToStaticMarkup(<PapersPrinted orderCreatedAt="2026-09-27T14:30:00.000Z" papers={[]} />)).toBe('');
  });
});
