/**
 * The F3 screen's Apply button follows the owner's "a discount needs a
 * reason" (Settings → Money & discounts, via checkout:getRules): off while
 * no reason is picked or typed, on once one is. Rendered to static markup
 * like ownerRulesOnScreen.test.tsx. Every name and amount is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, CheckoutRules, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { DiscountDialog } from './DiscountDialog';
import { CHECKOUT_RULES_KEY } from '../settings/shop-rules/useShopSetting';

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
// Static markup has no effects: the stores are read straight from their state.
vi.mock('zustand', async (importOriginal) => {
  const z = await importOriginal<typeof import('zustand')>();
  type Hook = ((select?: (state: unknown) => unknown) => unknown) & { getState: () => unknown };
  const live = (hook: Hook) => Object.assign((select: (state: unknown) => unknown = (state) => state) => select(hook.getState()), hook);
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
const RULES = (reasonRequired: boolean): CheckoutRules =>
  ({
    discounts: {
      approval: { percentOver: 10, flatOverCents: 20_000 },
      presets: { percents: [5, 10], flatCents: [15_000], reasons: ['Birthday'] },
      alsoOffDeliveryCharge: false,
      reasonRequired,
    },
    kitchen: { amberMin: 5, redMin: 10, notStartedMin: 5, notDoneMin: 20 },
    foodpanda: { deal: null, checks: { orderCode: 'optional', tabletTotal: 'optional' }, tabletToleranceCents: 100, upliftBps: 0 },
  }) as unknown as CheckoutRules;

/** A Rs 2,000 order already carrying a staff 5% (given before the owner's Yes) with this reason: the dialog opens on it. */
function withStaffDiscount(reason: string | null): void {
  useCheckoutStore.setState({
    snapshot: {
      order: { id: 'o1', subtotalCents: 200_000, mode: 'takeaway' },
      items: [
        { id: 'l1', lineTotalCents: 100_000, taxRateBps: 1600 },
        { id: 'l2', lineTotalCents: 100_000, taxRateBps: 1600 },
      ],
      discounts: [{ id: 'd1', discountType: 'percent', value: 5, reason, source: null, amountCents: 10_000, alsoOffDeliveryCharge: false }],
    } as unknown as OrderSnapshot,
    busy: false,
  });
}
/** The Apply button's opening tag. */
function applyButton(markup: string): string {
  const at = markup.indexOf('Apply 5% off');
  expect(at).toBeGreaterThan(-1);
  const open = markup.lastIndexOf('<button', at);
  return markup.slice(open, markup.indexOf('>', open) + 1);
}
const dialog = (seed: Array<[readonly unknown[], unknown]> = []) => applyButton(render(<DiscountDialog onClose={() => {}} />, seed));

describe('the F3 Apply button follows the owner’s "a discount needs a reason"', () => {
  it('No: Apply is on with no reason (as before); Yes: Apply is off until a reason is given', () => {
    signIn('cashier');
    withStaffDiscount(null);
    expect(dialog([[CHECKOUT_RULES_KEY, RULES(false)]])).not.toContain('disabled=""');
    expect(dialog([[CHECKOUT_RULES_KEY, RULES(true)]])).toContain('disabled=""');
    // Before the rules have answered: today's (a reason optional) — Apply on.
    expect(dialog()).not.toContain('disabled=""');
  });

  it('Yes: spaces, or the words Reports use for none (any capitals, any spacing), are no reason either; a real reason turns Apply on', () => {
    signIn('cashier');
    for (const none of ['No reason given', '  no REASON given ', 'No  reason given', '   ']) {
      withStaffDiscount(none);
      expect({ none, tag: dialog([[CHECKOUT_RULES_KEY, RULES(true)]]) }).toEqual({ none, tag: expect.stringContaining('disabled=""') });
    }
    withStaffDiscount('Birthday');
    expect(dialog([[CHECKOUT_RULES_KEY, RULES(true)]])).not.toContain('disabled=""');
  });
});
