/**
 * Settings polish on screen (owner, 2026-09-27: "everything should be
 * editable for admin"), rendered to static markup (react-dom/server, no
 * browser; nothing calls the till):
 *   - the receipt after Pay shows the shop's own name, tagline, thank-you
 *     and extra lines (it said "CheeseOclock / Pakistani Pizza • Cafe"
 *     whatever was saved), and "Cashier: Website" on a website order;
 *   - the new cards — Extra lines on receipts (Shop & logo), Opening float
 *     and Reason buttons (Staff & kitchen) — build every sentence from the
 *     values, and say "this till only" where it is;
 *   - the Cancel, Refund and Cash out boxes offer the owner's buttons, and
 *     today's when nothing is saved;
 *   - the board's "Picked up / Delivered + Pay" offers Exact and then
 *     exactly Pay's quick-cash notes;
 *   - the Open shift box says where its figure came from, and starts on it;
 *   - the Reason buttons card warns when a button's words print as "?".
 * Radix's dialog is stood in for by plain elements. Every name and amount
 * is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ORDER_REASONS,
  SHOP_SETTING_DEFAULTS,
  TILL_SETTING_DEFAULTS,
  type AuthenticatedUser,
  type CheckoutRules,
  type OrderReasons,
  type OrderSnapshot,
  type ShopSettingCard,
  type TillSettingCard,
  type TillSettingKey,
  type TillSettingValues,
  type UUID,
} from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../../components/toast/ToastProvider';
import { useSessionStore } from '../../../stores/sessionStore';
import { ReceiptDialog } from '../../checkout/ReceiptDialog';
import { VoidOrderDialog } from '../../orders/VoidOrderDialog';
import { RefundOrderDialog } from '../../orders/RefundOrderDialog';
import { CashMovementDialog } from '../../shell/CashMovementDialog';
import { OpenShiftDialog } from '../../shell/ShiftWidget';
import { MarkDeliveredDialog } from '../../orders/MarkDeliveredDialog';
import { TenderDialog } from '../../checkout/TenderDialog';
import { ReceiptExtraLinesCard } from '../ReceiptExtraLinesCard';
import { OpeningFloatCard } from '../OpeningFloatCard';
import { ReasonButtonsCard } from '../ReasonButtonsCard';
import { CHECKOUT_RULES_KEY, SHOP_SETTINGS_KEY } from './useShopSetting';
import { TILL_SETTINGS_KEY } from './useTillSetting';

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
const noop = () => {};

/** A paid takeaway (Rs 1,160). */
function paidOrder(source: 'pos' | 'web' = 'pos'): OrderSnapshot {
  return {
    order: {
      id: 'o1',
      orderNumber: '20260928-0007',
      mode: 'takeaway',
      status: 'paid',
      source,
      notes: null,
      cashierId: 'u_owner',
      tableId: null,
      subtotalCents: 100_000,
      discountCents: 0,
      taxCents: 16_000,
      totalCents: 116_000,
      createdAt: '2026-09-28T10:00:00.000Z',
      paidAt: '2026-09-28T10:20:00.000Z',
      dispatchedAt: null,
    },
    items: [
      {
        id: 'l1',
        orderId: 'o1',
        menuItemId: 'm1',
        menuItemName: 'Test Pizza',
        quantity: 1,
        unitPriceCents: 100_000,
        lineTotalCents: 100_000,
        taxRateBps: 1_600,
        notes: null,
        modifiers: [],
        kitchenStatus: 'pending',
      },
    ],
    discounts: [],
    payments: [{ id: 'p1', orderId: 'o1', method: 'cash', amountCents: 116_000, tenderedCents: 120_000, referenceNo: null, receivedByUserId: 'u1', paidAt: '2026-09-28T10:20:00.000Z' }],
    cashierName: 'Test Owner',
    tableLabel: null,
    customerName: null,
    customerPhone: null,
    deliveryAddress: null,
    deliveryNotes: null,
    rider: null,
  } as unknown as OrderSnapshot;
}

