/**
 * The owner's Money & discounts and Staff & kitchen timing on screen,
 * rendered to static markup (react-dom/server, no browser; nothing calls the
 * till): the F3 Discount screen's buttons, locks and rule, and the Live
 * Orders header, built from what checkout:getRules answered — and today's
 * when nothing is saved (or it has not answered yet); the two new owner
 * cards on Settings, and only the owner's login sees their tabs. Radix's
 * dialog is stood in for by plain elements (a server render has no portal).
 * Every name and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  SHOP_SETTING_DEFAULTS,
  type AuthenticatedUser,
  type CheckoutRules,
  type OrderSnapshot,
  type ShopSettingCard,
  type ShopSettingKey,
  type UUID,
} from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../../components/toast/ToastProvider';
import { useSessionStore } from '../../../stores/sessionStore';
import { useCheckoutStore } from '../../../stores/checkoutStore';
import { DiscountDialog } from '../../checkout/DiscountDialog';
import { OrdersBoardPage } from '../../orders/OrdersBoardPage';
import { MoneySettings } from '../MoneySettings';
import { FoodpandaSettings } from '../FoodpandaSettings';
import { TimingSettings } from '../TimingSettings';
import { SettingsPage } from '../SettingsPage';
import { CHECKOUT_RULES_KEY, SHOP_SETTINGS_KEY } from './useShopSetting';

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
/** Every aria-label on the page. */
const ariaLabels = (markup: string) => [...markup.matchAll(/aria-label="([^"]*)"/g)].map((m) => decode(m[1]!));

const RULES = (over: Partial<CheckoutRules> = {}): CheckoutRules => ({
  discounts: {
    approval: { percentOver: 10, flatOverCents: 20_000 },
    presets: { percents: [5, 15], flatCents: [15_000, 25_000], reasons: ['Birthday', 'Test reason'] },
    alsoOffDeliveryCharge: false,
    reasonRequired: false,
  },
  kitchen: { amberMin: 5, redMin: 10, notStartedMin: 5, notDoneMin: 20 },
  foodpanda: { deal: null, checks: { orderCode: 'optional', tabletTotal: 'optional' }, tabletToleranceCents: 100, upliftBps: 0 },
  ...over,
});

/** A Rs 2,000 order on the till (made-up lines). */
function ringUp(): void {
  useCheckoutStore.setState({
    snapshot: {
      order: { id: 'o1', subtotalCents: 200_000, mode: 'takeaway' },
      items: [
        { id: 'l1', lineTotalCents: 100_000, taxRateBps: 1600 },
        { id: 'l2', lineTotalCents: 100_000, taxRateBps: 1600 },
      ],
      discounts: [],
    } as unknown as OrderSnapshot,
    busy: false,
  });
}

/** Rs 2,000 of food and a Rs 200 delivery charge on the till (made-up lines), with these discount rows. */
function deliverySnapshot(discounts: unknown[]): OrderSnapshot {
  return {
    order: { id: 'o2', subtotalCents: 220_000, mode: 'delivery' },
    items: [
      { id: 'l1', lineTotalCents: 200_000, taxRateBps: 1600, menuItemName: 'Test Pizza' },
      { id: 'l2', lineTotalCents: 20_000, taxRateBps: 1600, menuItemName: 'Delivery Charge (Rs 200)' },
    ],
    discounts,
  } as unknown as OrderSnapshot;
}

/** A staff 10% on the order; `alsoOff` = the rule frozen on it (undefined = none: given before the rule). */
function tenPercent(alsoOff: boolean | undefined) {
  return {
    id: 'd1',
    discountType: 'percent',
    value: 10,
    reason: null,
    source: null,
    amountCents: alsoOff === false ? 20_000 : 22_000,
    ...(alsoOff === undefined ? {} : { alsoOffDeliveryCharge: alsoOff }),
  };
}

