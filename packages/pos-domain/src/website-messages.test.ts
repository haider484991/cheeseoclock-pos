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
  const C = (...codes: number[]) => String.fromCodePoint(...codes);
  const hex = (code: number) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  const refused = (text: string) => WEBSITE_TEXT_FORBIDDEN_RE.test(text);
  /** The codes NOT refused inside the words, at their start and at their end. */
  const letThrough = (codes: readonly number[]) =>
    codes.filter((code) => ![`Closed${C(code)}today`, `${C(code)}Closed`, `Closed${C(code)}`].every(refused)).map(hex);

  it('refuses, anywhere in the words, the marks that turn the text’s direction: U+061C (an Urdu keyboard can type it), U+200E, U+200F, U+202A–U+202E, U+2066–U+2069', () => {
    const marks = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    expect(letThrough(marks)).toEqual([]);
  });

  it('refuses, anywhere in the words, the invisible characters: the zero-width space, the word joiner and invisible operators, the byte order mark, the soft hyphen, U+180E, the Arabic shaping controls, U+FFF9–U+FFFB and the tag characters', () => {
    const hidden = [
      0x200b, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff, 0x00ad, 0x180e,
      0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0xfff9, 0xfffa, 0xfffb,
      0xe0001, 0xe0020, 0xe0041, 0xe0067, 0xe007f,
    ];
    expect(letThrough(hidden)).toEqual([]);
    // A flag spelt with tag characters (England's) goes with them.
    expect(refused(`Closed ${C(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f)}`)).toBe(true);
  });

  it('lets through the zero-width non-joiner (an Urdu keyboard types it between letters that must not join) and the joiner (emoji are built with it: the chef)', () => {
    expect(letThrough([0x200c, 0x200d])).toEqual(['U+200C', 'U+200D']);
    // Made-up Urdu words with the non-joiner typed inside them.
    expect(refused(`نیا${C(0x200c)}مینو — آج${C(0x200c)}سے`)).toBe(false);
    // The chef (man U+200D cooking), the cook (woman U+200D cooking) and a family, in an announcement.
    expect(refused(`New chef ${C(0x1f468, 0x200d, 0x1f373)} and cook ${C(0x1f469, 0x200d, 0x1f373)}`)).toBe(false);
    expect(refused(C(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467))).toBe(false);
  });

  it('refuses EVERY format character Unicode has (Cf) and every control character (Cc), and the line and paragraph separators — all but the non-joiner and the joiner; nothing else', () => {
    const cf = /^\p{Cf}$/u;
    const cc = /^\p{Cc}$/u;
    const wrong: string[] = [];
    let formats = 0;
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue; // halves of a pair, not characters
      const ch = C(code);
      if (cf.test(ch)) formats += 1;
      const refuse = (cc.test(ch) || cf.test(ch) || code === 0x2028 || code === 0x2029) && code !== 0x200c && code !== 0x200d;
      if (refused(`a${ch}b`) !== refuse) wrong.push(hex(code));
    }
    expect(wrong).toEqual([]);
    // Not a short list: Unicode 15 already has 170 format characters.
    expect(formats).toBeGreaterThanOrEqual(170);
  });

  it('keeps every Urdu letter: in U+0600–U+06FF only its format characters are refused (the number signs U+0600–U+0605, the letter mark U+061C, the end of a verse U+06DD — none is a letter)', () => {
    const inBlock: string[] = [];
    for (let code = 0x0600; code <= 0x06ff; code += 1) if (refused(`a${C(code)}b`)) inBlock.push(hex(code));
    expect(inBlock).toEqual(['U+0600', 'U+0601', 'U+0602', 'U+0603', 'U+0604', 'U+0605', 'U+061C', 'U+06DD']);
    // Beside the refused ones: a hair space, a hyphen, a medium space, an unassigned code, U+FEFE, a full-width "!".
    expect([0x200a, 0x2010, 0x205f, 0x2065, 0xfefe, 0xff01].filter((code) => refused(`a${C(code)}b`)).map(hex)).toEqual([]);
    expect(refused('بند ہے — کل کھلے گا')).toBe(false);
  });

  it('refuses control characters — a line break or tab, NUL, DEL, a C1 control — and the line/paragraph separators; plain words, Urdu, dashes and emoji are fine', () => {
    for (const code of [10, 13, 9, 0, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0x2028, 0x2029]) {
      expect({ code: hex(code), refused: refused(`a${C(code)}b`) }).toEqual({ code: hex(code), refused: true });
    }
    for (const good of ['Closed for Eid — back on Monday', 'عید مبارک', 'Rs 1,000 minimum: “made-up”', `${C(0x1f355)} New: a made-up pizza`, '']) {
      expect({ good, refused: refused(good) }).toEqual({ good, refused: false });
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
