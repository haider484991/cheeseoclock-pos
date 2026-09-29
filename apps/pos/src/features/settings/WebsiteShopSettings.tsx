import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Clock,
  Globe,
  HeartPulse,
  Home,
  MessageCircle,
  Phone,
  Plus,
  Store,
  Wallet,
  X,
} from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import {
  ALLERGY_NOTICE_MAX,
  ALLERGY_NOTICE_MIN,
  HOME_DEALS_MAX,
  HOME_HEADLINE_MAX,
  HOME_PIZZAS_MAX,
  HOME_TEXT_MAX,
  PRICE_RANGE_MAX,
  SHOP_AREA_LINE_MAX,
  SHOP_DAYS,
  SHOP_NAME_MAX,
  SHOP_STREET_MAX,
  SHOP_TAGLINE_MAX,
  SOCIAL_LINKS_MAX,
  WHATSAPP_GREETING_MAX,
  WHATSAPP_LINES_MAX,
  deliveryZoneFeeItemIds,
  socialLabel,
  type HomeEntry,
  type ShopDay,
  type ShopSettingCard,
  type ShopSettingKey,
  type WebsiteHome,
} from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { SettingCard } from './shop-rules/SettingCard';
import { useDraft } from './shop-rules/useDraft';
import { useCheckoutRules, useShopSetting } from './shop-rules/useShopSetting';
import { deliveryZonesOf } from './shop-rules/counterRules';
import {
  OPENING_TIMES,
  PAYMENT_CHOICES,
  SHOP_CARD_FIELDS,
  WEBSITE_SHOP_WORDS,
  allergyFromForm,
  allergyLacksGuarantee,
  allergySummary,
  cardPart,
  closesLabel,
  closingTimes,
  contactFromForm,
  contactSummary,
  contactToForm,
  googleListingChanges,
  greetingFromForm,
  greetingLink,
  greetingOf,
  greetingSummary,
  greetingToForm,
  homeFromForm,
  homeMissingHere,
  homeMissingWords,
  homePreview,
  homeSummary,
  hoursEffects,
  hoursFromForm,
  hoursSummary,
  hoursToForm,
  menuPriceHint,
  moved,
  paymentsEffect,
  paymentsFromForm,
  paymentsSummary,
  paymentsToForm,
  pickableItems,
  pickedEntry,
  shopDetailsFromForm,
  shopDetailsSummary,
  shopDetailsToForm,
  timeLabel,
  togglePayment,
  withWords,
  type ContactForm,
  type HoursForm,
  type PaymentsForm,
  type PickableItem,
  type ShopDetailsWebForm,
} from './shop-rules/websiteShopForm';

/**
 * Settings → Shop & logo → "Website: shop details (both tills)" (sweep B2 +
 * B4): the shop's name, numbers and address, its opening hours, what the
 * rider and the counter take, the WhatsApp numbers and greeting, social
 * links, the allergy notice and the home page's featured items — each a
 * synced, owner-only setting with History and "Put back the default"
 * (SettingCard), read-only when a newer version of the app saved it. The
 * website gets them in the shop block a few seconds after a Save. Nothing
 * here changes receipts (Receipt: shop details, above) or the till's Pay
 * buttons.
 */
export function WebsiteShopSettings() {
  return (
    <section aria-labelledby="website-shop-heading" className="space-y-6">
      <header className="border-t border-stone-200 pt-6 dark:border-stone-700">
        <h2 id="website-shop-heading" className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <Globe className="h-5 w-5" /> Website: shop details (both tills)
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-stone-500">{WEBSITE_SHOP_WORDS.group}</p>
      </header>
      <ShopDetailsCard />
      <OpeningHoursCard />
      <PaymentsCard />
      <section aria-labelledby="website-whatsapp-heading" className="space-y-4">
        <h3 id="website-whatsapp-heading" className="flex items-center gap-2 text-base font-semibold">
          <MessageCircle className="h-4 w-4" /> WhatsApp &amp; social
        </h3>
        <ContactCard />
        <GreetingCard />
      </section>
      <AllergyCard />
      <HomePageCard />
    </section>
  );
}

