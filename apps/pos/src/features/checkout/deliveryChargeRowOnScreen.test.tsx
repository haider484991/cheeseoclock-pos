/**
 * The delivery-charge row under the area on the customer panel (owner,
 * 28 Sep 2026: "if delivery area selected the delivery fee should be
 * automatically added"). The main process puts the charge on with the area
 * on every path; this row only SHOWS what the bill carries, with "Take it
 * off" / "Put it back". Rendered to static markup (react-dom/server, no
 * browser, nothing calls the till): the charge on the bill with "Take it
 * off"; before the till has answered, the fee without "taken off by hand"
 * (never a wrong claim during the moment it takes); an area not on the list
 * says the till adds no charge and takes the old one off. Made-up figures.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DELIVERY_ZONES, type OrderSnapshot } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { CustomerInlinePanel, deliveryTellPhone, makeEmptyCustomerForm } from './CustomerInlinePanel';

/**
 * Every plain <button> as JSX made it (its props, with its tap), so a test
 * can press one: a server render keeps no handlers in the markup.
 */
const made = vi.hoisted(() => {
  const buttons: Array<Record<string, unknown>> = [];
  type Jsx = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => unknown;
  const record =
    (jsx: Jsx): Jsx =>
    (type, props, ...rest) => {
      if (type === 'button' && props) buttons.push(props);
      return jsx(type, props, ...rest);
    };
  return { buttons, record };
});
vi.mock('react/jsx-runtime', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  type Jsx = Parameters<typeof made.record>[0];
  return { ...real, jsx: made.record(real['jsx'] as Jsx), jsxs: made.record(real['jsxs'] as Jsx) };
});
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, jsxDEV: made.record(real['jsxDEV'] as Parameters<typeof made.record>[0]) };
});

// A server render reads a zustand store's INITIAL state; the till's window reads each as it is now.
vi.mock('zustand', async (importOriginal) => {
  const z = await importOriginal<typeof import('zustand')>();
  type Hook = ((select?: (state: unknown) => unknown) => unknown) & { getState: () => unknown };
  const live = (hook: Hook) =>
    Object.assign((select: (state: unknown) => unknown = (state) => state) => select(hook.getState()), hook);
  const make = (init: unknown) => live(z.create(init as Parameters<typeof z.create>[0]) as unknown as Hook);
  return { ...z, create: (init?: unknown) => (init === undefined ? make : make(init)) };
});

const MENU = [
  { id: 'fee-200', name: 'Delivery Charge (Rs 200)', basePriceCents: 20_000, isActive: true, categoryId: 'c-fees' },
  { id: 'fee-250', name: 'Delivery Charge (Rs 250)', basePriceCents: 25_000, isActive: true, categoryId: 'c-fees' },
  { id: 'fee-300', name: 'Delivery Charge (Rs 300)', basePriceCents: 30_000, isActive: true, categoryId: 'c-fees' },
];

/** The areas the till has (Settings → Delivery areas); the released ones unless a test raises a fee. */
let rules: unknown = undefined;
function render(node: ReactNode): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['menu', 'items', { categoryId: null, activeOnly: true }], MENU);
  if (rules !== undefined) qc.setQueryData(['checkout-rules'], rules);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function order(lines: Array<[string, number]>, addOnTo?: OrderSnapshot['addOnTo']): OrderSnapshot {
  return {
    ...(addOnTo !== undefined ? { addOnTo } : {}),
    order: { id: 'o1', status: 'open', mode: 'delivery', source: 'pos', tableId: null },
    items: lines.map(([name, cents], i) => ({
      id: `l${i}`,
      orderId: 'o1',
      menuItemId: name.startsWith('Delivery') ? `fee-${cents / 100}` : 'm_pizza',
      menuItemName: name,
      quantity: 1,
      unitPriceCents: cents,
      lineTotalCents: cents,
      taxRateBps: 1_600,
      notes: null,
      modifiers: [],
      kitchenStatus: 'pending',
      createdAt: '2026-09-28T10:00:00.000Z',
    })),
    discounts: [],
    payments: [],
  } as unknown as OrderSnapshot;
}
const panel = (area: string, phone = '') =>
  render(<CustomerInlinePanel mode="delivery" form={{ ...makeEmptyCustomerForm(), area, phone }} setForm={() => {}} />);

const realSetDeliveryArea = useCheckoutStore.getState().setDeliveryArea;
afterEach(() => {
  useCheckoutStore.setState({ snapshot: null, mode: 'takeaway', busy: false, setDeliveryArea: realSetDeliveryArea });
  rules = undefined;
  made.buttons.length = 0;
});

