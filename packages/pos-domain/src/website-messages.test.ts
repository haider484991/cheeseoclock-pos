import { afterEach, describe, expect, it } from 'vitest';
import {
  ANNOUNCEMENT_MAX,
  CLOSED_NOTICE_MAX,
  DEFAULT_DELIVERY_ZONES,
  MIN_DELIVERY_ORDER_MAX_CENTS,
  PUBLISHED_SETTING_KEYS,
  WEBSITE_TEXT_FORBIDDEN_RE,
  announcementInForce,
  closedNoticeInForce,
  deliveryMinimumShortfallCents,
  karachiDateOf,
} from '@cheeseoclock/shared-types';
import { buildSettingsBlock } from './delivery-charge.js';

/**
 * The website's messages and delivery minimum (sweep B1; shared-types
 * website-messages.ts): the pure rules the till's card and the website's
 * pages and order route share. Every default is today's website: nothing in
 * force, no minimum. Made-up words and amounts.
 */

const at = (iso: string) => Date.parse(iso);

describe('the Karachi calendar day (UTC+5, no daylight saving), worked in UTC only', () => {
  const tz = process.env['TZ'];
  afterEach(() => {
    if (tz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = tz;
  });

  it('changes at 00:00 Karachi time (19:00 UTC the day before)', () => {
    expect(karachiDateOf(at('2026-10-01T18:59:59.999Z'))).toBe('2026-10-01');
    expect(karachiDateOf(at('2026-10-01T19:00:00.000Z'))).toBe('2026-10-02');
    // A Karachi evening is still that day.
    expect(karachiDateOf(at('2026-10-01T15:00:00.000Z'))).toBe('2026-10-01');
    // Across a month and a year end.
    expect(karachiDateOf(at('2026-12-31T19:00:00.000Z'))).toBe('2027-01-01');
  });

  it('the machine’s own time zone makes no difference (Vercel runs in UTC; a laptop anywhere)', () => {
    const t = at('2026-10-01T20:30:00.000Z');
    const seen: string[] = [];
    for (const zone of ['UTC', 'America/New_York', 'Asia/Karachi', 'Pacific/Kiritimati']) {
      process.env['TZ'] = zone;
      seen.push(karachiDateOf(t));
    }
    expect(seen).toEqual(['2026-10-02', '2026-10-02', '2026-10-02', '2026-10-02']);
    // The local day really does differ there (so a local-time rule would have been wrong).
    process.env['TZ'] = 'America/New_York';
    expect(new Date(t).getDate()).toBe(1);
  });
});

describe('the closed notice in force', () => {
  const notice = { text: 'Closed for Eid — back on Monday', until: '2026-10-03' };

  it('no notice (today): nothing in force, whatever the day — the website’s own texts', () => {
    expect(closedNoticeInForce({ text: '', until: null }, at('2026-10-01T12:00:00.000Z'))).toBeNull();
    expect(closedNoticeInForce({ text: '   ', until: '2026-10-03' }, at('2026-10-01T12:00:00.000Z'))).toBeNull();
    expect(closedNoticeInForce(undefined, at('2026-10-01T12:00:00.000Z'))).toBeNull();
    expect(closedNoticeInForce(null, at('2026-10-01T12:00:00.000Z'))).toBeNull();
  });

  it('shows through the WHOLE last day in Karachi, and is gone from 00:00 Karachi the day after', () => {
    expect(closedNoticeInForce(notice, at('2026-09-29T10:00:00.000Z'))).toBe(notice.text);
    // 23:59:59 Karachi on the 3rd.
    expect(closedNoticeInForce(notice, at('2026-10-03T18:59:59.999Z'))).toBe(notice.text);
    // 00:00 Karachi on the 4th.
    expect(closedNoticeInForce(notice, at('2026-10-03T19:00:00.000Z'))).toBeNull();
    expect(closedNoticeInForce(notice, at('2026-11-01T12:00:00.000Z'))).toBeNull();
  });

  it('under a time zone other than Karachi’s the end is the same instant', () => {
    const tz = process.env['TZ'];
    try {
      for (const zone of ['UTC', 'America/New_York']) {
        process.env['TZ'] = zone;
        expect(closedNoticeInForce(notice, at('2026-10-03T18:59:59.999Z'))).toBe(notice.text);
        expect(closedNoticeInForce(notice, at('2026-10-03T19:00:00.000Z'))).toBeNull();
      }
    } finally {
      if (tz === undefined) delete process.env['TZ'];
      else process.env['TZ'] = tz;
    }
  });

  it('with no end date it shows every night the website is closed', () => {
    const always = { text: 'Kitchen closed for renovation', until: null };
    expect(closedNoticeInForce(always, at('2026-10-03T19:00:00.000Z'))).toBe(always.text);
    expect(closedNoticeInForce(always, at('2030-01-01T00:00:00.000Z'))).toBe(always.text);
  });
});

describe('the announcement', () => {
  it('shows only while on and with words (off: today)', () => {
    expect(announcementInForce({ on: false, text: 'New: made-up pizza' })).toBeNull();
    expect(announcementInForce({ on: true, text: '' })).toBeNull();
    expect(announcementInForce({ on: true, text: 'New: made-up pizza' })).toBe('New: made-up pizza');
    expect(announcementInForce(undefined)).toBeNull();
  });
});

describe('the smallest website delivery order', () => {
  it('no minimum (0, today): never short', () => {
    expect(deliveryMinimumShortfallCents(0, 0)).toBe(0);
    expect(deliveryMinimumShortfallCents(100, 0)).toBe(0);
  });

  it('Rs 1 under is short by Rs 1; exactly the minimum or more is not', () => {
    expect(deliveryMinimumShortfallCents(99_900, 100_000)).toBe(100);
    expect(deliveryMinimumShortfallCents(100_000, 100_000)).toBe(0);
    expect(deliveryMinimumShortfallCents(150_000, 100_000)).toBe(0);
    expect(deliveryMinimumShortfallCents(0, 100_000)).toBe(100_000);
  });

  it('bounds: Rs 5,000 at most; one-line words of 160 and 120 letters', () => {
    expect(MIN_DELIVERY_ORDER_MAX_CENTS).toBe(500_000);
    expect(CLOSED_NOTICE_MAX).toBe(160);
    expect(ANNOUNCEMENT_MAX).toBe(120);
  });
});

describe('what a website message may hold', () => {
  it('refuses, anywhere in the words, the Arabic letter mark and the invisible characters: zero-width space, non-joiner and joiner, word joiner and invisible operators, byte order mark', () => {
    for (const code of [0x061c, 0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff]) {
      for (const bad of [`Closed${String.fromCharCode(code)}today`, `${String.fromCharCode(code)}Closed`, `Closed${String.fromCharCode(code)}`]) {
        expect({ code: code.toString(16), refused: WEBSITE_TEXT_FORBIDDEN_RE.test(bad) }).toEqual({ code: code.toString(16), refused: true });
      }
    }
  });

  it('keeps every other Urdu character (U+0600–U+06FF but U+061C) and the characters beside the new ones', () => {
    const allowed = [0x200a, 0x2010, 0x205f, 0x2065, 0xfefe, 0xff01];
    for (let code = 0x0600; code <= 0x06ff; code += 1) if (code !== 0x061c) allowed.push(code);
    const refused = allowed.filter((code) => WEBSITE_TEXT_FORBIDDEN_RE.test(`a${String.fromCharCode(code)}b`));
    expect(refused.map((c) => c.toString(16))).toEqual([]);
    expect(WEBSITE_TEXT_FORBIDDEN_RE.test('بند ہے — کل کھلے گا')).toBe(false);
  });

  it('refuses control characters, a line break or tab, line/paragraph separators and direction marks; plain words, Urdu and dashes are fine', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u2028b', 'a\u2029b', 'a\u202eb', 'a\u2066b', 'a\u200fb']) {
      expect({ bad, refused: WEBSITE_TEXT_FORBIDDEN_RE.test(bad) }).toEqual({ bad, refused: true });
    }
    for (const good of ['Closed for Eid — back on Monday', 'عید مبارک', 'Rs 1,000 minimum: “made-up”', '']) {
      expect({ good, refused: WEBSITE_TEXT_FORBIDDEN_RE.test(good) }).toEqual({ good, refused: false });
    }
  });
});

