/**
 * Settings → Online orders' two cards on the ONE key 'online.options'
 * (format 2, v0.7.30): "Publish the menu to the website by itself" and
 * "Website messages & smallest delivery order" (sweep B1). What is typed ↔
 * the setting's value, and the words.
 *
 * Each card saves the WHOLE value (the key is one row), keeping the other
 * card's part exactly as it is, always in this version's format — a value
 * v0.7.29 saved (format 1) is saved again as format 2. Each card's "Put back
 * the default" puts back ITS part only (onlineOptionsPart). The main process
 * checks every value again with the key's schema; this says what is wrong
 * before Save in the same words (the same schema runs here).
 */
import { onlineOptionsSchema } from '@cheeseoclock/shared-schemas';
import { formatCents } from '@cheeseoclock/pos-domain';
import {
  ANNOUNCEMENT_MAX,
  CLOSED_NOTICE_MAX,
  DEFAULT_ONLINE_OPTIONS,
  MIN_DELIVERY_ORDER_MAX_CENTS,
  SHOP_SETTING_FORMAT,
  closedNoticeInForce,
  karachiDateOf,
  type OnlineOptions,
  type ShopSettingCard,
} from '@cheeseoclock/shared-types';
import { centsFromRupeesText } from './foodpandaWords';
import type { Parsed } from './foodpandaForm';

/** The two cards on 'online.options'. */
export type OnlineOptionsPart = 'publish' | 'messages';

/** The whole value in this version's format, with `change` over what is saved. */
export function onlineOptionsWith(current: OnlineOptions, change: Partial<Omit<OnlineOptions, 'v'>>): OnlineOptions {
  return {
    v: SHOP_SETTING_FORMAT['online.options'],
    autoPublishMenu: current.autoPublishMenu,
    closedNotice: { ...current.closedNotice },
    announcement: { ...current.announcement },
    minDeliveryOrderCents: current.minDeliveryOrderCents,
    ...change,
  };
}

/** One card's part of the value, at its default; the other card's part kept. */
export function putBackPart(current: OnlineOptions, part: OnlineOptionsPart): OnlineOptions {
  const d = DEFAULT_ONLINE_OPTIONS;
  return part === 'publish'
    ? onlineOptionsWith(current, { autoPublishMenu: d.autoPublishMenu })
    : onlineOptionsWith(current, {
        closedNotice: { ...d.closedNotice },
        announcement: { ...d.announcement },
        minDeliveryOrderCents: d.minDeliveryOrderCents,
      });
}

/** Is this card's part at its default (the "Default" badge, whether "Put back" does anything)? */
export function partIsDefault(value: OnlineOptions, part: OnlineOptionsPart): boolean {
  const d = DEFAULT_ONLINE_OPTIONS;
  if (part === 'publish') return value.autoPublishMenu === d.autoPublishMenu;
  return (
    value.closedNotice.text === d.closedNotice.text &&
    value.closedNotice.until === d.closedNotice.until &&
    value.announcement.on === d.announcement.on &&
    value.announcement.text === d.announcement.text &&
    value.minDeliveryOrderCents === d.minDeliveryOrderCents
  );
}

/**
 * The card as ONE part of the key shows it: its own "Default" badge, and a
 * "Put back the default" that writes only its part (the other card's part
 * is kept). History and "last changed" are the key's.
 */
export function onlineOptionsPart(
  card: ShopSettingCard<'online.options'>,
  part: OnlineOptionsPart,
): ShopSettingCard<'online.options'> {
  return {
    ...card,
    isDefault: !card.readOnly && partIsDefault(card.value, part),
    defaultValue: putBackPart(card.value, part),
  };
}

// ------------------------------------------------------------ publish by itself --

/** The "publish by itself" card's Save: its answer, the rest as saved. */
export function autoPublishValue(current: OnlineOptions, on: boolean): OnlineOptions {
  return onlineOptionsWith(current, { autoPublishMenu: on });
}

// --------------------------------------------------------------- the messages --

export interface WebsiteMessagesForm {
  noticeText: string;
  /** 'YYYY-MM-DD' (the date box), or '' for no end date. */
  noticeUntil: string;
  announcementOn: boolean;
  announcementText: string;
  /** Whole rupees as typed; '' or 0 = no smallest order. */
  minimum: string;
}

export function websiteMessagesToForm(o: OnlineOptions): WebsiteMessagesForm {
  return {
    noticeText: o.closedNotice.text,
    noticeUntil: o.closedNotice.until ?? '',
    announcementOn: o.announcement.on,
    announcementText: o.announcement.text,
    minimum: o.minDeliveryOrderCents > 0 ? String(o.minDeliveryOrderCents / 100) : '',
  };
}

/** One line of words as it is saved: the ends trimmed. */
const line = (t: string) => t.trim();

/**
 * The value the messages card saves, or what is wrong. A notice's last day
 * may not be in the past when the notice is being changed (`todayKarachi`,
 * the Karachi date now); one saved earlier that has since ended stays
 * saveable with the rest (it simply shows no more). With no words the notice
 * has no end date.
 */
