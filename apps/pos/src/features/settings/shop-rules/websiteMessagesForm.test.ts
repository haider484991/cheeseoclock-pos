import { describe, expect, it } from 'vitest';
import { onlineOptionsSchema } from '@cheeseoclock/shared-schemas';
import {
  DEFAULT_ONLINE_OPTIONS,
  PUBLISHED_IMAGE_MAX_CHARS,
  type OnlineOptions,
  type ShopSettingCard,
} from '@cheeseoclock/shared-types';
import {
  WEBSITE_MESSAGES_RULES,
  autoPublishValue,
  closedNoticeStatus,
  minimumExample,
  onlineOptionsPart,
  onlineOptionsSummary,
  partIsDefault,
  putBackPart,
  websiteMessagesFromForm,
  websiteMessagesToForm,
} from './websiteMessagesForm';
import {
  CATEGORY_WEBSITE_WORDS,
  OLDER_WEBSITE_TOAST,
  WEBSITE_DEAL_CHOICE_NOTE,
  WEB_AVAILABILITY_WORDS,
  categoryWebsiteState,
  goesToWebsite,
  itemWebsiteLabel,
  itemWebsiteState,
  photoTooBigForWebsite,
  publishedToast,
  saysPickupOnly,
} from './publishWords';
import { settingsPublishWords } from './deliveryZonesForm';

/**
 * Settings → Online orders' two cards on 'online.options' (format 2): what
 * is typed ↔ the value, each card's own "Put back the default", and the
 * words. Made-up words and amounts.
 */

/** What v0.7.29 saved: format 1, "publish by itself" only — as this version reads it (the messages at their defaults). */
const V1_READ: OnlineOptions = { ...DEFAULT_ONLINE_OPTIONS, v: 1, autoPublishMenu: true };
const WORDS: OnlineOptions = {
  v: 2,
  autoPublishMenu: true,
  closedNotice: { text: 'Closed for a made-up holiday', until: '2026-10-03' },
  announcement: { on: true, text: 'New: a made-up pizza' },
  minDeliveryOrderCents: 100_000,
};
const TODAY = '2026-09-28';

const card = (value: OnlineOptions, over: Partial<ShopSettingCard<'online.options'>> = {}): ShopSettingCard<'online.options'> => ({
  key: 'online.options',
  value,
  defaultValue: { ...DEFAULT_ONLINE_OPTIONS },
  isDefault: false,
  readOnly: false,
  lastChanged: null,
  notOnOtherTillYet: false,
  history: [],
  ...over,
});

describe('“Publish the menu by itself”: its Save on a value v0.7.29 saved', () => {
  it('saves the whole value in this version’s format (format 1 was refused, and dropped the messages) — the messages as saved', () => {
    const value = autoPublishValue(V1_READ, false);
    expect(value).toEqual({ ...DEFAULT_ONLINE_OPTIONS, v: 2, autoPublishMenu: false });
    expect(onlineOptionsSchema.safeParse(value).success).toBe(true);
    // What v0.7.29's card sent — its format and its one field — is refused by this version's check.
    expect(onlineOptionsSchema.safeParse({ v: V1_READ.v, autoPublishMenu: false }).success).toBe(false);
    // Over saved words: they are kept.
    expect(autoPublishValue(WORDS, false)).toEqual({ ...WORDS, autoPublishMenu: false });
  });
});

