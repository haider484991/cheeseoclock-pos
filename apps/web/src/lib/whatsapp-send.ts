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

/**
 * A message the shop sends: plain text, up to three reply buttons, or a list to pick one row from (WhatsApp's
 * interactive messages — free to send inside the 24 hours after the customer wrote, no template needed).
 */
export type WaOut =
  | { type: 'text'; body: string }
  /** A picture (a public https address WhatsApp fetches) with words under it: the bot's deal menu (28 Oct 2026). */
  | { type: 'image'; link: string; caption: string }
  /** Up to three tap buttons under the words; `image`: a picture on top (a public https address WhatsApp fetches). */
  | { type: 'buttons'; body: string; buttons: Array<{ id: string; title: string }>; footer?: string; image?: string }
  /** A map pin the customer taps to open in their map app: the shop, for a pick-up or "address kya hai?" (30 Oct 2026). */
  | { type: 'location'; lat: number; lng: number; name: string; address: string }
  | {
      type: 'list';
      body: string;
      button: string;
      sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>;
      footer?: string;
    };

/** WhatsApp refuses anything longer than its limits: cut to fit, with an ellipsis. */
export function fit(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** The Cloud API's body for one message (WhatsApp's limits: body 1024, button 20, row 24 + 72, section 24). */
export function payloadOf(to: string, m: WaOut): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  if (m.type === 'text') return { ...base, type: 'text', text: { body: fit(m.body, 4096), preview_url: true } };
  if (m.type === 'image') return { ...base, type: 'image', image: { link: m.link, caption: fit(m.caption, 1024) } };
  if (m.type === 'location') return { ...base, type: 'location', location: { latitude: m.lat, longitude: m.lng, name: fit(m.name, 100), address: fit(m.address, 300) } };
  const footer = m.footer ? { footer: { text: fit(m.footer, 60) } } : {};
  if (m.type === 'buttons') {
    return {
      ...base,
      type: 'interactive',
      interactive: {
        type: 'button',
        ...(m.image ? { header: { type: 'image', image: { link: m.image } } } : {}),
        body: { text: fit(m.body, 1024) },
        ...footer,
        action: { buttons: m.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: fit(b.id, 256), title: fit(b.title, 20) } })) },
      },
    };
  }
  let left = 10;
  const sections = m.sections
    .map((s) => {
      const rows = s.rows.slice(0, left).map((r) => ({
        id: fit(r.id, 200),
        title: fit(r.title, 24),
        ...(r.description ? { description: fit(r.description, 72) } : {}),
      }));
      left -= rows.length;
      return { title: fit(s.title, 24), rows };
    })
    .filter((s) => s.rows.length > 0)
    .slice(0, 10);
  return {
    ...base,
    type: 'interactive',
    interactive: { type: 'list', body: { text: fit(m.body, 1024) }, ...footer, action: { button: fit(m.button, 20), sections } },
  };
}

/** One text message from the shop's number to a customer. Never throws: a failure is an answer. */
export function sendText(o: { phoneNumberId: string; to: string; body: string; token: string; fetchImpl?: typeof fetch }): Promise<SendResult> {
  return sendMessage({ ...o, message: { type: 'text', body: o.body } });
}

/** One message of any kind from the shop's number to a customer. Never throws: a failure is an answer. */
export async function sendMessage(o: {
  phoneNumberId: string;
  to: string;
  message: WaOut;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<SendResult> {
  try {
    const res = await (o.fetchImpl ?? fetch)(`https://graph.facebook.com/${GRAPH_VERSION}/${o.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payloadOf(o.to, o.message)),
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