/** printer:getConfig as the till answers it, with this branding. */
const printerConfig = (branding: Record<string, unknown>): [readonly unknown[], unknown] => [
  ['printer', 'config'],
  {
    config: { transport: 'network', network: { host: 'mock', port: 9100 }, width: 48 },
    branding,
    transports: ['network'],
    mockEnabled: true,
    policy: { kitchenTicket: true, deliveryBillOnDispatch: true, shopCopy: 'delivery', logoOnReceipt: true },
    kitchenPrinter: null,
    logo: { state: 'none', enabled: true, stored: null, checked: false },
  },
];

describe('the receipt after Pay shows the shop’s own lines (it said "CheeseOclock" whatever was saved)', () => {
  it('the saved name, tagline, thank-you and extra lines', () => {
    signIn('cashier');
    const words = text(
      render(<ReceiptDialog snapshot={paidOrder()} onClose={noop} />, [
        printerConfig({
          storeName: 'Test Pizza Shop',
          storeTagline: 'Test tagline',
          footerLine: 'Test thanks, come again',
          extraLines: ['Insta @test.example', 'Wi-Fi: TestShop'],
        }),
      ]),
    );
    expect(words).toContain('Test Pizza Shop Test tagline');
    expect(words).toContain('Test thanks, come again Insta @test.example Wi-Fi: TestShop');
    expect(words).not.toMatch(/CheeseOclock|Pakistani Pizza|visit us again/);
  });

  it('nothing saved: the till’s own defaults — its name, no tagline, the paper’s thank-you line', () => {
    signIn('cashier');
    const words = text(render(<ReceiptDialog snapshot={paidOrder()} onClose={noop} />, [printerConfig({ storeName: 'Cheese O Clock' })]));
    expect(words).toContain('Cheese O Clock');
    expect(words).toContain('Thank you — visit us again!');
    expect(words).not.toMatch(/CheeseOclock|Pakistani Pizza/);
  });

  it('before the till answers: no name at all rather than a wrong one', () => {
    signIn('cashier');
    const words = text(render(<ReceiptDialog snapshot={paidOrder()} onClose={noop} />));
    expect(words).not.toMatch(/CheeseOclock|Pakistani Pizza|Cheese O Clock/);
    expect(words).toContain('Thank you — visit us again!');
  });

  it('a website order says "Cashier: Website"; one rung up at the till keeps its cashier', () => {
    signIn('cashier');
    const seed = [printerConfig({ storeName: 'Test Pizza Shop' })];
    expect(text(render(<ReceiptDialog snapshot={paidOrder('web')} onClose={noop} />, seed))).toContain('Cashier: Website');
    expect(text(render(<ReceiptDialog snapshot={paidOrder('web')} onClose={noop} />, seed))).not.toContain('Test Owner');
    expect(text(render(<ReceiptDialog snapshot={paidOrder('pos')} onClose={noop} />, seed))).toContain('Cashier: Test Owner');
  });
});

/** A "this till" card as settings:getTill answers it. */
function tillCard<K extends TillSettingKey>(key: K, value: TillSettingValues[K]): TillSettingCard<K> {
  return {
    key,
    value,
    defaultValue: TILL_SETTING_DEFAULTS[key] as TillSettingValues[K],
    isDefault: false,
    readOnly: false,
    lastChanged: { at: '2026-09-28T09:02:00.000Z', byName: 'Test Owner', onThisTill: true },
    notOnOtherTillYet: false,
    history: [],
  };
}