describe('each card puts back only its own part', () => {
  it('“publish by itself” back to No keeps the messages; the messages back to none keep “publish by itself”', () => {
    expect(putBackPart(WORDS, 'publish')).toEqual({ ...WORDS, autoPublishMenu: false });
    expect(putBackPart(WORDS, 'messages')).toEqual({
      ...DEFAULT_ONLINE_OPTIONS,
      autoPublishMenu: true,
    });
    for (const part of ['publish', 'messages'] as const) {
      expect(onlineOptionsSchema.safeParse(putBackPart(WORDS, part)).success).toBe(true);
      expect(partIsDefault(putBackPart(WORDS, part), part)).toBe(true);
    }
  });

  it('each card has its own Default badge and put-back value; a read-only card is never the default', () => {
    const c = card(WORDS);
    expect(onlineOptionsPart(c, 'publish')).toMatchObject({ isDefault: false, defaultValue: { ...WORDS, autoPublishMenu: false } });
    expect(onlineOptionsPart(card({ ...WORDS, autoPublishMenu: false }), 'publish')).toMatchObject({ isDefault: true });
    expect(onlineOptionsPart(card({ ...DEFAULT_ONLINE_OPTIONS, autoPublishMenu: true }), 'messages')).toMatchObject({ isDefault: true });
    expect(onlineOptionsPart(card(WORDS, { readOnly: true }), 'messages').isDefault).toBe(false);
  });
});

describe('the messages card: what is typed ↔ the value', () => {
  it('shows the saved value; format 1 shows as none, empty minimum', () => {
    expect(websiteMessagesToForm(V1_READ)).toEqual({
      noticeText: '',
      noticeUntil: '',
      announcementOn: false,
      announcementText: '',
      minimum: '',
    });
    expect(websiteMessagesToForm(WORDS)).toEqual({
      noticeText: 'Closed for a made-up holiday',
      noticeUntil: '2026-10-03',
      announcementOn: true,
      announcementText: 'New: a made-up pizza',
      minimum: '1000',
    });
  });

  it('saves the words trimmed, keeps “publish by itself” as saved, in this version’s format', () => {
    const r = websiteMessagesFromForm(
      { noticeText: '  Closed today  ', noticeUntil: '2026-10-01', announcementOn: false, announcementText: ' New ', minimum: ' 1,500 ' },
      V1_READ,
      TODAY,
    );
    expect(r).toEqual({
      value: {
        v: 2,
        autoPublishMenu: true,
        closedNotice: { text: 'Closed today', until: '2026-10-01' },
        announcement: { on: false, text: 'New' },
        minDeliveryOrderCents: 150_000,
      },
      problem: null,
    });
  });

  it('no words = no notice and no end date; empty or 0 = no smallest order', () => {
    const r = websiteMessagesFromForm(
      { noticeText: '   ', noticeUntil: '2026-10-01', announcementOn: false, announcementText: '', minimum: '' },
      WORDS,
      TODAY,
    );
    expect(r.value).toMatchObject({ closedNotice: { text: '', until: null }, minDeliveryOrderCents: 0 });
    expect(websiteMessagesFromForm({ ...websiteMessagesToForm(WORDS), minimum: '0' }, WORDS, TODAY).value).toMatchObject({
      minDeliveryOrderCents: 0,
    });
  });

  it('a last day already past is refused while the notice is being changed — not when only something else is', () => {
    const past = { ...websiteMessagesToForm(WORDS), noticeUntil: '2026-09-27' };
    expect(websiteMessagesFromForm(past, WORDS, TODAY).problem).toMatch(/last day has passed/);
    // Today itself is fine (the whole day shows).
    expect(websiteMessagesFromForm({ ...past, noticeUntil: TODAY }, WORDS, TODAY).problem).toBeNull();
    // A notice that has since ended, saved earlier: the announcement can still be changed.
    const ended: OnlineOptions = { ...WORDS, closedNotice: { text: 'Closed', until: '2026-09-01' } };
    expect(websiteMessagesFromForm({ ...websiteMessagesToForm(ended), announcementOn: false }, ended, TODAY).problem).toBeNull();
  });

  it('the bounds, in the same words as the main process', () => {
    const f = websiteMessagesToForm(WORDS);
    expect(websiteMessagesFromForm({ ...f, noticeText: 'x'.repeat(161) }, WORDS, TODAY).problem).toMatch(/160 letters/);
    expect(websiteMessagesFromForm({ ...f, announcementText: 'x'.repeat(121) }, WORDS, TODAY).problem).toMatch(/120 letters/);
    expect(websiteMessagesFromForm({ ...f, noticeText: `Closed${String.fromCharCode(10)}today` }, WORDS, TODAY).problem).toMatch(/one line/);
    expect(websiteMessagesFromForm({ ...f, announcementText: '' }, WORDS, TODAY).problem).toMatch(/Type the announcement, or switch it off/);
    for (const bad of ['5001', '12.5', '-1', 'abc']) {
      expect({ bad, problem: websiteMessagesFromForm({ ...f, minimum: bad }, WORDS, TODAY).problem }).toEqual({
        bad,
        problem: expect.stringMatching(/whole rupees from Rs 0 to Rs 5,000/),
      });
    }
    expect(websiteMessagesFromForm({ ...f, minimum: '5000' }, WORDS, TODAY).problem).toBeNull();
  });
});

