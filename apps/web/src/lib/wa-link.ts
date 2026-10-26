import { readStored, writeStored } from './device-memory';

/**
 * The customer's personal WhatsApp order link (/menu?wa=TOKEN, lib/whatsapp-store, 26 Oct 2026), on the customer's
 * own phone: the menu keeps the token when the page opens with one, the checkout fills in the WhatsApp name and number
 * it belongs to and sends it with the order. Kept as long as the link lasts on the server (three days); a malformed
 * or older value reads as nothing.
 */
export const WA_LINK_KEY = 'coc.wa.link';
export const WA_LINK_KEEP_MS = 3 * 24 * 60 * 60_000;
const TOKEN = /^[A-Za-z0-9]{10,16}$/;

/** A token as the bot makes them, else null. */
export function readWaToken(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  return TOKEN.test(t) ? t : null;
}

export function serializeWaLink(token: string, now: number = Date.now()): string {
  return JSON.stringify({ t: token, at: now });
}

export function parseWaLink(raw: string | null, now: number = Date.now()): string | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { t?: unknown; at?: unknown };
    const at = typeof v.at === 'number' ? v.at : NaN;
    if (!(now - at >= 0 && now - at < WA_LINK_KEEP_MS)) return null;
    return readWaToken(typeof v.t === 'string' ? v.t : null);
  } catch {
    return null;
  }
}

/** The page opened with ?wa=TOKEN: keep it (a newer link replaces an older one). */
export function keepWaLinkFrom(search: string): void {
  const token = readWaToken(new URLSearchParams(search).get('wa'));
  if (token) writeStored(WA_LINK_KEY, serializeWaLink(token));
}

/** The link this phone was opened with in the last three days, or null. */
export function storedWaToken(): string | null {
  return parseWaLink(readStored(WA_LINK_KEY));
}
