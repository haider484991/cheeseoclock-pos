import { sql } from './db';
import { GRAPH_VERSION } from './meta-capi';
import { probeThenCreate } from './schema-on-demand';
import { orderLine, shopHoursInSentence, type ShopFacts } from './shop-facts';

/**
 * Comment auto-replies (26 Oct 2026, the user: "Comment auto-replies"): a question under the shop's Facebook posts,
 * its ads' posts or its Instagram posts ("price?", "menu", "delivery kahan?") gets a reply pointing to the WhatsApp
 * ordering bot; an obvious scam comment ("account recovery", crypto) is hidden — hidden, never deleted. Each comment
 * is acted on once (comment_actions); comments older than LOOKBACK_MS and the shop's own are left alone.
 *
 * A sweep runs at most every SWEEP_EVERY_MS, started by the till's order polls and WhatsApp's webhook calls
 * (waitUntil: never in their way). It needs META_PAGE_TOKEN (the Page's token, from the shop's system user: it never
 * expires), META_PAGE_ID and, for Instagram, META_IG_USER_ID; COMMENT_REPLIES must be "on".
 */
export const SWEEP_EVERY_MS = 3 * 60_000;
export const LOOKBACK_MS = 48 * 60 * 60_000;
const POSTS_PER_SOURCE = 15;

/** Scams that sit under small businesses' posts: account "recovery", hackers, crypto, loans, foreign numbers. */
const SCAM =
  /\b(recover(y|ing)?|hack(ed|er|ers)?|crypto|bitcoin|btc|forex|binary option|invest(ment|ing)?|earn \$|loan|cash ?app|t\.me\/|telegram|customer ?care|giveaway winner)\b|\+1[\s(]*\d{3}/i;
/** A customer asking something we answer on WhatsApp: prices, the menu, ordering, delivery, where, when. */
const QUESTION =
  /\?|\b(price|prices|rate|rates|kitna|kitne|kitni|kitny|menu|order|deliver|delivery|location|address|kahan|kidhar|timing|timings|open|khula|number|contact|whats ?app|deal|deals|available|inbox|dm|details?|kaise|how much)\b/i;

export type CommentAction = 'reply' | 'hide' | 'none';

/** What to do with a comment's words. */
export function actionFor(text: string): CommentAction {
  if (SCAM.test(text)) return 'hide';
  if (QUESTION.test(text)) return 'reply';
  return 'none';
}

/** The reply: WhatsApp the order line with "menu" (no web address: the shop's posts carry none). */
export function replyText(shop: ShopFacts): string {
  return `Assalam o Alaikum! 🧀 Menu aur prices WhatsApp par: ${orderLine(shop).display} par *menu* likh kar bhejein, wahin order ho jayega. Delivery DHA & Clifton (${shopHoursInSentence(shop)}).`;
}

export interface CommentConfig {
  pageToken: string;
  pageId: string;
  igUserId: string | null;
}

export function commentConfig(env: Record<string, string | undefined> = process.env): CommentConfig | null {
  const pageToken = (env['META_PAGE_TOKEN'] ?? '').trim();
  const pageId = (env['META_PAGE_ID'] ?? '').trim();
  if (env['COMMENT_REPLIES'] !== 'on' || !pageToken || !/^\d+$/.test(pageId)) return null;
  const ig = (env['META_IG_USER_ID'] ?? '').trim();
  return { pageToken, pageId, igUserId: /^\d+$/.test(ig) ? ig : null };
}

let ready: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ready) {
    ready = probeThenCreate(() => sql()`SELECT at FROM comment_sweeps LIMIT 0`, async () => {
      await sql()`
        CREATE TABLE IF NOT EXISTS comment_actions (
          comment_id TEXT PRIMARY KEY,
          platform   TEXT NOT NULL,
          action     TEXT NOT NULL,
          at         TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql()`
        CREATE TABLE IF NOT EXISTS comment_sweeps (
          id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          at TIMESTAMPTZ NOT NULL
        )
      `;
    }).catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

/** Takes this sweep if none ran in the last SWEEP_EVERY_MS (one statement: two callers at once get one sweep). */
async function claimSweep(now: Date): Promise<boolean> {
  const before = new Date(now.getTime() - SWEEP_EVERY_MS).toISOString();
  const rows = (await sql()`
    INSERT INTO comment_sweeps (id, at) VALUES (1, ${now.toISOString()})
    ON CONFLICT (id) DO UPDATE SET at = EXCLUDED.at WHERE comment_sweeps.at < ${before}
    RETURNING id
  `) as unknown[];
  return rows.length > 0;
}

/** Claims acting on this comment; false when it was acted on (or looked at) before. */
async function claimComment(id: string, platform: 'facebook' | 'instagram', action: CommentAction): Promise<boolean> {
  const rows = (await sql()`
    INSERT INTO comment_actions (comment_id, platform, action) VALUES (${id}, ${platform}, ${action})
    ON CONFLICT (comment_id) DO NOTHING RETURNING comment_id
  `) as unknown[];
  return rows.length > 0;
}

interface Comment {
  id: string;
  text: string;
  at: Date;
  platform: 'facebook' | 'instagram';
}

type Graph = (method: 'GET' | 'POST', path: string, params?: Record<string, string>) => Promise<Record<string, unknown>>;

function graphWith(token: string, fetchImpl: typeof fetch): Graph {
  return async (method, path, params = {}) => {
    const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
    const body = new URLSearchParams(params);
    if (method === 'GET') for (const [k, v] of body) url.searchParams.set(k, v);
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `OAuth ${token}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(method === 'POST' ? { body } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || json['error']) throw new Error(`${path}: ${String((json['error'] as { message?: string } | undefined)?.message ?? res.status)}`);
    return json;
  };
}

const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);

