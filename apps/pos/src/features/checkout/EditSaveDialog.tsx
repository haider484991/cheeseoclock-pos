import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import { ChefHat, Lock, X } from 'lucide-react';
import { FREE_ORDER_NEEDS_REASON, formatCents } from '@cheeseoclock/pos-domain';
import type { FoodMade, OrderEditChangeLine, OrderEditSaved } from '@cheeseoclock/shared-types';
import { useCheckoutStore, type EditSession } from '../../stores/checkoutStore';
import { SecretInput } from '../../components/secret/SecretInput';
import { SecretHint } from '../../components/secret/SecretHint';
import { approvalProblem, secretReady } from '../../components/secret/secretRules';
import { ownsEnter } from './keys';
import { FREE_ORDER_REASONS } from './discountWords';

interface Props {
  onClose: () => void;
  /** Saved: the till's answer, and the change as it was (where to go back to, the order's number). */
  onSaved: (saved: OrderEditSaved, session: EditSession) => void;
}

/** The reasons offered for a change (a Free order: FREE_ORDER_REASONS); any other can be typed. */
export const EDIT_REASONS = ['Customer changed order', 'Wrong item rung', 'Customer complaint', 'Forgot the discount'] as const;

/** Said when Save is tapped without a reason the change needs. */
export const EDIT_REASON_NEEDED = 'Say why (for example: customer changed order).';

/** "2 × Wings (No onion)". */
function lineWords(l: OrderEditChangeLine): string {
  const mods = l.modifiers.length > 0 ? ` (${l.modifiers.join(', ')})` : '';
  return `${l.quantity} × ${l.menuItemName}${mods}`;
}

/**
 * The Save box of an Edit order (v0.7.36): what changes, then only what the
 * change needs — "Was the food made?" for each item the kitchen has that
 * comes off (not made: back on the shelf; made: waste), a reason, and a
 * manager's PIN or password when an item the kitchen has comes off, the
 * delivery charge comes off, the discount is over the limit or the order is
 * made free. The till checks all of it again; the kitchen gets a CHANGE slip
 * with only these items, and a bill that already went out prints again.
 */
