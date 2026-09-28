/**
 * Settings → Staff & kitchen → Opening float ('drawer.openingFloat', this
 * till only: each till has its own drawer). What the Open shift box starts
 * the count on: this till's last count (the default, as before), or a fixed
 * amount. Only a starting figure: the float is still counted and typed, and
 * closing stays a blind count. The owner alone (the main process refuses
 * anyone else).
 */
import { useMemo } from 'react';
import { Wallet } from 'lucide-react';
import { cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { OPENING_FLOAT_MAX_CENTS, type OpeningFloatSetting, type TillSettingCard } from '@cheeseoclock/shared-types';
import { SettingCard } from './shop-rules/SettingCard';
import { useDraft } from './shop-rules/useDraft';
import { useTillSetting } from './shop-rules/useTillSetting';
import { sameValue } from './shop-rules/foodpandaForm';
import {
  openingFloatExample,
  openingFloatFromForm,
  openingFloatSummary,
  openingFloatToForm,
  type OpeningFloatForm,
} from './shop-rules/tillSettingsForm';

export function OpeningFloatCard() {
  const s = useTillSetting('drawer.openingFloat');
  if (s.q.isError) return <p className="py-6 text-center text-stone-500">Could not load the opening float.</p>;
  if (!s.q.data) return <p className="py-6 text-center text-stone-500">Loading…</p>;
  return <FloatForm s={s} card={s.q.data} />;
}

function FloatForm({
  s,
  card,
}: {
  s: ReturnType<typeof useTillSetting<'drawer.openingFloat'>>;
  card: TillSettingCard<'drawer.openingFloat'>;
}) {
  const d = useDraft<OpeningFloatSetting, OpeningFloatForm>(card.value, openingFloatToForm);
  const parsed = useMemo(() => openingFloatFromForm(d.form), [d.form]);
  const dirty = d.touched && (parsed.value === null || !sameValue(parsed.value, card.value));
  const choice = (mode: OpeningFloatSetting['mode'], title: string, help: string) => (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2 rounded-lg border-2 p-3 text-sm',
        d.form.mode === mode ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/40' : 'border-stone-200 dark:border-stone-700',
      )}
    >
      <input
        type="radio"
        name="opening-float-mode"
        className="mt-1"
        checked={d.form.mode === mode}
        onChange={() => d.set({ ...d.form, mode })}
      />
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-stone-500">{help}</span>
      </span>
    </label>
  );

  return (
    <SettingCard
      card={card}
      scope="till"
      title="Opening float"
      icon={<Wallet className="h-5 w-5" />}
      intro="What the Open shift box starts the cash count on. It is only where the box starts: whoever opens still counts the drawer."
      describe={openingFloatSummary}
      dirty={dirty}
      problem={parsed.problem}
      busy={s.save.isPending || s.putBack.isPending}
      onSave={() => parsed.value && s.save.mutate(parsed.value, { onSuccess: d.reset })}
      onPutBack={() => s.putBack.mutate(undefined, { onSuccess: d.reset })}
      footer={
        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100" aria-live="polite">
          <span className="font-semibold">For example: </span>
          {openingFloatExample(parsed.value ?? card.value)}
        </p>
      }
    >
      <div className="grid gap-2 md:grid-cols-2">
        {choice('lastCount', "The last shift's count", 'The cash this till’s last shift closed with (what stayed in the drawer).')}
        {choice('fixed', 'A fixed amount', 'The same float every shift, whatever was left last night.')}
      </div>
      {d.form.mode === 'fixed' && (
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500" htmlFor="opening-float-rupees">
            Fixed float
          </label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-stone-600 dark:text-stone-300">Rs</span>
            <input
              id="opening-float-rupees"
              inputMode="numeric"
              value={d.form.rupees}
              onChange={(e) => d.set({ ...d.form, rupees: e.target.value.replace(/[^\d,]/g, '').slice(0, 9) })}
              className="w-32 rounded-lg border border-stone-300 px-3 py-2 text-right font-mono text-sm dark:border-stone-700 dark:bg-stone-800 disabled:opacity-60"
            />
            <span className="text-xs text-stone-400">(whole rupees, Rs 0 to {formatCents(OPENING_FLOAT_MAX_CENTS).replace(/^Rs /, '')})</span>
          </div>
        </div>
      )}
    </SettingCard>
  );
}