const inputClass =
  'w-full rounded-lg border border-stone-300 px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800 disabled:opacity-60';
const labelClass = 'mb-1 block text-xs uppercase tracking-wider text-stone-500';
const exampleClass = 'rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100';
const hintClass = 'mt-1 text-xs text-stone-500';

/** The amber "change your Google listing" line. */
function GoogleNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function TextBox(p: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  hint?: ReactNode;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <label className={labelClass} htmlFor={p.id}>
        {p.label}
      </label>
      <input
        id={p.id}
        value={p.value}
        maxLength={p.max}
        placeholder={p.placeholder}
        onChange={(e) => p.onChange(e.target.value)}
        className={cn(inputClass, p.mono && 'font-mono')}
      />
      {p.hint && <p className={hintClass}>{p.hint}</p>}
    </div>
  );
}

/** A card on one key: loading and error handled once. */
function Loaded<K extends ShopSettingKey>({ k, what, children }: { k: K; what: string; children: (s: ReturnType<typeof useShopSetting<K>>) => ReactNode }) {
  const s = useShopSetting(k);
  if (s.q.isError) return <p className="py-6 text-center text-stone-500">Could not load {what}.</p>;
  if (!s.q.data) return null;
  return <>{children(s)}</>;
}

/** The items the next publish sends to the website (not delivery charges), for the Home card and the price hint. */
function usePickableItems(): { items: PickableItem[]; loading: boolean } {
  const itemsQ = useQuery({ queryKey: ['menu', 'items', 'all'], queryFn: () => ipc.menu.listItems() });
  const catsQ = useQuery({ queryKey: ['menu', 'categories', 'all'], queryFn: () => ipc.menu.listCategories() });
  const rules = useCheckoutRules();
  const items = useMemo(
    () =>
      itemsQ.data && catsQ.data
        ? pickableItems(itemsQ.data, catsQ.data, deliveryZoneFeeItemIds(deliveryZonesOf(rules.data)))
        : [],
    [itemsQ.data, catsQ.data, rules.data],
  );
  return { items, loading: !itemsQ.data || !catsQ.data };
}

// ------------------------------------------------------------ Shop details --

function ShopDetailsCard() {
  return <Loaded k="shop.profile" what="the shop details">{(s) => <ShopDetailsFields s={s} />}</Loaded>;
}

