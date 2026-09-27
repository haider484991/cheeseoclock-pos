import { useRef, useState, type KeyboardEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn, NumberPad } from '@cheeseoclock/ui';
import { expectedTabletCents, formatCents, tabletDiffers } from '@cheeseoclock/pos-domain';
import { FOODPANDA_ORDER_CODE_MAX, FOODPANDA_TABLET_TOLERANCE_CENTS } from '@cheeseoclock/shared-types';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { useCheckoutRules } from '../settings/shop-rules/useShopSetting';
import { useCheckoutStore } from '../../stores/checkoutStore';
import type { OrderSnapshot, PaymentMethod } from '@cheeseoclock/shared-types';
import { Banknote, CreditCard, Smartphone, Building, X } from 'lucide-react';
import { quickCashRupees } from './tenderAmounts';
import { ownsEnter } from './keys';
import { foodpandaDealLine } from './foodpandaDealLine';
import { payDiscountLabel } from './discountWords';

interface Props {
  snapshot: OrderSnapshot;
  onClose: () => void;
  onPaid: () => void;
}

const METHODS: Array<{
  id: PaymentMethod;
  label: string;
  icon: typeof Banknote;
  showTendered: boolean;
}> = [
  { id: 'cash', label: 'Cash', icon: Banknote, showTendered: true },
  { id: 'card', label: 'Card', icon: CreditCard, showTendered: false },
  { id: 'easypaisa', label: 'EasyPaisa', icon: Smartphone, showTendered: false },
  { id: 'jazzcash', label: 'JazzCash', icon: Smartphone, showTendered: false },
  { id: 'bank_transfer', label: 'Bank', icon: Building, showTendered: false },
  // Settled by the platform, never drawer cash — and the only way a foodpanda order is paid.
  { id: 'foodpanda', label: 'Foodpanda', icon: Smartphone, showTendered: false },
];

/**
 * Payment. Opens on Cash with "Exact" already chosen, so the usual sale is
 * Pay → Enter. Typing on the keyboard or the pad starts a cash amount (the
 * change shows as you type); a quick-note button fills in a round note.
 * Enter confirms from anywhere in the dialog except Cancel / Close.
 */