export function EditSaveDialog({ onClose, onSaved }: Props) {
  const edit = useCheckoutStore((s) => s.edit);
  const snapshot = useCheckoutStore((s) => s.snapshot);
  const saveEdit = useCheckoutStore((s) => s.saveEdit);
  const [made, setMade] = useState<Record<string, FoodMade>>({});
  // A Free order's own reason (given in the Discount box) is the change's: not asked twice.
  const [reason, setReason] = useState(() => {
    const free = useCheckoutStore.getState().edit?.ops.find((o) => o.op === 'discount' && o.free === true);
    return free?.op === 'discount' ? (free.reason ?? '') : '';
  });
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const reasonRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  if (!edit || !snapshot) return null;
  const { diff, needs } = edit;
  const short = snapshot.order.orderNumber.split('-').pop() ?? snapshot.order.orderNumber;
  const addedFood = diff.added.filter((l) => !l.fee);
  const removedFood = diff.removed.filter((l) => !l.fee);
  const chargeOff = diff.removed.some((l) => l.fee);
  const chips = diff.freeOrder ? FREE_ORDER_REASONS : EDIT_REASONS;
  const unanswered = removedFood.filter((l) => !made[l.lineId]);

  async function save() {
    if (saving || !edit) return;
    const first = unanswered[0];
    if (first) {
      setError(`Was the food made? Answer for ${first.menuItemName}.`);
      return;
    }
    if (needs.reason && !reason.trim()) {
      setError(diff.freeOrder ? FREE_ORDER_NEEDS_REASON : EDIT_REASON_NEEDED);
      reasonRef.current?.focus();
      return;
    }
    if (needs.pin && !secretReady(pin)) {
      setError((pin.trim() ? approvalProblem(pin) : null) ?? "A manager's PIN or password is needed.");
      pinRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    const session = edit;
    try {
      const saved = await saveEdit({
        ...(needs.pin ? { approverPin: pin } : {}),
        reason: reason.trim() || null,
        foodMade: made,
      });
      onSaved(saved, session);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The change was not saved');
      // A PIN that was sent is cleared for another try.
      if (needs.pin) setPin('');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const target = e.target as HTMLElement;
            if (target.tagName === 'BUTTON' && ownsEnter(target)) return;
            e.preventDefault();
            void save();
          }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[500px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl bg-white shadow-soft-lg dark:bg-stone-900"
        >
          <header className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
            <div>
              <Dialog.Title className="text-lg font-semibold">Save the change to #{short}?</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                The kitchen gets a CHANGE slip with only these items. A bill that already went out prints again.
              </Dialog.Description>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800">
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-1 text-sm">
            <section aria-label="What changes" className="space-y-1.5 rounded-xl bg-stone-50 p-3 dark:bg-stone-800">
              {addedFood.length > 0 && (
                <div>
                  <div className="font-semibold text-emerald-800 dark:text-emerald-300">Adding · make now</div>
                  <ul className="ml-1">
                    {addedFood.map((l, i) => (
                      <li key={`${l.lineId}-${i}`}>+ {lineWords(l)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {removedFood.length > 0 && (
                <div>
                  <div className="font-semibold text-red-800 dark:text-red-300">Taking off · do not make</div>
                  <ul className="ml-1">
                    {removedFood.map((l, i) => (
                      <li key={`${l.lineId}-${i}`}>− {lineWords(l)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {chargeOff && <div className="font-semibold">The delivery charge comes off.</div>}
              {diff.freeOrder ? (
                <div className="font-semibold text-emerald-800 dark:text-emerald-300">
                  Free order: nothing to pay.
                  {snapshot.order.mode === 'delivery' && ' At Send out the drawer pays an outside rider his delivery charge.'}
                </div>
              ) : (
                diff.discountChanged && <div className="font-semibold">The discount changes.</div>
              )}
              <div className="flex items-baseline justify-between border-t border-stone-200 pt-1.5 dark:border-stone-700">
                <span className="text-stone-500">
                  New total <s className="ml-1">{formatCents(diff.totalBeforeCents)}</s>
                </span>
                <span className="font-mono text-xl font-bold">{formatCents(diff.totalAfterCents)}</span>
              </div>
            </section>

            {removedFood.length > 0 && (
              <section aria-label="Was the food made?" className="space-y-2">
                <div className="flex items-center gap-1.5 font-semibold text-stone-800 dark:text-stone-100">
                  <ChefHat className="h-4 w-4" aria-hidden="true" />
                  Was the food made?
                </div>
                {removedFood.map((l, i) => (
                  <div key={`${l.lineId}-${i}`} className="space-y-1">
                    <div className="text-stone-700 dark:text-stone-200">{lineWords(l)}</div>
                    <div className="grid grid-cols-2 gap-2" role="group" aria-label={`Was ${l.menuItemName} made?`}>
                      <MadeButton pressed={made[l.lineId] === 'not_made'} onClick={() => setMade((m) => ({ ...m, [l.lineId]: 'not_made' }))}>
                        Not made · back on the shelf
                      </MadeButton>
                      <MadeButton pressed={made[l.lineId] === 'made'} onClick={() => setMade((m) => ({ ...m, [l.lineId]: 'made' }))}>
                        Made · it is waste
                      </MadeButton>
                    </div>
                  </div>
                ))}
              </section>
            )}

            {needs.reason && (
              <div>
                <label htmlFor="edit-reason" className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                  Reason
                </label>
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                  {chips.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => {
                        setReason(reason === r ? '' : r);
                        setError(null);
                      }}
                      aria-pressed={reason === r}
                      className={cn(
                        'rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition-colors',
                        reason === r
                          ? 'bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-700'
                          : 'bg-stone-50 text-stone-700 ring-stone-200 hover:bg-stone-100 dark:bg-stone-800 dark:text-stone-200 dark:ring-stone-700',
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <input
                  id="edit-reason"
                  ref={reasonRef}
                  value={reason}
                  maxLength={120}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setError(null);
                  }}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                  placeholder="Or type why…"
                />
              </div>
            )}

            {needs.pin && (
              <div>
                <label className="block">
                  <span className="mb-1 flex items-center gap-1.5 font-medium text-stone-700 dark:text-stone-200">
                    <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                    Manager PIN or password
                    <span className="font-normal text-stone-500">— {needs.why.join(' · ').toLowerCase()}</span>
                  </span>
                  <SecretInput
                    ref={pinRef}
                    value={pin}
                    onChange={(v) => {
                      setPin(v);
                      setError(null);
                    }}
                    className="min-w-0 flex-1 rounded-lg border border-stone-200 px-3 py-2 text-center font-mono text-lg tracking-[0.5em] focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                    placeholder="••••"
                  />
                </label>
                <SecretHint value={pin} className="mt-1" />
              </div>
            )}

            {error && (
              <p role="alert" className="font-semibold text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
          </div>

          <div className="flex gap-2 border-t border-stone-100 px-5 py-4 dark:border-stone-800">
            <Button type="button" variant="ghost" size="md" className="flex-1" onClick={onClose}>
              Back
            </Button>
            <Button type="button" variant="primary" size="md" className="flex-1" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Made or Not made for one item: a big button that stays pressed. */
function MadeButton({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'min-h-11 rounded-xl border-2 px-3 py-2 text-left text-sm font-bold transition-colors',
        pressed
          ? 'border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100'
          : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200',
      )}
    >
      {children}
    </button>
  );
}
