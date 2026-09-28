/**
 * Settings → Money & discounts → "Automatic offers" ('discounts.offers';
 * the owner, 28 Sep 2026: "the offer discount should have settings … so it
 * automatically applies on the whole order except delivery fee").
 *
 * Up to ten offers, each with its name (printed on the bill), on / off, how
 * the order came in (Walk-in / Phone / WhatsApp, or any way), takeaway and /
 * or delivery (a new offer is delivery only), a % or rupees off the food, a
 * minimum and a most-off, its days, hours and dates, and "once a customer a
 * day"; and whether the cashier is asked how every order came in. The till
 * puts the biggest offer that fits on a counter order by itself
 * (pos-domain matchOffer in the main process); every rule is checked again
 * there when the card is saved. Any offer is switched off from its row at
 * once. The owner alone (the main process refuses anyone else). No offers
 * and not asked by default: nothing changes until the owner adds one.
 */
import { useMemo, useState } from 'react';
import { cn } from '@cheeseoclock/ui';
import { Gift, Plus, Trash2 } from 'lucide-react';
import {
  CAME_BY_CHOICES,
  CAME_BY_LABEL,
  OFFER_MAX_PERCENT,
  OFFER_NAME_MAX,
  OFFERS_MAX,
  type ChannelOffer,
  type DiscountOffers,
  type ShopSettingCard,
} from '@cheeseoclock/shared-types';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { SettingCard } from './shop-rules/SettingCard';
import { useDraft } from './shop-rules/useDraft';
import { useShopSetting } from './shop-rules/useShopSetting';
import { sameValue } from './shop-rules/foodpandaForm';
import {
  ALL_DAYS,
  DAY_SHORT,
  OFFER_RULES_NOTE,
  newOfferForm,
  offerExample,
  offerSummary,
  offersFromForm,
  offersSummary,
  offersToForm,
  formWithOfferSwitched,
  withOfferSwitched,
  type OfferForm,
} from './shop-rules/offerRules';

const inputClass =
  'w-full rounded-lg border border-stone-300 px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800 disabled:opacity-60';
const labelClass = 'mb-1 block text-xs uppercase tracking-wider text-stone-500';
const chipClass = (on: boolean) =>
  cn(
    'h-9 rounded-lg border px-3 text-xs font-semibold transition-colors',
    on ? 'border-amber-500 bg-amber-50 text-stone-900 dark:bg-amber-950 dark:text-amber-50' : 'border-stone-200 text-stone-600 dark:border-stone-700 dark:text-stone-300',
  );
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;

/** The card, loaded on its own so the other Money & discounts cards never wait for it. */
export function OffersCard() {
  const s = useShopSetting('discounts.offers');
  if (s.q.isError) return <p className="py-6 text-center text-stone-500">Could not load “Automatic offers”.</p>;
  if (!s.q.data) return <p className="py-6 text-center text-stone-500">Loading…</p>;
  return <OffersFields s={s} />;
}

