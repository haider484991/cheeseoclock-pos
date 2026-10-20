/**
 * First-time setup's Website step as typed (OnboardingPage → WebsiteStep):
 * where the step starts, what it takes from the Business step, and the
 * answers system:completeOnboarding gets (shared-types NewShopAnswers; the
 * main process checks them again with shared-schemas checkedNewShop). Pure.
 */
import { NEW_SHOP_STARTING_HOURS, SHOP_DAYS, normalizePhone, type NewShopAnswers, type ShopDay } from '@cheeseoclock/shared-types';

export interface WebsiteForm {
  phone: string;
  /** '' = the same number as `phone`. */
  whatsapp: string;
  street: string;
  areaLine: string;
  postalCode: string;
  priceRange: string;
  opens: string;
  closes: string;
  days: ShopDay[];
  pickupOffered: boolean;
  /** The pick-up % as typed ('' = 0). */
  pickupPercent: string;
}

/** Where the step starts: nothing typed, open every day 11 am to 11 pm, and no pick-up (the website takes deliveries). */
export function startingWebsiteForm(): WebsiteForm {
  return {
    phone: '',
    whatsapp: '',
    street: '',
    areaLine: '',
    postalCode: '',
    priceRange: '',
    opens: NEW_SHOP_STARTING_HOURS.opens,
    closes: NEW_SHOP_STARTING_HOURS.closes,
    days: [...NEW_SHOP_STARTING_HOURS.days],
    pickupOffered: false,
    pickupPercent: '0',
  };
}

/**
 * The Business step's answers in this step's EMPTY boxes only: its phone
 * (when the website can call it: a Pakistani number), its address line as
 * the street, its city as the area line. Anything typed here stays.
 */
export function withBusinessDetails(f: WebsiteForm, business: { phoneLine: string; branchLine: string; city: string }): WebsiteForm {
  const phone = business.phoneLine.trim();
  return {
    ...f,
    phone: f.phone.trim() === '' && normalizePhone(phone) ? phone : f.phone,
    street: f.street.trim() === '' ? business.branchLine.trim() : f.street,
    areaLine: f.areaLine.trim() === '' ? business.city.trim() : f.areaLine,
  };
}

/** A day ticked or unticked: the days stay Monday first, each once. */
export function withDay(days: readonly ShopDay[], day: ShopDay, on: boolean): ShopDay[] {
  return SHOP_DAYS.filter((d) => (d === day ? on : days.includes(d)));
}

/**
 * The answers as system:completeOnboarding takes them. A pick-up not
 * offered carries no % (what was typed in its hidden box goes); one offered
 * reads '' as 0%, and anything but a whole number as not a % (NaN: the
 * check says so).
 */
export function websiteAnswers(f: WebsiteForm): NewShopAnswers {
  const typed = f.pickupPercent.trim();
  const percent = typed === '' ? 0 : /^\d{1,3}$/.test(typed) ? Number(typed) : Number.NaN;
  return {
    phone: f.phone,
    whatsapp: f.whatsapp,
    street: f.street,
    areaLine: f.areaLine,
    postalCode: f.postalCode,
    priceRange: f.priceRange,
    opens: f.opens,
    closes: f.closes,
    days: [...f.days],
    pickup: { offered: f.pickupOffered, percent: f.pickupOffered ? percent : 0 },
  };
}