describe('the Discount screen (F3)', () => {
  it('shows the owner’s buttons and reasons, the lock above his limit, and his rule in words', () => {
    signIn('cashier');
    ringUp();
    const out = render(<DiscountDialog onClose={() => {}} />, [[CHECKOUT_RULES_KEY, RULES()]]);
    const words = text(out);
    expect(words).toContain(
      "Up to 10% off, or up to Rs 200 off if that is no more than 10% of the order, without a manager. More needs a manager's PIN or password.",
    );
    const labels = ariaLabels(out);
    expect(labels).toContain('5% off, takes Rs 100 off');
    expect(labels).toContain("15% off, takes Rs 300 off, needs a manager's PIN or password");
    expect(labels).toContain('Rs 150 off, takes Rs 150 off');
    expect(labels).toContain("Rs 250 off, takes Rs 250 off, needs a manager's PIN or password");
    expect(words).toContain('Birthday');
    expect(words).toContain('Test reason');
    // Today's buttons are gone; typing any other amount still works.
    expect(labels.some((l) => l.startsWith('20% off'))).toBe(false);
    expect(words).not.toContain('Regular customer');
    expect(labels).toContain('Other percent off');
  });

  it('on an order with a delivery charge: worked on the food, and it says so (the owner, 28 Sep 2026)', () => {
    signIn('cashier');
    useCheckoutStore.setState({
      snapshot: {
        order: { id: 'o2', subtotalCents: 220_000, mode: 'delivery' },
        items: [
          { id: 'l1', lineTotalCents: 200_000, taxRateBps: 1600, menuItemName: 'Test Pizza' },
          { id: 'l2', lineTotalCents: 20_000, taxRateBps: 1600, menuItemName: 'Delivery Charge (Rs 200)' },
        ],
        discounts: [],
      } as unknown as OrderSnapshot,
      busy: false,
    });
    const out = render(<DiscountDialog onClose={() => {}} />, [[CHECKOUT_RULES_KEY, RULES()]]);
    expect(text(out)).toContain('Food Rs 2,000 before tax · delivery charge Rs 200 not discounted');
    const labels = ariaLabels(out);
    // A % of the food, not of Rs 2,200.
    expect(labels).toContain('5% off, takes Rs 100 off');
    expect(labels).toContain("15% off, takes Rs 300 off, needs a manager's PIN or password");
    // The owner's switch on: the whole bill, as before.
    const whole = render(<DiscountDialog onClose={() => {}} />, [
      [CHECKOUT_RULES_KEY, RULES({ discounts: { ...RULES().discounts, alsoOffDeliveryCharge: true } })],
    ]);
    expect(text(whole)).toContain('Order Rs 2,200 before tax');
    expect(ariaLabels(whole)).toContain('5% off, takes Rs 110 off');
  });

  it('the approval rule in words names what the lock checks: the food, on an order with a delivery charge a discount leaves alone', () => {
    signIn('cashier');
    useCheckoutStore.setState({ snapshot: deliverySnapshot([]), busy: false });
    const food = text(render(<DiscountDialog onClose={() => {}} />, [[CHECKOUT_RULES_KEY, RULES()]]));
    expect(food).toContain(
      "Up to 10% off, or up to Rs 200 off if that is no more than 10% of the food, without a manager. More needs a manager's PIN or password.",
    );
    expect(food).not.toContain('10% of the order');
    // The owner's switch on: the whole order, as before.
    const whole = text(
      render(<DiscountDialog onClose={() => {}} />, [[CHECKOUT_RULES_KEY, RULES({ discounts: { ...RULES().discounts, alsoOffDeliveryCharge: true } })]]),
    );
    expect(whole).toContain('no more than 10% of the order, without a manager');
    // No delivery charge on the order: "of the order", as before.
    ringUp();
    expect(text(render(<DiscountDialog onClose={() => {}} />, [[CHECKOUT_RULES_KEY, RULES()]]))).toContain('no more than 10% of the order, without a manager');
  });

  it('the discount already on the order is described by its OWN rule, and says so when the switch has changed since', () => {
    signIn('cashier');
    const rulesNo = [[CHECKOUT_RULES_KEY, RULES()]] as Array<[readonly unknown[], unknown]>;
    const rulesYes = [[CHECKOUT_RULES_KEY, RULES({ discounts: { ...RULES().discounts, alsoOffDeliveryCharge: true } })]] as Array<
      [readonly unknown[], unknown]
    >;
    // Given on the food only, and the switch still says No: one story.
    useCheckoutStore.setState({ snapshot: deliverySnapshot([tenPercent(false)]), busy: false });
    const same = text(render(<DiscountDialog onClose={() => {}} />, rulesNo));
    expect(same).toContain('Food Rs 2,000 before tax · delivery charge Rs 200 not discounted · now 10% off food');
    expect(same).not.toContain('Apply it again');
    // Left open over the update (no rule: it came off the charge too) while the switch says No.
    useCheckoutStore.setState({ snapshot: deliverySnapshot([tenPercent(undefined)]), busy: false });
    const legacy = text(render(<DiscountDialog onClose={() => {}} />, rulesNo));
    expect(legacy).toContain('delivery charge Rs 200 not discounted · now 10% off, delivery charge too');
    expect(legacy).toContain('Given when a discount also came off the delivery charge. Apply it again to take it off the food only.');
    // Given on the food only, then the owner turned the switch on.
    useCheckoutStore.setState({ snapshot: deliverySnapshot([tenPercent(false)]), busy: false });
    const flipped = text(render(<DiscountDialog onClose={() => {}} />, rulesYes));
    expect(flipped).toContain('Order Rs 2,200 before tax · now 10% off food');
    expect(flipped).toContain('Given when a discount was on the food only. Apply it again to take it off the delivery charge too.');
    // It came off the charge too, and the switch says Yes: as before.
    useCheckoutStore.setState({ snapshot: deliverySnapshot([tenPercent(true)]), busy: false });
    const yes = text(render(<DiscountDialog onClose={() => {}} />, rulesYes));
    expect(yes).toContain('Order Rs 2,200 before tax · now 10% off');
    expect(yes).not.toContain('Apply it again');
    expect(yes).not.toContain('10% off food');
  });

  it('nothing saved (or no answer yet): today’s buttons, locks and rule', () => {
    signIn('cashier');
    ringUp();
    const out = render(<DiscountDialog onClose={() => {}} />);
    const labels = ariaLabels(out);
    expect(labels.filter((l) => / off, takes /.test(l))).toEqual([
      '10% off, takes Rs 200 off',
      "20% off, takes Rs 400 off, needs a manager's PIN or password",
      "25% off, takes Rs 500 off, needs a manager's PIN or password",
      "50% off, takes Rs 1,000 off, needs a manager's PIN or password",
      "100% off, takes Rs 2,000 off, needs a manager's PIN or password",
      'Rs 100 off, takes Rs 100 off',
      'Rs 200 off, takes Rs 200 off',
      "Rs 500 off, takes Rs 500 off, needs a manager's PIN or password",
    ]);
    const words = text(out);
    for (const r of ['Staff', 'Friends & family', 'Regular customer', 'Complaint']) expect(words).toContain(r);
    expect(words).toContain('Up to 10% off, or up to Rs 500 off if that is no more than 10% of the order, without a manager.');
  });
});

