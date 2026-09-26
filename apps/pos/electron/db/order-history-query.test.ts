import { describe, expect, it } from 'vitest';
import {
  buildOrderHistoryWhere,
  historyPage,
  likeContains,
  methodsFromLegs,
  parseHistorySearch,
  phoneCore,
  PLACED_ORDER_SQL,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
} from './order-history-query.js';

describe('placed orders only', () => {
  it('never lists a cart still being rung up', () => {
    const { sql, params } = buildOrderHistoryWhere(undefined);
    expect(sql).toContain(`o.status <> 'open'`);
    expect(sql).toContain('o.deleted_at IS NULL');
    expect(params).toEqual([]);
  });

  it('hides a cart that was cancelled before it was ever sent', () => {
    // The void's audit row remembers the status it came from.
    expect(PLACED_ORDER_SQL).toContain(`o.status = 'void'`);
    expect(PLACED_ORDER_SQL).toContain(`json_extract(ha.before_json, '$.status')`);
    expect(PLACED_ORDER_SQL).toContain(`= 'open'`);
  });

  it('keeps the placed rule whatever else is filtered', () => {
    const { sql } = buildOrderHistoryWhere({ statusGroup: 'cancelled', channel: 'web', search: 'ali' });
    expect(sql.startsWith(PLACED_ORDER_SQL)).toBe(true);
  });
});

