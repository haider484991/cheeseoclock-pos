/**
 * The delivery charge follows the area (owner, 28 Sep 2026), and a charge the
 * cashier takes off by hand stays off. The customer panel's row asks the
 * main process only when the area, the order type or the order changes —
 * and the row is re-created every time the cashier comes back from "Edit
 * order" (where the cart's × is), so what it last asked must outlive it.
 * Order ids and areas are made up.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  deliveryChargeAskFor,
  forgetDeliveryChargeAsked,
  noteDeliveryChargeAsked,
  type DeliveryChargeAskState,
} from './deliveryChargeAsk';

/** One row on screen: what it does when it mounts or its inputs change (the effect, without React). */
function row(s: DeliveryChargeAskState): 'same' | 'note' | 'ask' {
  const todo = deliveryChargeAskFor(s);
  if (todo !== 'same') noteDeliveryChargeAsked(s);
  return todo;
}

const at = (area: string, over: Partial<DeliveryChargeAskState> = {}): DeliveryChargeAskState => ({
  orderId: 'order-1',
  mode: 'delivery',
  area,
  wouldAdd: true,
  ...over,
});

beforeEach(() => forgetDeliveryChargeAsked());

describe('when the till asks for the area’s delivery charge', () => {
  it('Edit order → × on the charge → Continue: the row comes back for the same order and area and does NOT ask again (the charge stays off)', () => {
    expect(row(at('DHA Phase 6'))).toBe('ask'); // picked: the Rs 200 line goes on
    // "Edit order": the row leaves the screen; the cashier removes the charge with ×.
    // "Continue": a NEW row for the same order, type and area.
    expect(row(at('DHA Phase 6'))).toBe('same');
    expect(row(at(' DHA Phase 6 '))).toBe('same');
  });

  it('the area changed, cleared after one was there, or the order type changed and back: asks', () => {
    expect(row(at('DHA Phase 6'))).toBe('ask');
    expect(row(at('DHA Phase 8'))).toBe('ask'); // swap
    expect(row(at(''))).toBe('ask'); // cleared: the charge comes off
    expect(row(at('DHA Phase 8'))).toBe('ask');
    expect(row(at('DHA Phase 8', { mode: 'takeaway' }))).toBe('ask');
    expect(row(at('DHA Phase 8'))).toBe('ask'); // back to Delivery: the main process took it off on the way out
  });

  it('a bill that never had an area is left alone (a charge tapped on by hand stays); a new order starts fresh', () => {
    expect(row(at(''))).toBe('note');
    expect(row(at(''))).toBe('same');
    expect(row(at('DHA Phase 6'))).toBe('ask');
    expect(row(at('', { orderId: 'order-2' }))).toBe('note');
  });

  it('no order yet: asks once a charge would go on (to start the order), and again once the order exists', () => {
    expect(row(at('DHA Phase 6', { orderId: null, wouldAdd: false }))).toBe('ask');
    expect(row(at('DHA Phase 6', { orderId: null, wouldAdd: true }))).toBe('ask');
    expect(row(at('DHA Phase 6', { orderId: null, wouldAdd: true }))).toBe('same');
    expect(row(at('DHA Phase 6'))).toBe('ask'); // the order now exists: the main process never doubles
    expect(row(at('DHA Phase 6'))).toBe('same');
  });
});