describe('the Live Orders header', () => {
  const order = (minutesOld: number) =>
    ({
      order: {
        id: `o${minutesOld}`,
        orderNumber: `20260928-00${minutesOld}`,
        mode: 'takeaway',
        status: 'sent_to_kitchen',
        source: 'pos',
        notes: null,
        createdAt: new Date(Date.now() - minutesOld * 60_000 - 1_000).toISOString(),
        paidAt: null,
        dispatchedAt: null,
        totalCents: 100_000,
      },
      items: [],
      discounts: [],
      payments: [],
      customerName: null,
      customerPhone: null,
      deliveryNotes: null,
      rider: null,
    }) as unknown as OrderSnapshot;
  const board = (orders: OrderSnapshot[]) => [['orders', 'active', 'all'], orders] as [readonly unknown[], unknown];

  it('counts the cards past the owner’s red minutes, and says his minutes', () => {
    signIn('cashier');
    const words = text(render(<OrdersBoardPage />, [board([order(12), order(3)]), [CHECKOUT_RULES_KEY, RULES()]]));
    expect(words).toContain('· 1 waiting over 10 min');
  });

  it('nothing saved: red at 30 minutes, as today', () => {
    signIn('cashier');
    expect(text(render(<OrdersBoardPage />, [board([order(12)])]))).not.toContain('waiting over');
    expect(text(render(<OrdersBoardPage />, [board([order(31), order(12)])]))).toContain('· 1 waiting over 30 min');
  });
});

