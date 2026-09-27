/**
 * Settings → foodpanda (owner, 2026-09-27: "we just need to add how much
 * discount is added on the foodpanda listing so the system knows what stock
 * cost and all… everything should be editable for the admin").
 *
 * Three cards, each its own synced setting (a Save on one never undoes a
 * Save on another made on the other till): the deal on the listing and who
 * pays for it; foodpanda's fees (Reports and the owner's Costing view only,
 * never printed); what Pay asks. Every new foodpanda order gets the deal
 * automatically; an order already on screen keeps the deal it started with.
 * The owner alone (the main process refuses anyone else).
 */
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@cheeseoclock/ui';
import { BadgePercent, ClipboardCheck, Receipt } from 'lucide-react';
import {
  FOODPANDA_DEAL_MAX_PERCENT,
  type FoodpandaCheckRule,
  type FoodpandaChecks,
  type FoodpandaDeal,
  type FoodpandaFees,
  type ShopSettingCard,
} from '@cheeseoclock/shared-types';
import { SettingCard } from './shop-rules/SettingCard';
import { useShopSetting, useShopSettingsLive } from './shop-rules/useShopSetting';
import { checksSummary, dealSummary, feesSummary, percentFromBps, workedExample, type DealPayer } from './shop-rules/foodpandaWords';
import { dealFromForm, dealToForm, feesFromForm, feesToForm, sameValue, type DealForm, type FeesForm } from './shop-rules/foodpandaForm';

const inputClass =
  'w-full rounded-lg border border-stone-300 px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800 disabled:opacity-60';
const labelClass = 'mb-1 block text-xs uppercase tracking-wider text-stone-500';

function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ id: T; label: string; hint?: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-1 gap-2 md:grid-cols-3">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'flex flex-col items-start gap-0.5 rounded-lg border-2 p-3 text-left transition-colors disabled:opacity-60',
            value === o.id ? 'border-amber-500 bg-amber-50 dark:bg-amber-950' : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
          )}
        >
          <span className="text-sm font-semibold">{o.label}</span>
          {o.hint && <span className="text-xs text-stone-500">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * The form for one card, kept in step with what is saved until the owner
 * starts typing (a Save here, or one from the other till, shows at once);
 * `reset` hands it back to the saved value after a Save.
 */
function useDraft<V, F>(saved: V, toForm: (v: V) => F) {
  const [form, setForm] = useState<F>(() => toForm(saved));
  const [touched, setTouched] = useState(false);
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    if (!touched) setForm(toForm(saved));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey, touched]);
  return {
    form,
    touched,
    set: (f: F) => {
      setTouched(true);
      setForm(f);
    },
    reset: () => setTouched(false),
  };
}

export function FoodpandaSettings() {
  useShopSettingsLive();
  const dealS = useShopSetting('foodpanda.deal');
  const feesS = useShopSetting('foodpanda.fees');
  const checksS = useShopSetting('foodpanda.checks');

  if (dealS.q.isError || feesS.q.isError || checksS.q.isError) {
    return <p className="py-6 text-center text-stone-500">Could not load the foodpanda settings.</p>;
  }
  if (!dealS.q.data || !feesS.q.data || !checksS.q.data) {
    return <p className="py-6 text-center text-stone-500">Loading…</p>;
  }
  return <FoodpandaCards deal={dealS} fees={feesS} checks={checksS} />;
}

