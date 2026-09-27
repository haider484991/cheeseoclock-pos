/**
 * Settings → Money & discounts (owner, 2026-09-27: "everything should be
 * editable for admin… as a developer I should not change anything every
 * time from code").
 *
 * Three cards, each its own synced setting:
 *  - when a cashier needs a manager for a discount ('discounts.approval'):
 *    the one rule, pos-domain requiresManagerApproval, used by the F3
 *    screen's locks, the IPC check and the repository's save and cart
 *    re-check, all with this value;
 *  - the F3 screen's one-tap buttons ('discounts.presets');
 *  - whether a discount also comes off the delivery charge
 *    ('discounts.delivery'; the owner, 28 Sep 2026: "Delivery charges is
 *    separate we don't want to add discount to it" — default No). Frozen on
 *    each discount when it is given: a change never moves one already given.
 * The foodpanda deal keeps its own rules (Settings → foodpanda). The owner
 * alone (the main process refuses anyone else); the first two defaults are
 * exactly what the till did before, the third is the owner's answer.
 */
import { useMemo } from 'react';
import { cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { Bike, Lock, MousePointerClick, ShieldCheck } from 'lucide-react';
import {
  APPROVAL_MAX_FLAT_CENTS,
  APPROVAL_MAX_PERCENT,
  PRESET_FLAT_MAX_CENTS,
  PRESET_REASON_MAX_LENGTH,
  type ShopSettingCard,
} from '@cheeseoclock/shared-types';
import { SettingCard } from './shop-rules/SettingCard';
import { useDraft } from './shop-rules/useDraft';
import { useShopSetting, useShopSettingsLive } from './shop-rules/useShopSetting';
import { sameValue } from './shop-rules/foodpandaForm';
import {
  DELIVERY_NEVER_CHANGED,
  DELIVERY_QUESTION,
  DELIVERY_RULE_NOTE,
  EXAMPLE_SMALL_ORDER_CENTS,
  LOWERED_LIMIT_NOTE,
  approvalExample,
  approvalFromForm,
  approvalSummary,
  approvalToForm,
  deliveryExample,
  deliveryFromForm,
  deliverySummary,
  deliveryToForm,
  presetPreview,
  presetsFromForm,
  presetsSummary,
  presetsToForm,
  type DeliveryChargeForm,
  type PresetsForm,
} from './shop-rules/discountRules';

const inputClass =
  'w-full rounded-lg border border-stone-300 px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800 disabled:opacity-60';
const labelClass = 'mb-1 block text-xs uppercase tracking-wider text-stone-500';

export function MoneySettings() {
  useShopSettingsLive();
  const approvalS = useShopSetting('discounts.approval');
  const presetsS = useShopSetting('discounts.presets');

  if (approvalS.q.isError || presetsS.q.isError) {
    return <p className="py-6 text-center text-stone-500">Could not load Money &amp; discounts.</p>;
  }
  if (!approvalS.q.data || !presetsS.q.data) {
    return <p className="py-6 text-center text-stone-500">Loading…</p>;
  }
  return <MoneyCards approval={approvalS} presets={presetsS} />;
}

function MoneyCards({
  approval,
  presets,
}: {
  approval: ReturnType<typeof useShopSetting<'discounts.approval'>>;
  presets: ReturnType<typeof useShopSetting<'discounts.presets'>>;
}) {
  const approvalCard = approval.q.data as ShopSettingCard<'discounts.approval'>;
  const presetsCard = presets.q.data as ShopSettingCard<'discounts.presets'>;

  const approvalD = useDraft(approvalCard.value, approvalToForm);
  const presetsD = useDraft(presetsCard.value, presetsToForm);
  const approvalParsed = useMemo(() => approvalFromForm(approvalD.form), [approvalD.form]);
  const presetsParsed = useMemo(() => presetsFromForm(presetsD.form), [presetsD.form]);
  // The example follows what is typed as soon as it reads; the saved value until then.
  const limits = approvalParsed.value ?? approvalCard.value;
  const buttons = presetsParsed.value ?? presetsCard.value;
  const preview = presetPreview(buttons, limits);

  const approvalDirty = approvalD.touched && (approvalParsed.value === null || !sameValue(approvalParsed.value, approvalCard.value));
  const presetsDirty = presetsD.touched && (presetsParsed.value === null || !sameValue(presetsParsed.value, presetsCard.value));
  const setBox = (list: keyof PresetsForm, i: number, text: string) => {
    const next = [...presetsD.form[list]];
    next[i] = text;
    presetsD.set({ ...presetsD.form, [list]: next });
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-stone-600 dark:text-stone-400">
        How much a cashier can take off an order alone, the one-tap buttons on the Discount screen (F3), and whether a discount
        also comes off the delivery charge. Both tills use them as soon as they are linked. Only a manager’s or the owner’s PIN
        or password approves a bigger discount, as before. The foodpanda deal keeps its own rules under foodpanda.
      </p>

      <SettingCard
        card={approvalCard}
        title="When a cashier needs a manager"
        icon={<ShieldCheck className="h-5 w-5" />}
        intro="A discount above this needs a manager’s PIN or password. The Discount screen shows a lock on it, and the till checks it again when the discount is saved."
        describe={approvalSummary}
        dirty={approvalDirty}
        problem={approvalParsed.problem}
        busy={approval.save.isPending || approval.putBack.isPending}
        onSave={() => approvalParsed.value && approval.save.mutate(approvalParsed.value, { onSuccess: approvalD.reset })}
        onPutBack={() => approval.putBack.mutate(undefined, { onSuccess: approvalD.reset })}
        footer={
          <div className="mt-4 space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100" aria-live="polite">
            <p>
              <span className="font-semibold">For example: </span>
              {approvalExample(limits)}
            </p>
            <p className="text-xs">{LOWERED_LIMIT_NOTE}</p>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="ap-percent">
              Up to this % off without a manager
            </label>
            <input
              id="ap-percent"
              inputMode="numeric"
              value={approvalD.form.percent}
              onChange={(e) => approvalD.set({ ...approvalD.form, percent: e.target.value.replace(/[^\d]/g, '').slice(0, 3) })}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-stone-500">
              A whole %, 0 to {APPROVAL_MAX_PERCENT}. 0 = every discount needs a manager.
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="ap-rupees">
              Up to this much off in rupees without a manager (Rs)
            </label>
            <input
              id="ap-rupees"
              inputMode="numeric"
              value={approvalD.form.rupees}
              onChange={(e) => approvalD.set({ ...approvalD.form, rupees: e.target.value.replace(/[^\d,]/g, '').slice(0, 7) })}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-stone-500">
              Whole rupees, Rs 0 to {formatCents(APPROVAL_MAX_FLAT_CENTS, { showSymbol: false })}. A rupee amount is also held to the
              % above: see the example below.
            </p>
          </div>
        </div>
      </SettingCard>

      <SettingCard
        card={presetsCard}
        title="Discount buttons"
        icon={<MousePointerClick className="h-5 w-5" />}
        intro="The one-tap buttons on the Discount screen. A button above the limit shows a lock. Any other amount or reason can still be typed."
        describe={presetsSummary}
        dirty={presetsDirty}
        problem={presetsParsed.problem}
        busy={presets.save.isPending || presets.putBack.isPending}
        onSave={() => presetsParsed.value && presets.save.mutate(presetsParsed.value, { onSuccess: presetsD.reset })}
        onPutBack={() => presets.putBack.mutate(undefined, { onSuccess: presetsD.reset })}
        footer={
          <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100" aria-live="polite">
            <p className="mb-2">
              <span className="font-semibold">On a {formatCents(EXAMPLE_SMALL_ORDER_CENTS)} order </span>
              the buttons would show:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {[...preview.percent, ...preview.flat].map((b) => (
                <span
                  key={b.label}
                  className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-white px-2 py-1 text-xs font-semibold text-stone-800 dark:border-amber-800 dark:bg-stone-900 dark:text-stone-100"
                  title={b.locked ? 'Needs a manager’s PIN or password' : 'A cashier can give it'}
                >
                  {b.label}
                  <span className="font-normal text-stone-500">−{formatCents(b.offCents, { showSymbol: false })}</span>
                  {b.locked && <Lock className="h-3 w-3 text-amber-700" aria-label="needs a manager" />}
                </span>
              ))}
            </div>
            <p className="mt-2 text-xs">Reasons: {buttons.reasons.join(' · ')}. The reason prints on the bill and groups discounts in Reports → Team &amp; leakage.</p>
          </div>
        }
      >
        <div>
          <span className={labelClass}>% buttons (up to {presetsD.form.percents.length})</span>
          <div className="grid grid-cols-5 gap-2">
            {presetsD.form.percents.map((t, i) => (
              <input
                key={`p${i}`}
                aria-label={`% button ${i + 1}`}
                inputMode="numeric"
                placeholder="—"
                value={t}
                onChange={(e) => setBox('percents', i, e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
                className={cn(inputClass, 'text-center')}
              />
            ))}
          </div>
          <p className="mt-1 text-xs text-stone-500">Whole % from 1 to 100. Leave a box empty to drop that button.</p>
        </div>
        <div>
          <span className={labelClass}>Rupee buttons (up to {presetsD.form.rupees.length})</span>
          <div className="grid grid-cols-3 gap-2 md:w-3/5">
            {presetsD.form.rupees.map((t, i) => (
              <input
                key={`f${i}`}
                aria-label={`Rupee button ${i + 1}`}
                inputMode="numeric"
                placeholder="—"
                value={t}
                onChange={(e) => setBox('rupees', i, e.target.value.replace(/[^\d,]/g, '').slice(0, 6))}
                className={cn(inputClass, 'text-center')}
              />
            ))}
          </div>
          <p className="mt-1 text-xs text-stone-500">Whole rupees, Rs 1 to {formatCents(PRESET_FLAT_MAX_CENTS)}.</p>
        </div>
        <div>
          <span className={labelClass}>Reason buttons (up to {presetsD.form.reasons.length})</span>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {presetsD.form.reasons.map((t, i) => (
              <input
                key={`r${i}`}
                aria-label={`Reason button ${i + 1}`}
                placeholder="—"
                maxLength={PRESET_REASON_MAX_LENGTH + 10}
                value={t}
                onChange={(e) => setBox('reasons', i, e.target.value)}
                className={inputClass}
              />
            ))}
          </div>
          <p className="mt-1 text-xs text-stone-500">Up to {PRESET_REASON_MAX_LENGTH} letters each; it prints on the bill.</p>
        </div>
      </SettingCard>

      <DeliveryChargeCard />
    </div>
  );
}

/**
 * "A discount also comes off the delivery charge" ('discounts.delivery'),
 * loaded on its own so the two cards above never wait for it.
 */
function DeliveryChargeCard() {
  const s = useShopSetting('discounts.delivery');
  if (s.q.isError) return <p className="py-6 text-center text-stone-500">Could not load “Discounts and the delivery charge”.</p>;
  if (!s.q.data) return <p className="py-6 text-center text-stone-500">Loading…</p>;
  return <DeliveryChargeFields s={s} />;
}

function DeliveryChargeFields({ s }: { s: ReturnType<typeof useShopSetting<'discounts.delivery'>> }) {
  const card = s.q.data as ShopSettingCard<'discounts.delivery'>;
  const draft = useDraft(card.value, deliveryToForm);
  const parsed = useMemo(() => deliveryFromForm(draft.form), [draft.form]);
  // The example follows the choice as soon as it is made; the saved value until then.
  const shown = parsed.value ?? card.value;
  const dirty = draft.touched && (parsed.value === null || !sameValue(parsed.value, card.value));
  const options: Array<{ id: DeliveryChargeForm; label: string; hint: string }> = [
    { id: 'no', label: 'No', hint: 'A discount is on the food only. The delivery charge is always paid in full.' },
    { id: 'yes', label: 'Yes', hint: 'A discount comes off the whole bill, the delivery charge too.' },
  ];
  return (
    <SettingCard
      card={card}
      title="Discounts and the delivery charge"
      icon={<Bike className="h-5 w-5" />}
      intro="The delivery charge is separate from the food. With No, a % off is worked on the food only, rupees off are at most the food, and even 100% off leaves the delivery charge to pay."
      describe={deliverySummary}
      dirty={dirty}
      problem={parsed.problem}
      busy={s.save.isPending || s.putBack.isPending}
      onSave={() => parsed.value && s.save.mutate(parsed.value, { onSuccess: draft.reset })}
      onPutBack={() => s.putBack.mutate(undefined, { onSuccess: draft.reset })}
      neverChangedText={DELIVERY_NEVER_CHANGED}
      footer={
        <div className="mt-4 space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100" aria-live="polite">
          <p>
            <span className="font-semibold">For example: </span>
            {deliveryExample(shown)}
          </p>
          <p className="text-xs">{DELIVERY_RULE_NOTE}</p>
        </div>
      }
    >
      <div>
        <span className={labelClass}>{DELIVERY_QUESTION}</span>
        <div role="radiogroup" aria-label={DELIVERY_QUESTION} className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={draft.form === o.id}
              onClick={() => draft.set(o.id)}
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-lg border-2 p-3 text-left transition-colors disabled:opacity-60',
                draft.form === o.id
                  ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                  : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
              )}
            >
              <span className="text-sm font-semibold">{o.label}</span>
              <span className="text-xs text-stone-500">{o.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </SettingCard>
  );
}