function ShopDetailsFields({ s }: { s: ReturnType<typeof useShopSetting<'shop.profile'>> }) {
  const saved = s.q.data as ShopSettingCard<'shop.profile'>;
  const card = cardPart(saved, SHOP_CARD_FIELDS.details);
  const draft = useDraft(saved.value, shopDetailsToForm);
  const f = draft.form;
  const parsed = useMemo(() => shopDetailsFromForm(f, saved.value), [f, saved.value]);
  const dirty = draft.touched && JSON.stringify(f) !== JSON.stringify(shopDetailsToForm(saved.value));
  const set = (patch: Partial<ShopDetailsWebForm>) => draft.set({ ...f, ...patch });
  const google = parsed.value ? googleListingChanges(saved.value, parsed.value) : [];
  const { items } = usePickableItems();
  const priceHint = menuPriceHint(items.map((i) => i.priceCents));
  return (
    <SettingCard
      card={card}
      title="Shop details"
      icon={<Store className="h-5 w-5" />}
      intro={WEBSITE_SHOP_WORDS.name}
      describe={shopDetailsSummary}
      dirty={dirty}
      problem={parsed.problem}
      busy={s.save.isPending || s.putBack.isPending}
      onSave={() => parsed.value && s.save.mutate(parsed.value, { onSuccess: draft.reset })}
      onPutBack={() => s.save.mutate(card.defaultValue, { onSuccess: draft.reset })}
      footer={
        <div className="mt-4 space-y-2">
          {dirty && google.length > 0 && (
            <GoogleNote>
              You changed {google.join(', ')}. {WEBSITE_SHOP_WORDS.google}
            </GoogleNote>
          )}
          {dirty && parsed.value && parsed.value.name !== saved.value.name && <GoogleNote>{WEBSITE_SHOP_WORDS.nameRebrand}</GoogleNote>}
          <p className={exampleClass} aria-live="polite">
            <span className="font-semibold">The website’s footer: </span>
            {parsed.value ? shopDetailsSummary(parsed.value) : shopDetailsSummary(saved.value)}
          </p>
        </div>
      }
    >
      <GoogleNote>{WEBSITE_SHOP_WORDS.google}</GoogleNote>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <TextBox id="web-shop-name" label="Name" value={f.name} max={SHOP_NAME_MAX} onChange={(name) => set({ name })} hint="Not the receipt, not FBR: those keep their own name." />
        <TextBox id="web-shop-tagline" label="Tagline (optional)" value={f.tagline} max={SHOP_TAGLINE_MAX} onChange={(tagline) => set({ tagline })} />
        <TextBox id="web-shop-phone" label="Phone (the call line)" value={f.phone} max={20} mono onChange={(phone) => set({ phone })} placeholder="0300 1234567" />
        <TextBox
          id="web-shop-price"
          label="Price range (for search engines)"
          value={f.priceRange}
          max={PRICE_RANGE_MAX}
          onChange={(priceRange) => set({ priceRange })}
          hint={
            <>
              {WEBSITE_SHOP_WORDS.priceRange}
              {priceHint && ` ${priceHint}`}
            </>
          }
        />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_16rem_8rem]">
        <TextBox id="web-shop-street" label="Street address" value={f.street} max={SHOP_STREET_MAX} onChange={(street) => set({ street })} />
        <TextBox id="web-shop-area" label="Short address line" value={f.areaLine} max={SHOP_AREA_LINE_MAX} onChange={(areaLine) => set({ areaLine })} />
        <TextBox id="web-shop-postcode" label="Postal code" value={f.postalCode} max={5} mono onChange={(postalCode) => set({ postalCode })} />
      </div>
      <p className={hintClass}>{WEBSITE_SHOP_WORDS.address}</p>
    </SettingCard>
  );
}

// ----------------------------------------------------------- Opening hours --

const DAY_LABEL: Record<ShopDay, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

function OpeningHoursCard() {
  return <Loaded k="shop.hours" what="the opening hours">{(s) => <OpeningHoursFields s={s} />}</Loaded>;
}