function FoodpandaCards({
  deal,
  fees,
  checks,
}: {
  deal: ReturnType<typeof useShopSetting<'foodpanda.deal'>>;
  fees: ReturnType<typeof useShopSetting<'foodpanda.fees'>>;
  checks: ReturnType<typeof useShopSetting<'foodpanda.checks'>>;
}) {
  const dealCard = deal.q.data as ShopSettingCard<'foodpanda.deal'>;
  const feesCard = fees.q.data as ShopSettingCard<'foodpanda.fees'>;
  const checksCard = checks.q.data as ShopSettingCard<'foodpanda.checks'>;

  const dealD = useDraft(dealCard.value, dealToForm);
  const feesD = useDraft(feesCard.value, feesToForm);
  const checksD = useDraft<FoodpandaChecks, FoodpandaChecks>(checksCard.value, (v) => ({ ...v }));
  const dealForm = dealD.form;
  const feesForm = feesD.form;
  const checksForm = checksD.form;

  const dealParsed = useMemo(() => dealFromForm(dealForm), [dealForm]);
  const feesParsed = useMemo(() => feesFromForm(feesForm), [feesForm]);
  const exampleDeal: FoodpandaDeal = dealParsed.value ?? dealCard.value;
  const exampleFees: FoodpandaFees = feesParsed.value ?? feesCard.value;

  const updDeal = (patch: Partial<DealForm>) => dealD.set({ ...dealForm, ...patch });
  const updFees = (patch: Partial<FeesForm>) => feesD.set({ ...feesForm, ...patch });
  const dealDirty = dealD.touched && (dealParsed.value === null || !sameValue(dealParsed.value, dealCard.value));
  const feesDirty = feesD.touched && (feesParsed.value === null || !sameValue(feesParsed.value, feesCard.value));
  const checksDirty = checksD.touched && !sameValue(checksForm, checksCard.value);
  const percentNow = Number(dealForm.percent);

  return (
    <div className="space-y-6">
      <p className="text-sm text-stone-600 dark:text-stone-400">
        foodpanda on its own, apart from the other discounts. Every new foodpanda order gets the deal by itself — no F3, no
        manager’s PIN. An order already on screen keeps the deal it started with, and a paid order never changes. Sales,
        food cost %, profit and the FBR invoice use what the food really sold for; the commission never prints on a bill.
      </p>

      <SettingCard
        card={dealCard}
        title="The deal on your foodpanda listing"
        icon={<BadgePercent className="h-5 w-5" />}
        intro="The % off your foodpanda listing shows, and who pays for it. Only your part comes off the bill."
        describe={dealSummary}
        dirty={dealDirty}
        problem={dealParsed.problem}
        busy={deal.save.isPending || deal.putBack.isPending}
        onSave={() => dealParsed.value && deal.save.mutate(dealParsed.value, { onSuccess: dealD.reset })}
        onPutBack={() => deal.putBack.mutate(undefined, { onSuccess: dealD.reset })}
        footer={
          <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100" aria-live="polite">
            <span className="font-semibold">For example: </span>
            {workedExample(exampleDeal, exampleFees)}
          </p>
        }
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className={labelClass} htmlFor="fp-percent">
              % off on foodpanda
            </label>
            <input
              id="fp-percent"
              inputMode="numeric"
              value={dealForm.percent}
              onChange={(e) => updDeal({ percent: e.target.value.replace(/[^\d]/g, '').slice(0, 3) })}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-stone-500">A whole %, 0 to {FOODPANDA_DEAL_MAX_PERCENT}. 0 = no deal.</p>
          </div>
          <div>
            <label className={labelClass} htmlFor="fp-min">
              Only on orders of at least (Rs)
            </label>
            <input
              id="fp-min"
              inputMode="numeric"
              placeholder="Any order"
              value={dealForm.minOrder}
              onChange={(e) => updDeal({ minOrder: e.target.value.replace(/[^\d,]/g, '') })}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="fp-max">
              Most it takes off one order (Rs)
            </label>
            <input
              id="fp-max"
              inputMode="numeric"
              placeholder="No limit"
              value={dealForm.maxOff}
              onChange={(e) => updDeal({ maxOff: e.target.value.replace(/[^\d,]/g, '') })}
              className={inputClass}
            />
          </div>
        </div>

        {percentNow > 0 && (
          <div>
            <span className={labelClass}>Who pays for the {percentNow}%</span>
            <Choice<DealPayer>
              label="Who pays for the deal"
              value={dealForm.payer}
              onChange={(payer) => {
                // "We share" starts at half, so the box never opens on a value it can't take.
                const part = Number(dealForm.shopPercent);
                const fits = part >= 1 && part < percentNow;
                updDeal(payer === 'shared' && !fits ? { payer, shopPercent: String(Math.max(1, Math.floor(percentNow / 2))) } : { payer });
              }}
              options={[
                { id: 'shop', label: 'I do', hint: `All ${percentNow}% comes off your bill.` },
                { id: 'foodpanda', label: 'foodpanda does', hint: 'Nothing comes off your bill; foodpanda pays it.' },
                { id: 'shared', label: 'We share', hint: 'You pay part of it, foodpanda the rest.' },
              ]}
            />
            {dealForm.payer === 'shared' && (
              <div className="mt-2 flex items-center gap-2 text-sm">
                <label htmlFor="fp-part">I pay</label>
                <input
                  id="fp-part"
                  inputMode="numeric"
                  value={dealForm.shopPercent}
                  onChange={(e) => updDeal({ shopPercent: e.target.value.replace(/[^\d]/g, '').slice(0, 3) })}
                  className={cn(inputClass, 'w-20')}
                />
                <span>% of the {percentNow}%; foodpanda pays the rest.</span>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="fp-from">
              Runs from (optional)
            </label>
            <input id="fp-from" type="date" value={dealForm.startsOn} onChange={(e) => updDeal({ startsOn: e.target.value })} className={inputClass} />
          </div>
          <div>
            <label className={labelClass} htmlFor="fp-until">
              Until (optional)
            </label>
            <input id="fp-until" type="date" value={dealForm.endsOn} onChange={(e) => updDeal({ endsOn: e.target.value })} className={inputClass} />
            <p className="mt-1 text-xs text-stone-500">With an end date the deal stops on the till when foodpanda ends it. Days run 5 am to 5 am.</p>
          </div>
        </div>
      </SettingCard>

      <SettingCard
        card={feesCard}
        title="foodpanda’s fees"
        icon={<Receipt className="h-5 w-5" />}
        intro="What foodpanda keeps from each order. Only in Reports and your Costing view — never on a bill, never in a sale’s total."
        describe={feesSummary}
        dirty={feesDirty}
        problem={feesParsed.problem}
        busy={fees.save.isPending || fees.putBack.isPending}
        onSave={() => feesParsed.value && fees.save.mutate(feesParsed.value, { onSuccess: feesD.reset })}
        onPutBack={() => fees.putBack.mutate(undefined, { onSuccess: feesD.reset })}
      >
        {!feesCard.value.confirmed && (
          <p className="rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-700 dark:bg-stone-800 dark:text-stone-200">
            {percentFromBps(feesCard.value.commissionBps)} is a suggestion until you confirm foodpanda’s real commission: Reports mark it
            “suggested”.
          </p>
        )}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className={labelClass} htmlFor="fp-commission">
              Commission (%)
            </label>
            <input
              id="fp-commission"
              inputMode="decimal"
              value={feesForm.commission}
              onChange={(e) => updFees({ commission: e.target.value.replace(/[^\d.]/g, '').slice(0, 6) })}
              className={inputClass}
            />
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={feesForm.confirmed} onChange={(e) => updFees({ confirmed: e.target.checked })} />
              This is foodpanda’s real commission
            </label>
          </div>
          <div>
            <label className={labelClass} htmlFor="fp-fee">
              Fixed fee per order (Rs)
            </label>
            <input
              id="fp-fee"
              inputMode="numeric"
              value={feesForm.fixedFee}
              onChange={(e) => updFees({ fixedFee: e.target.value.replace(/[^\d,]/g, '') })}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="fp-tax">
              Tax foodpanda adds on its commission (%)
            </label>
            <input
              id="fp-tax"
              inputMode="decimal"
              value={feesForm.commissionTax}
              onChange={(e) => updFees({ commissionTax: e.target.value.replace(/[^\d.]/g, '').slice(0, 6) })}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-stone-500">Ask your accountant if you are not sure; 0 if none.</p>
          </div>
        </div>
        <div>
          <span className={labelClass}>The commission is charged on</span>
          <Choice
            label="The commission is charged on"
            value={feesForm.base}
            onChange={(base) => updFees({ base })}
            options={[
              { id: 'after_deal', label: 'The food after the deal', hint: 'Before tax. The usual way.' },
              { id: 'before_deal', label: 'The food before the deal', hint: 'At full till price, before tax.' },
            ]}
          />
        </div>
      </SettingCard>

      <SettingCard
        card={checksCard}
        title="At Pay on a foodpanda order"
        icon={<ClipboardCheck className="h-5 w-5" />}
        intro={
          <>
            Pay can ask for foodpanda’s order number and the total on the foodpanda tablet. If the till’s total is more than Rs 1
            different, the till says so and Reports lists the order — how you know the till matches foodpanda, and how a walk-in
            cash sale rung up as foodpanda shows up.
          </>
        }
        describe={checksSummary}
        dirty={checksDirty}
        problem={null}
        busy={checks.save.isPending || checks.putBack.isPending}
        onSave={() => checks.save.mutate(checksForm, { onSuccess: checksD.reset })}
        onPutBack={() => checks.putBack.mutate(undefined, { onSuccess: checksD.reset })}
      >
        {(['orderCode', 'tabletTotal'] as const).map((field) => (
          <div key={field}>
            <span className={labelClass}>{field === 'orderCode' ? 'foodpanda’s order number' : 'The total on the foodpanda tablet'}</span>
            <Choice<FoodpandaCheckRule>
              label={field === 'orderCode' ? 'foodpanda’s order number' : 'The total on the tablet'}
              value={checksForm[field]}
              onChange={(rule) => checksD.set({ ...checksForm, [field]: rule })}
              options={[
                { id: 'optional', label: 'Asked, may be left empty' },
                { id: 'required', label: 'Must be typed', hint: 'Pay waits until it is.' },
              ]}
            />
          </div>
        ))}
      </SettingCard>
    </div>
  );
}