/** An owner card as settings:getBusiness answers it. */
function card<K extends ShopSettingKey>(key: K, value: ShopSettingCard<K>['value']): ShopSettingCard<K> {
  return {
    key,
    value,
    defaultValue: SHOP_SETTING_DEFAULTS[key] as ShopSettingCard<K>['value'],
    isDefault: false,
    readOnly: false,
    lastChanged: { at: '2026-09-28T09:02:00.000Z', byName: 'Test Owner', onThisTill: true },
    notOnOtherTillYet: false,
    history: [],
  };
}

describe('the owner’s cards', () => {
  it('Money & discounts: the limit, the buttons, and examples built from the saved values', () => {
    signIn('admin');
    const words = text(
      render(<MoneySettings />, [
        [[...SHOP_SETTINGS_KEY, 'discounts.approval'], card('discounts.approval', { v: 2, percentOver: 20, flatOverCents: 100_000, reasonRequired: false })],
        [
          [...SHOP_SETTINGS_KEY, 'discounts.presets'],
          card('discounts.presets', { v: 1, percents: [5, 25], flatCents: [30_000], reasons: ['Birthday'] }),
        ],
      ]),
    );
    expect(words).toContain('When a cashier needs a manager');
    expect(words).toContain(
      'On a Rs 2,000 order a cashier can give up to 20% off, or up to Rs 400 off in rupees, without a manager. On a Rs 10,000 order: up to 20% off, or up to Rs 1,000 off in rupees.',
    );
    expect(words).toContain('Discount buttons');
    expect(words).toContain('Reasons: Birthday.');
    expect(words).toContain('Last changed by Test Owner on this till');
  });

  it('Money & discounts: "A discount also comes off the delivery charge", No by default, its words built from the value', () => {
    signIn('admin');
    const seed = (value: { v: number; alsoOffDeliveryCharge: boolean }, never: boolean): Array<[readonly unknown[], unknown]> => [
      [[...SHOP_SETTINGS_KEY, 'discounts.approval'], card('discounts.approval', { v: 2, percentOver: 10, flatOverCents: 50_000, reasonRequired: false })],
      [
        [...SHOP_SETTINGS_KEY, 'discounts.presets'],
        card('discounts.presets', { v: 1, percents: [10], flatCents: [10_000], reasons: ['Staff'] }),
      ],
      [
        [...SHOP_SETTINGS_KEY, 'discounts.delivery'],
        { ...card('discounts.delivery', value), ...(never ? { isDefault: true, lastChanged: null } : {}) },
      ],
    ];
    const no = render(<MoneySettings />, seed({ v: 1, alsoOffDeliveryCharge: false }, true));
    const words = text(no);
    expect(words).toContain('Discounts and the delivery charge');
    expect(words).toContain('A discount also comes off the delivery charge');
    expect(words).toContain(
      'On Rs 2,000 of food with a Rs 200 delivery charge, 10% off takes Rs 200 off (10% of the food). The Rs 200 delivery charge is paid in full: Rs 3,000 off takes Rs 2,000 (all the food), and even 100% off leaves the Rs 200 delivery charge (and its tax) to pay.',
    );
    expect(words).toContain('A discount already on an order keeps the rule it was given with, and paid orders never change.');
    // Never saved is not "as the till always worked" here.
    expect(words).toContain('Never changed: a discount is on the food only');
    expect(words).not.toContain('the till works as it always has');
    expect(no).toMatch(/aria-checked="true"[^>]*>\s*<span[^>]*>No</);

    const yes = text(render(<MoneySettings />, seed({ v: 1, alsoOffDeliveryCharge: true }, false)));
    expect(yes).toContain(
      'On Rs 2,000 of food with a Rs 200 delivery charge, 10% off takes Rs 220 off: the delivery charge is discounted too. Rs 3,000 off takes Rs 2,200, and 100% off leaves nothing to pay.',
    );

    // The approval limit's card says what its % is of on a delivery order: it follows this switch.
    expect(words).toContain(
      'With a delivery charge on the order, the % is of the food only: the delivery charge doesn’t count (“A discount also comes off the delivery charge”: No).',
    );
    expect(yes).toContain(
      'With a delivery charge on the order, the % is of the whole order, the delivery charge too (“A discount also comes off the delivery charge”: Yes).',
    );
  });

  it('Money & discounts: "Value deals never get a discount" under the buttons, and on each offer — only while a category is never discounted', () => {
    signIn('admin');
    const testOffer = {
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
    } as const;
    const seed = (categories: Array<{ name: string; noDiscount: boolean | null }>): Array<[readonly unknown[], unknown]> => [
      [[...SHOP_SETTINGS_KEY, 'discounts.approval'], card('discounts.approval', { v: 2, percentOver: 10, flatOverCents: 50_000, reasonRequired: false })],
      [[...SHOP_SETTINGS_KEY, 'discounts.presets'], card('discounts.presets', { v: 1, percents: [10], flatCents: [10_000], reasons: ['Staff'] })],
      [
        [...SHOP_SETTINGS_KEY, 'discounts.offers'],
        card('discounts.offers', { v: 1, askCameBy: false, offers: [testOffer] } as unknown as ShopSettingCard<'discounts.offers'>['value']),
      ],
      [
        ['menu', 'categories', 'all'],
        categories.map((c, i) => ({ id: `c${i}`, displayOrder: i, colorHex: '#000000', isActive: true, isOnWebsite: true, ...c })),
      ],
    ];
    // Value Deals by its name (nothing set): both sentences.
    const marked = text(render(<MoneySettings />, seed([{ name: 'Pizza', noDiscount: null }, { name: 'Value Deals', noDiscount: null }])));
    expect(marked).toContain('Value deals never get a discount (Menu → Categories).');
    expect(marked).toContain('10% off the food, not on value deals · deliveries');
    // The owner said discounts come off it: neither.
    const unmarked = text(render(<MoneySettings />, seed([{ name: 'Pizza', noDiscount: null }, { name: 'Value Deals', noDiscount: false }])));
    expect(unmarked).not.toContain('Value deals never get a discount');
    expect(unmarked).not.toContain('not on value deals');
    expect(unmarked).toContain('10% off the food · deliveries');
  });

  it('Staff & kitchen timing: both cards, with examples built from the saved values', () => {
    signIn('admin');
    const words = text(
      render(<TimingSettings />, [
        [
          [...SHOP_SETTINGS_KEY, 'staff.timing'],
          card('staff.timing', { v: 1, idleLogoutMin: 20, maxLoginHours: 16, stepInMin: 15, freeReprints: 2, reprintWindowMin: 45 }),
        ],
        [[...SHOP_SETTINGS_KEY, 'kitchen.timing'], card('kitchen.timing', { v: 1, amberMin: 20, redMin: 40, notStartedMin: 15, notDoneMin: 45 })],
      ]),
    );
    expect(words).toContain('Staff logins and reprints');
    expect(words).toContain('after 20 minutes with nobody touching it');
    expect(words).toContain('two copies of a paid receipt');
    expect(words).toContain('Kitchen timing');
    expect(words).toContain('turns amber on Live Orders at 7:20 and red at 7:40');
    expect(words).toContain('Cashiers are never signed out for being idle');
  });

  it('only the owner’s login sees the two new tabs, in the design’s order', () => {
    /** The Settings tabs' names, left to right. */
    const tabs = (markup: string) =>
      markup
        .split('role="tab"')
        .slice(1)
        .map((t) => text(`<x ${t.slice(0, t.indexOf('</button>'))}`));
    signIn('admin');
    // Step 7 put Kitchen & stock (an owner's business-rules section) where the design has it: before Receipts & printing;
    // step 3 Delivery areas & fees, after Money & discounts.
    expect(tabs(render(<SettingsPage />)).slice(0, 7)).toEqual([
      'foodpanda',
      'Money & discounts',
      'Delivery areas & fees',
      'Shop & logo',
      // "Staff & kitchen timing" up to v0.7.26, until the opening float and the reason buttons joined the timings.
      'Staff & kitchen',
      'Kitchen & stock',
      'Printers',
    ]);
    for (const role of ['manager', 'cashier'] as const) {
      signIn(role);
      const other = tabs(render(<SettingsPage />));
      expect({ role, other }).toEqual({ role, other: ['Printers', 'Sounds', 'About'] });
    }
  });
});

