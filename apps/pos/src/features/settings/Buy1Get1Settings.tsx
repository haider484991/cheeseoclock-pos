/**
 * Settings → Money & discounts → "Buy 1 Get 1 deals" ('deals.buy1Get1', v0.7.39; the owner, 7 Oct 2026: "all these
 * settings should be in the settings"): whether the deals are sold, their hours, and whether the website asks for
 * the customer's Instagram or Facebook name. Both tills use it at once (the counter's check reads it on every add),
 * and a Save sends it to the website by itself in the settings block, never with the unpublished menu. The owner
 * alone (the main process refuses anyone else). Loaded on its own, so the cards above never wait for it.
 */
import { useMemo } from 'react';
import { cn } from '@cheeseoclock/ui';
import { Gift } from 'lucide-react';
import { buy1Get1Summary, type ShopSettingCard } from '@cheeseoclock/shared-types';
import { SettingCard } from './shop-rules/SettingCard';
import { useDraft } from './shop-rules/useDraft';
import { useShopSetting } from './shop-rules/useShopSetting';
import { sameValue } from './shop-rules/foodpandaForm';
import {
  BUY_1_GET_1_MENU_NOTE,
  BUY_1_GET_1_NEVER_CHANGED,
  buy1Get1Example,
  buy1Get1FromForm,
  buy1Get1ToForm,
  hourOptions,
  hoursNote,
} from './shop-rules/buy1Get1Form';

const selectClass =
  'w-full rounded-lg border border-stone-300 px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800 disabled:opacity-60';
const labelClass = 'mb-1 block text-xs uppercase tracking-wider text-stone-500';

export function Buy1Get1Card() {
  const s = useShopSetting('deals.buy1Get1');
  if (s.q.isError) return <p className="py-6 text-center text-stone-500">Could not load “Buy 1 Get 1 deals”.</p>;
  if (!s.q.data) return <p className="py-6 text-center text-stone-500">Loading…</p>;
  return <Buy1Get1Fields s={s} />;
}

function Buy1Get1Fields({ s }: { s: ReturnType<typeof useShopSetting<'deals.buy1Get1'>> }) {
  const card = s.q.data as ShopSettingCard<'deals.buy1Get1'>;
  const draft = useDraft(card.value, buy1Get1ToForm);
  const parsed = useMemo(() => buy1Get1FromForm(draft.form), [draft.form]);
  const dirty = draft.touched && (parsed.value === null || !sameValue(parsed.value, card.value));
  const f = draft.form;
  const options = [
    { on: true, label: 'On', hint: 'Sold on the till and the website, in the hours below.' },
    { on: false, label: 'Off', hint: 'Not sold anywhere: greyed on the till, hidden on the website.' },
  ];
  return (
    <SettingCard
      card={card}
      title="Buy 1 Get 1 deals"
      icon={<Gift className="h-5 w-5" />}
      intro="A regular pizza with a free burger, side or Medium pizza: the customer posts the meal, tags the shop and shows the post. The till greys the deals outside these hours and the website shows them closed."
      describe={buy1Get1Summary}
      dirty={dirty}
      problem={parsed.problem}
      busy={s.save.isPending || s.putBack.isPending}
      onSave={() => parsed.value && s.save.mutate(parsed.value, { onSuccess: draft.reset })}
      onPutBack={() => s.putBack.mutate(undefined, { onSuccess: draft.reset })}
      neverChangedText={BUY_1_GET_1_NEVER_CHANGED}
      footer={
        <div className="mt-4 space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100" aria-live="polite">
          <p>
            <span className="font-semibold">What happens: </span>
            {buy1Get1Example(f)}
          </p>
          <p className="text-xs">{BUY_1_GET_1_MENU_NOTE}</p>
        </div>
      }
    >
      <div role="radiogroup" aria-label="Sell the Buy 1 Get 1 deals" className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {options.map((o) => (
          <button
            key={String(o.on)}
            type="button"
            role="radio"
            aria-checked={f.on === o.on}
            onClick={() => draft.set({ ...f, on: o.on })}
            className={cn(
              'flex flex-col items-start gap-0.5 rounded-lg border-2 p-3 text-left transition-colors disabled:opacity-60',
              f.on === o.on ? 'border-amber-500 bg-amber-50 dark:bg-amber-950' : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
            )}
          >
            <span className="text-sm font-semibold">{o.label}</span>
            <span className="text-xs text-stone-500">{o.hint}</span>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="b1g1-from">
            From
          </label>
          <select
            id="b1g1-from"
            value={f.opensMinute}
            disabled={!f.on}
            onChange={(e) => draft.set({ ...f, opensMinute: Number(e.target.value) })}
            className={selectClass}
          >
            {hourOptions('from', f.opensMinute).map((o) => (
              <option key={o.minute} value={o.minute}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="b1g1-to">
            Until
          </label>
          <select
            id="b1g1-to"
            value={f.closesMinute}
            disabled={!f.on}
            onChange={(e) => draft.set({ ...f, closesMinute: Number(e.target.value) })}
            className={selectClass}
          >
            {hourOptions('to', f.closesMinute).map((o) => (
              <option key={o.minute} value={o.minute}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <p className="-mt-2 text-xs text-stone-500 md:col-span-2">{hoursNote(f)}</p>
      </div>
      <label
        className={cn(
          'flex cursor-pointer items-start gap-2 rounded-lg border-2 border-stone-200 p-3 text-sm dark:border-stone-700',
          !f.on && 'opacity-60',
        )}
      >
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-amber-500"
          checked={f.asksSocial}
          disabled={!f.on}
          onChange={(e) => draft.set({ ...f, asksSocial: e.target.checked })}
        />
        <span>
          <span className="font-semibold">The website asks for the customer’s Instagram or Facebook name</span>
          <span className="block text-xs text-stone-500">
            Needed to order a deal online. It is the first line of the order’s notes, so the cashier knows whose post to check. At the
            counter the cashier just looks at the post.
          </span>
        </span>
      </label>
    </SettingCard>
  );
}
