/**
 * The owner's automatic offers on screen (Settings → Money & discounts →
 * "Automatic offers"; the owner, 28 Sep 2026: "the offer discount should
 * have settings … so it automatically applies on the whole order except
 * delivery fee"), rendered to static markup (react-dom/server, no browser;
 * nothing calls the till):
 *   - the card on Settings, with no offers and with one: its row, its on /
 *     off switch, its worked example and the rules in words;
 *   - the Walk-in · Phone · WhatsApp buttons on the order screen, only when
 *     asked or when an offer needs them;
 *   - the offer on the cart (its name, "automatic offer", × takes it off,
 *     "Put the offer back"), at Pay, in the F3 screen and on the receipt, and
 *     the cart's hint while an offer waits for the phone;
 *   - how a sent order came in, in the order drawer, with the manager's change.
 * Radix's dialog is stood in for by plain elements. Every name and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  SHOP_SETTING_DEFAULTS,
  type AuthenticatedUser,
  type ChannelOffer,
  type CheckoutRules,
  type OrderSnapshot,
  type ShopSettingCard,
  type ShopSettingKey,
  type UUID,
} from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { CartPane, offerHeldBackToast } from './CartPane';
import { TenderDialog } from './TenderDialog';
import { ReceiptDialog } from './ReceiptDialog';
import { DiscountDialog } from './DiscountDialog';
import { OrderDetails } from './OrderDetails';
import { MoneySettings } from '../settings/MoneySettings';
import { CameByRow } from '../orders/CameByRow';
import { CHECKOUT_RULES_KEY, SHOP_SETTINGS_KEY } from '../settings/shop-rules/useShopSetting';
import { resetCustomerForm, setCustomerForm } from './useCustomerForm';
import { makeEmptyCustomerForm } from './CustomerInlinePanel';

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

const offer = (over: Partial<ChannelOffer> = {}): ChannelOffer => ({
  id: 'test-wa',
  name: 'Test WhatsApp 10%',
  on: true,
  cameBy: ['whatsapp'],
  orderTypes: ['delivery'],
  type: 'percent',
  value: 10,
  minOrderCents: null,
  maxOffCents: null,
  days: [0, 1, 2, 3, 4, 5, 6],
  hours: null,
  startsOn: null,
  endsOn: null,
  oncePerCustomerPerDay: false,
  ...over,
});

const RULES = (offers: CheckoutRules['offers']): CheckoutRules => ({
  discounts: {
    approval: { percentOver: 10, flatOverCents: 50_000 },
    presets: { percents: [10, 20], flatCents: [10_000], reasons: ['Staff'] },
    alsoOffDeliveryCharge: false,
    reasonRequired: false,
  },
  kitchen: { amberMin: 15, redMin: 30, notStartedMin: 10, notDoneMin: 30 },
  ...(offers ? { offers } : {}),
  foodpanda: { deal: null, checks: { orderCode: 'optional', tabletTotal: 'optional' }, tabletToleranceCents: 100, upliftBps: 0 },
});

const line = (id: string, name: string, cents: number) => ({
  id,
  orderId: 'o1',
  menuItemId: `m_${id}`,
  menuItemName: name,
  quantity: 1,
  unitPriceCents: cents,
  lineTotalCents: cents,
  taxRateBps: 1_600,
  notes: null,
  modifiers: [],
  kitchenStatus: 'pending',
  createdAt: '2026-09-28T10:00:00.000Z',
});

/** A WhatsApp delivery: Rs 2,000 of food and a Rs 200 delivery charge; `discount`: the offer on it (or none). */
function order(opts: { status?: 'open' | 'sent_to_kitchen' | 'paid'; discount?: 'on' | 'declined' | null; phone?: string | null } = {}): OrderSnapshot {
  const status = opts.status ?? 'open';
  const on = opts.discount === 'on';
  const discountCents = on ? 20_000 : 0;
  const taxCents = on ? 32_000 : 35_200;
  const totalCents = 220_000 - discountCents + taxCents;
  return {
    order: {
      id: 'o1',
      orderNumber: '20260928-0007',
      mode: 'delivery',
      status,
      source: 'pos',
      notes: null,
      cashierId: 'u1',
      tableId: null,
      subtotalCents: 220_000,
      discountCents,
      taxCents,
      totalCents,
      createdAt: '2026-09-28T10:00:00.000Z',
      paidAt: status === 'paid' ? '2026-09-28T10:20:00.000Z' : null,
      dispatchedAt: null,
      cameBy: 'whatsapp',
    },
    items: [line('l1', 'Test Pizza', 100_000), line('l2', 'Delivery Charge (Rs 200)', 20_000), line('l3', 'Test Side', 100_000)],
    discounts: opts.discount
      ? [
          {
            id: 'd1',
            orderId: 'o1',
            discountType: on ? 'percent' : 'flat',
            value: on ? 10 : 0,
            reason: 'Test WhatsApp 10%',
            appliedByUserId: 'u1',
            approvedByUserId: 'u_owner',
            amountCents: discountCents,
            source: 'offer',
            foodpanda: null,
            offer: { id: 'test-wa', name: 'Test WhatsApp 10%', type: 'percent', value: 10, minOrderCents: null, maxOffCents: null, declined: !on },
            alsoOffDeliveryCharge: false,
          },
        ]
      : [],
    payments:
      status === 'paid'
        ? [{ id: 'p1', orderId: 'o1', method: 'cash', amountCents: totalCents, tenderedCents: totalCents, referenceNo: null, receivedByUserId: 'u1', paidAt: '2026-09-28T10:20:00.000Z' }]
        : [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: opts.phone === null ? null : 'Test Customer',
    customerPhone: opts.phone === undefined ? '03001234567' : opts.phone,
    deliveryAddress: 'House 1, Test Street',
    deliveryNotes: null,
    rider: null,
  } as unknown as OrderSnapshot;
}

const noop = () => {};
const cart = (seed: Array<[readonly unknown[], unknown]> = []) =>
  render(
    <CartPane step="items" onContinue={noop} onBack={noop} onPay={noop} onDiscount={noop} onRemoveDeal={noop} onSendToKitchen={noop} onCustomize={noop} />,
    seed,
  );

function card<K extends ShopSettingKey>(key: K, value: ShopSettingCard<K>['value'], never = false): ShopSettingCard<K> {
  return {
    key,
    value,
    defaultValue: SHOP_SETTING_DEFAULTS[key] as ShopSettingCard<K>['value'],
    isDefault: never,
    readOnly: false,
    lastChanged: never ? null : { at: '2026-09-28T09:02:00.000Z', byName: 'Test Owner', onThisTill: true },
    notOnOtherTillYet: false,
    history: [],
  };
}

describe('Settings → Money & discounts → Automatic offers', () => {
  const money = (offers: ShopSettingCard<'discounts.offers'>): Array<[readonly unknown[], unknown]> => [
    [[...SHOP_SETTINGS_KEY, 'discounts.approval'], card('discounts.approval', { v: 2, percentOver: 10, flatOverCents: 50_000, reasonRequired: false })],
    [[...SHOP_SETTINGS_KEY, 'discounts.presets'], card('discounts.presets', { v: 1, percents: [10], flatCents: [10_000], reasons: ['Staff'] })],
    [[...SHOP_SETTINGS_KEY, 'discounts.delivery'], card('discounts.delivery', { v: 1, alsoOffDeliveryCharge: false })],
    [[...SHOP_SETTINGS_KEY, 'discounts.offers'], offers],
  ];

  it('nothing saved: no offers, not asked — nothing changes', () => {
    signIn('admin');
    const words = text(render(<MoneySettings />, money(card('discounts.offers', { v: 1, askCameBy: false, offers: [] }, true))));
    expect(words).toContain('Automatic offers');
    expect(words).toContain('No offers yet: orders are billed as always.');
    expect(words).toContain('Never changed: no automatic offers, and the cashier is not asked how orders came in.');
    expect(words).toContain('Ask how every order came in');
    expect(words).toContain('Add an offer');
  });

  it('a saved offer: its row in words, a switch that saves at once, the worked example on the food, and the rules', () => {
    signIn('admin');
    const out = render(<MoneySettings />, money(card('discounts.offers', { v: 1, askCameBy: false, offers: [offer()] })));
    const words = text(out);
    expect(words).toContain('Test WhatsApp 10% 10% off the food · deliveries · came by WhatsApp · every day, all day');
    expect(ariaLabels(out)).toContain('Test WhatsApp 10%: on — switch it off now');
    expect(words).toContain(
      'For example (Test WhatsApp 10%): A delivery that came by WhatsApp, Rs 2,000 of food and a Rs 200 delivery charge: 10% off takes Rs 200 off the food. The Rs 200 delivery charge is paid in full.',
    );
    expect(words).toContain('never on a website or foodpanda order');
    expect(words).toContain('How the order came in is locked when it is sent');
  });
});

describe('the order screen', () => {
  it('the Walk-in · Phone · WhatsApp buttons show when the owner asks, or on an order type an offer needs them for', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: null, mode: 'delivery', cameBy: null, busy: false });
    const chips = (rules: CheckoutRules | undefined) => ariaLabels(render(<OrderDetails />, rules ? [[CHECKOUT_RULES_KEY, rules]] : []));
    expect(chips(undefined)).not.toContain('How the order came in');
    expect(chips(RULES({ askCameBy: false, offers: [] }))).not.toContain('How the order came in');
    expect(chips(RULES({ askCameBy: false, offers: [offer()] }))).toContain('How the order came in');
    expect(chips(RULES({ askCameBy: false, offers: [offer({ cameBy: 'any' })] }))).not.toContain('How the order came in');
    useCheckoutStore.setState({ mode: 'takeaway' });
    expect(chips(RULES({ askCameBy: false, offers: [offer()] }))).not.toContain('How the order came in');
    expect(chips(RULES({ askCameBy: true, offers: [] }))).toContain('How the order came in');
    useCheckoutStore.setState({ mode: 'foodpanda' });
    expect(chips(RULES({ askCameBy: true, offers: [] }))).not.toContain('How the order came in');
    useCheckoutStore.setState({ mode: 'delivery', cameBy: 'whatsapp' });
    expect(render(<OrderDetails />, [[CHECKOUT_RULES_KEY, RULES({ askCameBy: true, offers: [] })]])).toMatch(/aria-pressed="true"[^>]*>(<svg[\s\S]*?<\/svg>)?WhatsApp/);
  });

  it('the cart names the offer; its × takes it off this order; one taken off says so and is put back with the same button', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order({ discount: 'on' }), mode: 'delivery', busy: false });
    const on = cart([[CHECKOUT_RULES_KEY, RULES({ askCameBy: false, offers: [offer()] })]]);
    expect(text(on)).toContain('Test WhatsApp 10% · automatic offer, food only');
    expect(ariaLabels(on)).toContain('Take the offer off this order');
    useCheckoutStore.setState({ snapshot: order({ discount: 'declined' }) });
    const off = cart();
    expect(text(off)).toContain('Test WhatsApp 10% · taken off this order');
    expect(ariaLabels(off)).toContain('Put the offer back');
  });

  it('while no offer is on, the cart says one waits for the customer’s phone', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order({ discount: null, phone: null }), mode: 'delivery', busy: false });
    expect(text(cart([[CHECKOUT_RULES_KEY, RULES({ askCameBy: false, offers: [offer()] })]]))).toContain(
      'Test WhatsApp 10% needs the customer’s phone on the order',
    );
  });

  it('the hint for a once-a-day offer does not promise it: that phone may have had it today (review 28 Sep)', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order({ discount: null, phone: null }), mode: 'delivery', busy: false });
    setCustomerForm({ ...makeEmptyCustomerForm(), phone: '0300 1234567' });
    const rules = (o: ChannelOffer) => [[CHECKOUT_RULES_KEY, RULES({ askCameBy: false, offers: [o] })]] as Array<[readonly unknown[], unknown]>;
    expect(text(cart(rules(offer())))).toContain('Test WhatsApp 10% goes on when Pay or Send saves the customer’s phone');
    expect(text(cart(rules(offer({ oncePerCustomerPerDay: true }))))).toContain(
      'Test WhatsApp 10% goes on when Pay or Send saves the customer’s phone, if that phone has not had it today',
    );
    // Any text is not a phone: "1" still needs one (the till gives no offer on it).
    setCustomerForm({ ...makeEmptyCustomerForm(), phone: '1' });
    expect(text(cart(rules(offer())))).toContain('Test WhatsApp 10% needs the customer’s phone on the order');
    resetCustomerForm();
  });

  it('a live order of the same phone holds the once-a-day offer: the cart says to cancel it first, or refund it when it is paid (order-edit #12)', () => {
    signIn('cashier');
    const seed: Array<[readonly unknown[], unknown]> = [
      [CHECKOUT_RULES_KEY, RULES({ askCameBy: false, offers: [offer({ cameBy: 'any', oncePerCustomerPerDay: true })] })],
    ];
    const held = (paid: boolean) => ({ orderId: 'o0', orderNumber: '20260928-0042', paid });
    useCheckoutStore.setState({ snapshot: { ...order({ discount: null }), offerHeldBy: held(false) } as OrderSnapshot, mode: 'delivery', busy: false });
    const unpaid = cart(seed);
    expect(text(unpaid)).toContain('Cancel #0042 first to keep the offer');
    // Amber, as the cart's other warnings, and said once.
    expect(unpaid).toMatch(/class="ticket-gate" role="status">[\s\S]*?Cancel #0042 first to keep the offer/);
    expect(text(unpaid).match(/first to keep the offer/g)).toHaveLength(1);
    expect(text(unpaid)).not.toContain('goes on when');

    useCheckoutStore.setState({ snapshot: { ...order({ discount: null }), offerHeldBy: held(true) } as OrderSnapshot });
    const paid = text(cart(seed));
    expect(paid).toContain('Refund #0042 first to keep the offer');
    expect(paid).not.toContain('Cancel #0042');

    // Nobody holds it: nothing to say.
    useCheckoutStore.setState({ snapshot: { ...order({ discount: null }), offerHeldBy: null } as OrderSnapshot });
    expect(text(cart(seed))).not.toContain('first to keep the offer');
  });

  it('Send stopped because the phone it saved shows a live order holding the offer (review fixes C): the toast says what to do, in the cart’s own words', () => {
    expect(offerHeldBackToast({ orderNumber: '20261002-0001', paid: false })).toEqual({
      title: 'Not sent yet',
      description: 'Cancel #0001 first to keep the offer, or tap Send again to send it without the offer.',
    });
    expect(offerHeldBackToast({ orderNumber: '20261002-0001', paid: true }).description).toBe(
      'Refund #0001 first to keep the offer, or tap Send again to send it without the offer.',
    );
  });

  it('no such words with an offer or a discount on the cart, or once the order is sent', () => {
    signIn('cashier');
    const seed: Array<[readonly unknown[], unknown]> = [[CHECKOUT_RULES_KEY, RULES({ askCameBy: false, offers: [offer()] })]];
    const offerHeldBy = { orderId: 'o0', orderNumber: '20260928-0042', paid: false };
    const words = (snapshot: OrderSnapshot) => {
      useCheckoutStore.setState({ snapshot: { ...snapshot, offerHeldBy } as OrderSnapshot, mode: 'delivery', busy: false });
      return text(cart(seed));
    };
    expect(words(order({ discount: 'on' }))).not.toContain('first to keep the offer');
    expect(words(order({ discount: 'declined' }))).not.toContain('first to keep the offer');
    // A staff (F3) discount.
    const withOffer = order({ discount: 'on' });
    const staff = { ...withOffer, discounts: withOffer.discounts.map((d) => ({ ...d, source: null, offer: undefined, reason: 'Test staff' })) } as OrderSnapshot;
    expect(words(staff)).toContain('Discount');
    expect(words(staff)).not.toContain('first to keep the offer');
    expect(words(order({ status: 'sent_to_kitchen', discount: null }))).not.toContain('first to keep the offer');
  });

  it('asked how every order came in: Send and Pay wait for Walk-in, Phone or WhatsApp, and say so', () => {
    signIn('cashier');
    const base = order({ discount: null });
    const takeaway = {
      ...base,
      order: { ...base.order, mode: 'takeaway', cameBy: null },
      items: base.items.filter((i) => !i.menuItemName.startsWith('Delivery')),
    } as unknown as OrderSnapshot;
    const seed: Array<[readonly unknown[], unknown]> = [[CHECKOUT_RULES_KEY, RULES({ askCameBy: true, offers: [] })]];
    const disabled = (markup: string, title: string) => new RegExp(`<button[^>]*disabled=""[^>]*title="${title}`).test(markup);
    useCheckoutStore.setState({ snapshot: takeaway, mode: 'takeaway', cameBy: null, busy: false });
    const waiting = cart(seed);
    expect(text(waiting)).toContain('Still needed: How the order came in (Walk-in, Phone or WhatsApp)');
    expect(disabled(waiting, 'Send to kitchen')).toBe(true);
    expect(disabled(waiting, 'Take payment now')).toBe(true);
    // A chip tapped: both go.
    useCheckoutStore.setState({ cameBy: 'walk_in' });
    const ready = cart(seed);
    expect(text(ready)).not.toContain('Still needed');
    expect(disabled(ready, 'Send to kitchen')).toBe(false);
    expect(disabled(ready, 'Take payment now')).toBe(false);
    // Not asked: nothing waits.
    useCheckoutStore.setState({ cameBy: null });
    expect(disabled(cart([[CHECKOUT_RULES_KEY, RULES({ askCameBy: false, offers: [] })]]), 'Send to kitchen')).toBe(false);
  });

  it('Pay, the F3 screen and the receipt say the offer by its name', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: order({ discount: 'on' }), busy: false });
    expect(text(render(<TenderDialog snapshot={order({ discount: 'on' })} onClose={noop} onPaid={noop} />))).toContain('Test WhatsApp 10% (food only)');
    const f3 = text(render(<DiscountDialog onClose={noop} />, [[CHECKOUT_RULES_KEY, RULES({ askCameBy: false, offers: [offer()] })]]));
    expect(f3).toContain('now Test WhatsApp 10% (the owner’s offer)');
    expect(f3).toContain('A discount you apply replaces it (the usual manager rule applies).');
    expect(f3).toContain('Take the offer off');
    const paid = order({ status: 'paid', discount: 'on' });
    expect(text(render(<ReceiptDialog snapshot={paid} onClose={noop} />))).toContain('Test WhatsApp 10% (food only)');
    // Taken off: nothing off, no line.
    expect(text(render(<ReceiptDialog snapshot={order({ status: 'paid', discount: 'declined' })} onClose={noop} />))).not.toContain('Test WhatsApp');
  });

  it('the order drawer says how a sent order came in, and a manager may change it', () => {
    signIn('manager');
    const words = text(render(<CameByRow snap={order({ status: 'sent_to_kitchen', discount: 'on' })} />));
    expect(words).toContain('Came in by WhatsApp');
    expect(words).toContain('Change (manager)');
    // Still being rung up: the chips on the order screen do it, not the drawer.
    expect(text(render(<CameByRow snap={order({ status: 'open' })} />))).not.toMatch(/Came in by|came in: not asked/);
  });
});