/** Which radio of a group is chosen: its label (the group found by its aria-label). */
function chosen(markup: string, group: string): string[] {
  const at = markup.indexOf(`aria-label="${group}"`);
  expect(at).toBeGreaterThan(-1);
  const end = markup.indexOf('</div>', at);
  return markup
    .slice(at, end)
    .split('role="radio"')
    .slice(1)
    .filter((b) => b.includes('aria-checked="true"'))
    .map((b) => text(`<x ${b}`).split(' ')[0] ?? '');
}

describe('"A discount needs a reason" (Settings sweep B7b)', () => {
  it('the F3 screen: nothing saved says the reason is optional, as before', () => {
    signIn('cashier');
    ringUp();
    for (const out of [render(<DiscountDialog onClose={() => {}} />), render(<DiscountDialog onClose={() => {}} />, [[CHECKOUT_RULES_KEY, RULES()]])]) {
      expect(text(out)).toContain('Reason (optional, prints on the bill)');
      expect(out).toContain('aria-required="false"');
      expect(text(out)).not.toContain('needed');
    }
  });

  it('the F3 screen with the owner’s Yes: the reason is needed, the box says so, and the reason buttons are still one tap', () => {
    signIn('cashier');
    ringUp();
    const out = render(<DiscountDialog onClose={() => {}} />, [
      [CHECKOUT_RULES_KEY, RULES({ discounts: { ...RULES().discounts, reasonRequired: true } })],
    ]);
    expect(text(out)).toContain('Reason (needed — prints on the bill)');
    expect(out).toContain('aria-required="true"');
    // The owner's two reason buttons, each a plain button (one tap fills the reason).
    expect(out.split('aria-pressed="false" class="h-10 rounded-full').length - 1).toBe(2);
    expect(text(out)).toContain('Birthday');
    expect(text(out)).toContain('Test reason');
  });

  it('a reason button reading as no reason (saved before, or by an older till) shows only while a reason is optional', () => {
    signIn('cashier');
    ringUp();
    const withNone = (reasonRequired: boolean) =>
      RULES({ discounts: { ...RULES().discounts, presets: { ...RULES().discounts.presets, reasons: ['Birthday', 'No reason given'] }, reasonRequired } });
    const buttons = (markup: string) => (markup.match(/aria-pressed="false" class="h-10 rounded-full/g) ?? []).length;
    const optional = render(<DiscountDialog onClose={() => {}} />, [[CHECKOUT_RULES_KEY, withNone(false)]]);
    expect(buttons(optional)).toBe(2);
    expect(text(optional)).toContain('No reason given');
    // Needed: that button could never be applied, so the dialog leaves it out.
    const needed = render(<DiscountDialog onClose={() => {}} />, [[CHECKOUT_RULES_KEY, withNone(true)]]);
    expect(buttons(needed)).toBe(1);
    expect(text(needed)).toContain('Birthday');
    expect(text(needed)).not.toContain('No reason given');
  });

  it('the Money card asks it, No by default, with what it does in words', () => {
    signIn('admin');
    const seed = (approval: ShopSettingCard<'discounts.approval'>['value']): Array<[readonly unknown[], unknown]> => [
      [[...SHOP_SETTINGS_KEY, 'discounts.approval'], card('discounts.approval', approval)],
      [[...SHOP_SETTINGS_KEY, 'discounts.presets'], card('discounts.presets', { v: 1, percents: [10], flatCents: [10_000], reasons: ['Staff'] })],
    ];
    const no = render(<MoneySettings />, seed({ v: 2, percentOver: 10, flatOverCents: 50_000, reasonRequired: false }));
    expect(text(no)).toContain('A discount needs a reason');
    expect(chosen(no, 'A discount needs a reason')).toEqual(['No']);
    expect(text(no)).toContain('from every login, the owner’s too; the till refuses one without.');
    expect(text(no)).toContain('The automatic offers, the foodpanda deal and the website’s pick-up % carry their own names.');
    expect(text(no)).toContain('A discount already on an order keeps what it has.');
    expect(text(no)).toContain('Update both tills the same day');
    // A format-1 value (saved by v0.7.29) reads as No.
    const v1 = render(<MoneySettings />, seed({ v: 1, percentOver: 10, flatOverCents: 50_000, reasonRequired: false }));
    expect(chosen(v1, 'A discount needs a reason')).toEqual(['No']);
    const yes = render(<MoneySettings />, seed({ v: 2, percentOver: 10, flatOverCents: 50_000, reasonRequired: true }));
    expect(chosen(yes, 'A discount needs a reason')).toEqual(['Yes']);
  });
});

describe('the foodpanda tablet’s tolerance (Settings sweep B10)', () => {
  const seed = (checks: ShopSettingCard<'foodpanda.checks'>['value']): Array<[readonly unknown[], unknown]> => [
    [[...SHOP_SETTINGS_KEY, 'foodpanda.deal'], card('foodpanda.deal', { ...SHOP_SETTING_DEFAULTS['foodpanda.deal'] })],
    [[...SHOP_SETTINGS_KEY, 'foodpanda.fees'], card('foodpanda.fees', { ...SHOP_SETTING_DEFAULTS['foodpanda.fees'] })],
    [[...SHOP_SETTINGS_KEY, 'foodpanda.checks'], card('foodpanda.checks', checks)],
  ];
  const toleranceBox = (markup: string) => {
    const at = markup.indexOf('id="fp-tolerance"');
    expect(at).toBeGreaterThan(-1);
    const tag = markup.slice(markup.lastIndexOf('<input', at), markup.indexOf('>', at));
    return tag.slice(tag.indexOf('value="') + 7).split('"')[0];
  };

  it('Rs 1 by default (and for a format-1 value): the words say Rs 1, the box shows 1', () => {
    signIn('admin');
    for (const checks of [
      { v: 2, orderCode: 'optional' as const, tabletTotal: 'optional' as const, tabletToleranceCents: 100 },
      { v: 1, orderCode: 'optional' as const, tabletTotal: 'optional' as const, tabletToleranceCents: 100 },
    ]) {
      const out = render(<FoodpandaSettings />, seed(checks));
      expect(text(out)).toContain('If the till’s total is more than Rs 1 different, the till says so and Reports lists the order');
      expect(toleranceBox(out)).toBe('1');
      expect(text(out)).toContain('Difference allowed on the tablet (Rs)');
      expect(text(out)).toContain('Whole rupees, Rs 0 to Rs 10 — never more');
      expect(text(out)).toContain('Reports use it as it is now for every order, old ones too');
      expect(text(out)).toContain('At Rs 0 even a few paisa of tax rounding is flagged.');
    }
  });

  it('the words follow the owner’s value: Rs 5, and Rs 0', () => {
    signIn('admin');
    const five = render(<FoodpandaSettings />, seed({ v: 2, orderCode: 'optional', tabletTotal: 'optional', tabletToleranceCents: 500 }));
    expect(text(five)).toContain('If the till’s total is more than Rs 5 different');
    expect(text(five)).not.toContain('more than Rs 1 different');
    expect(toleranceBox(five)).toBe('5');
    const zero = render(<FoodpandaSettings />, seed({ v: 2, orderCode: 'optional', tabletTotal: 'optional', tabletToleranceCents: 0 }));
    expect(text(zero)).toContain('If the till’s total is different at all');
    expect(toleranceBox(zero)).toBe('0');
  });
});
