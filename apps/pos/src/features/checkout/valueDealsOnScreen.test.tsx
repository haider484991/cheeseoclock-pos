/**
 * The owner, 2026-10-02: value deals never get a discount. Every screen that
 * shows a bill says "not on value deals" when an order's discount left its
 * deals alone — the cart, Pay, the receipt after Pay and the order drawer —
 * from the discount's OWN frozen rule (the snapshot's skipsNoDiscountLines)
 * and the deal lines on the order (noDiscount); F3 says what it is worked on
 * (under either setting of the owner's delivery-charge switch) and, with only
 * deals on the order, that there is nothing to take off, shows no choice and
 * keeps the cursor (and so Enter) in the dialog; and
 * "Add discount" says so on the button itself. A foodpanda order covers its
 * deals, as the tablet does. Static renders (react-dom/server, no browser;
 * nothing calls the till); Radix's dialog is stood in for by plain elements.
 * Every name and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { NOTHING_TO_DISCOUNT } from '@cheeseoclock/pos-domain';
import type { AuthenticatedUser, CheckoutRules, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { CHECKOUT_RULES_KEY } from '../settings/shop-rules/useShopSetting';
import { CartPane } from './CartPane';
import { DiscountDialog } from './DiscountDialog';
import { TenderDialog } from './TenderDialog';
import { ReceiptDialog } from './ReceiptDialog';
import { OrderDetailDrawer } from '../orders/OrderDetailDrawer';

/** The props the last dialog rendered gave Radix's Content: the handlers Radix would call (on open, on a key). */
const radix = vi.hoisted(() => ({ content: null as Record<string, unknown> | null }));

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
    Content: (props: P & Record<string, unknown>) => {
      radix.content = props;
      return h('div', { className: props.className, role: 'dialog' }, props.children);
    },
    Title: tag('h2'),
    Description: tag('p'),
    Close: pass,
    Trigger: pass,
  };
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

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const ariaLabels = (markup: string) => [...markup.matchAll(/aria-label="([^"]*)"/g)].map((m) => decode(m[1]!));
/** The opening tag of the `tag` element holding `needle` (in its text or its attributes). */
const tagOf = (markup: string, needle: string, tag = 'button'): string => {
  const at = markup.indexOf(needle);
  expect(at, needle).toBeGreaterThan(-1);
  const open = markup.lastIndexOf(`<${tag}`, at);
  return markup.slice(open, markup.indexOf('>', open) + 1);
};
/** Every button's opening tag. */
const buttons = (markup: string) => markup.match(/<button[^>]*>/g) ?? [];

/**
 * Radix opening the last dialog rendered: its onOpenAutoFocus, with the few
 * DOM bits it touches as plain objects. The cursor starts in the menu search
 * behind the dialog (where it is after "big" + Enter); the "Other" amount box
 * takes it only when `boxTakesCursor` (a box that is off takes none, as in a
 * browser). Says where the cursor ended up.
 */
function openDialog(boxTakesCursor: boolean): 'menu search' | 'amount box' | 'dialog' {
  type Doc = { activeElement: unknown };
  type El = { focus: () => void };
  type Dialog = El & { ownerDocument: Doc; querySelector: (sel: string) => El | null; contains: (el: unknown) => boolean };
  const doc: Doc = { activeElement: 'menu search' };
  const box: El = {
    focus: () => {
      if (boxTakesCursor) doc.activeElement = box;
    },
  };
  const dialog: Dialog = {
    ownerDocument: doc,
    querySelector: (sel) => (sel === '[data-field="custom"]' ? box : null),
    contains: (el) => el === dialog || el === box,
    focus: () => {
      doc.activeElement = dialog;
    },
  };
  const preventDefault = vi.fn();
  const onOpenAutoFocus = radix.content?.['onOpenAutoFocus'] as (e: { preventDefault: () => void; currentTarget: Dialog }) => void;
  onOpenAutoFocus({ preventDefault, currentTarget: dialog });
  expect(preventDefault).toHaveBeenCalledOnce();
  return doc.activeElement === dialog ? 'dialog' : doc.activeElement === box ? 'amount box' : 'menu search';
}

const RULES: CheckoutRules = {
  discounts: {
    approval: { percentOver: 10, flatOverCents: 50_000 },
    presets: { percents: [10, 20], flatCents: [10_000], reasons: ['Staff'] },
    alsoOffDeliveryCharge: false,
    reasonRequired: false,
  },
  kitchen: { amberMin: 5, redMin: 10, notStartedMin: 5, notDoneMin: 20 },
  foodpanda: { deal: null, checks: { orderCode: 'optional', tabletTotal: 'optional' }, tabletToleranceCents: 100, upliftBps: 0 },
} as unknown as CheckoutRules;
const RULES_SEED: Array<[readonly unknown[], unknown]> = [[CHECKOUT_RULES_KEY, RULES]];