describe('search', () => {
  it('reads a short number as the order number', () => {
    expect(parseHistorySearch('42')).toEqual({ kind: 'orderNo', n: 42 });
    expect(parseHistorySearch('#42')).toEqual({ kind: 'orderNo', n: 42 });
    expect(parseHistorySearch('  # 0042 ')).toEqual({ kind: 'orderNo', n: 42 });
  });

  it('reads a long number as a phone, whatever its format', () => {
    for (const q of ['03001234567', '0300-1234567', '+92 300 1234567', '923001234567', '0092 300 1234567']) {
      const s = parseHistorySearch(q);
      expect(s.kind).toBe('digits');
      if (s.kind === 'digits') expect(s.phoneCore).toBe('3001234567');
    }
  });

  it('keeps part of a phone as typed', () => {
    const s = parseHistorySearch('1234567');
    expect(s).toEqual({ kind: 'digits', digits: '1234567', phoneCore: '1234567' });
  });

  it('matches a full receipt order number as text', () => {
    expect(parseHistorySearch('20260926-0042')).toEqual({ kind: 'text', text: '20260926-0042' });
  });

  it('treats words as a name search', () => {
    expect(parseHistorySearch('  Ali Khan ')).toEqual({ kind: 'text', text: 'Ali Khan' });
    expect(parseHistorySearch('')).toEqual({ kind: 'none' });
    expect(parseHistorySearch(undefined)).toEqual({ kind: 'none' });
  });

  it('builds the right condition for each kind', () => {
    const byNo = buildOrderHistoryWhere({ search: '#7' });
    expect(byNo.sql).toContain(`CAST(substr(o.order_number, instr(o.order_number, '-') + 1) AS INTEGER) = ?`);
    expect(byNo.params).toEqual([7]);

    const byPhone = buildOrderHistoryWhere({ search: '0300 1234567' });
    expect(byPhone.params).toEqual(['%3001234567%', '03001234567%']);

    const byName = buildOrderHistoryWhere({ search: 'ali' });
    expect(byName.sql).toContain('o.customer_name_snapshot');
    expect(byName.params).toEqual(['%ali%', '%ali%', '%ali%']);
  });

  it('takes the user\'s own % and _ literally', () => {
    expect(likeContains('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });

  it('strips the country code or trunk zero from a phone', () => {
    expect(phoneCore('03001234567')).toBe('3001234567');
    expect(phoneCore('923001234567')).toBe('3001234567');
    expect(phoneCore('00923001234567')).toBe('3001234567');
    // Too short to carry a country code: left alone.
    expect(phoneCore('92345')).toBe('92345');
  });
});

describe('filters', () => {
  it('bounds the date range half-open, like Reports', () => {
    const { sql, params } = buildOrderHistoryWhere({
      sinceIso: '2026-09-26T00:00:00.000Z',
      untilIso: '2026-09-27T00:00:00.000Z',
    });
    expect(sql).toContain('o.created_at >= ?');
    expect(sql).toContain('o.created_at < ?');
    expect(sql).not.toContain('o.created_at <= ?');
    expect(params).toEqual(['2026-09-26T00:00:00.000Z', '2026-09-27T00:00:00.000Z']);
  });

  it('maps each status choice to the statuses behind it', () => {
    expect(buildOrderHistoryWhere({ statusGroup: 'in_progress' }).params).toEqual([
      'sent_to_kitchen',
      'preparing',
      'ready',
      'out_for_delivery',
    ]);
    expect(buildOrderHistoryWhere({ statusGroup: 'done' }).params).toEqual(['paid', 'served', 'delivered']);
    expect(buildOrderHistoryWhere({ statusGroup: 'not_paid' }).sql).toContain('o.paid_at IS NULL');
    expect(buildOrderHistoryWhere({ statusGroup: 'cancelled' }).sql).toMatch(/AND\s+o\.status = 'void'/);
    // Part refunds leave the order 'paid' — they still count as refunded.
    expect(buildOrderHistoryWhere({ statusGroup: 'refunded' }).sql).toContain('hp.amount_cents < 0');
    expect(buildOrderHistoryWhere({ statusGroup: 'all' }).sql).toBe(PLACED_ORDER_SQL);
  });

  it('filters by channel, with website orders by source', () => {
    expect(buildOrderHistoryWhere({ channel: 'delivery' }).params).toEqual(['delivery']);
    expect(buildOrderHistoryWhere({ channel: 'web' }).sql).toContain(`o.source = 'web'`);
    expect(buildOrderHistoryWhere({ channel: 'all' }).sql).toBe(PLACED_ORDER_SQL);
  });

  it('filters by a payment method actually taken (not a refund)', () => {
    const { sql, params } = buildOrderHistoryWhere({ paymentMethod: 'card' });
    expect(sql).toContain('hp.amount_cents > 0 AND hp.method = ?');
    expect(params).toEqual(['card']);
  });

  it('ignores values it does not know', () => {
    const junk = buildOrderHistoryWhere({
      // Renderer input is untrusted: unknown choices mean "all".
      statusGroup: 'nonsense' as never,
      channel: 'drone' as never,
      paymentMethod: 'bitcoin' as never,
    });
    expect(junk.sql).toBe(PLACED_ORDER_SQL);
    expect(junk.params).toEqual([]);
  });

  it('keeps parameters in the same order as their placeholders', () => {
    const { sql, params } = buildOrderHistoryWhere({
      sinceIso: 'S',
      untilIso: 'U',
      statusGroup: 'done',
      channel: 'takeaway',
      paymentMethod: 'cash',
      search: '#3',
    });
    expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
    expect(params).toEqual(['S', 'U', 'paid', 'served', 'delivered', 'takeaway', 'cash', 3]);
  });
});

describe('paging', () => {
  it('defaults and clamps page size and offset', () => {
    expect(historyPage(undefined)).toEqual({ limit: HISTORY_DEFAULT_LIMIT, offset: 0 });
    expect(historyPage({ limit: 5000, offset: -3 })).toEqual({ limit: HISTORY_MAX_LIMIT, offset: 0 });
    expect(historyPage({ limit: 0, offset: 100 })).toEqual({ limit: 1, offset: 100 });
    expect(historyPage({ limit: Number.NaN, offset: Number.NaN })).toEqual({
      limit: HISTORY_DEFAULT_LIMIT,
      offset: 0,
    });
  });
});

describe('payment methods on a row', () => {
  it('lists each method once, largest amount first', () => {
    expect(methodsFromLegs('cash:30000,card:120000,cash:5000')).toEqual(['card', 'cash']);
    expect(methodsFromLegs('foodpanda:99900')).toEqual(['foodpanda']);
  });

  it('copes with nothing paid or odd values', () => {
    expect(methodsFromLegs(null)).toEqual([]);
    expect(methodsFromLegs('')).toEqual([]);
    expect(methodsFromLegs('gold:100,cash:x')).toEqual(['cash']);
  });
});