describe('the delivery-charge row only shows what the bill carries', () => {
  it('the area’s charge on the bill: says so, with “Take it off”', () => {
    useCheckoutStore.setState({ mode: 'delivery', snapshot: order([['Test Pizza', 100_000], ['Delivery Charge (Rs 200)', 20_000]]) });
    const t = text(panel('DHA Phase 6'));
    expect(t).toContain('Rs 200 delivery charge is on the bill');
    expect(t).toContain('Take it off');
    expect(t).not.toContain('Put it back');
  });

  it('not on the bill before the till has answered: the fee, never “taken off by hand”, no button yet', () => {
    useCheckoutStore.setState({ mode: 'delivery', snapshot: order([['Test Pizza', 100_000]]) });
    const t = text(panel('DHA Phase 8'));
    expect(t).toContain('Delivery to this area is Rs 250');
    expect(t).not.toContain('taken off by hand');
    expect(t).not.toContain('Put it back');
  });

  it('an area not on the list: the till adds no charge and takes the old area’s off — in words', () => {
    useCheckoutStore.setState({ mode: 'delivery', snapshot: order([['Test Pizza', 100_000]]) });
    expect(text(panel('Gulshan Block 13'))).toContain(
      'Not one of the delivery areas (Settings → Delivery areas): the till adds no delivery charge, and takes off the one it added for the area before. Add one by hand if you deliver there.',
    );
  });

  // Review of 865657b: with a charge at ANOTHER fee on the bill the row said "Delivery to this area
  // is Rs 300 — not on the bill (taken off by hand)" and "Put it back", while Rs 250 WAS on the bill.
  it('a fee raised while the order is open: the bill’s Rs 250 and the area’s Rs 300, with a one-tap swap — never “taken off by hand”', () => {
    rules = {
      delivery: {
        zones: DEFAULT_DELIVERY_ZONES.zones.map((z) => (z.id === 'dha-8' ? { ...z, feeCents: 30_000, feeItemId: 'fee-300' } : z)),
      },
    };
    useCheckoutStore.setState({ mode: 'delivery', snapshot: order([['Test Pizza', 100_000], ['Delivery Charge (Rs 250)', 25_000]]) });
    const t = text(panel('DHA Phase 8'));
    expect(t).toContain('The bill has a Rs 250 delivery charge — this area’s charge is Rs 300');
    expect(t).toContain('Change to Rs 300');
    expect(t).not.toContain('taken off by hand');
    expect(t).not.toContain('Put it back');
    expect(t).not.toContain('is on the bill');
  });

  it('another charge tapped on by hand: the same words and swap', () => {
    useCheckoutStore.setState({ mode: 'delivery', snapshot: order([['Test Pizza', 100_000], ['Delivery Charge (Rs 200)', 20_000]]) });
    const t = text(panel('DHA Phase 8'));
    expect(t).toContain('The bill has a Rs 200 delivery charge — this area’s charge is Rs 250');
    expect(t).toContain('Change to Rs 250');
    expect(t).not.toContain('taken off by hand');
  });

  it('the area’s charge and another on the bill: never just “on the bill” — says both, and keeps only the area’s in one tap', () => {
    useCheckoutStore.setState({
      mode: 'delivery',
      snapshot: order([['Test Pizza', 100_000], ['Delivery Charge (Rs 200)', 20_000], ['Delivery Charge (Rs 250)', 25_000]]),
    });
    const t = text(panel('DHA Phase 8'));
    expect(t).toContain('The bill has a Rs 200 delivery charge as well as this area’s Rs 250 — check it');
    expect(t).toContain('Keep only Rs 250');
    expect(t).not.toContain('Rs 250 delivery charge is on the bill');
  });
});

/**
 * Add-on delivery (v0.7.34, step 18-11; the owner, 2 Oct 2026: "if its out
 * then it should charge if the rider is not out"): the main process left the
 * area's charge off because the same phone's delivery #0042 is still in the
 * shop (OrderSnapshot.addOnTo). The row says so in green, with "Put it
 * back". Made-up phone and order numbers.
 */
