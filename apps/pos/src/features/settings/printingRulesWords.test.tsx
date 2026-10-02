/**
 * Settings → Printers, "Delivery bill goes with the rider" in the words of
 * Send out (v0.7.34): the bill prints when the order goes out — Send out, or
 * Assign rider — once per order on either till, and the switch is still the
 * saved deliveryBillOnDispatch (the key keeps its name; only the words
 * changed). Rendered to static markup (react-dom/server, no browser; nothing
 * calls the till). A tap is made while the card renders: React re-renders
 * the card with the new state, as the till's window would after the tap.
 * Every name is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrintPolicy } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { PrintingRulesSettings } from './PrintingRulesSettings';

/**
 * Every element as JSX made it (its type and props, with its taps), so a test
 * can press a button: a server render keeps no handlers in the markup. A
 * switch named in `tap` is flipped as the card makes it, once — a change made
 * while the card renders, which React re-renders the card with.
 */
const made = vi.hoisted(() => {
  const elements: Array<{ type: unknown; props: Record<string, unknown> }> = [];
  const tap = { label: null as string | null };
  type Jsx = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => unknown;
  const record =
    (jsx: Jsx): Jsx =>
    (type, props, ...rest) => {
      if (props) {
        elements.push({ type, props });
        const onChange = props['onChange'];
        if (tap.label !== null && props['label'] === tap.label && typeof onChange === 'function') {
          tap.label = null;
          (onChange as (on: boolean) => void)(props['checked'] !== true);
        }
      }
      return jsx(type, props, ...rest);
    };
  return { elements, tap, record };
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

/** What Save hands the main process (printer:setPolicy). */
const setPolicy = vi.hoisted(() => vi.fn(async (next: unknown) => next));
vi.mock('../../ipc/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../ipc/client')>();
  return { ...real, ipc: { ...real.ipc, printer: { ...real.ipc.printer, setPolicy } } };
});

const SWITCH = 'Print the bill when the order goes out';
const BASE: PrintPolicy = { kitchenTicket: true, deliveryBillOnDispatch: true, shopCopy: 'delivery', logoOnReceipt: true };

/** Settings → Printers as printer:getConfig answers it, with this till's saved rules. */
function render(node: ReactNode, policy: PrintPolicy): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['printer', 'config'], {
    config: { transport: 'network', network: { host: 'mock', port: 9100 }, width: 48 },
    branding: { storeName: 'Test Shop' },
    transports: ['network'],
    mockEnabled: true,
    policy,
    kitchenPrinter: null,
    logo: { state: 'none', enabled: true, stored: null, checked: false },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Whether the delivery-bill switch shows on, from the markup. */
function switchOn(markup: string): boolean | null {
  const tag = [...markup.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`aria-label="${SWITCH}"`));
  if (!tag) return null;
  return /aria-checked="true"/.test(tag);
}

/** Save as the card made it last (after any re-render). */
function saveButton(): Record<string, unknown> {
  const saves = made.elements.filter((e) => e.props['children'] === 'Save' && typeof e.props['onClick'] === 'function');
  const last = saves[saves.length - 1];
  if (!last) throw new Error('no Save button');
  return last.props;
}

afterEach(() => {
  made.elements.length = 0;
  made.tap.label = null;
  setPolicy.mockClear();
});

describe('Settings → Printers: the delivery bill prints when the order goes out', () => {
  it('the row says Send out, or Assign rider, once per order on either till — the exact words', () => {
    const words = text(render(<PrintingRulesSettings />, BASE));
    expect(words).toContain(
      'Delivery bill goes with the rider For delivery orders the bill prints when the order goes out — Send out, or Assign rider — so it travels with the food and shows the amount to collect, or PAID. It prints once per order, on either till. When the rider brings the money back, only the drawer opens.',
    );
    expect(words).not.toContain('when a rider is assigned');
    expect(words).not.toContain('the customer already has the receipt');
  });

  it('the switch is named “Print the bill when the order goes out” and shows the saved rule', () => {
    expect(switchOn(render(<PrintingRulesSettings />, BASE))).toBe(true);
    expect(switchOn(render(<PrintingRulesSettings />, { ...BASE, deliveryBillOnDispatch: false }))).toBe(false);
    expect(render(<PrintingRulesSettings />, BASE)).not.toContain('Print the bill when a rider is assigned');
  });

  it('switched off and saved: Save sends deliveryBillOnDispatch false, nothing else changed', async () => {
    made.tap.label = SWITCH;
    const markup = render(<PrintingRulesSettings />, BASE);
    expect(made.tap.label).toBeNull(); // the switch was there to tap
    expect(switchOn(markup)).toBe(false);
    expect(text(markup)).toContain('Your changes are not saved yet');

    const save = saveButton();
    expect(save['disabled']).toBe(false);
    (save['onClick'] as () => void)();
    await vi.waitFor(() => expect(setPolicy).toHaveBeenCalledTimes(1));
    expect(setPolicy.mock.calls[0]?.[0]).toEqual({ ...BASE, deliveryBillOnDispatch: false });
  });

  it('switched back on and saved: Save sends deliveryBillOnDispatch true', async () => {
    const off: PrintPolicy = { ...BASE, deliveryBillOnDispatch: false, kitchenCopies: 2 };
    made.tap.label = SWITCH;
    const markup = render(<PrintingRulesSettings />, off);
    expect(switchOn(markup)).toBe(true);

    (saveButton()['onClick'] as () => void)();
    await vi.waitFor(() => expect(setPolicy).toHaveBeenCalledTimes(1));
    expect(setPolicy.mock.calls[0]?.[0]).toEqual({ ...off, deliveryBillOnDispatch: true });
  });

  it('nothing tapped: Save stays off, nothing is sent', () => {
    render(<PrintingRulesSettings />, BASE);
    expect(saveButton()['disabled']).toBe(true);
    expect(setPolicy).not.toHaveBeenCalled();
  });
});