const line = (id: string, name: string, cents: number, noDiscount: boolean) => ({
  id,
  orderId: 'o1',
  menuItemId: `m_${id}`,
  menuItemName: name,
  categoryName: noDiscount ? 'Value Deals' : 'Pizza',
  quantity: 1,
  unitPriceCents: cents,
  lineTotalCents: cents,
  taxRateBps: 1_600,
  notes: null,
  modifiers: [],
  kitchenStatus: 'pending',
  noDiscount,
});

/**
 * A takeaway of a Rs 3,600 value deal and a Rs 1,500 pizza with a staff 10%
 * whose rule left the deal alone (Rs 150), or — `dealsOnly` — the deal alone,
 * with no discount (with `discount`, the staff 10% left at Rs 0 when the
 * pizza was taken off); `mode` 'foodpanda' for a foodpanda order. `charge`:
 * a delivery with the area's Rs 200 "Delivery Charge (Rs 200)" line;
 * `noDeal`: without the value deal.
 */
function order(
  opts: { status?: 'open' | 'paid'; dealsOnly?: boolean; noDeal?: boolean; charge?: boolean; discount?: boolean; mode?: string; skips?: boolean } = {},
): OrderSnapshot {
  const status = opts.status ?? 'open';
  const items = [
    ...(opts.noDeal ? [] : [line('l1', 'Test Big Deal', 360_000, true)]),
    ...(opts.dealsOnly ? [] : [line('l2', 'Test Pizza', 150_000, false)]),
    ...(opts.charge ? [line('l3', 'Delivery Charge (Rs 200)', 20_000, false)] : []),
  ];
  const subtotalCents = items.reduce((s, i) => s + i.lineTotalCents, 0);
  const discountCents = opts.discount && !opts.dealsOnly ? 15_000 : 0;
  const taxCents = Math.round(((subtotalCents - discountCents) * 16) / 100);
  const totalCents = subtotalCents - discountCents + taxCents;
  return {
    order: {
      id: 'o1',
      orderNumber: '20261002-0007',
      mode: opts.mode ?? (opts.charge ? 'delivery' : 'takeaway'),
      status,
      source: 'pos',
      notes: null,
      cashierId: 'u1',
      tableId: null,
      subtotalCents,
      discountCents,
      taxCents,
      totalCents,
      createdAt: '2026-10-02T10:00:00.000Z',
      paidAt: status === 'paid' ? '2026-10-02T10:20:00.000Z' : null,
      dispatchedAt: null,
    },
    items,
    discounts: opts.discount
      ? [
          {
            id: 'd1',
            orderId: 'o1',
            discountType: 'percent',
            value: 10,
            reason: 'Staff',
            appliedByUserId: 'u1',
            approvedByUserId: null,
            amountCents: discountCents,
            source: null,
            foodpanda: null,
            alsoOffDeliveryCharge: false,
            ...(opts.skips === false ? {} : { skipsNoDiscountLines: true }),
          },
        ]
      : [],
    payments:
      status === 'paid'
        ? [{ id: 'p1', orderId: 'o1', method: 'cash', amountCents: totalCents, tenderedCents: totalCents, referenceNo: null, receivedByUserId: 'u1', paidAt: '2026-10-02T10:20:00.000Z' }]
        : [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: null,
    customerPhone: null,
    deliveryAddress: null,
    deliveryNotes: null,
    rider: null,
  } as unknown as OrderSnapshot;
}

const noop = () => {};
const cart = (seed = RULES_SEED) =>
  render(
    <CartPane step="items" onContinue={noop} onBack={noop} onPay={noop} onDiscount={noop} onRemoveDeal={noop} onSendToKitchen={noop} onCustomize={noop} />,
    seed,
  );

describe('a discount that left the value deals alone says so on every bill screen', () => {
  it('the cart', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order({ discount: true }), busy: false });
    expect(text(cart())).toContain('Discount · 10% off, not on value deals · Staff');
  });

  it('Pay', () => {
    signIn('cashier');
    const snapshot = order({ discount: true });
    useCheckoutStore.setState({ snapshot, busy: false });
    expect(text(render(<TenderDialog snapshot={snapshot} onClose={noop} onPaid={noop} />))).toContain('Discount (not on value deals)');
  });

  it('the receipt after Pay', () => {
    signIn('cashier');
    const words = text(render(<ReceiptDialog snapshot={order({ status: 'paid', discount: true })} onClose={noop} />));
    expect(words).toContain('Subtotal 5,100 Discount (Staff, not on value deals) −150 Tax');
  });

  it('the order drawer', () => {
    signIn('admin');
    const words = text(render(<OrderDetailDrawer orderId="o1" onClose={noop} />, [[['orders', 'detail', 'o1'], order({ status: 'paid', discount: true })]]));
    expect(words).toContain('Discount (Staff, not on value deals)');
  });

  it('given before 0.7.34 (no rule field): no "not on value deals" anywhere', () => {
    signIn('admin');
    const open = order({ discount: true, skips: false });
    useCheckoutStore.setState({ snapshot: open, busy: false });
    const paid = order({ status: 'paid', discount: true, skips: false });
    const screens = [
      text(cart()),
      text(render(<TenderDialog snapshot={open} onClose={noop} onPaid={noop} />)),
      text(render(<ReceiptDialog snapshot={paid} onClose={noop} />)),
      text(render(<OrderDetailDrawer orderId="o1" onClose={noop} />, [[['orders', 'detail', 'o1'], paid]])),
    ];
    for (const words of screens) expect(words).not.toContain('not on value deals');
  });
});