describe('the new cards: every sentence from the values', () => {
  it('Extra lines on receipts: this till only, the lines in the preview, where they print, and a warning for what prints as "?"', () => {
    signIn('admin');
    const words = text(
      render(<ReceiptExtraLinesCard />, [
        [[...TILL_SETTINGS_KEY, 'receipt.extraLines'], tillCard('receipt.extraLines', ['Insta @test.example', 'شکریہ'])],
        printerConfig({ storeName: 'Test Pizza Shop', footerLine: 'Test thanks' }),
      ]),
    );
    expect(words).toContain('Extra lines on receipts');
    expect(words).toContain('This till only: the other till keeps its own.');
    expect(words).toContain('These 2 lines print under the thank-you line on every customer receipt and bill from this till');
    expect(words).toContain('Never on kitchen tickets, the shop\'s copy, refund slips or cancelled orders.');
    // The preview is what the printer puts on paper: the Urdu word as question marks.
    expect(words).toContain('Test thanks Insta @test.example ?????');
    expect(words).toContain('Line 2: ش ک ر ی ہ print as “?” — the receipt printer only has English letters.');
    expect(words).toContain('Last changed by Test Owner on this till');
  });

  it('Extra lines, none saved: says nothing prints, and the bounds', () => {
    signIn('admin');
    const words = text(
      render(<ReceiptExtraLinesCard />, [[[...TILL_SETTINGS_KEY, 'receipt.extraLines'], { ...tillCard('receipt.extraLines', []), isDefault: true, lastChanged: null }]]),
    );
    expect(words).toContain('Nothing prints under the thank-you line. Add up to 3 lines of up to 64 letters each');
    expect(words).toContain('Default');
  });

  it('Opening float: fixed — the amount, this till only, and that the count is still typed and the close blind', () => {
    signIn('admin');
    const words = text(
      render(<OpeningFloatCard />, [[[...TILL_SETTINGS_KEY, 'drawer.openingFloat'], tillCard('drawer.openingFloat', { mode: 'fixed', fixedCents: 750_000 })]]),
    );
    expect(words).toContain('Opening float');
    expect(words).toContain('This till only');
    expect(words).toContain(
      'The Open shift box on this till starts on Rs 7,500 every shift, whatever the last shift closed with. Whoever opens still counts the drawer and types the float, and closing stays a blind count.',
    );
  });

  it('Opening float: the default says the last count, as today', () => {
    signIn('admin');
    const words = text(
      render(<OpeningFloatCard />, [
        [[...TILL_SETTINGS_KEY, 'drawer.openingFloat'], { ...tillCard('drawer.openingFloat', { mode: 'lastCount', fixedCents: 0 }), isDefault: true, lastChanged: null }],
      ]),
    );
    expect(words).toContain('starts on what its last shift closed with');
    expect(words).toContain('A first shift starts at Rs 0.');
  });

  it('Reason buttons: counts, what each says about the food, the cash-out ones, and that typing and the PIN stay', () => {
    signIn('admin');
    const value: OrderReasons = {
      v: 1,
      cancel: [
        { id: 'a', label: 'Test changed mind', food: 'ask' },
        { id: 'b', label: 'Test not collected', food: 'made' },
      ],
      refund: [{ id: 'c', label: 'Test missing item', food: 'not_made' }],
      cashOut: ['Test gas'],
    };
    const card: ShopSettingCard<'orders.reasons'> = {
      key: 'orders.reasons',
      value,
      defaultValue: SHOP_SETTING_DEFAULTS['orders.reasons'] as OrderReasons,
      isDefault: false,
      readOnly: false,
      lastChanged: null,
      notOnOtherTillYet: false,
      history: [],
    };
    const words = text(render(<ReasonButtonsCard />, [[[...SHOP_SETTINGS_KEY, 'orders.reasons'], card]]));
    expect(words).toContain('Reason buttons');
    expect(words).toContain('The Cancel box offers 2 buttons and the Refund box 1.');
    expect(words).toContain('“Test not collected” answers Made; “Test missing item” answers Not made');
    expect(words).toContain('never once the food has left the shop');
    expect(words).toContain('Cash out offers “Test gas”.');
    expect(words).toContain('every cancel and refund still needs a reason and a manager’s PIN');
    expect(words).not.toContain('This till only');
    // All English: nothing to warn about.
    expect(words).not.toContain('print as “?”');
  });

  it('Reason buttons: a button in Urdu is saved as it is, with a warning that it prints as "?" (like Extra lines)', () => {
    signIn('admin');
    const value: OrderReasons = {
      v: 1,
      cancel: [{ id: 'a', label: 'گاہک', food: 'ask' }],
      refund: [{ id: 'c', label: 'Test missing item', food: 'ask' }],
      cashOut: ['گیس'],
    };
    const card: ShopSettingCard<'orders.reasons'> = {
      key: 'orders.reasons',
      value,
      defaultValue: SHOP_SETTING_DEFAULTS['orders.reasons'] as OrderReasons,
      isDefault: false,
      readOnly: false,
      lastChanged: null,
      notOnOtherTillYet: false,
      history: [],
    };
    const words = text(render(<ReasonButtonsCard />, [[[...SHOP_SETTINGS_KEY, 'orders.reasons'], card]]));
    expect(words).toContain(
      'Cancel button 1 (“گاہک”): گ ا ہ ک print as “?” on a cancelled order’s receipt and kitchen ticket — the receipt printer only has English letters.',
    );
    // Cash out words never print: no warning for them.
    expect(words).not.toContain('گیس”)');
  });
});