describe('the card’s words', () => {
  it('says the minimum is for website DELIVERIES only: pick-up never refused, orders rung up at the till not checked', () => {
    expect(WEBSITE_MESSAGES_RULES.minimum).toMatch(/website DELIVERY/);
    expect(WEBSITE_MESSAGES_RULES.minimum).toMatch(/Pick-up is never refused/);
    expect(WEBSITE_MESSAGES_RULES.minimum).toMatch(/rung up at the till .* not checked/);
    expect(WEBSITE_MESSAGES_RULES.minimum).toMatch(/before tax and the delivery charge/);
  });

  it('says a notice with no end date shows every night the website is closed', () => {
    expect(WEBSITE_MESSAGES_RULES.noticeUntil).toMatch(/every night the website is closed/);
    expect(closedNoticeStatus({ text: 'Closed', until: null }, Date.parse('2026-09-28T10:00:00Z'))).toMatch(/every night the website is closed/);
  });

  it('where the notice stands: shows up to and including its last day (Karachi), then says it ended', () => {
    const n = { text: 'Closed', until: '2026-10-03' };
    expect(closedNoticeStatus(n, Date.parse('2026-10-03T18:59:59Z'))).toMatch(/up to and including 3 Oct 2026/);
    expect(closedNoticeStatus(n, Date.parse('2026-10-03T19:00:00Z'))).toMatch(/^Ended on 3 Oct 2026/);
    expect(closedNoticeStatus({ text: '', until: null }, Date.now())).toMatch(/No closed notice/);
  });

  it('the example: none today; with a minimum, Rs 1 under is refused and pick-up always goes', () => {
    expect(minimumExample(0)).toMatch(/No smallest order/);
    expect(minimumExample(100_000)).toBe(
      'A website delivery with Rs 999 of food is refused — the checkout says to add Rs 1 more. Rs 1,000 of food or more goes through. A pick-up of any size always goes through.',
    );
  });

  it('History names both cards’ parts', () => {
    expect(onlineOptionsSummary(WORDS)).toBe(
      'The menu goes to the website by itself · closed notice until 3 Oct 2026, announcement on, smallest website delivery Rs 1,000',
    );
    expect(onlineOptionsSummary(DEFAULT_ONLINE_OPTIONS)).toBe(
      'The menu goes to the website when published · no closed notice, no announcement, no smallest delivery order',
    );
  });

  it('the status line speaks of all the website settings, not only the areas', () => {
    expect(settingsPublishWords({ state: 'waiting', at: null, message: null })?.text).toMatch(/^Delivery areas, pick-up & website messages: waiting/);
  });
});