describe('only value deals on the order', () => {
  it('the cart: the button says "No discount on value deals", and is off', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order({ dealsOnly: true }), busy: false });
    const out = cart();
    expect(text(out)).toContain('No discount on value deals');
    expect(text(out)).not.toContain('Add discount');
    expect(tagOf(out, 'No discount on value deals')).toContain('disabled');
    // A pizza beside the deal: "Add discount", as before.
    useCheckoutStore.setState({ snapshot: order(), busy: false });
    const mixed = cart();
    expect(text(mixed)).toContain('Add discount');
    expect(tagOf(mixed, 'Add discount')).not.toContain('disabled');
    // A foodpanda order covers its deals (the tablet does).
    useCheckoutStore.setState({ snapshot: order({ dealsOnly: true, mode: 'foodpanda' }), busy: false });
    expect(text(cart())).toContain('Add discount');
  });

  it('F3: says there is nothing to take off; the buttons, the amount box and Apply are off', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order({ dealsOnly: true }), busy: false });
    const out = render(<DiscountDialog onClose={noop} />, RULES_SEED);
    const words = text(out);
    expect(words).toContain(NOTHING_TO_DISCOUNT);
    expect(words).toContain('No discount on value deals');
    expect(words).not.toContain('without a manager');
    const presets = buttons(out).filter((b) => b.includes(' off, takes '));
    expect(presets.length).toBe(3);
    for (const b of presets) expect(b).toContain('disabled');
    expect(tagOf(out, 'aria-label="Other percent off"', 'input')).toContain('disabled');
    expect(tagOf(out, '>Apply<')).toContain('disabled');
  });

  it('F3: the dialog itself takes the cursor (the amount box is off), so Enter stays in it and applies nothing', async () => {
    signIn('cashier');
    const real = useCheckoutStore.getState().applyDiscount;
    const applyDiscount = vi.fn(async () => {});
    useCheckoutStore.setState({ snapshot: order({ dealsOnly: true }), busy: false, applyDiscount });
    try {
      const out = render(<DiscountDialog onClose={noop} />, RULES_SEED);
      expect(tagOf(out, 'aria-label="Other percent off"', 'input')).toContain('disabled=""');
      // Never left in the menu search behind it, where Enter would send the order to the kitchen.
      expect(openDialog(false)).toBe('dialog');
      // Enter on the dialog: its own key handler takes it, and Apply refuses (NOTHING_TO_DISCOUNT).
      const preventDefault = vi.fn();
      const onKeyDown = radix.content?.['onKeyDown'] as (e: { key: string; target: unknown; preventDefault: () => void }) => void;
      onKeyDown({ key: 'Enter', target: { tagName: 'DIV', dataset: {} }, preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(applyDiscount).not.toHaveBeenCalled();
    } finally {
      useCheckoutStore.setState({ applyDiscount: real });
    }
  });

  it('F3 with a staff 10% left on at Rs 0 (its pizza taken off): still "No discount on value deals", no preset pressed; Remove still works', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order({ dealsOnly: true, discount: true }), busy: false });
    const out = render(<DiscountDialog onClose={noop} />, RULES_SEED);
    const words = text(out);
    expect(words).toContain(NOTHING_TO_DISCOUNT);
    expect(words).toContain('No discount on value deals');
    // Not the old choice: no "10% off, not on value deals −Rs 0", no new total.
    expect(words).not.toContain('New total');
    expect(words).not.toContain('Apply 10% off');
    const presets = buttons(out).filter((b) => b.includes(' off, takes '));
    expect(presets.length).toBe(3);
    for (const b of presets) {
      expect(b).toContain('aria-pressed="false"');
      expect(b).toContain('disabled=""');
    }
    expect(tagOf(out, '>Apply<')).toContain('disabled=""');
    expect(tagOf(out, '>Remove discount<')).not.toContain('disabled=""');
    expect(openDialog(false)).toBe('dialog');
  });
});

