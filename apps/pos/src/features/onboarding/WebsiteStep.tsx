import { cn } from '@cheeseoclock/ui';
import {
  PRICE_RANGE_MAX,
  SHOP_AREA_LINE_MAX,
  SHOP_DAYS,
  SHOP_PHONE_DISPLAY_MAX,
  SHOP_STREET_MAX,
  WEBSITE_PICKUP_MAX_PERCENT,
  type ShopDay,
} from '@cheeseoclock/shared-types';
import { OPENING_TIMES, closesLabel, closingTimes, timeLabel } from '../settings/shop-rules/websiteShopForm';
import { Field } from './Field';
import { withDay, type WebsiteForm } from './websiteStepForm';
import { SETUP_EXAMPLES, type SetupExamples } from './setupCountry';

const DAY_LABEL: Record<ShopDay, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const inputClass = 'w-full rounded-xl border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800';

/**
 * First-time setup's Website step: what the shop's online ordering website
 * shows — its own numbers, address, price range, opening hours and pick-up
 * offer (shared-types new-shop.ts). Nothing here is filled in with another
 * shop's details; `problem` is the first thing to fix (shared-schemas
 * checkedNewShop, the same check the main process makes).
 */
export function WebsiteStep({
  form,
  problem,
  onChange,
  examples = SETUP_EXAMPLES.PK,
}: {
  form: WebsiteForm;
  problem: string | null;
  onChange: (patch: Partial<WebsiteForm>) => void;
  /** The placeholders for the shop's country (setupCountry.ts); Pakistan's when not given. */
  examples?: SetupExamples;
}) {
  const closes = closingTimes(form.opens);
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">What your website shows</h2>
      <p className="text-xs text-stone-500">
        Customers see these on your online ordering website, with the business name and tagline. They are this shop’s
        own: change them any time in Settings → Shop &amp; logo.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Phone for calls *" htmlFor="onboarding-web-phone">
          <input
            id="onboarding-web-phone"
            type="tel"
            value={form.phone}
            onChange={(e) => onChange({ phone: e.target.value })}
            placeholder={examples.websitePhone}
            maxLength={SHOP_PHONE_DISPLAY_MAX}
            className={cn(inputClass, 'font-mono')}
          />
        </Field>
        <Field label="WhatsApp for orders" htmlFor="onboarding-web-whatsapp">
          <input
            id="onboarding-web-whatsapp"
            type="tel"
            value={form.whatsapp}
            onChange={(e) => onChange({ whatsapp: e.target.value })}
            placeholder={form.phone.trim() || 'Same as the phone'}
            maxLength={SHOP_PHONE_DISPLAY_MAX}
            className={cn(inputClass, 'font-mono')}
          />
        </Field>
      </div>

      <Field label="Street address *" htmlFor="onboarding-web-street">
        <input
          id="onboarding-web-street"
          type="text"
          value={form.street}
          onChange={(e) => onChange({ street: e.target.value })}
          placeholder={examples.street}
          maxLength={SHOP_STREET_MAX}
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-[1fr_8rem_11rem] gap-3">
        <Field label="Area and city *" htmlFor="onboarding-web-area">
          <input
            id="onboarding-web-area"
            type="text"
            value={form.areaLine}
            onChange={(e) => onChange({ areaLine: e.target.value })}
            placeholder={examples.areaLine}
            maxLength={SHOP_AREA_LINE_MAX}
            className={inputClass}
          />
        </Field>
        <Field label="Postal code *" htmlFor="onboarding-web-postal">
          <input
            id="onboarding-web-postal"
            type="text"
            inputMode="numeric"
            value={form.postalCode}
            onChange={(e) => onChange({ postalCode: e.target.value })}
            placeholder="5 digits"
            maxLength={5}
            className={cn(inputClass, 'font-mono')}
          />
        </Field>
        <Field label="Price range *" htmlFor="onboarding-web-price">
          <input
            id="onboarding-web-price"
            type="text"
            value={form.priceRange}
            onChange={(e) => onChange({ priceRange: e.target.value })}
            placeholder={examples.priceRange}
            maxLength={PRICE_RANGE_MAX}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Opens" htmlFor="onboarding-web-opens">
          <select id="onboarding-web-opens" value={form.opens} onChange={(e) => onChange({ opens: e.target.value })} className={inputClass}>
            {OPENING_TIMES.map((t) => (
              <option key={t} value={t}>
                {timeLabel(t)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Closes" htmlFor="onboarding-web-closes">
          <select id="onboarding-web-closes" value={form.closes} onChange={(e) => onChange({ closes: e.target.value })} className={inputClass}>
            {!closes.includes(form.closes) && <option value={form.closes}>{timeLabel(form.closes)} (pick again)</option>}
            {closes.map((t) => (
              <option key={t} value={t}>
                {closesLabel(t)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <fieldset>
        <legend className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">Open on</legend>
        <div className="flex flex-wrap gap-3">
          {SHOP_DAYS.map((d) => (
            <label key={d} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={form.days.includes(d)} onChange={(e) => onChange({ days: withDay(form.days, d, e.target.checked) })} />
              {DAY_LABEL[d]}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-stone-500">Shown on the website only: website orders open and close with the shift.</p>
      </fieldset>

      <div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.pickupOffered} onChange={(e) => onChange({ pickupOffered: e.target.checked })} />
            Customers can also order on the website and pick it up
          </label>
          {form.pickupOffered && (
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="number"
                min={0}
                max={WEBSITE_PICKUP_MAX_PERCENT}
                step={1}
                value={form.pickupPercent}
                onChange={(e) => onChange({ pickupPercent: e.target.value })}
                aria-label="Pick-up discount %"
                className="w-20 rounded-xl border border-stone-300 px-2 py-1.5 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
              />
              % off a pick-up order
            </label>
          )}
        </div>
        <p className="mt-1 text-xs text-stone-500">
          Off: the website takes delivery orders only. Change it later in Settings → Money &amp; discounts.
        </p>
      </div>

      {problem && (
        <p role="status" className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {problem}
        </p>
      )}
    </div>
  );
}
