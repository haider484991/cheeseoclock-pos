/**
 * The delivery-charge row tells the main process an area the cashier set or
 * cleared — never the empty form an order-type switch or a restart leaves
 * behind (review of f55e3f0: Delivery → Takeaway → Delivery emptied the
 * form, the row told "no area", the charge came off, and Send went out on
 * the saved address without it). What it tells is pos-domain
 * makeDeliveryAreaTeller (tested there); this checks the row asks it. No
 * browser in these tests, so the row is read from its source.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeDeliveryAreaTeller } from '@cheeseoclock/pos-domain';

describe('the delivery-charge row on the customer panel', () => {
  it('keeps one teller per row, asks it before every tell, and records the tell when it goes', () => {
    const src = readFileSync(fileURLToPath(new URL('./CustomerInlinePanel.tsx', import.meta.url)), 'utf8');
    const row = src.slice(src.indexOf('function DeliveryChargeRow('));
    const body = row.slice(0, row.indexOf('\n}\n'));
    const ask = body.indexOf('teller.shouldTell(orderId, area)');
    const wait = body.indexOf('const t = setTimeout(() => {');
    const told = body.indexOf('teller.told(orderId, area)');
    const tell = body.indexOf('setDeliveryArea(area, { mayStartOrder');
    expect(body).toContain('useRef<DeliveryAreaTeller | null>(null)');
    expect(body).toContain('makeDeliveryAreaTeller()');
    expect(ask).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(ask);
    // Recorded when the ask goes — inside the wait — so an area deleted before it ends was never told.
    expect(told).toBeGreaterThan(wait);
    expect(tell).toBeGreaterThan(told);
  });

  it('the empty form after an order-type switch is not told; an area, and a clear after it, are', () => {
    const row = makeDeliveryAreaTeller();
    expect(row.shouldTell('o1', '')).toBe(false);
    expect(row.shouldTell('o1', 'DHA Phase 6')).toBe(true);
    row.told('o1', 'DHA Phase 6');
    expect(row.shouldTell('o1', '')).toBe(true);
  });
});