describe('an add-on delivery: “Goes with #0042: no second delivery charge”', () => {
  const GOES_WITH = { orderId: 'o42', orderNumber: '20261002-0042' } as unknown as NonNullable<OrderSnapshot['addOnTo']>;
  const wordsOf = (n: unknown): string =>
    typeof n === 'string' || typeof n === 'number'
      ? String(n)
      : Array.isArray(n)
        ? n.map(wordsOf).join('')
        : n && typeof n === 'object' && 'props' in n
          ? wordsOf((n as { props: { children?: unknown } }).props.children)
          : '';
  /** The last-made plain button with exactly these words. */
  const button = (words: string) => made.buttons.filter((b) => wordsOf(b['children']).trim() === words).pop();

  it('reads “Goes with #0042: no second delivery charge” in green, with “Put it back” — never “taken off by hand”', () => {
    useCheckoutStore.setState({ mode: 'delivery', snapshot: order([['Test Pizza', 100_000]], GOES_WITH) });
    const html = panel('DHA Phase 6', '0300 1234567');
    const t = text(html);
    expect(t).toContain('Goes with #0042: no second delivery charge Put it back');
    expect(t).not.toContain('taken off by hand');
    expect(t).not.toContain('Take it off');
    expect(t).not.toContain('Delivery to this area is Rs 200');
    expect(html).toContain('bg-emerald-50');
  });

  it('“Put it back” asks the till for the area’s charge with putBack, for this order, with the phone the row told', async () => {
    const asked: Array<[string, unknown]> = [];
    useCheckoutStore.setState({
      mode: 'delivery',
      snapshot: order([['Test Pizza', 100_000]], GOES_WITH),
      setDeliveryArea: async (area, opts) => {
        asked.push([area, opts]);
      },
    });
    panel('DHA Phase 6', '0300 1234567');
    const putBack = button('Put it back');
    expect(putBack).toBeDefined();
    (putBack!['onClick'] as () => void)();
    await Promise.resolve();
    expect(asked).toEqual([['DHA Phase 6', { putBack: true, forOrderId: 'o1', phone: '0300 1234567' }]]);
  });

  it('a change on its way to the till: the words, no button yet', () => {
    useCheckoutStore.setState({ mode: 'delivery', busy: true, snapshot: order([['Test Pizza', 100_000]], GOES_WITH) });
    const t = text(panel('DHA Phase 6', '0300 1234567'));
    expect(t).toContain('Goes with #0042: no second delivery charge');
    expect(t).not.toContain('Put it back');
  });

  it('a charge on the bill anyway (tapped on by hand): the row says what the bill has, not “no second charge”', () => {
    useCheckoutStore.setState({
      mode: 'delivery',
      snapshot: order([['Test Pizza', 100_000], ['Delivery Charge (Rs 200)', 20_000]], GOES_WITH),
    });
    const t = text(panel('DHA Phase 6', '0300 1234567'));
    expect(t).toContain('Rs 200 delivery charge is on the bill');
    expect(t).not.toContain('Goes with');
  });

  it('without it (null, or not filled in) the row reads exactly as before', () => {
    for (const addOnTo of [null, undefined]) {
      useCheckoutStore.setState({ mode: 'delivery', snapshot: order([['Test Pizza', 100_000], ['Delivery Charge (Rs 200)', 20_000]], addOnTo) });
      const charged = text(panel('DHA Phase 6', '0300 1234567'));
      expect(charged).toContain('Rs 200 delivery charge is on the bill');
      expect(charged).toContain('Take it off');
      expect(charged).not.toContain('Goes with');
      useCheckoutStore.setState({ snapshot: order([['Test Pizza', 100_000]], addOnTo) });
      const telling = text(panel('DHA Phase 8'));
      expect(telling).toContain('Delivery to this area is Rs 250');
      expect(telling).not.toContain('Goes with');
    }
  });

  it('an area with no charge (free, switched off, not on the list): no add-on words either', () => {
    useCheckoutStore.setState({ mode: 'delivery', snapshot: order([['Test Pizza', 100_000]], GOES_WITH) });
    const t = text(panel('Gulshan Block 13', '0300 1234567'));
    expect(t).toContain('Not one of the delivery areas');
    expect(t).not.toContain('Goes with');
  });
});

describe('the phone the row tells with the area (deliveryTellPhone)', () => {
  it('a whole number is told as typed, in any of its forms', () => {
    expect(deliveryTellPhone(null, '0300 1234567')).toBe('0300 1234567');
    expect(deliveryTellPhone(null, ' +92 300 1234567 ')).toBe('+92 300 1234567');
    expect(deliveryTellPhone('03001234567', '03017654321')).toBe('03017654321');
  });

  it('the box emptied: no phone (null)', () => {
    expect(deliveryTellPhone('03001234567', '')).toBeNull();
    expect(deliveryTellPhone('03001234567', '   ')).toBeNull();
    expect(deliveryTellPhone(null, '')).toBeNull();
  });

  it('a digit being typed, deleted or fixed: the one told before — not another customer at every keystroke', () => {
    expect(deliveryTellPhone(null, '0300')).toBeNull();
    expect(deliveryTellPhone(null, '0300 123456')).toBeNull();
    expect(deliveryTellPhone('0300 1234567', '0300 123456')).toBe('0300 1234567');
    expect(deliveryTellPhone('0300 1234567', '0300 123456x')).toBe('0300 1234567');
    // Typed back whole: told again (the main process sees the same delivery to go with).
    expect(deliveryTellPhone('0300 1234567', '0300 1234567')).toBe('0300 1234567');
  });
});
