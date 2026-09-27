/**
 * Settings → Staff & kitchen timing (owner, 2026-09-27: "everything should
 * be editable for admin").
 *
 * Only timings, two cards, each its own synced setting:
 *  - staff ('staff.timing'): when an idle owner or manager is signed out,
 *    the longest login, a manager's step-in, and the cashier's free reprints
 *    — read by auth-service, the step-in hold and reprint-policy on both
 *    tills. Cashiers are still never signed out for being idle; the
 *    DUPLICATE marks and the print log never change;
 *  - kitchen ('kitchen.timing'): the Live Orders colours and the "waiting
 *    too long" reminders.
 * Who can do what stays in the role table: no permission switches here. The
 * owner alone (the main process refuses anyone else); the defaults are
 * exactly what the till did before.
 */
import { useMemo } from 'react';
import { ChefHat, UserRoundCog } from 'lucide-react';
import {
  KITCHEN_TIMING_BOUNDS,
  STAFF_TIMING_BOUNDS,
  type KitchenTiming,
  type ShopSettingCard,
  type StaffTiming,
} from '@cheeseoclock/shared-types';
import { SettingCard } from './shop-rules/SettingCard';
import { useDraft } from './shop-rules/useDraft';
import { useShopSetting, useShopSettingsLive } from './shop-rules/useShopSetting';
import { sameValue } from './shop-rules/foodpandaForm';
import {
  KITCHEN_FIELDS,
  STAFF_FIELDS,
  kitchenFromForm,
  kitchenToForm,
  staffFromForm,
  staffToForm,
  type KitchenTimingForm,
  type StaffTimingForm,
} from './shop-rules/timingForm';
import { kitchenTimingExample, kitchenTimingSummary, staffTimingExample, staffTimingSummary } from './shop-rules/timingWords';

const inputClass =
  'w-24 rounded-lg border border-stone-300 px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800 disabled:opacity-60';
const labelClass = 'mb-1 block text-xs uppercase tracking-wider text-stone-500';

export function TimingSettings() {
  useShopSettingsLive();
  const staffS = useShopSetting('staff.timing');
  const kitchenS = useShopSetting('kitchen.timing');

  if (staffS.q.isError || kitchenS.q.isError) {
    return <p className="py-6 text-center text-stone-500">Could not load Staff &amp; kitchen timing.</p>;
  }
  if (!staffS.q.data || !kitchenS.q.data) {
    return <p className="py-6 text-center text-stone-500">Loading…</p>;
  }
  return <TimingCards staff={staffS} kitchen={kitchenS} />;
}

function NumberFields<F extends string>({
  fields,
  bounds,
  form,
  onChange,
  idPrefix,
}: {
  fields: ReadonlyArray<{ field: F; label: string; unit: string; help: string }>;
  /** Each field's lowest and highest (the same bounds the main process checks). */
  bounds: Readonly<Record<F, readonly [number, number]>>;
  form: Record<F, string>;
  onChange: (field: F, text: string) => void;
  idPrefix: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {fields.map(({ field, label, unit, help }) => (
        <div key={field}>
          <label className={labelClass} htmlFor={`${idPrefix}-${field}`}>
            {label}
          </label>
          <div className="flex items-center gap-2">
            <input
              id={`${idPrefix}-${field}`}
              inputMode="numeric"
              value={form[field]}
              onChange={(e) => onChange(field, e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
              className={inputClass}
            />
            <span className="text-sm text-stone-600 dark:text-stone-300">
              {unit}{' '}
              <span className="text-xs text-stone-400">
                ({bounds[field][0]} to {bounds[field][1]})
              </span>
            </span>
          </div>
          <p className="mt-1 text-xs text-stone-500">{help}</p>
        </div>
      ))}
    </div>
  );
}

function TimingCards({
  staff,
  kitchen,
}: {
  staff: ReturnType<typeof useShopSetting<'staff.timing'>>;
  kitchen: ReturnType<typeof useShopSetting<'kitchen.timing'>>;
}) {
  const staffCard = staff.q.data as ShopSettingCard<'staff.timing'>;
  const kitchenCard = kitchen.q.data as ShopSettingCard<'kitchen.timing'>;

  const staffD = useDraft<StaffTiming, StaffTimingForm>(staffCard.value, staffToForm);
  const kitchenD = useDraft<KitchenTiming, KitchenTimingForm>(kitchenCard.value, kitchenToForm);
  const staffParsed = useMemo(() => staffFromForm(staffD.form), [staffD.form]);
  const kitchenParsed = useMemo(() => kitchenFromForm(kitchenD.form), [kitchenD.form]);
  const staffDirty = staffD.touched && (staffParsed.value === null || !sameValue(staffParsed.value, staffCard.value));
  const kitchenDirty = kitchenD.touched && (kitchenParsed.value === null || !sameValue(kitchenParsed.value, kitchenCard.value));

  return (
    <div className="space-y-6">
      <p className="text-sm text-stone-600 dark:text-stone-400">
        How long logins last, and when Live Orders warns about an order. Only the timings: who can do what stays as it is. Both
        tills use them as soon as they are linked.
      </p>

      <SettingCard
        card={staffCard}
        title="Staff logins and reprints"
        icon={<UserRoundCog className="h-5 w-5" />}
        intro="When the till signs people out, how long a manager stepping in on a cashier’s till gets, and how many receipts a cashier may print again without a manager. Cashiers are never signed out for being idle, and every reprint still says DUPLICATE and is logged."
        describe={staffTimingSummary}
        dirty={staffDirty}
        problem={staffParsed.problem}
        busy={staff.save.isPending || staff.putBack.isPending}
        onSave={() => staffParsed.value && staff.save.mutate(staffParsed.value, { onSuccess: staffD.reset })}
        onPutBack={() => staff.putBack.mutate(undefined, { onSuccess: staffD.reset })}
        footer={
          <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100" aria-live="polite">
            <span className="font-semibold">For example: </span>
            {staffTimingExample(staffParsed.value ?? staffCard.value)}
          </p>
        }
      >
        <NumberFields
          idPrefix="staff"
          fields={STAFF_FIELDS}
          bounds={STAFF_TIMING_BOUNDS}
          form={staffD.form}
          onChange={(field, text) => staffD.set({ ...staffD.form, [field]: text })}
        />
      </SettingCard>

      <SettingCard
        card={kitchenCard}
        title="Kitchen timing"
        icon={<ChefHat className="h-5 w-5" />}
        intro="When a card on Live Orders turns amber and red, and when a website order that is waiting too long gets a reminder. Settings → Sounds turns the reminder beep on or off."
        describe={kitchenTimingSummary}
        dirty={kitchenDirty}
        problem={kitchenParsed.problem}
        busy={kitchen.save.isPending || kitchen.putBack.isPending}
        onSave={() => kitchenParsed.value && kitchen.save.mutate(kitchenParsed.value, { onSuccess: kitchenD.reset })}
        onPutBack={() => kitchen.putBack.mutate(undefined, { onSuccess: kitchenD.reset })}
        footer={
          <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100" aria-live="polite">
            <span className="font-semibold">For example: </span>
            {kitchenTimingExample(kitchenParsed.value ?? kitchenCard.value)}
          </p>
        }
      >
        <NumberFields
          idPrefix="kitchen"
          fields={KITCHEN_FIELDS}
          bounds={KITCHEN_TIMING_BOUNDS}
          form={kitchenD.form}
          onChange={(field, text) => kitchenD.set({ ...kitchenD.form, [field]: text })}
        />
      </SettingCard>
    </div>
  );
}
