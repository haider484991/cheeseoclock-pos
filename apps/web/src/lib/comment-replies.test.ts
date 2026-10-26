/**
 * Comment auto-replies (lib/comment-replies, 26 Oct 2026): a question under a Facebook post, an ad's post or an
 * Instagram post gets one reply pointing to WhatsApp; a scam comment is hidden; the shop's own comments, old ones and
 * plain praise are left alone; a sweep runs at most every 3 minutes and never acts on a comment twice.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHOP_FACTS } from './shop-facts';

const db = vi.hoisted(() => ({ pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> } }));
vi.mock('@/lib/db', () => ({
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows),
}));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const { actionFor, replyText, sweepComments } = await import('./comment-replies');

const PAGE = '1338194859379616';
const IG = '17841422775965235';
const NOW = new Date('2026-10-26T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

/** The Graph API as the sweep sees it: the Page's posts and ads' posts, their comments, Instagram, and what it posts. */
const posted: Array<{ path: string; body: Record<string, string> }> = [];
const fakeFetch = (async (input: URL | string, init: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v[\d.]+\//, '');
  if (init.method === 'POST') {
    posted.push({ path, body: Object.fromEntries(new URLSearchParams(String(init.body))) });
    return Response.json({ success: true, id: 'new' });
  }
  const answers: Record<string, unknown> = {
    [`${PAGE}/posts`]: { data: [{ id: `${PAGE}_post1` }] },
    [`${PAGE}/ads_posts`]: { data: [{ id: `${PAGE}_ad1` }, { id: `${PAGE}_post1` }] },
    [`${PAGE}_post1/comments`]: {
      data: [
        { id: 'fb-q', message: 'Mega box kitne ka hai?', created_time: hoursAgo(1), from: { id: '999' } },
        { id: 'fb-praise', message: 'Bohot tasty tha 😍', created_time: hoursAgo(2), from: { id: '998' } },
        { id: 'fb-own', message: 'Order on WhatsApp?', created_time: hoursAgo(1), from: { id: PAGE } },
        { id: 'fb-old', message: 'Price?', created_time: hoursAgo(72), from: { id: '997' } },
      ],
    },
    [`${PAGE}_ad1/comments`]: { data: [{ id: 'fb-scam', message: 'Message Ctech recovery on facebook directly for your old instagram account recovery', created_time: hoursAgo(3), from: { id: '996' } }] },
    [IG]: { username: 'cheeseoclock.karachi' },
    [`${IG}/media`]: { data: [{ id: 'ig-m1', timestamp: hoursAgo(20) }] },
    ['ig-m1/comments']: {
      data: [
        { id: 'ig-q', text: 'Delivery Clifton mein hai?', timestamp: hoursAgo(1), username: 'ali.k' },
        { id: 'ig-own', text: 'Menu in bio?', timestamp: hoursAgo(1), username: 'cheeseoclock.karachi' },
      ],
    },
  };
  return Response.json(answers[path] ?? { data: [] });
}) as unknown as typeof fetch;

beforeAll(async () => {
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  Object.assign(process.env, { COMMENT_REPLIES: 'on', META_PAGE_TOKEN: 'page-token', META_PAGE_ID: PAGE, META_IG_USER_ID: IG });
});

describe('comment auto-replies', () => {
  it('questions get a reply, scams are hidden, the rest is left alone', () => {
    for (const q of ['Price?', 'menu bhejein', 'Delivery DHA phase 2 mein hoti hai', 'kitne ka hai', 'Inbox details', 'Timing kya hai']) {
      expect(actionFor(q), q).toBe('reply');
    }
    for (const s of ['Message Ctech recovery on facebook', 'Earn $500 a day with crypto', 'Contact +1 (555) 201 3344 hacker']) {
      expect(actionFor(s), s).toBe('hide');
    }
    for (const n of ['Bohot tasty tha 😍', 'Best pizza in DHA', '🔥🔥']) expect(actionFor(n), n).toBe('none');
  });

  it('the reply points to WhatsApp with the shop’s own number and hours, and no web address', () => {
    const text = replyText(DEFAULT_SHOP_FACTS);
    expect(text).toContain('0300 9367865');
    expect(text).toContain('*menu*');
    expect(text).not.toMatch(/https?:|\.net|\.com/);
  });

  it('one sweep: replies to the two questions (Facebook and Instagram), hides the scam, once; the next is not due', async () => {
    const shop = vi.fn(async () => DEFAULT_SHOP_FACTS);
    expect(await sweepComments(shop, NOW, fakeFetch)).toEqual({ replied: 2, hidden: 1 });
    expect(posted.map((p) => [p.path, Object.keys(p.body).join()])).toEqual([
      ['fb-q/comments', 'message'],
      ['fb-scam', 'is_hidden'],
      ['ig-q/replies', 'message'],
    ]);
    expect(posted[1]!.body).toEqual({ is_hidden: 'true' });
    expect(await sweepComments(shop, new Date(NOW.getTime() + 60_000), fakeFetch)).toMatchObject({ skipped: 'not due' });
    // Due again later: the same comments are not answered twice.
    expect(await sweepComments(shop, new Date(NOW.getTime() + 4 * 60_000), fakeFetch)).toEqual({ replied: 0, hidden: 0 });
    expect(posted).toHaveLength(3);
  });

  it('switched off: nothing is read', async () => {
    process.env['COMMENT_REPLIES'] = 'off';
    expect(await sweepComments(async () => DEFAULT_SHOP_FACTS, NOW, fakeFetch)).toMatchObject({ skipped: 'off' });
    process.env['COMMENT_REPLIES'] = 'on';
  });
});