function OffersFields({ s }: { s: ReturnType<typeof useShopSetting<'discounts.offers'>> }) {
  const card = s.q.data as ShopSettingCard<'discounts.offers'>;
  const draft = useDraft(card.value, offersToForm);
  const parsed = useMemo(() => offersFromForm(draft.form), [draft.form]);
  const dirty = draft.touched && (parsed.value === null || !sameValue(parsed.value, card.value));
  // The example follows "A discount also comes off the delivery charge" (its own card, below).
  const alsoOff = useShopSetting('discounts.delivery').q.data?.value.alsoOffDeliveryCharge ?? false;
  const [open, setOpen] = useState<string | null>(null);
  const saving = s.save.isPending || s.putBack.isPending;

  const setOffer = (id: string, patch: Partial<OfferForm>) =>
    draft.set({ ...draft.form, offers: draft.form.offers.map((o) => (o.id === id ? { ...o, ...patch } : o)) });

  function add() {
    const next = newOfferForm([...draft.form.offers.map((o) => o.id), ...card.value.offers.map((o) => o.id)]);
    draft.set({ ...draft.form, offers: [...draft.form.offers, next] });
    setOpen(next.id);
  }

  async function remove(o: OfferForm) {
    const ok = await askConfirm(
      `Remove “${o.name || 'this offer'}”?\nIt stops for new orders once you Save. Orders already open, and every paid order, keep what they got; Reports still show it by name.`,
    );
    if (ok) draft.set({ ...draft.form, offers: draft.form.offers.filter((x) => x.id !== o.id) });
  }

  /** On / off from the row, saved at once (the saved offers, with only this one switched). */
  function quickSwitch(o: ChannelOffer) {
    s.save.mutate(withOfferSwitched(card.value, o.id), {
      onSuccess: () => {
        // Anything typed and not saved stays, with the switch as saved.
        if (draft.touched) draft.set(formWithOfferSwitched(draft.form, o.id, !o.on));
      },
    });
  }

  const shown: DiscountOffers = parsed.value ?? card.value;
  const example = shown.offers.find((o) => o.id === open) ?? shown.offers[0] ?? null;

  return (
    <SettingCard
      card={card}
      title="Automatic offers"
      icon={<Gift className="h-5 w-5" />}
      intro={
        alsoOff
          ? 'Offers the till puts on a counter order by itself — for example 10% off deliveries that come by WhatsApp. No PIN, no F3. They come off the delivery charge too, as “Discounts and the delivery charge” below says; the minimum is always on the food.'
          : 'Offers the till puts on a counter order by itself — for example 10% off deliveries that come by WhatsApp. No PIN, no F3. Worked on the food: the delivery charge is paid in full.'
      }
      describe={offersSummary}
      dirty={dirty}
      problem={parsed.problem}
      busy={saving}
      onSave={() => parsed.value && s.save.mutate(parsed.value, { onSuccess: draft.reset })}
      onPutBack={() => s.putBack.mutate(undefined, { onSuccess: draft.reset })}
      neverChangedText="Never changed: no automatic offers, and the cashier is not asked how orders came in."
      footer={
        <div className="mt-4 space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100" aria-live="polite">
          {example && (
            <p>
              <span className="font-semibold">For example ({example.name || 'the new offer'}): </span>
              {offerExample(example, alsoOff)}
            </p>
          )}
          {OFFER_RULES_NOTE.map((n) => (
            <p key={n} className="text-xs">
              {n}
            </p>
          ))}
        </div>
      }
    >
      <label className="flex items-start gap-3 rounded-lg border border-stone-200 p-3 dark:border-stone-700">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={draft.form.askCameBy}
          onChange={(e) => draft.set({ ...draft.form, askCameBy: e.target.checked })}
        />
        <span>
          <span className="block text-sm font-semibold">Ask how every order came in</span>
          <span className="block text-xs text-stone-500">
            Walk-in · Phone · WhatsApp on every counter takeaway and delivery; Send and Pay wait for a tap. Reports then split your
            orders by how they came in. Off: the buttons show only when an offer needs them.
          </span>
        </span>
      </label>

      <div className="space-y-2">
        <span className={labelClass}>
          Offers ({draft.form.offers.length} of {OFFERS_MAX})
        </span>
        {draft.form.offers.length === 0 && <p className="text-sm text-stone-500">No offers yet: orders are billed as always.</p>}
        {draft.form.offers.map((f, i) => {
          const saved = card.value.offers.find((o) => o.id === f.id) ?? null;
          const one = parsed.value?.offers.find((o) => o.id === f.id) ?? saved;
          const isOpen = open === f.id;
          return (
            <div key={f.id} className="rounded-lg border border-stone-200 dark:border-stone-700">
              <div className="flex flex-wrap items-center gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{f.name.trim() || `Offer ${i + 1} (new)`}</div>
                  <div className="text-xs text-stone-500">{one ? offerSummary(one) : 'Not finished yet'}</div>
                </div>
                {saved && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={saved.on}
                    aria-label={`${saved.name}: ${saved.on ? 'on — switch it off now' : 'off — switch it on now'}`}
                    title="Saved at once, on both tills"
                    disabled={saving || card.readOnly}
                    onClick={() => quickSwitch(saved)}
                    className={cn(
                      'h-8 rounded-full px-3 text-xs font-bold',
                      saved.on ? 'bg-emerald-600 text-white' : 'bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-200',
                    )}
                  >
                    {saved.on ? 'On' : 'Off'}
                  </button>
                )}
                <button type="button" className="text-xs font-medium underline" onClick={() => setOpen(isOpen ? null : f.id)} aria-expanded={isOpen}>
                  {isOpen ? 'Close' : 'Edit'}
                </button>
                <button type="button" aria-label={`Remove ${f.name || 'this offer'}`} onClick={() => void remove(f)} className="text-stone-400 hover:text-red-600">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {isOpen && <OfferFields f={f} set={(p) => setOffer(f.id, p)} />}
            </div>
          );
        })}
        <button
          type="button"
          onClick={add}
          disabled={draft.form.offers.length >= OFFERS_MAX}
          className="inline-flex items-center gap-1 rounded-lg border border-dashed border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 disabled:opacity-50 dark:border-stone-600 dark:text-stone-200"
        >
          <Plus className="h-4 w-4" /> Add an offer
        </button>
      </div>
    </SettingCard>
  );
}