describe('publishing: a photo too big for the website is no longer left out silently', () => {
  it('the toast names the items published with no picture', () => {
    expect(publishedToast({ categories: 2, items: 9, photosLeftOut: [] })).toEqual({
      title: 'Menu published 🎉',
      description: '9 items in 2 categories are now live on the website.',
      variant: 'success',
    });
    const t = publishedToast({ categories: 2, items: 9, photosLeftOut: [{ id: 'a', name: 'Test Pizza' }, { id: 'b', name: 'Test Wrap' }] });
    expect(t.variant).toBe('warning');
    expect(t.description).toMatch(/too big for the website/);
    expect(t.description).toMatch(/Test Pizza and Test Wrap/);
  });

  it('the Menu editor warns on exactly the photos the publish leaves out', () => {
    expect(photoTooBigForWebsite(null)).toBe(false);
    expect(photoTooBigForWebsite('x'.repeat(PUBLISHED_IMAGE_MAX_CHARS))).toBe(false);
    expect(photoTooBigForWebsite('x'.repeat(PUBLISHED_IMAGE_MAX_CHARS + 1))).toBe(true);
  });

  it('the description’s old “pick-up only” rule is spotted, so the editor can say the website still follows it', () => {
    expect(saysPickupOnly('Family deal — pick-up only')).toBe(true);
    expect(saysPickupOnly('Pickup only on weekends')).toBe(true);
    expect(saysPickupOnly('A made-up pizza')).toBe(false);
    expect(saysPickupOnly(null)).toBe(false);
  });
});

describe('each card on the one key shows its OWN changes: History and “last changed”', () => {
  const OWNER_SAVE = (at: string, value: OnlineOptions | null, onThisTill = true) => ({ at, byName: 'Test Owner', onThisTill, value });
  // Newest first, as the key's History is: "publish by itself" on (Sep 20), then the messages saved (Sep 28).
  const history = [
    OWNER_SAVE('2026-09-28T10:00:00.000Z', WORDS),
    OWNER_SAVE('2026-09-20T10:00:00.000Z', { ...DEFAULT_ONLINE_OPTIONS, autoPublishMenu: true }, false),
  ];
  const keyCard = card(WORDS, {
    history,
    lastChanged: { at: '2026-09-28T10:00:00.000Z', byName: 'Test Owner', onThisTill: true },
  });

  it('a Save of the messages is not a change of “publish by itself” (its History and “last changed” stay its own)', () => {
    const publish = onlineOptionsPart(keyCard, 'publish');
    expect(publish.history.map((h) => h.at)).toEqual(['2026-09-20T10:00:00.000Z']);
    expect(publish.lastChanged).toEqual({ at: '2026-09-20T10:00:00.000Z', byName: 'Test Owner', onThisTill: false });
    const msgs = onlineOptionsPart(keyCard, 'messages');
    expect(msgs.history.map((h) => h.at)).toEqual(['2026-09-28T10:00:00.000Z']);
    expect(msgs.lastChanged).toEqual({ at: '2026-09-28T10:00:00.000Z', byName: 'Test Owner', onThisTill: true });
  });

  it('a part never saved, at its default: “never changed”; a line this version can’t read is kept on both', () => {
    const onlyMessages = card({ ...WORDS, autoPublishMenu: false }, {
      history: [OWNER_SAVE('2026-09-28T10:00:00.000Z', { ...WORDS, autoPublishMenu: false })],
      lastChanged: { at: '2026-09-28T10:00:00.000Z', byName: 'Test Owner', onThisTill: true },
    });
    expect(onlineOptionsPart(onlyMessages, 'publish')).toMatchObject({ history: [], lastChanged: null });
    expect(onlineOptionsPart(onlyMessages, 'messages').history).toHaveLength(1);
    const unreadable = card(WORDS, { history: [OWNER_SAVE('2026-09-29T10:00:00.000Z', null), ...history] });
    for (const part of ['publish', 'messages'] as const) {
      expect(onlineOptionsPart(unreadable, part).history[0]!.at).toBe('2026-09-29T10:00:00.000Z');
    }
  });
});

