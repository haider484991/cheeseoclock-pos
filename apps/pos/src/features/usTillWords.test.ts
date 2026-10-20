/**
 * 0.9.1: the words a US till still showed in Pakistan's terms — the drawer
 * notes, the files' column heads, the deals' and the website notice's clock,
 * the website phone hints, Reports' times. Pakistan reads exactly as before
 * (each file's own tests pin its words word for word); these pin the US ones.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { US_SHOP_LOCALE, resetShopLocale, setShopLocale, shopSettingDefault, shopTimeName } from '@cheeseoclock/shared-types';
import {
  noteChangeQuestion,
  noteChangeText,
  noteChangeTitle,
  noteWordsLang,
  openDrawerCashButton,
  openDrawerNoteText,
  openDrawerNoteTitle,
} from './shell/noteChangeWords';
import { drawerLogColumns } from './reports/drawerLogFormat';
import { fmtWhen } from './reports/reportFormat';
import { costingFileHeader } from './inventory/costing-file';
import { hoursNote } from './settings/shop-rules/buy1Get1Form';
import { WEBSITE_MESSAGES_RULES, todayInKarachi } from './settings/shop-rules/websiteMessagesForm';
import { contactFromForm, shopDetailsFromForm, shopDetailsSummary } from './settings/shop-rules/websiteShopForm';

afterEach(resetShopLocale);

// 00:35 UTC on 21 Oct 2026: 05:35 on the 21st in Karachi, 8:35 pm on the 20th in New York (EDT).
const AT = '2026-10-21T00:35:00.000Z';
const DEALS = { opensMinute: 13 * 60, closesMinute: 19 * 60 };

describe('Pakistan, as before', () => {
  it('Roman Urdu notes, rupee heads, Karachi and Pakistan time', () => {
    expect(noteWordsLang()).toBe('ur-Latn');
    expect(noteChangeTitle()).toBe('Note khulwana Cash in ya Cash out nahi hai');
    expect(openDrawerCashButton()).toBe('Cash out / Cash in karein');
    expect(drawerLogColumns()).toContain('Cash Rs');
    expect(costingFileHeader()).toContain('Till price (Rs)');
    expect(hoursNote(DEALS)).toBe('Every day 1–7 PM, Karachi time.');
    expect(shopTimeName()).toBe('Pakistan time');
    expect(shopTimeName({ city: true })).toBe('Karachi time');
    expect(fmtWhen(AT)).toBe('21 Oct, 5:35 am');
    expect(todayInKarachi(Date.parse(AT))).toBe('2026-10-21');
  });
});

describe('a US till', () => {
  it('reads the drawer notes in English, and still asks before a note change is recorded', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(noteWordsLang()).toBe('en');
    expect(noteChangeTitle()).toBe('Breaking a note is not Cash in or Cash out');
    expect(noteChangeText()).toMatch(/the drawer holds the same amount/);
    expect(openDrawerNoteTitle()).toBe('Open drawer records no money');
    expect(openDrawerNoteText()).toMatch(/use "Cash out"/);
    expect(openDrawerCashButton()).toBe('Cash out / Cash in');
    const payin = noteChangeQuestion('payin', 'for change');
    expect(payin?.message.split('\n')[0]).toBe('Is this new money put into the drawer from outside?');
    expect(payin?.yesLabel).toBe('Yes, it is new money');
    expect(payin?.noLabel).toBe('Go back');
    const payout = noteChangeQuestion('payout', 'break a $20');
    expect(payout?.message.split('\n')[0]).toBe('Was this money taken out of the drawer and spent?');
    expect(noteChangeQuestion('payin', 'Float from the owner')).toBeNull();
    const all = [noteChangeTitle(), noteChangeText(), openDrawerNoteTitle(), openDrawerNoteText(), openDrawerCashButton()];
    for (const t of [...all, payin!.message, payout!.message]) expect(t).not.toMatch(/karein|nahi|paisa|Wapas/);
  });

  it('heads its files in dollars', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(drawerLogColumns()).toContain('Cash $');
    expect(costingFileHeader()).toEqual(expect.arrayContaining(['Till price ($)', 'Pack price ($)', "Sheet's price ($)"]));
    expect([...drawerLogColumns(), ...costingFileHeader()].join(' ')).not.toMatch(/\bRs\b/);
  });

  it('names its own clock, and tells the time on it', () => {
    setShopLocale(US_SHOP_LOCALE);
    expect(shopTimeName()).toBe('local time');
    expect(shopTimeName({ capital: true })).toBe('Local time');
    expect(shopTimeName({ city: true })).toBe('local time');
    expect(hoursNote(DEALS)).toBe('Every day 1–7 PM, local time.');
    expect(WEBSITE_MESSAGES_RULES.noticeUntil).toMatch(/^The last day it shows \(local time\)\./);
    expect(fmtWhen(AT)).toBe('Oct 20, 8:35 pm');
    expect(todayInKarachi(Date.parse(AT))).toBe('2026-10-20');
  });

  it('asks for US phone numbers in US words, and sums the shop up with its own town', () => {
    setShopLocale(US_SHOP_LOCALE);
    const saved = shopSettingDefault('shop.profile');
    expect(contactFromForm({ lines: ['12345'], links: [] }, saved).problem).toBe('12345 is not a US phone number (like (415) 555-0123).');
    const details = shopDetailsFromForm(
      { name: 'Main Street Pizza', tagline: '', phone: '0300 1234567', street: '123 Main St', areaLine: 'Springfield, IL', postalCode: '62701', priceRange: '' },
      saved,
    );
    expect(details.problem).toBe('Type the phone number as it is dialled in the US (like (415) 555-0123).');
    const profile = {
      ...saved,
      name: 'Main Street Pizza',
      phone: { display: '(415) 555-0123', e164: '+14155550123' },
      address: { street: '123 Main St', areaLine: 'Springfield, IL', postalCode: '62701' },
    };
    expect(shopDetailsSummary(profile)).toBe('Main Street Pizza · (415) 555-0123 · 123 Main St, Springfield, IL 62701');
  });
});
