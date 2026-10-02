/**
 * Settings → Printers, "Delivery bill goes with the rider" in the words of
 * Send out (v0.7.34): the bill prints when the order goes out — Send out, or
 * Assign rider — once per order on either till, and the switch is still the
 * saved deliveryBillOnDispatch (the key keeps its name; only the words
 * changed).
 *
 * And Settings → Printers → Shift report (v0.7.35; the owner, 2 Oct 2026:
 * "all orders and totals also add seetngs so we can customize"): this
 * till's switch for printing at the close, the nine sections (all on at
 * first) and Every item / Category totals, saved as shiftReportOnClose,
 * shiftReportSections and shiftReportItems through 'printer:setPolicy' with
 * the rest of the policy as it was; no control for a manager's paper (every
 * close prints the full paper).
 *
 * Rendered to static markup (react-dom/server, no browser; nothing calls the
 * till). A tap is made while the card renders: React re-renders the card
 * with the new state, as the till's window would after the tap. Every name
 * is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHIFT_REPORT_SECTIONS, type PrintPolicy } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { PrintingRulesSettings, SHIFT_REPORT_RULE_BODY, SHIFT_REPORT_SECTIONS_NOTE, SHIFT_REPORT_SWITCH } from './PrintingRulesSettings';

/**
 * Every element as JSX made it (its type and props, with its taps), so a test
 * can press a button: a server render keeps no handlers in the markup. A
 * switch named in `tap` is flipped as the card makes it, once — a change made
 * while the card renders, which React re-renders the card with.
 */