export function websiteMessagesFromForm(
  f: WebsiteMessagesForm,
  saved: OnlineOptions,
  todayKarachi: string,
): Parsed<OnlineOptions> {
  const text = line(f.noticeText);
  const until = text === '' ? null : f.noticeUntil.trim() === '' ? null : f.noticeUntil.trim();
  const noticeChanged = text !== saved.closedNotice.text || until !== saved.closedNotice.until;
  if (until !== null && noticeChanged && until < todayKarachi) {
    return { value: null, problem: 'The notice’s last day has passed — pick today or a later day, or no end date.' };
  }
  const cents = centsFromRupeesText(f.minimum);
  if (cents !== null && (!Number.isFinite(cents) || cents > MIN_DELIVERY_ORDER_MAX_CENTS)) {
    return {
      value: null,
      problem: `The smallest delivery order is whole rupees from Rs 0 to ${formatCents(MIN_DELIVERY_ORDER_MAX_CENTS)} (empty = no smallest order).`,
    };
  }
  const value = onlineOptionsWith(saved, {
    closedNotice: { text, until },
    announcement: { on: f.announcementOn, text: line(f.announcementText) },
    minDeliveryOrderCents: cents ?? 0,
  });
  const parsed = onlineOptionsSchema.safeParse(value);
  if (!parsed.success) return { value: null, problem: parsed.error.issues[0]?.message ?? 'Check the website messages.' };
  return { value, problem: null };
}

/** "3 Oct 2026" for a 'YYYY-MM-DD'. */
export function dayWords(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(t)) return ymd;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Where the closed notice stands at `nowMs`: "No closed notice…", "Shows
 * every night the website is closed (no end date)", "Shows while the
 * website is closed, up to and including 3 Oct 2026", "Ended on 3 Oct 2026…".
 */
export function closedNoticeStatus(notice: OnlineOptions['closedNotice'], nowMs: number): string {
  if (notice.text.trim() === '') return 'No closed notice: while the website is closed it says what it always has.';
  if (notice.until === null) return 'No end date: it shows every night the website is closed (the website closes by itself when the last shift closes).';
  return closedNoticeInForce(notice, nowMs) !== null
    ? `Shows while the website is closed, up to and including ${dayWords(notice.until)} (Karachi time). After that the website’s own words come back by themselves.`
    : `Ended on ${dayWords(notice.until)}: the website says what it always has. Clear it, or give it a new last day.`;
}

/** The "publish by itself" card's part, in one line (its History and its "Put back" question). */
export function autoPublishSummary(o: OnlineOptions): string {
  return o.autoPublishMenu ? 'The menu goes to the website by itself' : 'The menu goes to the website when published';
}

/** The whole key in one line (both cards' parts). */
export function onlineOptionsSummary(o: OnlineOptions): string {
  return `${autoPublishSummary(o)} · ${websiteMessagesSummary(o)}`;
}

/** The messages card's part, in one line. */
export function websiteMessagesSummary(o: OnlineOptions): string {
  const parts: string[] = [];
  const n = o.closedNotice;
  parts.push(n.text === '' ? 'no closed notice' : n.until ? `closed notice until ${dayWords(n.until)}` : 'closed notice, no end date');
  parts.push(o.announcement.on ? 'announcement on' : 'no announcement');
  parts.push(
    o.minDeliveryOrderCents > 0
      ? `smallest website delivery ${formatCents(o.minDeliveryOrderCents)}`
      : 'no smallest delivery order',
  );
  return parts.join(', ');
}

/** What the minimum does, with the value typed (or today's: none). */
export function minimumExample(cents: number): string {
  if (!(cents > 0)) return 'No smallest order: the website takes a delivery of any size (as today).';
  const under = Math.max(0, cents - 100);
  return `A website delivery with ${formatCents(under)} of food is refused — the checkout says to add ${formatCents(cents - under)} more. ${formatCents(cents)} of food or more goes through. A pick-up of any size always goes through.`;
}

/** The card's rules in the owner's words (every limit from its constant). */
export const WEBSITE_MESSAGES_RULES = {
  notice: `The website’s words while it is closed: one line, up to ${CLOSED_NOTICE_MAX} letters (for example “Closed for Eid — back on Monday”). The WhatsApp and call buttons stay. Empty = the website’s own words.`,
  noticeUntil:
    'The last day it shows (Karachi time). With no end date the notice shows every night the website is closed — the website closes by itself when the last shift closes.',
  announcement: `A line on the website’s home page and menu page while it is on, up to ${ANNOUNCEMENT_MAX} letters (for example a new item or a holiday). It never goes into the page titles or Google’s listing.`,
  minimum:
    'The smallest website DELIVERY order, in whole rupees: the food, before tax and the delivery charge. Pick-up is never refused, and orders rung up at the till (phone, WhatsApp, walk-in) are not checked.',
  reaches:
    'A Save reaches the website by itself in a few seconds — only these words and the delivery areas, never menu changes you have not published.',
} as const;

/** Today's Karachi date (the date box's earliest day). */
export function todayInKarachi(nowMs: number = Date.now()): string {
  return karachiDateOf(nowMs);
}