export function TenderDialog({ snapshot, onClose, onPaid }: Props) {
  const total = snapshot.order.totalCents;
  // A foodpanda order is paid through Foodpanda only (it used to default to Cash and inflate the
  // drawer's expected cash every night); every other order can't use that method.
  const isFoodpanda = snapshot.order.mode === 'foodpanda';
  const methods = METHODS.filter((m) => (m.id === 'foodpanda') === isFoodpanda);
  const [method, setMethod] = useState<PaymentMethod>(isFoodpanda ? 'foodpanda' : 'cash');
  const [tendered, setTendered] = useState('');
  // "Exact" tenders the bill to the paisa. The pad only types whole rupees, so
  // a Rs 1,234.50 bill could not be paid with exactly Rs 1,234.50 in cash.
  // It is the starting choice: most customers hand over the bill amount or
  // the cashier types what they gave.
  const [exact, setExact] = useState(!isFoodpanda && total > 0);
  const [error, setError] = useState<string | null>(null);
  // foodpanda's order number and the tablet's total (Settings → foodpanda → checks).
  const rules = useCheckoutRules();
  const checks = rules.data?.foodpanda.checks ?? { orderCode: 'optional', tabletTotal: 'optional' };
  const tolerance = rules.data?.foodpanda.tabletToleranceCents ?? FOODPANDA_TABLET_TOLERANCE_CENTS;
  // The tablet shows the till's total at foodpanda's prices (Settings → foodpanda: the listing may be dearer).
  const tabletExpected = expectedTabletCents(total, rules.data?.foodpanda.upliftBps ?? 0);
  const [fpCode, setFpCode] = useState('');
  const [fpTablet, setFpTablet] = useState('');
  const deal = snapshot.discounts.find((d) => d.source === 'foodpanda') ?? null;
  const dealLine = deal ? foodpandaDealLine(deal, snapshot.order.subtotalCents) : null;
  const tender = useCheckoutStore((s) => s.tender);
  const busy = useCheckoutStore((s) => s.busy);
  const contentRef = useRef<HTMLDivElement>(null);

  const tenderedCents = exact ? total : parseTenderedCents(tendered);
  const exactLabel = (total / 100).toFixed(total % 100 === 0 ? 0 : 2);
  const quickRupees = quickCashRupees(total);
  const methodSpec = methods.find((m) => m.id === method) ?? methods[0]!;
  // A 100%-discounted order has nothing to collect — no payment leg at all.
  const nothingToPay = total === 0;
  // For cash: tendered must be >= total. For others: amount = total exactly.
  const enough = nothingToPay || (methodSpec.showTendered ? tenderedCents >= total : true);
  const changeCents = methodSpec.showTendered && tenderedCents >= total ? tenderedCents - total : 0;
  const shortCents = methodSpec.showTendered && !enough ? total - tenderedCents : 0;

  function typeAmount(next: string) {
    setError(null);
    if (exact) {
      // Typing after Exact starts a fresh amount; backspace clears it.
      setExact(false);
      setTendered(next.length > exactLabel.length ? next.slice(exactLabel.length) : '');
      return;
    }
    setTendered(next.replace(/^0+/, '').slice(0, 8));
  }

  async function submit() {
    // The number pad's Enter bypasses the disabled button: a double Enter sent
    // a second tender, refused, with a "Payment failed" after a good payment.
    if (busy || !enough) return;
    setError(null);
    let tabletTotalCents: number | null = null;
    if (isFoodpanda) {
      if (checks.orderCode === 'required' && !fpCode.trim()) {
        setError("Type foodpanda's order number — the owner has made it required.");
        return;
      }
      const typed = parseTabletCents(fpTablet);
      if (Number.isNaN(typed)) {
        setError('Type the tablet total in rupees, like 1920 or 1920.50.');
        return;
      }
      tabletTotalCents = typed;
      if (checks.tabletTotal === 'required' && tabletTotalCents === null) {
        setError('Type the total on the foodpanda tablet — the owner has made it required.');
        return;
      }
      if (tabletTotalCents !== null && tabletDiffers(tabletExpected, tabletTotalCents, tolerance)) {
        // A warning to read: Enter (or a held key) lands on "Go back", never on paying anyway.
        const expected =
          tabletExpected === total
            ? `The till says ${formatCents(total)}`
            : `The tablet should say ${formatCents(tabletExpected)} (the till's ${formatCents(total)} at foodpanda's prices)`;
        const payAnyway = await askConfirm(
          `${expected}, the tablet says ${formatCents(tabletTotalCents)} — check the items and the deal.\nPay anyway? The difference is kept, and Reports list this order to check.`,
          { safeDefault: true, yesLabel: 'Pay anyway', noLabel: 'Go back' },
        );
        if (!payAnyway) return;
      }
    }
    try {
      await tender(
        nothingToPay
          ? []
          : [
              {
                method,
                amountCents: total,
                tenderedCents: methodSpec.showTendered ? tenderedCents : null,
                ...(isFoodpanda ? { referenceNo: fpCode.trim() || null } : {}),
              },
            ],
        isFoodpanda ? { tabletTotalCents } : undefined,
      );
      onPaid();
    } catch (e) {
      setError(`Payment not taken: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }

  // The keyboard works like the pad: digits, Backspace, Enter to confirm.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Enter') {
      // Cancel / Close keep their Enter, as does any button reached with Tab.
      if (target.dataset['nativeEnter'] !== undefined || (target.tagName === 'BUTTON' && ownsEnter(target))) return;
      e.preventDefault();
      void submit();
      return;
    }
    if (!methodSpec.showTendered) return;
    const shown = exact ? exactLabel : tendered;
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      typeAmount(shown + e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      typeAmount(shown.slice(0, -1));
    }
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          ref={contentRef}
          onKeyDown={onKeyDown}
          // Not the Close button (Radix's default): Enter there would close
          // the dialog instead of taking the payment.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            contentRef.current?.focus();
          }}
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-24px)] w-[720px] max-w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-xl bg-white shadow-xl outline-none dark:bg-stone-900 dark:text-stone-100"
        >
          <header className="flex items-center justify-between border-b border-stone-200 px-5 py-3 dark:border-stone-800">
            <Dialog.Title className="text-xl font-bold">
              Payment <span className="ml-2 font-mono text-stone-500">{formatCents(total)}</span>
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                data-native-enter=""
                aria-label="Close"
                className="grid h-10 w-10 place-items-center rounded-lg text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>

          <div className="grid grid-cols-2 gap-5 p-5">
            <div>
              <div className="mb-2 text-xs uppercase tracking-wider text-stone-500">Method</div>
              <div className="grid grid-cols-2 gap-2">
                {methods.map((m) => {
                  const Icon = m.icon;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={method === m.id}
                      onClick={() => {
                        setMethod(m.id);
                        setError(null);
                        if (!m.showTendered) {
                          setTendered('');
                          setExact(false);
                        } else if (!tendered) {
                          setExact(total > 0);
                        }
                      }}
                      className={cn(
                        'flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-lg border-2 p-2 transition-colors',
                        method === m.id
                          ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                          : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                      )}
                    >
                      <Icon className="h-6 w-6" />
                      <span className="text-sm font-semibold">{m.label}</span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-4 rounded-lg bg-stone-100 p-4 dark:bg-stone-800">
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <dt>Subtotal</dt>
                    <dd className="font-mono">{formatCents(snapshot.order.subtotalCents)}</dd>
                  </div>
                  {(snapshot.order.discountCents > 0 || dealLine) && (
                    <div className="flex justify-between text-emerald-700 dark:text-emerald-300">
                      <dt>
                        {/* "(food only)" when the discount's own frozen rule left the delivery charge alone. */}
                        {payDiscountLabel(
                          dealLine?.label,
                          snapshot.discounts[snapshot.discounts.length - 1],
                          snapshot.items,
                          snapshot.order.discountCents,
                        )}
                      </dt>
                      <dd className="font-mono">−{formatCents(snapshot.order.discountCents)}</dd>
                    </div>
                  )}
                  {dealLine?.note && (
                    <div className="flex justify-between text-xs text-stone-500">
                      <dt>{dealLine.note}</dt>
                      <dd />
                    </div>
                  )}
                  <div className="flex justify-between">
                    <dt>Tax</dt>
                    <dd className="font-mono">{formatCents(snapshot.order.taxCents)}</dd>
                  </div>
                  <div className="flex justify-between border-t border-stone-300 pt-1 text-lg font-bold dark:border-stone-600">
                    <dt>Total</dt>
                    <dd className="font-mono">{formatCents(total)}</dd>
                  </div>
                </dl>
              </div>
            </div>

            <div>
              {methodSpec.showTendered && !nothingToPay ? (
                <>
                  <div className="mb-2 text-xs uppercase tracking-wider text-stone-500">Cash given</div>
                  <div className="mb-3 grid grid-cols-5 gap-2">
                    <button
                      type="button"
                      aria-pressed={exact}
                      onClick={() => {
                        setExact(true);
                        setTendered('');
                        setError(null);
                      }}
                      className={cn(
                        'h-12 rounded-lg border-2 px-2 text-sm font-semibold',
                        exact
                          ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                          : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                      )}
                    >
                      Exact
                    </button>
                    {quickRupees.map((r) => (
                      <button
                        key={r}
                        type="button"
                        aria-pressed={!exact && tendered === String(r)}
                        onClick={() => {
                          setExact(false);
                          setTendered(String(r));
                          setError(null);
                        }}
                        className={cn(
                          'h-12 rounded-lg border-2 px-2 font-mono text-sm font-semibold',
                          !exact && tendered === String(r)
                            ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                            : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                        )}
                      >
                        {r.toLocaleString('en-PK')}
                      </button>
                    ))}
                  </div>
                  <NumberPad value={exact ? exactLabel : tendered} onChange={typeAmount} maxLength={8} onSubmit={() => void submit()} />
                  <div
                    className={cn(
                      'mt-3 rounded-lg p-3 text-center',
                      enough ? 'bg-emerald-50 dark:bg-emerald-950' : 'bg-red-50 dark:bg-red-950',
                    )}
                    aria-live="polite"
                  >
                    <div
                      className={cn(
                        'text-xs uppercase tracking-wider',
                        enough ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300',
                      )}
                    >
                      {enough ? 'Change' : 'Short by'}
                    </div>
                    <div className="font-mono text-3xl font-bold">{formatCents(enough ? changeCents : shortCents)}</div>
                  </div>
                </>
              ) : (
                <>
                  <div className={cn('rounded-lg bg-stone-100 p-6 text-center dark:bg-stone-800', isFoodpanda ? 'mt-0' : 'mt-12')}>
                    <div className="mb-2 text-sm text-stone-500">
                      {nothingToPay ? 'Nothing to collect' : `Charge to ${methodSpec.label}`}
                    </div>
                    <div className="font-mono text-4xl font-bold">{formatCents(total)}</div>
                  </div>
                  {isFoodpanda && (
                    <div className="mt-4 space-y-3">
                      <label className="block text-sm">
                        <span className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                          foodpanda order # {checks.orderCode === 'required' ? '(required)' : '(if you have it)'}
                        </span>
                        <input
                          value={fpCode}
                          maxLength={FOODPANDA_ORDER_CODE_MAX}
                          onChange={(e) => {
                            setFpCode(e.target.value);
                            setError(null);
                          }}
                          className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                          placeholder="As on the tablet"
                        />
                      </label>
                      <label className="block text-sm">
                        <span className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                          Total on the tablet (Rs) {checks.tabletTotal === 'required' ? '(required)' : '(if you have it)'}
                        </span>
                        <input
                          value={fpTablet}
                          inputMode="decimal"
                          onChange={(e) => {
                            setFpTablet(e.target.value.replace(/[^\d.,]/g, '').slice(0, 12));
                            setError(null);
                          }}
                          className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                          // Not the till's total: an empty box must not look filled in and matching.
                          placeholder="Type what the tablet shows"
                        />
                      </label>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {error && (
            <p role="alert" className="mx-5 -mt-2 mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 dark:bg-red-950 dark:text-red-300">
              {error}
            </p>
          )}

          <footer className="flex items-center justify-end gap-2 border-t border-stone-200 px-5 py-3 dark:border-stone-800">
            <span className="mr-auto text-xs text-stone-400">
              <kbd className="rounded bg-stone-100 px-1 font-mono dark:bg-stone-800">Enter</kbd> confirm ·{' '}
              <kbd className="rounded bg-stone-100 px-1 font-mono dark:bg-stone-800">Esc</kbd> back
            </span>
            <Button variant="secondary" data-native-enter="" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="success" size="lg" disabled={!enough || busy} onClick={() => void submit()}>
              {busy
                ? 'Processing…'
                : nothingToPay
                  ? 'Nothing to pay — complete order'
                  : methodSpec.showTendered && changeCents > 0
                    ? `Confirm · change ${formatCents(changeCents)}`
                    : 'Confirm payment'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The tablet total as typed ("1,920" / "1920.50") → paisa; '' → null; anything else → NaN. */
export function parseTabletCents(input: string): number | null {
  const t = input.trim().replace(/,/g, '');
  if (t === '') return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * 100);
}

function parseTenderedCents(input: string): number {
  if (!input) return 0;
  // Interpret raw input as PKR rupees (no decimals on numpad). User types "1500" → 1500 rupees → 150000 cents.
  const rupees = parseInt(input, 10);
  if (Number.isNaN(rupees)) return 0;
  return rupees * 100;
}