describe('the settings block carries the messages (v0.7.30)', () => {
  const menuItems = [
    { id: 'fee-200', name: 'Delivery Charge (Rs 200)', basePriceCents: 20_000 },
    { id: 'fee-250', name: 'Delivery Charge (Rs 250)', basePriceCents: 25_000 },
  ];
  const base = {
    zones: DEFAULT_DELIVERY_ZONES.zones,
    pickup: { offered: true, percent: 10 },
    stamps: [{ version: 1, updatedAt: '2026-09-28T09:00:00.000Z' }, null, null],
    menuItems,
    deviceId: 'till-a',
  };

  it('online.options is one of the carried keys (a Save of the messages alone changes the stamp)', () => {
    expect(PUBLISHED_SETTING_KEYS).toEqual(['delivery.zones', 'discounts.websitePickup', 'online.options']);
  });

  it('a till of this version sends all three, at their defaults too (sent at the default = cleared on the website)', () => {
    const block = buildSettingsBlock({
      ...base,
      website: { closedNotice: { text: '', until: null }, announcement: { on: false, text: '' }, minDeliveryOrderCents: 0 },
    });
    expect(block).toMatchObject({
      closedNotice: { text: '', until: null },
      announcement: { on: false, text: '' },
      minDeliveryOrderCents: 0,
    });
  });

  it('carries the owner’s words and minimum as saved', () => {
    const block = buildSettingsBlock({
      ...base,
      website: {
        closedNotice: { text: 'Closed for Eid', until: '2026-10-03' },
        announcement: { on: true, text: 'New: made-up pizza' },
        minDeliveryOrderCents: 100_000,
      },
    });
    expect(block.closedNotice).toEqual({ text: 'Closed for Eid', until: '2026-10-03' });
    expect(block.announcement).toEqual({ on: true, text: 'New: made-up pizza' });
    expect(block.minDeliveryOrderCents).toBe(100_000);
  });

  it('without them the block is exactly a v0.7.29 till’s (no message keys at all)', () => {
    const block = buildSettingsBlock(base);
    expect(Object.keys(block).sort()).toEqual(['deviceId', 'pickup', 'settingsAt', 'settingsRev', 'settingsTie', 'v', 'zones']);
    expect(block.v).toBe(1);
  });
});