/** The recent comments under the Page's posts, its ads' posts and its Instagram posts — not the shop's own. */
async function recentComments(g: Graph, c: CommentConfig, since: Date): Promise<Comment[]> {
  const out: Comment[] = [];
  const fbPosts = new Set<string>();
  for (const edge of ['posts', 'ads_posts']) {
    const r = await g('GET', `${c.pageId}/${edge}`, { fields: 'id', limit: String(POSTS_PER_SOURCE), ...(edge === 'ads_posts' ? { include_inline_create: 'true' } : {}) });
    for (const p of list(r['data'])) if (typeof p['id'] === 'string') fbPosts.add(p['id']);
  }
  for (const post of fbPosts) {
    const r = await g('GET', `${post}/comments`, { fields: 'id,message,created_time,from', limit: '25', filter: 'stream', order: 'reverse_chronological' });
    for (const k of list(r['data'])) {
      const at = new Date(String(k['created_time']));
      const from = (k['from'] as { id?: string } | undefined)?.id;
      if (at >= since && from !== c.pageId && typeof k['id'] === 'string') {
        out.push({ id: k['id'], text: String(k['message'] ?? ''), at, platform: 'facebook' });
      }
    }
  }
  if (c.igUserId) {
    const me = await g('GET', c.igUserId, { fields: 'username' });
    const media = await g('GET', `${c.igUserId}/media`, { fields: 'id,timestamp', limit: String(POSTS_PER_SOURCE) });
    for (const m of list(media['data'])) {
      const r = await g('GET', `${String(m['id'])}/comments`, { fields: 'id,text,timestamp,username', limit: '25' });
      for (const k of list(r['data'])) {
        const at = new Date(String(k['timestamp']));
        if (at >= since && k['username'] !== me['username'] && typeof k['id'] === 'string') {
          out.push({ id: k['id'], text: String(k['text'] ?? ''), at, platform: 'instagram' });
        }
      }
    }
  }
  return out;
}

/** One sweep, if one is due. Never throws; resolves to what it did. */
export async function sweepComments(
  shop: () => Promise<ShopFacts>,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ replied: number; hidden: number; skipped?: string; error?: string }> {
  const c = commentConfig();
  if (!c) return { replied: 0, hidden: 0, skipped: 'off' };
  let replied = 0;
  let hidden = 0;
  try {
    await ensureTables();
    if (!(await claimSweep(now))) return { replied, hidden, skipped: 'not due' };
    const g = graphWith(c.pageToken, fetchImpl);
    const comments = await recentComments(g, c, new Date(now.getTime() - LOOKBACK_MS));
    let words: string | null = null;
    for (const k of comments) {
      const action = actionFor(k.text);
      if (!(await claimComment(k.id, k.platform, action)) || action === 'none') continue;
      if (action === 'hide') {
        await g('POST', k.id, k.platform === 'facebook' ? { is_hidden: 'true' } : { hide: 'true' });
        hidden++;
      } else {
        words ??= replyText(await shop());
        await g('POST', k.platform === 'facebook' ? `${k.id}/comments` : `${k.id}/replies`, { message: words });
        replied++;
      }
    }
    return { replied, hidden };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error('comment sweep failed', error);
    return { replied, hidden, error };
  }
}
