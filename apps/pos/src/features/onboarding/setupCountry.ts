import {
  DEFAULT_SHOP_LOCALE,
  DEFAULT_STORED_SHOP_LOCALE,
  US_SHOP_LOCALE,
  US_TIME_ZONES,
  type StoredShopLocale,
} from '@cheeseoclock/shared-types';
import { startingTaxRows } from '../menu-mgmt/taxForm';

/**
 * First-time setup's country (international edition): where the shop is,
 * on a Pixel & Oak till. Cheese O'Clock's till never asks — it is Pakistan.
 *
 * The country sets the money, the receipt's symbol, the drawer's notes and
 * how phone numbers are read, and it locks once the till takes an order. The
 * examples and starting rows below are what setup shows for each; Pakistan's
 * are, string for string, what setup showed before it asked.
 */
export type SetupCountry = 'PK' | 'US';

/** The placeholders and the tax step's words, per country. */
export interface SetupExamples {
  businessName: string;
  tagline: string;
  receiptPhone: string;
  branch: string;
  websiteLine: string;
  websitePhone: string;
  street: string;
  areaLine: string;
  priceRange: string;
  taxHelp: string;
}

export const SETUP_EXAMPLES: Readonly<Record<SetupCountry, Readonly<SetupExamples>>> = Object.freeze({
  PK: Object.freeze({
    businessName: 'e.g. Karachi Grill House',
    tagline: 'e.g. Pakistani Pizza · Cafe',
    receiptPhone: '+92 51 1234 5678',
    branch: 'F-10 Markaz, Islamabad',
    websiteLine: 'yourshop.pk',
    websitePhone: '0300 1234567',
    street: 'e.g. Shop 2, Main Road, Block 6',
    areaLine: 'e.g. Gulshan-e-Iqbal, Karachi',
    priceRange: 'e.g. PKR 300–1,500',
    taxHelp: "Categories you'll assign per menu item. Pakistani defaults are pre-filled — change them to match your registration.",
  }),
  US: Object.freeze({
    businessName: 'e.g. Main Street Pizza',
    tagline: 'e.g. Pizza · Wings · Subs',
    receiptPhone: '(415) 555-0123',
    branch: '123 Main St, Springfield',
    websiteLine: 'yourshop.com',
    websitePhone: '(415) 555-0123',
    street: 'e.g. 123 Main St',
    areaLine: 'e.g. Springfield, IL',
    priceRange: 'e.g. $10–$40',
    taxHelp:
      "Categories you'll assign per menu item. Type your combined state and local sales tax rate — up to two decimals, like 8.25% (a rate like 8.875% can't be held yet). Use 0% for anything not taxed.",
  }),
});

/** The choice, as the country menu names it. */
export const COUNTRY_LABELS: Readonly<Record<SetupCountry, string>> = Object.freeze({
  PK: `Pakistan (${DEFAULT_SHOP_LOCALE.words.major})`,
  US: `United States (${US_SHOP_LOCALE.words.major})`,
});

/** The US zones as people say them. */
export const US_ZONE_LABELS: Readonly<Record<(typeof US_TIME_ZONES)[number], string>> = Object.freeze({
  'America/New_York': 'Eastern (New York)',
  'America/Chicago': 'Central (Chicago)',
  'America/Denver': 'Mountain (Denver)',
  'America/Phoenix': 'Arizona (no daylight saving)',
  'America/Los_Angeles': 'Pacific (Los Angeles)',
  'America/Anchorage': 'Alaska',
  'Pacific/Honolulu': 'Hawaii',
});

/**
 * The tax rows setup starts a shop with. Pakistan: the till's one starting
 * set. US: a sales tax row for the owner's own rate — there is no national
 * one — and a 0% row for what is not taxed.
 */
export function startingTaxRowsFor(country: SetupCountry): Array<{ name: string; rateBps: number }> {
  return country === 'US'
    ? [
        { name: 'Sales tax', rateBps: 0 },
        { name: 'Not taxed', rateBps: 0 },
      ]
    : startingTaxRows();
}

/** What setup stores for the choice: Pakistan always keeps Pakistan time. */
export function storedLocaleFor(country: SetupCountry, usZone: string): StoredShopLocale {
  return country === 'US' ? { v: 1, country: 'US', timeZone: usZone } : DEFAULT_STORED_SHOP_LOCALE;
}

/** The zone a US shop starts on. */
export const STARTING_US_ZONE: string = US_TIME_ZONES[0];