describe('F3 on a delivery with a deal: the header and the limit name what is counted, under either switch', () => {
  const ON = { ...RULES, discounts: { ...RULES.discounts, alsoOffDeliveryCharge: true } } as CheckoutRules;

  it('the switch off (released): the food; the deal and the delivery charge are not discounted', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order({ charge: true }), busy: false });
    const out = render(<DiscountDialog onClose={noop} />, RULES_SEED);
    const words = text(out);
    expect(words).toContain('Food Rs 1,500 before tax · value deals Rs 3,600 and delivery charge Rs 200 not discounted');
    expect(words).toContain(
      "Up to 10% off, or up to Rs 500 off if that is no more than 10% of the food (value deals not counted), without a manager. More needs a manager's PIN or password.",
    );
    expect(ariaLabels(out)).toContain('10% off, takes Rs 150 off');
  });

  it('the switch on: the food and delivery charge (Rs 1,700), and the limit line says the same; without the deal, the order', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order({ charge: true }), busy: false });
    const out = render(<DiscountDialog onClose={noop} />, [[CHECKOUT_RULES_KEY, ON]]);
    const words = text(out);
    expect(words).toContain('Food and delivery charge Rs 1,700 before tax · value deals Rs 3,600 not discounted');
    expect(words).toContain(
      "Up to 10% off, or up to Rs 500 off if that is no more than 10% of the food and delivery charge (value deals not counted), without a manager. More needs a manager's PIN or password.",
    );
    expect(words).not.toContain('Food Rs 1,700');
    expect(ariaLabels(out)).toContain('10% off, takes Rs 170 off');
    // The same delivery without the deal: the whole order, as before.
    useCheckoutStore.setState({ snapshot: order({ charge: true, noDeal: true }), busy: false });
    const plain = text(render(<DiscountDialog onClose={noop} />, [[CHECKOUT_RULES_KEY, ON]]));
    expect(plain).toContain('Order Rs 1,700 before tax');
    expect(plain).toContain('no more than 10% of the order, without a manager');
  });
});

describe('F3 on a deal and a pizza', () => {
  it('worked on the pizza only, and it says so; the limit is on the food without the deals', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order(), busy: false });
    const out = render(<DiscountDialog onClose={noop} />, RULES_SEED);
    const words = text(out);
    expect(words).toContain('Food Rs 1,500 before tax · value deals Rs 3,600 not discounted');
    expect(words).toContain(
      "Up to 10% off, or up to Rs 500 off if that is no more than 10% of the food (value deals not counted), without a manager. More needs a manager's PIN or password.",
    );
    expect(ariaLabels(out)).toContain('10% off, takes Rs 150 off');
    // The cursor goes to the "Other" amount box (keys first: F3, type 15, Enter).
    expect(openDialog(true)).toBe('amount box');
    // Should a box ever refuse it, the dialog takes it, never the page behind.
    expect(openDialog(false)).toBe('dialog');
    // Rs 100 is under 10% of Rs 1,500 (the food without the deal): no lock.
    expect(ariaLabels(out)).toContain('Rs 100 off, takes Rs 100 off');
    // Rs 200 would be over it, though under 10% of the whole Rs 5,100.
    const rs200 = { ...RULES, discounts: { ...RULES.discounts, presets: { ...RULES.discounts.presets, flatCents: [20_000] } } };
    expect(ariaLabels(render(<DiscountDialog onClose={noop} />, [[CHECKOUT_RULES_KEY, rs200]]))).toContain(
      "Rs 200 off, takes Rs 200 off, needs a manager's PIN or password",
    );
  });

  it('the discount already on it: "now 10% off, not on value deals"', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order({ discount: true }), busy: false });
    expect(text(render(<DiscountDialog onClose={noop} />, RULES_SEED))).toContain('now 10% off, not on value deals');
  });

  it('a foodpanda order: the deal is discounted too (the tablet does)', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order({ mode: 'foodpanda' }), busy: false });
    const out = render(<DiscountDialog onClose={noop} />, RULES_SEED);
    expect(text(out)).toContain('Order Rs 5,100 before tax');
    expect(ariaLabels(out)).toContain('10% off, takes Rs 510 off');
  });
});
