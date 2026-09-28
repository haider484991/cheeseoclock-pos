/**
 * Settings → Staff & kitchen → Reason buttons ('orders.reasons', synced to
 * both tills): the buttons on the Cancel and Refund boxes — each with what
 * it says about "Was the food made?" — and, if the owner wants them, on the
 * drawer's Cash out. A tapped button fills the reason box with its words,
 * and those words are what is saved, exactly as if typed: any other reason
 * can still be typed, every cancel and refund still needs a reason and a
 * manager's PIN, and Team & leakage keeps listing every row by its own
 * words. The owner alone (the main process refuses anyone else); the
 * default is the buttons the boxes had.
 */
import { useMemo, useState } from 'react';
import { ArrowUp, ListChecks, Plus, Trash2 } from 'lucide-react';
import { Button } from '@cheeseoclock/ui';
import {
  CASH_OUT_REASONS_MAX,
  ORDER_REASON_LABEL_MAX,
  ORDER_REASONS_MAX,
  type OrderReasonButton,
  type OrderReasons,
  type ReasonFoodAnswer,
  type ShopSettingCard,
} from '@cheeseoclock/shared-types';
import { SettingCard } from './shop-rules/SettingCard';
import { useDraft } from './shop-rules/useDraft';
import { useShopSetting } from './shop-rules/useShopSetting';
import { sameValue } from './shop-rules/foodpandaForm';
import {
  FOOD_ANSWER_WORDS,
  addReason,
  moveReasonUp,
  reasonsExample,
  reasonsFromForm,
  reasonsSummary,
  reasonsToForm,
  reasonsWarnings,
  type ReasonList,
  type ReasonsForm,
} from './shop-rules/reasonsForm';

const inputClass =
  'min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800 disabled:opacity-60';

export function ReasonButtonsCard() {
  const s = useShopSetting('orders.reasons');
  if (s.q.isError) return <p className="py-6 text-center text-stone-500">Could not load the reason buttons.</p>;
  if (!s.q.data) return <p className="py-6 text-center text-stone-500">Loading…</p>;
  return <ReasonsCardForm s={s} card={s.q.data} />;
}

function ReasonsCardForm({
  s,
  card,
}: {
  s: ReturnType<typeof useShopSetting<'orders.reasons'>>;
  card: ShopSettingCard<'orders.reasons'>;
}) {
  const d = useDraft<OrderReasons, ReasonsForm>(card.value, reasonsToForm);
  const parsed = useMemo(() => reasonsFromForm(d.form), [d.form]);
  const warnings = useMemo(() => reasonsWarnings(d.form), [d.form]);
  const dirty = d.touched && (parsed.value === null || !sameValue(parsed.value, card.value));
  const setList = (which: ReasonList, list: OrderReasonButton[]) => d.set({ ...d.form, [which]: list });

  return (
    <SettingCard
      card={card}
      title="Reason buttons"
      icon={<ListChecks className="h-5 w-5" />}
      intro="The one-tap reasons on the Cancel and Refund boxes, and on the drawer’s Cash out. A button fills in the reason; staff can still type any other."
      describe={reasonsSummary}
      dirty={dirty}
      problem={parsed.problem}
      busy={s.save.isPending || s.putBack.isPending}
      onSave={() => parsed.value && s.save.mutate(parsed.value, { onSuccess: d.reset })}
      onPutBack={() => s.putBack.mutate(undefined, { onSuccess: d.reset })}
      footer={
        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100" aria-live="polite">
          <span className="font-semibold">For example: </span>
          {reasonsExample(parsed.value ?? card.value)}
        </p>
      }
    >
      <ButtonList title="Cancel an order" which="cancel" list={d.form.cancel} onChange={(l) => setList('cancel', l)} />
      <ButtonList title="Refund" which="refund" list={d.form.refund} onChange={(l) => setList('refund', l)} />
      {warnings.map((w) => (
        <p key={w} className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {w}
        </p>
      ))}
      <CashOutList list={d.form.cashOut} onChange={(cashOut) => d.set({ ...d.form, cashOut })} />
    </SettingCard>
  );
}