/** checkout:getRules with these reason buttons (the rest as released). */
const rulesWith = (reasons: CheckoutRules['reasons']): CheckoutRules => ({
  discounts: { approval: { percentOver: 10, flatOverCents: 50_000 }, presets: { percents: [10], flatCents: [10_000], reasons: ['Staff'] }, alsoOffDeliveryCharge: false },
  kitchen: { amberMin: 15, redMin: 30, notStartedMin: 10, notDoneMin: 30 },
  ...(reasons ? { reasons } : {}),
  foodpanda: { deal: null, checks: { orderCode: 'optional', tabletTotal: 'optional' }, tabletToleranceCents: 100, upliftBps: 0 },
});

describe('the Cancel, Refund and Cash out boxes offer the owner’s buttons', () => {
  const OWNERS = {
    cancel: [{ id: 'x', label: 'Test rider lost', food: 'made' as const }],
    refund: [{ id: 'y', label: 'Test cold food', food: 'ask' as const }],
    cashOut: ['Test gas cylinder'],
  };

  it('nothing saved (or not answered yet): today’s buttons, in today’s order', () => {
    signIn('cashier');
    const snap = { ...paidOrder(), order: { ...paidOrder().order, status: 'sent_to_kitchen', paidAt: null } } as OrderSnapshot;
    const cancel = text(render(<VoidOrderDialog snap={snap} onClose={noop} onDone={noop} />));
    expect(cancel).toContain(DEFAULT_ORDER_REASONS.cancel.map((r) => r.label).join(' '));
    const refund = text(render(<RefundOrderDialog snap={paidOrder()} onClose={noop} onDone={noop} />));
    expect(refund).toContain(DEFAULT_ORDER_REASONS.refund.map((r) => r.label).join(' '));
    // No cash-out buttons: typed, as today.
    const cash = text(render(<CashMovementDialog shiftId="s1" onClose={noop} />));
    expect(cash).not.toContain('Test gas cylinder');
  });

  it('saved: the owner’s buttons, and the box to type any other reason stays', () => {
    signIn('cashier');
    const seed: Array<[readonly unknown[], unknown]> = [[CHECKOUT_RULES_KEY, rulesWith(OWNERS)]];
    const snap = { ...paidOrder(), order: { ...paidOrder().order, status: 'sent_to_kitchen', paidAt: null } } as OrderSnapshot;
    const cancelMarkup = render(<VoidOrderDialog snap={snap} onClose={noop} onDone={noop} />, seed);
    expect(text(cancelMarkup)).toContain('Test rider lost');
    expect(text(cancelMarkup)).not.toContain('Refused at the door');
    expect(cancelMarkup).toContain('placeholder="Or type why…"');
    expect(text(cancelMarkup)).toContain('Manager PIN or password');
    const refund = text(render(<RefundOrderDialog snap={paidOrder()} onClose={noop} onDone={noop} />, seed));
    expect(refund).toContain('Test cold food');
    expect(refund).not.toContain('Customer unhappy');
    const cash = render(<CashMovementDialog shiftId="s1" onClose={noop} />, seed);
    expect(text(cash)).toContain('What was it for? Test gas cylinder');
    expect(cash).toContain('id="cash-reason"');
  });
});

