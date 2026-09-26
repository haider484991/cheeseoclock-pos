import { useRef, useState, type KeyboardEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { Lock, X } from 'lucide-react';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { SecretInput } from '../../components/secret/SecretInput';
import { SecretHint } from '../../components/secret/SecretHint';
import { approvalProblem, secretReady } from '../../components/secret/secretRules';
import { ownsEnter } from './keys';
import {
  FLAT_PRESETS_RUPEES,
  PERCENT_PRESETS,
  REASON_PRESETS,
  describeDiscount,
  flatChoiceRupees,
  parseDiscountEntry,
  percentChoice,
  previewDiscount,
  sameChoice,
  type DiscountChoice,
} from './discountPresets';

interface Props {
  onClose: () => void;
}

/**
 * Discount in two taps: pick a preset (10 / 20 / 25 / 50 / 100 %, or Rs 100 /
 * 200 / 500), check the new total, Apply — or tap the same preset again. Each
 * preset shows what it takes off this order, and a lock where the till will
 * ask for a manager's PIN or password (over 10%, or a flat amount over 10% of
 * the order — the same rule the till checks when it saves the discount).
 */
export function DiscountDialog({ onClose }: Props) {
  const snapshot = useCheckoutStore((s) => s.snapshot);
  const applyDiscount = useCheckoutStore((s) => s.applyDiscount);
  const clearDiscount = useCheckoutStore((s) => s.clearDiscount);
  const busy = useCheckoutStore((s) => s.busy);

  const current = snapshot?.discounts[snapshot.discounts.length - 1] ?? null;
  const currentChoice: DiscountChoice | null = current ? { type: current.discountType, value: current.value } : null;

  const [picked, setPicked] = useState<DiscountChoice | null>(currentChoice);
  const [customKind, setCustomKind] = useState<'percent' | 'flat'>('percent');
  const [customText, setCustomText] = useState('');
  const [reason, setReason] = useState(current?.reason ?? '');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** A preset was tapped in this dialog: tapping it again applies it. */
  const [armed, setArmed] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);
  const customRef = useRef<HTMLInputElement>(null);

  const lines = snapshot?.items ?? [];
  const subtotal = snapshot?.order.subtotalCents ?? 0;
  const typing = customText.trim() !== '';
  const typed = parseDiscountEntry(customKind, customText);
  const choice = typing ? typed : picked;

  const before = previewDiscount(lines, subtotal, null);
  const after = previewDiscount(lines, subtotal, choice);
  const needsPin = after.needsApproval;
  const pinOk = secretReady(pin);
  const canApply = !!choice && after.discountCents > 0 && (!needsPin || pinOk) && !saving && !busy;

  function focusPinSoon() {
    requestAnimationFrame(() => pinRef.current?.focus());
  }

  function pick(next: DiscountChoice) {
    setError(null);
    // Tapping the chosen preset again applies it.
    if (!typing && armed && sameChoice(picked, next)) {
      void apply(next);
      return;
    }
    setPicked(next);
    setArmed(true);
    setCustomText('');
    if (previewDiscount(lines, subtotal, next).needsApproval && !pinOk) focusPinSoon();
  }

  async function apply(which: DiscountChoice | null = choice) {
    if (saving || busy) return;
    if (!which) {
      setError(typing ? 'That amount does not work — check it.' : 'Pick a discount or type an amount.');
      return;
    }
    const preview = previewDiscount(lines, subtotal, which);
    if (preview.discountCents <= 0) {
      setError('Nothing to take off this order.');
      return;
    }
    if (preview.needsApproval && !pinOk) {
      setError(pin.trim() ? approvalProblem(pin) : "This discount needs a manager's PIN or password.");
      pinRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await applyDiscount(which.type, which.value, reason.trim() || undefined, preview.needsApproval ? pin : undefined);
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      setError(`Discount not applied: ${message}`);
      if (preview.needsApproval) {
        setPin('');
        pinRef.current?.focus();
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (saving || busy) return;
    setSaving(true);
    setError(null);
    try {
      await clearDiscount();
      onClose();
    } catch (e) {
      setError(`Could not remove the discount: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  }

  // Enter applies from anywhere in the dialog except a button reached with
  // Tab (which does its own thing). In the "other amount" box, Enter goes to
  // the PIN / password box first when one is needed.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON' && ownsEnter(target)) return;
    e.preventDefault();
    if (target.dataset['field'] === 'custom' && needsPin && !pinOk) {
      pinRef.current?.focus();
      return;
    }
    void apply();
  }

  const presetClass = (selected: boolean) =>
    cn(
      'flex min-h-[60px] flex-col items-center justify-center gap-0.5 rounded-xl border-2 px-2 py-1.5 transition-colors',
      selected
        ? 'border-amber-500 bg-amber-50 text-stone-900 dark:bg-amber-950 dark:text-amber-50'
        : 'border-stone-200 bg-white hover:border-stone-400 dark:border-stone-700 dark:bg-stone-800',
    );

  function presetButton(key: string, label: string, preset: DiscountChoice) {
    const p = previewDiscount(lines, subtotal, preset);
    const selected = !typing && sameChoice(picked, preset);
    return (
      <button
        key={key}
        type="button"
        onClick={() => pick(preset)}
        aria-pressed={selected}
        aria-label={`${describeDiscount(preset)}, takes ${formatCents(p.discountCents)} off${p.needsApproval ? ", needs a manager's PIN or password" : ''}`}
        className={presetClass(selected)}
      >
        <span className="text-lg font-bold leading-tight">{label}</span>
        <span className="flex items-center gap-1 text-xs font-medium text-stone-500 dark:text-stone-400">
          {p.needsApproval && <Lock className="h-3 w-3" aria-hidden="true" />}−{formatCents(p.discountCents, { showSymbol: false })}
        </span>
      </button>
    );
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          onKeyDown={onKeyDown}
          // Keys first: F3, type 15, Enter. Taps on the presets work the same.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            customRef.current?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-24px)] w-[560px] max-w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900 dark:text-stone-100"
        >
          <header className="mb-3 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-xl font-bold">Discount</Dialog.Title>
              <Dialog.Description className="text-sm text-stone-500 dark:text-stone-400">
                Order {formatCents(subtotal)} before tax
                {current && (
                  <>
                    {' · '}
                    <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                      now {describeDiscount(currentChoice!)}
                    </span>
                  </>
                )}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="grid h-10 w-10 place-items-center rounded-lg text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>

          <div className="space-y-3">
            <section aria-label="Percent off">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-500">Percent off</div>
              <div className="grid grid-cols-5 gap-2">
                {PERCENT_PRESETS.map((pct) => presetButton(`p${pct}`, `${pct}%`, percentChoice(pct)))}
              </div>
            </section>

            <section aria-label="Amount off">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-500">Amount off</div>
              <div className="grid grid-cols-5 gap-2">
                {FLAT_PRESETS_RUPEES.map((rs) => presetButton(`f${rs}`, `Rs ${rs}`, flatChoiceRupees(rs)))}
                <div
                  className={cn(
                    'col-span-2 flex min-h-[60px] items-center gap-1 rounded-xl border-2 pl-3 pr-1',
                    typing
                      ? typed
                        ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                        : 'border-red-400 bg-red-50 dark:bg-red-950'
                      : 'border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-800',
                  )}
                >
                  <input
                    ref={customRef}
                    data-field="custom"
                    inputMode="decimal"
                    aria-label={customKind === 'percent' ? 'Other percent off' : 'Other amount off in rupees'}
                    placeholder="Other"
                    value={customText}
                    onChange={(e) => {
                      setCustomText(e.target.value.replace(/[^\d.,]/g, '').slice(0, 9));
                      setError(null);
                    }}
                    className="w-full min-w-0 bg-transparent py-2 font-mono text-lg font-semibold outline-none placeholder:font-sans placeholder:text-base placeholder:font-normal placeholder:text-stone-400"
                  />
                  <div className="flex shrink-0 rounded-lg bg-stone-100 p-0.5 dark:bg-stone-700" role="group" aria-label="Other amount is in">
                    {(['percent', 'flat'] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        aria-pressed={customKind === k}
                        onClick={() => setCustomKind(k)}
                        className={cn(
                          'h-10 min-w-[40px] rounded-md px-2 text-sm font-bold',
                          customKind === k
                            ? 'bg-white text-stone-900 shadow-sm dark:bg-stone-900 dark:text-stone-100'
                            : 'text-stone-500',
                        )}
                      >
                        {k === 'percent' ? '%' : 'Rs'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section aria-label="Reason">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Reason <span className="font-normal normal-case tracking-normal">(optional, prints on the bill)</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {REASON_PRESETS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={reason === r}
                    onClick={() => setReason(reason === r ? '' : r)}
                    className={cn(
                      'h-10 rounded-full border px-3 text-sm font-medium',
                      reason === r
                        ? 'border-amber-500 bg-amber-50 text-stone-900 dark:bg-amber-950 dark:text-amber-50'
                        : 'border-stone-200 hover:border-stone-400 dark:border-stone-700',
                    )}
                  >
                    {r}
                  </button>
                ))}
                <input
                  type="text"
                  aria-label="Reason"
                  value={reason}
                  maxLength={120}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="or type one"
                  className="h-10 min-w-[140px] flex-1 rounded-full border border-stone-200 px-3 text-sm dark:border-stone-700 dark:bg-stone-800"
                />
              </div>
            </section>

            {needsPin && (
              <div>
                <label className="flex items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-700 dark:bg-amber-950">
                  <Lock className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
                  <span className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                    Manager PIN or password
                  </span>
                  <SecretInput
                    ref={pinRef}
                    value={pin}
                    onChange={(v) => {
                      setPin(v);
                      setError(null);
                    }}
                    wrapperClassName="min-w-0 flex-1"
                    className="h-11 min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-3 font-mono text-lg tracking-widest dark:border-amber-700 dark:bg-stone-900"
                    placeholder="••••"
                  />
                </label>
                <SecretHint value={pin} className="mt-1 px-1" />
              </div>
            )}

            <div className="rounded-xl bg-stone-100 px-4 py-3 dark:bg-stone-800" aria-live="polite">
              {choice ? (
                <>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                      {describeDiscount(choice)}
                      {after.capped && ' (the whole order)'}
                    </span>
                    <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                      −{formatCents(after.discountCents)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-baseline justify-between">
                    <span className="text-sm text-stone-500 dark:text-stone-400">
                      New total <s className="ml-1">{formatCents(before.totalCents)}</s>
                    </span>
                    <span className="font-mono text-2xl font-bold">{formatCents(after.totalCents)}</span>
                  </div>
                </>
              ) : (
                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-stone-500 dark:text-stone-400">
                    {typing ? 'Type a number' : 'Tap a discount to see the new total'}
                  </span>
                  <span className="font-mono text-2xl font-bold">{formatCents(before.totalCents)}</span>
                </div>
              )}
            </div>

            {error && (
              <p role="alert" className="text-sm font-semibold text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
          </div>

          <footer className="mt-4 flex items-center gap-2">
            {current && (
              <Button variant="ghost" className="text-red-700 dark:text-red-400" disabled={saving || busy} onClick={() => void remove()}>
                Remove discount
              </Button>
            )}
            <div className="flex-1" />
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" size="lg" disabled={!canApply} onClick={() => void apply()}>
              {saving ? 'Applying…' : choice ? `Apply ${describeDiscount(choice)}` : 'Apply'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