function ButtonList({
  title,
  which,
  list,
  onChange,
}: {
  title: string;
  which: ReasonList;
  list: OrderReasonButton[];
  onChange: (list: OrderReasonButton[]) => void;
}) {
  const [adding, setAdding] = useState('');
  const full = list.length >= ORDER_REASONS_MAX;
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-500">
        {title} <span className="font-normal normal-case tracking-normal">(1 to {ORDER_REASONS_MAX} buttons)</span>
      </div>
      <ul className="space-y-1.5">
        {list.map((b, i) => (
          <li key={b.id} className="flex flex-wrap items-center gap-2">
            <input
              aria-label={`${title}: button ${i + 1}`}
              value={b.label}
              maxLength={ORDER_REASON_LABEL_MAX + 5}
              onChange={(e) => onChange(list.map((x) => (x.id === b.id ? { ...x, label: e.target.value } : x)))}
              className={inputClass}
            />
            <select
              aria-label={`${title}: what “${b.label}” says about the food`}
              value={b.food}
              onChange={(e) => onChange(list.map((x) => (x.id === b.id ? { ...x, food: e.target.value as ReasonFoodAnswer } : x)))}
              className="rounded-lg border border-stone-300 px-2 py-1.5 text-xs dark:border-stone-700 dark:bg-stone-800"
            >
              {(Object.keys(FOOD_ANSWER_WORDS) as ReasonFoodAnswer[]).map((f) => (
                <option key={f} value={f}>
                  {FOOD_ANSWER_WORDS[f]}
                </option>
              ))}
            </select>
            <button
              type="button"
              title="Move up"
              aria-label={`Move “${b.label}” up`}
              disabled={i === 0}
              onClick={() => onChange(moveReasonUp(list, b.id))}
              className="rounded p-1.5 text-stone-500 hover:bg-stone-100 disabled:opacity-30 dark:hover:bg-stone-800"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="Take off"
              aria-label={`Take “${b.label}” off`}
              disabled={list.length <= 1}
              onClick={() => onChange(list.filter((x) => x.id !== b.id))}
              className="rounded p-1.5 text-stone-500 hover:bg-stone-100 disabled:opacity-30 dark:hover:bg-stone-800"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
      {!full && (
        <div className="mt-1.5 flex items-center gap-2">
          <input
            aria-label={`${title}: a new button`}
            value={adding}
            maxLength={ORDER_REASON_LABEL_MAX + 5}
            onChange={(e) => setAdding(e.target.value)}
            placeholder={which === 'cancel' ? 'Rider could not find the house' : 'Missing item'}
            className={inputClass}
          />
          <Button
            variant="secondary"
            disabled={adding.trim() === ''}
            onClick={() => {
              onChange(addReason(list, adding));
              setAdding('');
            }}
          >
            <Plus className="mr-1 h-4 w-4" /> Add
          </Button>
        </div>
      )}
    </div>
  );
}

function CashOutList({ list, onChange }: { list: string[]; onChange: (list: string[]) => void }) {
  const [adding, setAdding] = useState('');
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-500">
        Drawer cash out{' '}
        <span className="font-normal normal-case tracking-normal">(0 to {CASH_OUT_REASONS_MAX} buttons; none = staff type it)</span>
      </div>
      <ul className="space-y-1.5">
        {list.map((label, i) => (
          <li key={i} className="flex items-center gap-2">
            <input
              aria-label={`Cash out: button ${i + 1}`}
              value={label}
              maxLength={ORDER_REASON_LABEL_MAX + 5}
              onChange={(e) => onChange(list.map((x, j) => (j === i ? e.target.value : x)))}
              className={inputClass}
            />
            <button
              type="button"
              title="Take off"
              aria-label={`Take “${label}” off`}
              onClick={() => onChange(list.filter((_, j) => j !== i))}
              className="rounded p-1.5 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
      {list.length < CASH_OUT_REASONS_MAX && (
        <div className="mt-1.5 flex items-center gap-2">
          <input
            aria-label="Cash out: a new button"
            value={adding}
            maxLength={ORDER_REASON_LABEL_MAX + 5}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="Gas cylinder"
            className={inputClass}
          />
          <Button
            variant="secondary"
            disabled={adding.trim() === ''}
            onClick={() => {
              onChange([...list, adding.trim()]);
              setAdding('');
            }}
          >
            <Plus className="mr-1 h-4 w-4" /> Add
          </Button>
        </div>
      )}
    </div>
  );
}