function OpeningHoursFields({ s }: { s: ReturnType<typeof useShopSetting<'shop.hours'>> }) {
  const card = s.q.data as ShopSettingCard<'shop.hours'>;
  const draft = useDraft(card.value, hoursToForm);
  const f = draft.form;
  const parsed = useMemo(() => hoursFromForm(f, card.value), [f, card.value]);
  const dirty = draft.touched && JSON.stringify(f) !== JSON.stringify(hoursToForm(card.value));
  const set = (patch: Partial<HoursForm>) => draft.set({ ...f, ...patch });
  const shown = parsed.value ?? card.value;
  const closes = closingTimes(f.opens);
  return (
    <SettingCard
      card={card}
      title="Opening hours"
      icon={<Clock className="h-5 w-5" />}
      intro={WEBSITE_SHOP_WORDS.hours}
      describe={hoursSummary}
      dirty={dirty}
      problem={parsed.problem}
      busy={s.save.isPending || s.putBack.isPending}
      onSave={() => parsed.value && s.save.mutate(parsed.value, { onSuccess: draft.reset })}
      onPutBack={() => s.putBack.mutate(undefined, { onSuccess: draft.reset })}
      footer={
        <div className="mt-4 space-y-2" aria-live="polite">
          <p className={exampleClass}>
            <span className="font-semibold">The website says: </span>
            {hoursSummary(shown)}
          </p>
          {hoursEffects(shown).map((e) => (
            <p key={e} className="text-sm text-stone-600 dark:text-stone-300">
              {e}
            </p>
          ))}
        </div>
      }
    >
      <GoogleNote>{WEBSITE_SHOP_WORDS.google}</GoogleNote>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="web-hours-opens">
            Opens
          </label>
          <select id="web-hours-opens" value={f.opens} onChange={(e) => set({ opens: e.target.value })} className={inputClass}>
            {OPENING_TIMES.map((t) => (
              <option key={t} value={t}>
                {timeLabel(t)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="web-hours-closes">
            Closes
          </label>
          <select id="web-hours-closes" value={f.closes} onChange={(e) => set({ closes: e.target.value })} className={inputClass}>
            {!closes.includes(f.closes) && <option value={f.closes}>{timeLabel(f.closes)} (pick again)</option>}
            {closes.map((t) => (
              <option key={t} value={t}>
                {closesLabel(t)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <fieldset>
        <legend className={labelClass}>Open on</legend>
        <div className="flex flex-wrap gap-3">
          {SHOP_DAYS.map((d) => (
            <label key={d} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={f.days.includes(d)}
                onChange={(e) => set({ days: e.target.checked ? [...f.days, d] : f.days.filter((x) => x !== d) })}
              />
              {DAY_LABEL[d]}
            </label>
          ))}
        </div>
      </fieldset>
    </SettingCard>
  );
}

// ------------------------------------------------------- Payments at the door --

function PaymentsCard() {
  return <Loaded k="shop.website" what="the payments">{(s) => <PaymentsFields s={s} />}</Loaded>;
}

function PaymentsFields({ s }: { s: ReturnType<typeof useShopSetting<'shop.website'>> }) {
  const saved = s.q.data as ShopSettingCard<'shop.website'>;
  const card = cardPart(saved, SHOP_CARD_FIELDS.payments);
  const draft = useDraft(saved.value, paymentsToForm);
  const f = draft.form;
  const parsed = useMemo(() => paymentsFromForm(f, saved.value), [f, saved.value]);
  const dirty = draft.touched && JSON.stringify(f) !== JSON.stringify(paymentsToForm(saved.value));
  const group = (which: keyof PaymentsForm, title: string) => (
    <fieldset>
      <legend className="text-sm font-semibold">{title}</legend>
      <div className="mt-1 flex flex-wrap gap-3">
        {PAYMENT_CHOICES.map((p) => (
          <label key={p.id} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={f[which].includes(p.id)}
              disabled={p.id === 'cash'}
              onChange={() => draft.set({ ...f, [which]: togglePayment(f[which], p.id) })}
            />
            {p.label}
            {p.id === 'cash' && <span className="text-xs text-stone-500">(always)</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
  return (
    <SettingCard
      card={card}
      title="Payments at the door"
      icon={<Wallet className="h-5 w-5" />}
      intro={WEBSITE_SHOP_WORDS.payments}
      describe={paymentsSummary}
      dirty={dirty}
      problem={parsed.problem}
      busy={s.save.isPending || s.putBack.isPending}
      onSave={() => parsed.value && s.save.mutate(parsed.value, { onSuccess: draft.reset })}
      onPutBack={() => s.save.mutate(card.defaultValue, { onSuccess: draft.reset })}
      footer={
        <p className={cn(exampleClass, 'mt-4')} aria-live="polite">
          <span className="font-semibold">The website says: </span>
          {paymentsEffect(parsed.value ?? saved.value)}
        </p>
      }
    >
      {group('door', 'The rider takes (a delivery)')}
      {group('pickup', 'The counter takes (a website pick-up)')}
    </SettingCard>
  );
}

// ------------------------------------------------- WhatsApp numbers & social --

function ContactCard() {
  return <Loaded k="shop.profile" what="the WhatsApp numbers">{(s) => <ContactFields s={s} />}</Loaded>;
}

function ContactFields({ s }: { s: ReturnType<typeof useShopSetting<'shop.profile'>> }) {
  const saved = s.q.data as ShopSettingCard<'shop.profile'>;
  const card = cardPart(saved, SHOP_CARD_FIELDS.contact);
  const draft = useDraft(saved.value, contactToForm);
  const f = draft.form;
  const parsed = useMemo(() => contactFromForm(f, saved.value), [f, saved.value]);
  const dirty = draft.touched && JSON.stringify(f) !== JSON.stringify(contactToForm(saved.value));
  const set = (patch: Partial<ContactForm>) => draft.set({ ...f, ...patch });
  const numbersChanged = !!parsed.value && JSON.stringify(parsed.value.whatsappLines) !== JSON.stringify(saved.value.whatsappLines);
  return (
    <SettingCard
      card={card}
      title="WhatsApp numbers & social links"
      icon={<Phone className="h-5 w-5" />}
      intro={WEBSITE_SHOP_WORDS.contact}
      describe={contactSummary}
      dirty={dirty}
      problem={parsed.problem}
      busy={s.save.isPending || s.putBack.isPending}
      onSave={() => parsed.value && s.save.mutate(parsed.value, { onSuccess: draft.reset })}
      onPutBack={() => s.save.mutate(card.defaultValue, { onSuccess: draft.reset })}
      footer={dirty && numbersChanged ? <div className="mt-4"><GoogleNote>{WEBSITE_SHOP_WORDS.google}</GoogleNote></div> : undefined}
    >
      <section>
        <h4 className="text-sm font-semibold">WhatsApp numbers</h4>
        <div className="mt-1 space-y-2">
          {f.lines.map((l, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                aria-label={i === 0 ? 'WhatsApp number (the order link)' : `WhatsApp number ${i + 1}`}
                value={l}
                maxLength={20}
                placeholder="0300 1234567"
                onChange={(e) => set({ lines: f.lines.map((x, j) => (j === i ? e.target.value : x)) })}
                className={cn(inputClass, 'max-w-[14rem] font-mono')}
              />
              {i === 0 && <span className="text-xs text-stone-500">“Order on WhatsApp” link</span>}
              {f.lines.length > 1 && (
                <Button variant="ghost" size="sm" aria-label="Remove this number" onClick={() => set({ lines: f.lines.filter((_, j) => j !== i) })}>
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
          {f.lines.length < WHATSAPP_LINES_MAX && (
            <Button variant="secondary" size="sm" onClick={() => set({ lines: [...f.lines, ''] })}>
              <Plus className="mr-1 h-4 w-4" /> Add a number
            </Button>
          )}
        </div>
      </section>
      <section>
        <h4 className="text-sm font-semibold">Social links</h4>
        <p className={hintClass}>Each starts with https:// — the footer names it by its site (Instagram, Facebook, TikTok…). Empty = none (as today).</p>
        <div className="mt-1 space-y-2">
          {f.links.map((l, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                aria-label={`Social link ${i + 1}`}
                value={l}
                maxLength={200}
                placeholder="https://www.instagram.com/…"
                onChange={(e) => set({ links: f.links.map((x, j) => (j === i ? e.target.value : x)) })}
                className={cn(inputClass, 'font-mono')}
              />
              <span className="w-24 shrink-0 text-xs text-stone-500">{l.trim() ? socialLabel(l.trim()) : ''}</span>
              <Button variant="ghost" size="sm" aria-label="Remove this link" onClick={() => set({ links: f.links.filter((_, j) => j !== i) })}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {f.links.length < SOCIAL_LINKS_MAX && (
            <Button variant="secondary" size="sm" onClick={() => set({ links: [...f.links, ''] })}>
              <Plus className="mr-1 h-4 w-4" /> Add a link
            </Button>
          )}
        </div>
      </section>
    </SettingCard>
  );
}

// ------------------------------------------------------------ The greeting --

function GreetingCard() {
  const profile = useShopSetting('shop.profile');
  return (
    <Loaded k="shop.website" what="the WhatsApp greeting">
      {(s) => <GreetingFields s={s} lines={profile.q.data?.value.whatsappLines ?? []} />}
    </Loaded>
  );
}

function GreetingFields({ s, lines }: { s: ReturnType<typeof useShopSetting<'shop.website'>>; lines: Array<{ display: string; e164: string }> }) {
  const saved = s.q.data as ShopSettingCard<'shop.website'>;
  const card = cardPart(saved, SHOP_CARD_FIELDS.greeting);
  const draft = useDraft(saved.value, greetingToForm);
  const parsed = useMemo(() => greetingFromForm(draft.form, saved.value), [draft.form, saved.value]);
  const dirty = draft.touched && draft.form !== greetingToForm(saved.value);
  const greeting = greetingOf(draft.form) || saved.value.whatsappGreeting;
  const link = greetingLink(greeting, { whatsappLines: lines });
  return (
    <SettingCard
      card={card}
      title="WhatsApp greeting"
      icon={<MessageCircle className="h-5 w-5" />}
      intro={WEBSITE_SHOP_WORDS.greeting}
      describe={greetingSummary}
      dirty={dirty}
      problem={parsed.problem}
      busy={s.save.isPending || s.putBack.isPending}
      onSave={() => parsed.value && s.save.mutate(parsed.value, { onSuccess: draft.reset })}
      onPutBack={() => s.save.mutate(card.defaultValue, { onSuccess: draft.reset })}
      footer={
        link ? (
          <p className={cn(exampleClass, 'mt-4 break-all')} aria-live="polite">
            <span className="font-semibold">The customer’s WhatsApp opens with: </span>“{greeting}…”
            <span className="mt-1 block font-mono text-xs text-stone-600 dark:text-stone-300">{link}</span>
          </p>
        ) : undefined
      }
    >
      <TextBox
        id="web-greeting"
        label="Greeting"
        value={draft.form}
        max={WHATSAPP_GREETING_MAX - 1}
        onChange={(v) => draft.set(v)}
        hint="One line. The till adds the space the customer types on after."
      />
    </SettingCard>
  );
}

// ---------------------------------------------------------- Allergy notice --

function AllergyCard() {
  return <Loaded k="shop.website" what="the allergy notice">{(s) => <AllergyFields s={s} />}</Loaded>;
}

function AllergyFields({ s }: { s: ReturnType<typeof useShopSetting<'shop.website'>> }) {
  const saved = s.q.data as ShopSettingCard<'shop.website'>;
  const card = cardPart(saved, SHOP_CARD_FIELDS.allergy);
  const draft = useDraft(saved.value, (v) => v.allergyNotice);
  const parsed = useMemo(() => allergyFromForm(draft.form, saved.value), [draft.form, saved.value]);
  const dirty = draft.touched && draft.form !== saved.value.allergyNotice;
  return (
    <SettingCard
      card={card}
      title="Allergy notice"
      icon={<HeartPulse className="h-5 w-5" />}
      intro={WEBSITE_SHOP_WORDS.allergy}
      describe={allergySummary}
      dirty={dirty}
      problem={parsed.problem}
      busy={s.save.isPending || s.putBack.isPending}
      onSave={() => parsed.value && s.save.mutate(parsed.value, { onSuccess: draft.reset })}
      onPutBack={() => s.save.mutate(card.defaultValue, { onSuccess: draft.reset })}
      footer={
        dirty && allergyLacksGuarantee(draft.form) ? (
          <div className="mt-4">
            <GoogleNote>The “our kitchen shares equipment, so we can’t guarantee any dish is allergen-free” sentence is gone: put it back unless the kitchen really changed.</GoogleNote>
          </div>
        ) : undefined
      }
    >
      <label className={labelClass} htmlFor="web-allergy">
        Allergy notice
      </label>
      <textarea
        id="web-allergy"
        value={draft.form}
        rows={3}
        maxLength={ALLERGY_NOTICE_MAX}
        onChange={(e) => draft.set(e.target.value.replace(/[\r\n]+/g, ' '))}
        className={inputClass}
      />
      <p className={hintClass}>
        {draft.form.trim().length} / {ALLERGY_NOTICE_MAX} (at least {ALLERGY_NOTICE_MIN}). One paragraph.
      </p>
    </SettingCard>
  );
}

// --------------------------------------------------------------- Home page --

type HomeLists = Pick<WebsiteHome, 'pizzas' | 'burger' | 'deals'>;
const homeToForm = (h: WebsiteHome): HomeLists => ({
  pizzas: h.pizzas.map((e) => ({ ...e, itemRef: { ...e.itemRef } })),
  burger: h.burger ? { ...h.burger, itemRef: { ...h.burger.itemRef } } : null,
  deals: h.deals.map((e) => ({ ...e, itemRef: { ...e.itemRef } })),
});

function HomePageCard() {
  return <Loaded k="website.home" what="the home page">{(s) => <HomePageFields s={s} />}</Loaded>;
}

function HomePageFields({ s }: { s: ReturnType<typeof useShopSetting<'website.home'>> }) {
  const card = s.q.data as ShopSettingCard<'website.home'>;
  const draft = useDraft(card.value, homeToForm);
  const f = draft.form;
  const parsed = useMemo(() => homeFromForm(f, card.value), [f, card.value]);
  const dirty = draft.touched && JSON.stringify(f) !== JSON.stringify(homeToForm(card.value));
  const { items, loading } = usePickableItems();
  const preview = useMemo(() => homePreview(f, items), [f, items]);
  const missing = loading ? null : homeMissingWords(homeMissingHere(f, items));
  const featured = new Set(
    [...preview.pizzas, ...(preview.burger ? [preview.burger] : []), ...preview.deals].map((e) => e.item?.id).filter(Boolean),
  );
  const firstFree = items.find((i) => !featured.has(i.id));
  const set = (patch: Partial<HomeLists>) => draft.set({ ...f, ...patch });

  const rows = (which: 'pizzas' | 'deals', max: number, headline: boolean) => (
    <div className="space-y-3">
      {f[which].map((e, i) => (
        <EntryRow
          key={i}
          entry={e}
          found={preview[which][i]?.item ?? null}
          items={items}
          headline={headline}
          onPick={(item) => set({ [which]: f[which].map((x, j) => (j === i ? pickedEntry(item, x) : x)) })}
          onWords={(w) => set({ [which]: f[which].map((x, j) => (j === i ? withWords(x, w) : x)) })}
          onUp={i > 0 ? () => set({ [which]: moved(f[which], i, -1) }) : undefined}
          onDown={i < f[which].length - 1 ? () => set({ [which]: moved(f[which], i, 1) }) : undefined}
          onRemove={which === 'deals' || f[which].length > 1 ? () => set({ [which]: f[which].filter((_, j) => j !== i) }) : undefined}
        />
      ))}
      {f[which].length < max && firstFree && (
        <Button variant="secondary" size="sm" onClick={() => set({ [which]: [...f[which], pickedEntry(firstFree)] })}>
          <Plus className="mr-1 h-4 w-4" /> Add {which === 'pizzas' ? 'a pizza' : 'a deal'}
        </Button>
      )}
    </div>
  );

  return (
    <SettingCard
      card={card}
      title="Home page"
      icon={<Home className="h-5 w-5" />}
      intro={WEBSITE_SHOP_WORDS.home}
      describe={homeSummary}
      dirty={dirty}
      problem={parsed.problem}
      busy={s.save.isPending || s.putBack.isPending}
      onSave={() => parsed.value && s.save.mutate(parsed.value, { onSuccess: draft.reset })}
      onPutBack={() => s.putBack.mutate(undefined, { onSuccess: draft.reset })}
      footer={
        <div className="mt-4 space-y-2" aria-live="polite">
          {missing && <GoogleNote>{missing}</GoogleNote>}
          <div className={exampleClass}>
            <span className="font-semibold">The home page will show: </span>
            {[...preview.pizzas, ...(preview.burger ? [preview.burger] : []), ...preview.deals]
              .filter((e) => e.item)
              .map((e) => `${e.item!.name} ${formatCents(e.item!.priceCents)}`)
              .join(' · ') || 'no featured items'}
            <span className="mt-1 block text-xs">{WEBSITE_SHOP_WORDS.homePreview}</span>
          </div>
        </div>
      }
    >
      <section>
        <h4 className="text-sm font-semibold">Signature pizzas (the 3D carousel and the grid, 1–{HOME_PIZZAS_MAX})</h4>
        {rows('pizzas', HOME_PIZZAS_MAX, true)}
      </section>
      <section>
        <h4 className="text-sm font-semibold">Signature burger</h4>
        {f.burger ? (
          <EntryRow
            entry={f.burger}
            found={preview.burger?.item ?? null}
            items={items}
            headline
            onPick={(item) => set({ burger: pickedEntry(item, f.burger ?? {}) })}
            onWords={(w) => f.burger && set({ burger: withWords(f.burger, w) })}
            onRemove={() => set({ burger: null })}
          />
        ) : (
          firstFree && (
            <Button variant="secondary" size="sm" onClick={() => set({ burger: pickedEntry(firstFree) })}>
              <Plus className="mr-1 h-4 w-4" /> Feature a burger
            </Button>
          )
        )}
      </section>
      <section>
        <h4 className="text-sm font-semibold">Value deals (0–{HOME_DEALS_MAX})</h4>
        {rows('deals', HOME_DEALS_MAX, false)}
      </section>
    </SettingCard>
  );
}

/** One featured item: which item (only those on the website), its own words (empty = the website's own), and its place. */
function EntryRow(p: {
  entry: HomeEntry;
  found: PickableItem | null;
  items: PickableItem[];
  headline: boolean;
  onPick: (item: PickableItem) => void;
  onWords: (w: { headline?: string; text?: string }) => void;
  onUp?: () => void;
  onDown?: () => void;
  onRemove?: () => void;
}) {
  const value = p.found?.id ?? '';
  return (
    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Featured item"
          value={value}
          onChange={(e) => {
            const item = p.items.find((i) => i.id === e.target.value);
            if (item) p.onPick(item);
          }}
          className={cn(inputClass, 'max-w-md')}
        >
          {!p.found && <option value="">Not found: {p.entry.itemRef.name}</option>}
          {p.items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} · {formatCents(i.priceCents)}
              {i.categoryName ? ` (${i.categoryName})` : ''}
            </option>
          ))}
        </select>
        {!p.found && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" /> left off the home page
          </span>
        )}
        <span className="ml-auto flex gap-1">
          {p.onUp && (
            <Button variant="ghost" size="sm" aria-label="Move up" onClick={p.onUp}>
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
          {p.onDown && (
            <Button variant="ghost" size="sm" aria-label="Move down" onClick={p.onDown}>
              <ArrowDown className="h-4 w-4" />
            </Button>
          )}
          {p.onRemove && (
            <Button variant="ghost" size="sm" aria-label="Take it off the home page" onClick={p.onRemove}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </span>
      </div>
      <div className={cn('mt-2 grid grid-cols-1 gap-2', p.headline && 'md:grid-cols-[18rem_1fr]')}>
        {p.headline && (
          <input
            aria-label="Headline (the short line under its name)"
            value={p.entry.headline ?? ''}
            maxLength={HOME_HEADLINE_MAX}
            placeholder="Headline: empty = the website’s own"
            onChange={(e) => p.onWords({ headline: e.target.value })}
            className={inputClass}
          />
        )}
        <input
          aria-label={p.headline ? 'Words on its card' : 'What is in the deal'}
          value={p.entry.text ?? ''}
          maxLength={HOME_TEXT_MAX}
          placeholder={p.headline ? 'Words on its card: empty = the website’s own (else the till’s description)' : 'What is in it: empty = the website’s own'}
          onChange={(e) => p.onWords({ text: e.target.value })}
          className={inputClass}
        />
      </div>
    </div>
  );
}
