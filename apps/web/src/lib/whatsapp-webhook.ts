import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WaAd, WaInbound } from './whatsapp-store';

/**
 * Meta's WhatsApp webhook (api/whatsapp/webhook), read: the signature it signs every call with, and the messages in
 * a call. Pure — the route does the storing and the replying.
 */

/**
 * Meta signs each call's raw body with the app secret: `X-Hub-Signature-256: sha256=<hex>`. Anything else — no
 * header, no secret configured, another app's signature — is not Meta writing to us.
 */
export function signatureOk(rawBody: string, header: string | null, appSecret: string | undefined): boolean {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  const want = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

/** A message staff sent from the WhatsApp Business app on the phone. */
export interface WaStaffMessage {
  messageId: string;
  waId: string;
  kind: string;
  at: Date;
}

/**
 * What the customer wrote or tapped, for the ordering bot (lib/whatsapp-bot) to act on in this call only — never
 * stored: the text of a text message, the id and title of a button or list row they tapped.
 */
export interface WaSaid {
  text: string | null;
  reply: { id: string; title: string } | null;
}

/** What one webhook call says: customers' messages (with the shop number they wrote to) and staff's. */
export interface WaCall {
  inbound: Array<WaInbound & WaSaid & { phoneNumberId: string }>;
  staff: WaStaffMessage[];
}

/** Message kinds that are not someone writing to the shop: kept, never answered. */
const NOT_A_MESSAGE = new Set(['reaction', 'system', 'unsupported', 'ephemeral', 'errors']);

/** Does this kind of message get the day's automatic reply? A reaction or a system notice does not. */
export function answersKind(kind: string): boolean {
  return !NOT_A_MESSAGE.has(kind);
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
/** WhatsApp numbers are digits only, country code first (923001234567). */
const waIdOf = (v: unknown): string | null => (typeof v === 'string' && /^\d{8,15}$/.test(v) ? v : null);

/** A message's time: Meta's Unix seconds, else now. */
function atOf(v: unknown): Date {
  const s = Number(v);
  return Number.isFinite(s) && s > 0 ? new Date(s * 1000) : new Date();
}

/** The ad a Click-to-WhatsApp chat came from: the referral's ad id, headline, link and click id. */
function adOf(v: unknown): WaAd | null {
  const r = obj(v);
  if (!r) return null;
  const ad: WaAd = {
    id: r['source_type'] === 'ad' ? text(r['source_id'], 40) : null,
    headline: text(r['headline'], 200),
    sourceUrl: text(r['source_url'], 500),
    ctwaClid: text(r['ctwa_clid'], 200),
  };
  return ad.id || ad.headline || ad.sourceUrl || ad.ctwaClid ? ad : null;
}

/** The words of a text message, or of a template's quick-reply button. */
function textOf(m: Obj): string | null {
  return text(obj(m['text'])?.['body'], 1000) ?? text(obj(m['button'])?.['text'], 200);
}

/** A tapped reply button or list row (an interactive message's answer). */
function replyOf(m: Obj): { id: string; title: string } | null {
  const i = obj(m['interactive']);
  const r = obj(i?.['button_reply']) ?? obj(i?.['list_reply']);
  const id = text(r?.['id'], 200);
  return id ? { id, title: text(r?.['title'], 100) ?? '' } : null;
}

/** Reads one webhook call. Anything it does not know (statuses, history, account updates) is left out. */
export function readCall(body: unknown): WaCall {
  const call: WaCall = { inbound: [], staff: [] };
  const root = obj(body);
  if (!root || root['object'] !== 'whatsapp_business_account') return call;
  for (const entry of list(root['entry'])) {
    for (const change of list(obj(entry)?.['changes'])) {
      const c = obj(change);
      const value = obj(c?.['value']);
      if (!c || !value) continue;
      if (c['field'] === 'messages') {
        const phoneNumberId = text(obj(value['metadata'])?.['phone_number_id'], 40);
        if (!phoneNumberId) continue;
        const names = new Map<string, string>();
        for (const contact of list(value['contacts'])) {
          const k = obj(contact);
          const id = waIdOf(k?.['wa_id']);
          const name = text(obj(k?.['profile'])?.['name'], 80);
          if (id && name) names.set(id, name);
        }
        for (const message of list(value['messages'])) {
          const m = obj(message);
          const waId = waIdOf(m?.['from']);
          const messageId = text(m?.['id'], 200);
          if (!m || !waId || !messageId) continue;
          call.inbound.push({
            phoneNumberId,
            messageId,
            waId,
            profileName: names.get(waId) ?? null,
            kind: text(m['type'], 30) ?? 'unknown',
            at: atOf(m['timestamp']),
            ad: adOf(m['referral']),
            text: textOf(m),
            reply: replyOf(m),
          });
        }
      } else if (c['field'] === 'smb_message_echoes') {
        // Coexistence: what staff send from the phone app comes back as an echo, addressed to the customer.
        for (const echo of list(value['message_echoes'])) {
          const m = obj(echo);
          const waId = waIdOf(m?.['to']);
          const messageId = text(m?.['id'], 200);
          if (!m || !waId || !messageId) continue;
          call.staff.push({ messageId, waId, kind: text(m['type'], 30) ?? 'unknown', at: atOf(m['timestamp']) });
        }
      }
    }
  }
  return call;
}
