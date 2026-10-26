import { getShopFacts } from '@/lib/site-facts';
import { getStoreStatus } from '@/lib/store-status';
import { answersKind, readCall, signatureOk } from '@/lib/whatsapp-webhook';
import { autoReplyOn, autoReplyText, orderLinkUrl, sendText } from '@/lib/whatsapp-send';
import {
  claimAutoReply,
  createLink,
  recordBotMessage,
  recordInbound,
  recordStaffMessage,
  releaseAutoReply,
} from '@/lib/whatsapp-store';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

/**
 * Meta's WhatsApp webhook for the shop's number (lib/whatsapp-store, 26 Oct 2026).
 *
 * GET  Meta checks the address once, when it is saved in the app (Use cases → WhatsApp → Configuration): it sends
 *      WHATSAPP_VERIFY_TOKEN back, and gets its challenge echoed.
 * POST Every customer message, and every message staff send from the phone app (coexistence echoes), signed with
 *      the app secret (META_APP_SECRET). Each is kept once; a customer's first message of the shop's day gets the
 *      bot's reply with their order link, while WHATSAPP_AUTO_REPLY is on.
 *
 * A 500 makes Meta try again later (it retries for days); every write is keyed by WhatsApp's message id, so a retry
 * never counts or answers anything twice.
 */
export function GET(req: Request): Response {
  const q = new URL(req.url).searchParams;
  const want = process.env['WHATSAPP_VERIFY_TOKEN'];
  if (q.get('hub.mode') === 'subscribe' && want && q.get('hub.verify_token') === want) {
    return new Response(q.get('hub.challenge') ?? '', { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  return new Response('forbidden', { status: 403 });
}

/** A message older than this (a retry long after it was sent) is kept but not answered. */
const ANSWER_WITHIN_MS = 15 * 60_000;

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();
  if (!signatureOk(raw, req.headers.get('x-hub-signature-256'), process.env['META_APP_SECRET'])) {
    console.warn('whatsapp webhook: bad or missing signature');
    return new Response('bad signature', { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const call = readCall(body);
  try {
    // Staff first: a reply they sent in the same call holds the bot back.
    for (const m of call.staff) await recordStaffMessage(m);
    for (const m of call.inbound) {
      const fresh = await recordInbound(m);
      const now = new Date();
      if (!fresh || !answersKind(m.kind) || now.getTime() - m.at.getTime() > ANSWER_WITHIN_MS || !autoReplyOn()) continue;
      if (!(await claimAutoReply(m.waId, now))) continue;
      const [shop, store, token] = await Promise.all([getShopFacts(), getStoreStatus(), createLink(m.waId)]);
      const sent = await sendText({
        phoneNumberId: m.phoneNumberId,
        to: m.waId,
        body: autoReplyText({ shop, open: store.acceptingOrders, link: orderLinkUrl(token), profileName: m.profileName }),
        token: process.env['WHATSAPP_ACCESS_TOKEN']!,
      });
      if (sent.ok) {
        await recordBotMessage({ messageId: sent.messageId, waId: m.waId, at: new Date() });
      } else {
        console.error('whatsapp auto-reply not sent', sent.error);
        await releaseAutoReply(m.waId, now);
      }
    }
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('whatsapp webhook failed', e);
    return new Response('error', { status: 500 });
  }
}