/** One offer's fields. */
function OfferFields({ f, set }: { f: OfferForm; set: (p: Partial<OfferForm>) => void }) {
  const toggleDay = (d: number) => set({ days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d].sort((a, b) => a - b) });
  const toggleWay = (c: (typeof CAME_BY_CHOICES)[number]) =>
    set({ anyWay: false, cameBy: f.cameBy.includes(c) ? f.cameBy.filter((x) => x !== c) : [...f.cameBy, c] });
  const id = (what: string) => `${f.id}-${what}`;
  return (
    <div className="space-y-4 border-t border-stone-200 p-3 dark:border-stone-700">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor={id('name')}>
            Name (prints on the bill)
          </label>
          <input id={id('name')} value={f.name} maxLength={OFFER_NAME_MAX + 5} placeholder="e.g. WhatsApp 10% off" onChange={(e) => set({ name: e.target.value })} className={inputClass} />
          <p className="mt-1 text-xs text-stone-500">Up to {OFFER_NAME_MAX} letters; no two offers the same.</p>
        </div>
        <div>
          <span className={labelClass}>How much off the food</span>
          <div className="flex gap-2">
            <input
              aria-label={f.type === 'percent' ? 'Percent off' : 'Rupees off'}
              inputMode="numeric"
              value={f.amount}
              onChange={(e) => set({ amount: e.target.value.replace(/[^\d,]/g, '').slice(0, 6) })}
              className={cn(inputClass, 'w-28')}
            />
            <div className="flex rounded-lg bg-stone-100 p-0.5 dark:bg-stone-800" role="group" aria-label="Off in">
              {(['percent', 'flat'] as const).map((t) => (
                <button key={t} type="button" aria-pressed={f.type === t} onClick={() => set({ type: t })} className={chipClass(f.type === t)}>
                  {t === 'percent' ? '%' : 'Rs'}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-1 text-xs text-stone-500">A whole % from 1 to {OFFER_MAX_PERCENT}, or whole rupees up to Rs 5,000.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <span className={labelClass}>Order type</span>
          <div className="flex flex-wrap gap-2">
            <button type="button" aria-pressed={f.delivery} onClick={() => set({ delivery: !f.delivery })} className={chipClass(f.delivery)}>
              Delivery
            </button>
            <button type="button" aria-pressed={f.takeaway} onClick={() => set({ takeaway: !f.takeaway })} className={chipClass(f.takeaway)}>
              Takeaway
            </button>
          </div>
          <p className="mt-1 text-xs text-stone-500">A new offer is delivery only: the rider, not the cashier, takes the cash. Add takeaway on purpose.</p>
        </div>
        <div>
          <span className={labelClass}>How the order came in</span>
          <div className="flex flex-wrap gap-2">
            <button type="button" aria-pressed={f.anyWay} onClick={() => set({ anyWay: true, cameBy: [] })} className={chipClass(f.anyWay)}>
              Any way
            </button>
            {CAME_BY_CHOICES.map((c) => (
              <button key={c} type="button" aria-pressed={!f.anyWay && f.cameBy.includes(c)} onClick={() => toggleWay(c)} className={chipClass(!f.anyWay && f.cameBy.includes(c))}>
                {CAME_BY_LABEL[c]}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-stone-500">Phone and WhatsApp need the customer’s phone on the order.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor={id('min')}>
            Only from this much food (Rs)
          </label>
          <input id={id('min')} inputMode="numeric" placeholder="Any order" value={f.minOrder} onChange={(e) => set({ minOrder: e.target.value.replace(/[^\d,]/g, '').slice(0, 7) })} className={inputClass} />
          <p className="mt-1 text-xs text-stone-500">Measured on the food, never the delivery charge.</p>
        </div>
        <div>
          <label className={labelClass} htmlFor={id('max')}>
            At most this much off one order (Rs)
          </label>
          <input id={id('max')} inputMode="numeric" placeholder="No limit" value={f.maxOff} onChange={(e) => set({ maxOff: e.target.value.replace(/[^\d,]/g, '').slice(0, 7) })} className={inputClass} />
        </div>
      </div>

      <div>
        <span className={labelClass}>Days (the trading day: an order at 1:30 am on Saturday is Friday’s)</span>
        <div className="flex flex-wrap gap-1.5">
          {ALL_DAYS.map((d) => (
            <button key={d} type="button" aria-pressed={f.days.includes(d)} onClick={() => toggleDay(d)} className={chipClass(f.days.includes(d))}>
              {DAY_SHORT[d]}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <span className={labelClass}>Hours (when the order was started)</span>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.allDay} onChange={(e) => set({ allDay: e.target.checked })} /> All day
          </label>
        </div>
        {!f.allDay && (
          <>
            <div>
              <label className={labelClass} htmlFor={id('from')}>
                From
              </label>
              <select id={id('from')} value={f.fromHour} onChange={(e) => set({ fromHour: e.target.value })} className={inputClass}>
                {HOURS.map((h) => (
                  <option key={h} value={String(h)}>
                    {hh(h)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor={id('until')}>
                Until
              </label>
              <select id={id('until')} value={f.untilHour} onChange={(e) => set({ untilHour: e.target.value })} className={inputClass}>
                {HOURS.map((h) => (
                  <option key={h + 1} value={String(h + 1)}>
                    {hh(h + 1)}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor={id('start')}>
            Runs from (optional)
          </label>
          <input id={id('start')} type="date" value={f.startsOn} onChange={(e) => set({ startsOn: e.target.value })} className={inputClass} />
        </div>
        <div>
          <label className={labelClass} htmlFor={id('end')}>
            Until (optional)
          </label>
          <input id={id('end')} type="date" value={f.endsOn} onChange={(e) => set({ endsOn: e.target.value })} className={inputClass} />
        </div>
      </div>

      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1" checked={f.oncePerCustomerPerDay} onChange={(e) => set({ oncePerCustomerPerDay: e.target.checked })} />
        <span>
          Once a customer a day
          <span className="block text-xs text-stone-500">Checked by the customer’s phone, so the order needs it. With the link to the other till down it can repeat there once; Reports show it.</span>
        </span>
      </label>
    </div>
  );
}