describe('one quick-cash rule on screen: the board’s "Picked up / Delivered + Pay" offers Exact and then Pay’s notes', () => {
  // Up to the first review this was only checked by reading the source: a
  // board that dropped its Exact button, or went back to its own rule,
  // would still have passed.
  /** The one-tap amounts after "Cash given", as rupees ("Exact" as it is). */
  const quickAmounts = (markup: string): string[] => {
    const from = markup.indexOf('grid-cols-5', markup.indexOf('Cash given'));
    const grid = markup.slice(from, markup.indexOf('</div>', from));
    return [...grid.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1]!).replace(/^Rs /, '').replace(/,/g, ''));
  };
  const unpaid = (totalCents: number): OrderSnapshot => {
    const s = paidOrder();
    return { ...s, order: { ...s.order, status: 'ready', paidAt: null, totalCents }, payments: [] } as unknown as OrderSnapshot;
  };

  it('the same amounts as Pay, Exact first — including a round bill and one with paisa', () => {
    signIn('cashier');
    const cases: Array<[number, string[]]> = [
      [123_400, ['Exact', '1300', '1500', '2000', '5000']],
      // Round: the board used to offer Exact and Rs 5,000 only.
      [200_000, ['Exact', '2500', '3000', '5000']],
      [185_050, ['Exact', '1900', '2000', '5000']],
    ];
    for (const [totalCents, amounts] of cases) {
      const board = quickAmounts(render(<MarkDeliveredDialog snap={unpaid(totalCents)} onClose={noop} onDone={noop} />));
      const pay = quickAmounts(render(<TenderDialog snapshot={unpaid(totalCents)} onClose={noop} onPaid={noop} />));
      expect({ totalCents, board, pay }).toEqual({ totalCents, board: amounts, pay: amounts });
    }
  });
});

describe('the Open shift box says where its figure came from (only where it starts: the float is counted)', () => {
  it('the owner’s fixed float', () => {
    signIn('cashier');
    const words = text(
      render(<OpenShiftDialog onClose={noop} />, [[['shifts', 'openingFloat'], { prefillCents: 500_000, from: 'fixed', lastCount: null }]]),
    );
    expect(words).toContain('This till starts each shift with Rs 5,000 (Settings). Count the drawer and change this if it is different.');
  });

  it('the owner’s fixed float: the box starts on it, not on the last count', () => {
    // Up to the first review only the note was checked here: the box was
    // filled by an effect, which a static render never runs.
    signIn('cashier');
    const markup = render(<OpenShiftDialog onClose={noop} />, [
      [['shifts', 'openingFloat'], { prefillCents: 500_000, from: 'fixed', lastCount: { countedCashCents: 1_234_500, closedAt: '2026-09-27T20:00:00.000Z' } }],
    ]);
    expect(markup).toContain('value="5000"');
    expect(markup).not.toContain('value="12345"');
  });

  it('the last count (today)', () => {
    signIn('cashier');
    const markup = render(<OpenShiftDialog onClose={noop} />, [
      [['shifts', 'openingFloat'], { prefillCents: 1_234_500, from: 'last_count', lastCount: { countedCashCents: 1_234_500, closedAt: '2026-09-27T20:00:00.000Z' } }],
    ]);
    expect(text(markup)).toContain('The last shift closed with Rs 12,345 in the drawer. Count it again and change this if it is different.');
    expect(markup).toContain('value="12345"');
  });

  it('before the till answers: the box starts at 0', () => {
    signIn('cashier');
    expect(render(<OpenShiftDialog onClose={noop} />)).toContain('value="0"');
  });

  it('a first shift: no line, the box starts at 0', () => {
    signIn('cashier');
    const markup = render(<OpenShiftDialog onClose={noop} />, [[['shifts', 'openingFloat'], { prefillCents: null, from: 'none', lastCount: null }]]);
    expect(text(markup)).not.toMatch(/last shift closed|starts each shift/);
    expect(markup).toContain('value="0"');
  });
});