describe('the Menu editor says where each item and category really stands on the website (the publish’s own rule)', () => {
  const item = (over: Partial<{ isActive: boolean; webAvailability: 'on' | 'pickup_only' | 'off' }> = {}) => ({
    isActive: true,
    webAvailability: 'on' as const,
    ...over,
  });
  const cat = (over: Partial<{ isActive: boolean; isOnWebsite: boolean }> = {}) => ({ isActive: true, isOnWebsite: true, ...over });

  it('an item hidden on the till, or in a category hidden on the till, is not on the website — whatever it is set to', () => {
    expect(itemWebsiteState(item({ isActive: false }), cat(), false)).toBe('hidden_on_till');
    expect(itemWebsiteState(item(), cat({ isActive: false }), false)).toBe('hidden_on_till');
    expect(itemWebsiteState(item(), cat({ isActive: false }), true)).toBe('hidden_on_till');
    expect(itemWebsiteLabel('hidden_on_till')).toBe('Not on the website (hidden on the till)');
    expect(goesToWebsite('hidden_on_till')).toBe(false);
  });

  it('otherwise: a delivery charge always goes; a category off takes its items off; else the item’s own setting', () => {
    expect(itemWebsiteState(item({ webAvailability: 'off' }), cat({ isOnWebsite: false }), true)).toBe('fee');
    expect(itemWebsiteState(item(), cat({ isOnWebsite: false }), false)).toBe('category_off');
    expect(itemWebsiteState(item({ webAvailability: 'pickup_only' }), cat(), false)).toBe('pickup_only');
    expect(itemWebsiteState(item(), undefined, false)).toBe('on');
    expect(['fee', 'on', 'pickup_only', 'off', 'category_off'].map((s) => goesToWebsite(s as never))).toEqual([true, true, true, false, false]);
  });

  it('a category: hidden on the till → not on the website; off but holding delivery charges → only those go', () => {
    expect(categoryWebsiteState(cat({ isActive: false }), false)).toBe('hidden_on_till');
    expect(categoryWebsiteState(cat({ isActive: false, isOnWebsite: true }), true)).toBe('hidden_on_till');
    expect(categoryWebsiteState(cat(), true)).toBe('on');
    expect(categoryWebsiteState(cat({ isOnWebsite: false }), true)).toBe('fees_only');
    expect(categoryWebsiteState(cat({ isOnWebsite: false }), false)).toBe('off');
    expect(CATEGORY_WEBSITE_WORDS.fees_only).toBe('Only its delivery charges');
  });

  it('“Pick-up only” says it is this item only (another size is its own) and that it can’t be ordered while pick-up is off; the deal note says deals still offer it', () => {
    expect(WEB_AVAILABILITY_WORDS.pickup_only.hint).toMatch(/Only this item — another size is its own item/);
    expect(WEB_AVAILABILITY_WORDS.pickup_only.hint).toMatch(/while online pick-up is off/);
    expect(WEBSITE_DEAL_CHOICE_NOTE).toMatch(/deal .* still offers it on the website, for delivery too/);
  });
});

describe('the announcement’s words promise only what is true of Google', () => {
  it('never in titles, descriptions or the search data — but page words Google may show, for a while after it is off', () => {
    expect(WEBSITE_MESSAGES_RULES.announcement).not.toMatch(/never goes into[^.]*Google’s listing/);
    expect(WEBSITE_MESSAGES_RULES.announcement).toMatch(/Google may show them in its results, and for a while after you switch it off/);
  });
});

describe('publishing to a website older than this till', () => {
  it('the toast says the website needs its update (it dropped “Pick-up only” and the messages)', () => {
    const t = publishedToast({ categories: 2, items: 9, photosLeftOut: [], olderWebsite: true });
    expect(t).toEqual({
      title: 'Menu published — the website needs its update',
      description: `9 items in 2 categories are now live on the website. ${OLDER_WEBSITE_TOAST}`,
      variant: 'warning',
    });
    const both = publishedToast({ categories: 2, items: 9, photosLeftOut: [{ id: 'a', name: 'Test Pizza' }], olderWebsite: true });
    expect(both.description).toMatch(/Test Pizza/);
    expect(both.description).toMatch(/website is older than this till/);
  });
});