const made = vi.hoisted(() => {
  const elements: Array<{ type: unknown; props: Record<string, unknown> }> = [];
  // `queue`: more taps, in order, each once: a switch's label, or 'radio:<its words>' for a
  // choice button (a disabled one cannot be tapped, as on the till). One tap a render: the
  // next waits for the card made again after it (Save is the last control the card makes).
  const tap = { label: null as string | null, queue: [] as string[], waiting: false };
  type Jsx = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => unknown;
  const record =
    (jsx: Jsx): Jsx =>
    (type, props, ...rest) => {
      if (props) {
        elements.push({ type, props });
        const onChange = props['onChange'];
        const onClick = props['onClick'];
        const next = tap.waiting ? undefined : tap.queue[0];
        if (tap.label !== null && props['label'] === tap.label && typeof onChange === 'function') {
          tap.label = null;
          (onChange as (on: boolean) => void)(props['checked'] !== true);
        } else if (next !== undefined && next.startsWith('radio:')) {
          if (props['role'] === 'radio' && props['children'] === next.slice(6) && props['disabled'] !== true && typeof onClick === 'function') {
            tap.queue.shift();
            tap.waiting = true;
            (onClick as () => void)();
          }
        } else if (next !== undefined && props['label'] === next && typeof onChange === 'function') {
          tap.queue.shift();
          tap.waiting = true;
          (onChange as (on: boolean) => void)(props['checked'] !== true);
        }
        if (props['children'] === 'Save') tap.waiting = false;
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
const decode = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
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
  made.tap.queue.length = 0;
  made.tap.waiting = false;
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

// ------------------------------------------------ the shift report (v0.7.35) --

/** The nine sections' switches, in the order they print, in the owner's words. */
const SECTION_LABELS = ['Sales', 'Money taken', 'By channel', 'Cancelled and refunded', 'Cash drawer', 'Cash counted', 'Unpaid carried over', 'Items sold', 'All orders'];
const ALL_ON = { sales: true, moneyTaken: true, channels: true, cancelsRefunds: true, drawer: true, counted: true, unpaid: true, items: true, orders: true };

/** Every switch on the card, by its name: on, off. */
function switches(markup: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [tag] of markup.matchAll(/<button[^>]*role="switch"[^>]*>/g)) {
    const name = decode(/aria-label="([^"]*)"/.exec(tag)?.[1] ?? '');
    out[name] = /aria-checked="true"/.test(tag);
  }
  return out;
}

/** A choice button by its words: chosen, and whether it can be tapped. */
function choice(markup: string, words: string): { checked: boolean; disabled: boolean } | null {
  const hit = [...markup.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].find((m) => m[1]!.includes('role="radio"') && m[2] === words);
  if (!hit) return null;
  return { checked: /aria-checked="true"/.test(hit[1]!), disabled: /\sdisabled=""/.test(hit[1]!) };
}

/** The radiogroups on the card, by name, and whether each says it cannot be changed. */
function radiogroups(markup: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [tag] of markup.matchAll(/<div[^>]*role="radiogroup"[^>]*>/g)) {
    out[decode(/aria-label="([^"]*)"/.exec(tag)?.[1] ?? '')] = /aria-disabled="true"/.test(tag);
  }
  return out;
}

/** Save as the card made it last, tapped; what it sent. */
async function save(): Promise<unknown> {
  const s = saveButton();
  expect(s['disabled']).toBe(false);
  (s['onClick'] as () => void)();
  await vi.waitFor(() => expect(setPolicy).toHaveBeenCalledTimes(1));
  return setPolicy.mock.calls[0]?.[0];
}

describe('Settings → Printers → Shift report (v0.7.35)', () => {
  it('the row says it prints at the close on this till, set on each till, every section saved, print again from Shift history, no food cost or profit; then the sections in the order they print', () => {
    expect(SECTION_LABELS).toEqual(SHIFT_REPORT_SECTIONS.map((s) => s.label));
    const words = text(render(<PrintingRulesSettings />, BASE));
    expect(SHIFT_REPORT_RULE_BODY).toBe(
      "Prints on this till's receipt printer when a shift closes, after the count is saved. Set it on each till. The till always saves every section; switching one off only leaves it off the paper. Print any shift again from Reports → Team & leakage → Shift history. Food cost and profit never print.",
    );
    expect(words).toContain(
      `Shift report ${SHIFT_REPORT_RULE_BODY} Sections on the paper ${SHIFT_REPORT_SECTIONS_NOTE} Sales Money taken By channel Cancelled and refunded Cash drawer Cash counted Unpaid carried over Items sold Every item Category totals All orders`,
    );
    // The note quotes the paper's last two lines as they print (each fits 58 mm paper).
    expect(SHIFT_REPORT_SECTIONS_NOTE).toContain('"Some sections are off. See Settings > Printers."');
    // After every other rule, before Save.
    expect(words.indexOf('Shift report')).toBeGreaterThan(words.indexOf('Refunds and reprints'));
    expect(words.indexOf('All orders')).toBeLessThan(words.lastIndexOf('Save'));
    // Each section's words are a label for its switch: a tap on them flips it.
    const markup = render(<PrintingRulesSettings />, BASE);
    for (const label of SECTION_LABELS) {
      const tag = [...markup.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`aria-label="${label}"`));
      const id = tag && /\sid="([^"]+)"/.exec(tag)?.[1];
      expect({ label, labelled: id ? markup.includes(`<label for="${id}" class="cursor-pointer text-sm">${label}</label>`) : false }).toEqual({ label, labelled: true });
    }
  });

  it('a policy saved before 0.7.35 shows what the owner chose for every till: printing at the close on, all nine sections on, Every item; nothing to save', () => {
    const markup = render(<PrintingRulesSettings />, BASE);
    const on = switches(markup);
    expect(on[SHIFT_REPORT_SWITCH]).toBe(true);
    expect(SECTION_LABELS.map((l) => [l, on[l]])).toEqual(SECTION_LABELS.map((l) => [l, true]));
    expect(choice(markup, 'Every item')).toEqual({ checked: true, disabled: false });
    expect(choice(markup, 'Category totals')).toEqual({ checked: false, disabled: false });
    expect(radiogroups(markup)['Items sold']).toBe(false);
    expect(saveButton()['disabled']).toBe(true);
    expect(text(markup)).not.toContain('Your changes are not saved yet');
  });

  it('a saved policy shows what it says: printing off, two sections off, Category totals (waiting while Items sold is off)', () => {
    const markup = render(<PrintingRulesSettings />, {
      ...BASE,
      shiftReportOnClose: false,
      shiftReportSections: { orders: false, items: false },
      shiftReportItems: 'categories',
    });
    const on = switches(markup);
    expect(on[SHIFT_REPORT_SWITCH]).toBe(false);
    expect(SECTION_LABELS.filter((l) => on[l] === false)).toEqual(['Items sold', 'All orders']);
    expect(SECTION_LABELS.filter((l) => on[l] === true)).toHaveLength(7);
    expect(choice(markup, 'Category totals')).toEqual({ checked: true, disabled: true });
    expect(choice(markup, 'Every item')).toEqual({ checked: false, disabled: true });
    expect(radiogroups(markup)['Items sold']).toBe(true);
  });

  it('saving writes the three fields — printing off, All orders off with all nine written, Category totals — and the rest of the policy as it was', async () => {
    made.tap.queue.push(SHIFT_REPORT_SWITCH, 'All orders', 'radio:Category totals');
    const saved: PrintPolicy = { ...BASE, kitchenCopies: 2, kitchenPhone: false };
    const markup = render(<PrintingRulesSettings />, saved);
    expect(made.tap.queue).toEqual([]); // every tap found its control
    expect(switches(markup)[SHIFT_REPORT_SWITCH]).toBe(false);
    expect(switches(markup)['All orders']).toBe(false);
    expect(choice(markup, 'Category totals')).toEqual({ checked: true, disabled: false });
    expect(text(markup)).toContain('Your changes are not saved yet');

    expect(await save()).toEqual({
      ...saved,
      shiftReportOnClose: false,
      shiftReportSections: { ...ALL_ON, orders: false },
      shiftReportItems: 'categories',
    });
  });

  it('each change on its own is a change to save: printing at the close off; Category totals', async () => {
    made.tap.queue.push(SHIFT_REPORT_SWITCH);
    expect(text(render(<PrintingRulesSettings />, BASE))).toContain('Your changes are not saved yet');
    expect(await save()).toEqual({ ...BASE, shiftReportOnClose: false });

    setPolicy.mockClear();
    made.elements.length = 0;
    made.tap.queue.push('radio:Category totals');
    expect(text(render(<PrintingRulesSettings />, BASE))).toContain('Your changes are not saved yet');
    expect(await save()).toEqual({ ...BASE, shiftReportItems: 'categories' });
  });

  it('Items sold off: Every item and Category totals cannot be tapped; it saves as off, the choice kept', async () => {
    made.tap.queue.push('Items sold', 'radio:Category totals');
    const markup = render(<PrintingRulesSettings />, BASE);
    expect(made.tap.queue).toEqual(['radio:Category totals']); // disabled: the tap did nothing
    expect(choice(markup, 'Every item')).toEqual({ checked: true, disabled: true });
    expect(choice(markup, 'Category totals')).toEqual({ checked: false, disabled: true });
    expect(radiogroups(markup)['Items sold']).toBe(true);
    // Every other control on the card still works.
    expect(Object.values(radiogroups(markup)).filter(Boolean)).toHaveLength(1);
    made.tap.queue.length = 0;
    expect(await save()).toEqual({ ...BASE, shiftReportSections: { ...ALL_ON, items: false } });
  });

  it('Items sold switched back on: the choice can be made again', () => {
    made.tap.queue.push('Items sold', 'radio:Category totals');
    const markup = render(<PrintingRulesSettings />, { ...BASE, shiftReportSections: { items: false } });
    expect(made.tap.queue).toEqual([]);
    expect(choice(markup, 'Category totals')).toEqual({ checked: true, disabled: false });
    expect(radiogroups(markup)['Items sold']).toBe(false);
  });

  it('a section switched off and on again is no change: nothing to save', () => {
    made.tap.queue.push('Cash counted', 'Cash counted');
    const markup = render(<PrintingRulesSettings />, BASE);
    expect(made.tap.queue).toEqual([]);
    expect(switches(markup)['Cash counted']).toBe(true);
    expect(saveButton()['disabled']).toBe(true);
    expect(text(markup)).not.toContain('Your changes are not saved yet');
  });

  it('a Save from another row keeps the shift report fields as saved', async () => {
    made.tap.label = SWITCH;
    const saved: PrintPolicy = { ...BASE, shiftReportOnClose: false, shiftReportSections: { ...ALL_ON, drawer: false }, shiftReportItems: 'categories' };
    render(<PrintingRulesSettings />, saved);
    expect(made.tap.label).toBeNull();
    expect(await save()).toEqual({ ...saved, deliveryBillOnDispatch: false });
  });

  it('no control for a manager’s paper: every close prints the full paper — these are all the switches and choices on the card', () => {
    const markup = render(<PrintingRulesSettings />, BASE);
    expect(Object.keys(switches(markup))).toEqual([
      'Print kitchen tickets',
      "Print the customer's phone on kitchen tickets",
      'List drinks on kitchen tickets',
      'Print the logo on receipts',
      'Print the bill when the order goes out',
      SHIFT_REPORT_SWITCH,
      ...SECTION_LABELS,
    ]);
    expect(Object.keys(radiogroups(markup))).toEqual(['Kitchen tickets per order', 'Shop copy', 'Items sold']);
    const words = text(markup);
    expect(words).not.toMatch(/when a manager closes/i);
    expect(words).not.toContain('Cash drawer only');
    expect(SHIFT_REPORT_SWITCH).toBe('Print the shift report when a shift closes');
  });
});
