/**
 * A NEW shop's own website details, from its first-time setup (the setup
 * screen's Website step; system:completeOnboarding). The frozen
 * DEFAULT_SHOP_* (website-shop.ts) and DEFAULT_WEBSITE_PICKUP
 * (shop-settings.ts) are the FIRST shop's: its name, numbers, address,
 * social links, greeting, hours, home picks and its printed menu's 10% off
 * a pick-up. Its tills never ran this setup and keep reading them,
 * untouched. Every till set up since stores its own five values at once —
 * like its receipt's website line — so nothing of another shop's is ever
 * published by default: the shop block and the settings block carry these
 * from the first publish.
 *
 * Pure (no clock, no I/O): the setup screen shows the first problem as the
 * owner types, and the main process builds the same values and checks them
 * again with the keys' own write schemas (shared-schemas checkedNewShop).
 */

import { normalizePhone } from './phone.js';
import { SHOP_SETTING_FORMAT, type WebsitePickup } from './shop-settings.js';
import {
  DEFAULT_SHOP_WEBSITE,
  SHOP_DAYS,
  type ShopDay,
  type ShopHours,
  type ShopPhone,
  type ShopProfile,
  type ShopWebsite,
  type WebsiteHome,
} from './website-shop.js';

/** What the Website step asks (the name and tagline are the business's own, from the step before). */
export interface NewShopAnswers {
  /** The number customers call, as typed ("0300 1234567"). */
  phone: string;
  /** The WhatsApp ordering number as typed; '' = the same as `phone`. */
  whatsapp: string;
  /** The full street address (the footer, search engines, the pick-up line). */
  street: string;
  /** The short "area, city" line ("Gulshan-e-Iqbal, Karachi"). */
  areaLine: string;
  /** Five digits. */
  postalCode: string;
  /** For search engines ("PKR 300–1,500"). */
  priceRange: string;
  /** The opening hours the website shows (display only: ordering follows the shift). */
  opens: string;
  closes: string;
  days: ShopDay[];
  /** Pick-up from the website: offered or not, and its whole % off (0 when not offered). */
  pickup: { offered: boolean; percent: number };
}

/** The keys first-time setup stores, in the order it writes them. */
export const NEW_SHOP_KEYS = ['shop.profile', 'shop.hours', 'shop.website', 'website.home', 'discounts.websitePickup'] as const;

/** Each of NEW_SHOP_KEYS with the value first-time setup stores. */
export interface NewShopSettings {
  'shop.profile': ShopProfile;
  'shop.hours': ShopHours;
  'shop.website': ShopWebsite;
  'website.home': WebsiteHome;
  'discounts.websitePickup': WebsitePickup;
}

/** The hours the Website step starts at: every day, 11 am to 11 pm (the owner changes them there). */
export const NEW_SHOP_STARTING_HOURS: Readonly<Pick<ShopHours, 'opens' | 'closes' | 'days'>> = Object.freeze({
  opens: '11:00',
  closes: '23:00',
  days: Object.freeze([...SHOP_DAYS]) as ShopDay[],
});

/** The message a new shop's "Order on WhatsApp" buttons start with: its own name, then ONE space. */
export function newShopGreeting(name: string): string {
  return `Hi ${name.trim()}! I'd like to place an order: `;
}

/** A number as typed, and as dialled ('' when it is not a Pakistani number: the schema then says so). */
function phoneLine(display: string): ShopPhone {
  return { display, e164: normalizePhone(display) ?? '' };
}

/**
 * The five values from the setup answers. Every field is the shop's own —
 * the name and tagline as typed on the step before, one WhatsApp line (the
 * call line when none is typed), no social link (Settings adds them) — or
 * names no shop at all: the greeting built from its own name, cash at the
 * door and the counter, the allergy notice's words (they name no shop: the
 * website's own "Allergy or special request" box, and the shared-equipment
 * caution), NOTHING_FEATURED on the home page (no menu to pick from yet),
 * and pick-up as answered, never on a delivery. Spaces at the ends of each
 * answer are dropped, and the days go Monday first, each once.
 */
export function newShopSettings(name: string, tagline: string, a: NewShopAnswers): NewShopSettings {
  const shopName = name.trim();
  const phone = a.phone.trim();
  const whatsapp = a.whatsapp.trim() || phone;
  return {
    'shop.profile': {
      v: SHOP_SETTING_FORMAT['shop.profile'],
      name: shopName,
      tagline: tagline.trim(),
      phone: phoneLine(phone),
      whatsappLines: [phoneLine(whatsapp)],
      address: { street: a.street.trim(), areaLine: a.areaLine.trim(), postalCode: a.postalCode.trim() },
      socialLinks: [],
      priceRange: a.priceRange.trim(),
    },
    'shop.hours': {
      v: SHOP_SETTING_FORMAT['shop.hours'],
      opens: a.opens,
      closes: a.closes,
      days: SHOP_DAYS.filter((d) => a.days.includes(d)),
    },
    'shop.website': {
      v: SHOP_SETTING_FORMAT['shop.website'],
      whatsappGreeting: newShopGreeting(shopName),
      doorPayments: ['cash'],
      pickupPayments: ['cash'],
      allergyNotice: DEFAULT_SHOP_WEBSITE.allergyNotice,
    },
    // NOTHING_FEATURED (website-shop.ts), as a fresh value.
    'website.home': { v: SHOP_SETTING_FORMAT['website.home'], pizzas: [], burger: null, deals: [] },
    'discounts.websitePickup': {
      v: SHOP_SETTING_FORMAT['discounts.websitePickup'],
      offered: a.pickup.offered,
      percent: a.pickup.offered ? a.pickup.percent : 0,
      alsoDelivery: false,
    },
  };
}
