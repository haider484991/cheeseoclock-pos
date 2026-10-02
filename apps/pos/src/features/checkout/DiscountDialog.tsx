import { useRef, useState, type KeyboardEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import { approvalRuleText, DISCOUNT_REASON_REQUIRED, formatCents } from '@cheeseoclock/pos-domain';
import { Lock, X } from 'lucide-react';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { SecretInput } from '../../components/secret/SecretInput';
import { SecretHint } from '../../components/secret/SecretHint';
import { approvalProblem, secretReady } from '../../components/secret/secretRules';
import { ownsEnter } from './keys';
import { useDiscountRules } from '../settings/shop-rules/useShopSetting';
import {
  currentDiscountWords,
  describeDiscount,
  describePreview,
  discountApplyStep,
  discountBaseNow,
  discountBaseText,
  discountDialogOpenFocus,
  discountDialogPrimary,
  discountDialogStart,
  discountReasonHint,
  discountReasonProblem,
  discountRefused,
  discountRuleBasisNow,
  parseDiscountEntry,
  presetButtons,
  previewDiscount,
  reasonButtons,
  sameChoice,
  type DiscountChoice,
  type DiscountDialogFocus,
  type DiscountDialogIntent,
} from './discountPresets';

interface Props {
  onClose: () => void;
  /** 'removeDeal': opened from the × on the foodpanda deal's line (Enter takes it off). */
  intent?: DiscountDialogIntent;
}

/**
 * Discount in two taps: pick a preset (the owner's buttons, Settings → Money
 * & discounts; by default 10 / 20 / 25 / 50 / 100 %, or Rs 100 / 200 / 500),
 * check the new total, Apply — or tap the same preset again. Each preset
 * shows what it takes off this order, and a lock where the till will ask for
 * a manager's PIN or password: pos-domain requiresManagerApproval with the
 * owner's limit (by default over 10%, or a flat amount over Rs 500 or over
 * 10% of the order), the same rule the till checks when it saves the
 * discount. Any other amount can still be typed. By default a discount is
 * worked on the food only (Settings → Money & discounts: the delivery charge
 * is paid in full), and the dialog says so on an order that has one. Value
 * deals never get a discount (except on a foodpanda order, matching the
 * tablet): the header says what they come to, and with nothing else on the
 * order the buttons and Apply are off (Remove still works), no choice shows
 * and the dialog itself has the cursor (Enter says why, Esc closes). When the
 * owner has made a reason required, the Reason row says "needed" and Apply
 * waits for one (a reason button is still one tap); the main process refuses
 * a discount without one in any case.
 */
export function DiscountDialog({ onClose, intent = 'change' }: Props) {
  const snapshot = useCheckoutStore((s) => s.snapshot);
  const applyDiscount = useCheckoutStore((s) => s.applyDiscount);
  const clearDiscount = useCheckoutStore((s) => s.clearDiscount);
  const busy = useCheckoutStore((s) => s.busy);
  // The owner's approval limit and buttons (checkout:getRules; the released ones until it answers).
  const rules = useDiscountRules();
  const limits = rules.approval;
  const buttons = presetButtons(rules.presets);

  const current = snapshot?.discounts[snapshot.discounts.length - 1] ?? null;
  // The shop's foodpanda deal is on this order: only a manager changes it or takes it off (for one order).
  const dealOn = current?.source === 'foodpanda';
  // One of the owner's automatic offers: a discount applied here replaces it under the usual rule
  // (no PIN of its own); Remove takes it off this order, and on one taken off it is put back.
  const offerOn = current?.source === 'offer' ? { declined: current.offer?.declined === true } : null;
  // A staff discount opens on itself; the deal opens on nothing (never re-applied as a staff discount).
  const start = discountDialogStart(current);
  const removingDeal = dealOn && intent === 'removeDeal';

  const [picked, setPicked] = useState<DiscountChoice | null>(start.picked);
  const [customKind, setCustomKind] = useState<'percent' | 'flat'>('percent');
  const [customText, setCustomText] = useState('');
  const [reason, setReasonText] = useState(start.reason);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** A preset was tapped in this dialog: tapping it again applies it. */
  const [armed, setArmed] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  /** A reason picked or typed: a "reason needed" message has been answered. */
  function setReason(next: string) {
    setReasonText(next);
    setError((e) => (e === DISCOUNT_REASON_REQUIRED ? null : e));
  }

  const lines = snapshot?.items ?? [];
  const subtotal = snapshot?.order.subtotalCents ?? 0;
  // The order's mode: value deals are never discounted, except on a foodpanda order (matching the tablet).
  const mode = snapshot?.order.mode;
  // What a discount given now is worked on: the food only, unless the owner's switch says every line;
  // never the value deals.
  const base = discountBaseNow(lines, subtotal, rules, mode);
  // What the header and the limit line call it (the main process's refusal says the same).
  const basis = discountRuleBasisNow(lines, rules, mode);
  // Every line it could come off is a value deal: nothing to pick, nothing to apply (Remove still works).
  const onlyValueDeals = base.baseCents === 0 && base.dealsCents > 0;
  const typing = customText.trim() !== '';
  const typed = parseDiscountEntry(customKind, customText);
  // Only value deals: no choice to show, not even the discount already on the order (a staff
  // discount left at Rs 0 when the food was taken off) — no preset pressed, no preview.
  const pickedNow = onlyValueDeals ? null : picked;
  const choice = typing && !onlyValueDeals ? typed : pickedNow;

  const before = previewDiscount(lines, subtotal, null, rules, mode);
  const after = previewDiscount(lines, subtotal, choice, rules, mode);
  // The discount already on the order, by its OWN frozen rule (the header's first part follows the switch now).
  const currentWords = current ? currentDiscountWords(current, lines, rules) : null;
  const needsPin = after.needsApproval || dealOn;
  const pinOk = secretReady(pin);
  // The owner's "a discount needs a reason" (checkout:getRules): the main process decides again on save.
  const reasonProblem = discountReasonProblem(rules.reasonRequired, reason);
  // The button is on exactly when Apply would send it (Enter and a second tap decide the same way, in apply()).
  const applyNow = discountApplyStep({
    onlyValueDeals,
    choice,
    typing,
    discountCents: after.discountCents,
    needsApproval: needsPin,
    reasonRequired: rules.reasonRequired,
    reason,
    pin,
  });
  const canApply = applyNow.kind === 'save' && !saving && !busy;
  const primary = discountDialogPrimary({ dealOn, intent, hasChoice: !!choice });

  function focusPinSoon() {
    requestAnimationFrame(() => pinRef.current?.focus());
  }

  function focusOn(where: DiscountDialogFocus) {
    if (where === 'reason') reasonRef.current?.focus();
    else if (where === 'pin') pinRef.current?.focus();
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
    if ((previewDiscount(lines, subtotal, next, rules, mode).needsApproval || dealOn) && !pinOk) focusPinSoon();
  }

  async function apply(which: DiscountChoice | null = choice) {
    if (saving || busy) return;
    const preview = which ? previewDiscount(lines, subtotal, which, rules, mode) : null;
    // Something to work it on, something picked, something to take off, the reason (said before
    // the PIN, as the main process does), then the manager's PIN: the same decision as the button's.
    const step = discountApplyStep({
      onlyValueDeals,
      choice: which,
      typing,
      discountCents: preview?.discountCents ?? 0,
      needsApproval: (preview?.needsApproval ?? false) || dealOn,
      reasonRequired: rules.reasonRequired,
      reason,
      pin,
    });
    if (step.kind === 'refuse') {
      setError(step.message);
      focusOn(step.focus);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await applyDiscount(step.choice.type, step.choice.value, step.reason, step.approverPin);
      onClose();
    } catch (e) {
      // Refused for its reason alone: the dialog's own words (the PIN stays typed); else
      // "Discount not applied: …" and a PIN that was sent is cleared for another try.
      const refused = discountRefused(e instanceof Error ? e.message : 'Unknown error', step.approverPin !== undefined);
      setError(refused.error);
      // The owner may have just changed the limit (or made a reason required): the screen follows it.
      rules.refetch();
      if (refused.clearPin) setPin('');
      focusOn(refused.focus);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (saving || busy) return;
    if (dealOn && !pinOk) {
      setError(pin.trim() ? approvalProblem(pin) : "Taking the foodpanda deal off needs a manager's PIN or password.");
      pinRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await clearDiscount(dealOn ? pin : undefined);
      onClose();
    } catch (e) {
      setError(`Could not remove the discount: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  }

  // Enter applies from anywhere in the dialog except a button reached with
  // Tab (which does its own thing). In the "other amount" box, Enter goes to
  // the PIN / password box first when one is needed. Opened from the deal's
  // ×, with nothing else picked, Enter takes the deal off.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON' && ownsEnter(target)) return;
    e.preventDefault();
    if (target.dataset['field'] === 'custom' && needsPin && !pinOk) {
      pinRef.current?.focus();
      return;
    }
    if (primary === 'remove') void remove();
    else void apply();
  }

  const presetClass = (selected: boolean) =>
    cn(
      'flex min-h-[60px] flex-col items-center justify-center gap-0.5 rounded-xl border-2 px-2 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
      selected
        ? 'border-amber-500 bg-amber-50 text-stone-900 dark:bg-amber-950 dark:text-amber-50'
        : 'border-stone-200 bg-white hover:border-stone-400 dark:border-stone-700 dark:bg-stone-800',
    );

  function presetButton(key: string, label: string, preset: DiscountChoice) {
    const p = previewDiscount(lines, subtotal, preset, rules, mode);
    const selected = !typing && sameChoice(pickedNow, preset);
    return (
      <button
        key={key}
        type="button"
        disabled={onlyValueDeals}
        onClick={() => pick(preset)}
        aria-pressed={selected}
        aria-label={`${describeDiscount(preset)}, takes ${formatCents(p.discountCents)} off${p.needsApproval || dealOn ? ", needs a manager's PIN or password" : ''}`}
        className={presetClass(selected)}
      >
        <span className="text-lg font-bold leading-tight">{label}</span>
        <span className="flex items-center gap-1 text-xs font-medium text-stone-500 dark:text-stone-400">
          {(p.needsApproval || dealOn) && <Lock className="h-3 w-3" aria-hidden="true" />}−{formatCents(p.discountCents, { showSymbol: false })}
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
          // From the deal's ×: straight to the manager's PIN, then Enter. Only
          // value deals: the dialog itself (the amount box is off), so Enter
          // says why and never reaches the page behind it.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const dialog = e.currentTarget as HTMLElement;
            const where = discountDialogOpenFocus({ removingDeal, onlyValueDeals });
            const target =
              where === 'pin' ? pinRef.current : where === 'custom' ? dialog.querySelector<HTMLElement>('[data-field="custom"]') : dialog;
            target?.focus();
            // A box that is off takes no cursor: then the dialog does, never whatever had it before F3.
            if (!dialog.contains(dialog.ownerDocument.activeElement)) dialog.focus();
          }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-24px)] w-[560px] max-w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-xl bg-white p-5 shadow-xl outline-none dark:bg-stone-900 dark:text-stone-100"
        >
          <header className="mb-3 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-xl font-bold">{removingDeal ? 'Take the foodpanda deal off?' : 'Discount'}</Dialog.Title>
              <Dialog.Description className="text-sm text-stone-500 dark:text-stone-400">
                {discountBaseText(base, subtotal, basis)}
                {currentWords && (
                  <>
                    {' · '}
                    <span className="font-semibold text-emerald-700 dark:text-emerald-400">now {currentWords.now}</span>
                  </>
                )}
              </Dialog.Description>
              {currentWords?.ruleNote && <p className="mt-1 text-xs font-medium text-amber-800 dark:text-amber-300">{currentWords.ruleNote}</p>}
              {/* The limit in words, on what it is checked on: the food, when the delivery charge is left
                  out; the food without the value deals, when they are (the food and delivery charge
                  without them, with the owner's switch on). None when only value deals are left. */}
              {!dealOn && !onlyValueDeals && (
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{approvalRuleText(limits, basis)}</p>
              )}
              {offerOn && (
                <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                  {offerOn.declined
                    ? "The owner's automatic offer was taken off this order. Put it back, or give a discount instead."
                    : "The owner's automatic offer is on this order. A discount you apply replaces it (the usual manager rule applies)."}
                </p>
              )}
              {dealOn && (
                <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                  {removingDeal
                    ? "A manager's PIN or password takes it off this order. Or pick what the tablet shows instead."
                    : "The owner's foodpanda deal: only a manager can change it on this order (for example to what the tablet shows) or take it off."}
                </p>
              )}
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
                {buttons.percent.map((b) => presetButton(b.key, b.label, b.choice))}
              </div>
            </section>

            <section aria-label="Amount off">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-500">Amount off</div>
              <div className="grid grid-cols-5 gap-2">
                {buttons.flat.map((b) => presetButton(b.key, b.label, b.choice))}
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
                    data-field="custom"
                    disabled={onlyValueDeals}
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
                        disabled={onlyValueDeals}
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
                Reason{' '}
                <span
                  className={cn(
                    'font-normal normal-case tracking-normal',
                    reasonProblem && 'font-semibold text-amber-700 dark:text-amber-300',
                  )}
                >
                  {discountReasonHint(rules.reasonRequired)}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {reasonButtons(rules.presets.reasons, rules.reasonRequired).map((r) => (
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
                  ref={reasonRef}
                  type="text"
                  aria-label="Reason"
                  aria-required={rules.reasonRequired}
                  aria-invalid={error !== null && reasonProblem !== null}
                  value={reason}
                  maxLength={120}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={dealOn ? 'e.g. as on the tablet' : 'or type one'}
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
                    <span className="font-semibold text-emerald-700 dark:text-emerald-400">{describePreview(choice, after, base)}</span>
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
                    {onlyValueDeals ? 'No discount on value deals' : typing ? 'Type a number' : 'Tap a discount to see the new total'}
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
            {current && primary !== 'remove' && (
              <Button variant="ghost" className="text-red-700 dark:text-red-400" disabled={saving || busy} onClick={() => void remove()}>
                {dealOn ? 'Take the deal off' : offerOn ? (offerOn.declined ? 'Put the offer back' : 'Take the offer off') : 'Remove discount'}
              </Button>
            )}
            <div className="flex-1" />
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            {primary === 'remove' ? (
              <Button variant="danger" size="lg" disabled={!pinOk || saving || busy} onClick={() => void remove()}>
                {saving ? 'Taking it off…' : 'Take the deal off'}
              </Button>
            ) : (
              <Button variant="primary" size="lg" disabled={!canApply} onClick={() => void apply()}>
                {saving ? 'Applying…' : choice ? `Apply ${describeDiscount(choice)}` : 'Apply'}
              </Button>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
