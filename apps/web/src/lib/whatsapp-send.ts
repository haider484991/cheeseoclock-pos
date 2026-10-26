import { GRAPH_VERSION } from './meta-capi';
import { SITE_URL } from './seo';
import { shopHoursInSentence, shopNameProse, type ShopFacts } from './shop-facts';

/**
 * The bot's one message a day to a customer who writes to the shop on WhatsApp (the user, 26 Oct 2026: "Bot, first
 * message a day"): hello, and their personal order link (/menu?wa=TOKEN), sent through Meta's Cloud API. A customer
 * who wrote in the last 24 hours may be answered free of charge (a service conversation).
 *
 * It sends only while WHATSAPP_AUTO_REPLY is "on" (the owner approves the words first) and with
 * WHATSAPP_ACCESS_TOKEN (the shop's system user, WhatsApp permissions). Without them the chats are still kept.
 */

export function autoReplyOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['WHATSAPP_AUTO_REPLY'] === 'on' && Boolean(env['WHATSAPP_ACCESS_TOKEN']);
}

/** The customer's personal order link. */
export function orderLinkUrl(token: string): string {
  return `${SITE_URL}/menu?wa=${token}`;
}

/** "Ali" from a WhatsApp name like "Ali Raza": a first name of letters only, else nothing (names can be anything). */
export function greetingName(profileName: string | null): string | null {
  const first = profileName?.trim().split(/\s+/)[0] ?? '';
  return /^\p{L}{2,20}$/u.test(first) ? first : null;
}

/** The reply's words: open, the link to order now; closed, the hours and the link for later. */
export function autoReplyText(o: { shop: ShopFacts; open: boolean; link: string; profileName: string | null }): string {
  const name = greetingName(o.profileName);
  const hello = `Assalam o Alaikum${name ? ` ${name}` : ''}!`;
  if (o.open) {
    return [
      `${hello} ${shopNameProse(o.shop)} mein khush aamdeed 🧀`,
      'Apna order is link se karein, seedha kitchen mein jata hai. Aapka naam aur number pehle se bhara hoga:',
      o.link,
      'Koi sawal ho to yahin message karein.',
    ].join('\n');
  }
  return [
    `${hello} Abhi hum band hain (${shopHoursInSentence(o.shop)}) 🧀`,
    'Menu dekh lein, aur khulte hi isi link se order karein:',
    o.link,
  ].join('\n');
}

export type SendResult = { ok: true; messageId: string } | { ok: false; error: string };

/** One text message from the shop's number to a customer. Never throws: a failure is an answer. */
export async function sendText(o: {
  phoneNumberId: string;
  to: string;
  body: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<SendResult> {
  try {
    const res = await (o.fetchImpl ?? fetch)(`https://graph.facebook.com/${GRAPH_VERSION}/${o.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: o.to,
        type: 'text',
        text: { body: o.body, preview_url: true },
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => null)) as { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } } | null;
    const id = json?.messages?.[0]?.id;
    if (res.ok && id) return { ok: true, messageId: id };
    return { ok: false, error: `${res.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? 'no message id'}`.trim() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
