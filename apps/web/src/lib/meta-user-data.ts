import { normalizePhone } from './format';
import { sha256Hex } from './sha256';

/**
 * The customer details Meta matches an order to a Facebook / Instagram account with ("advanced
 * matching"), the same in the browser (lib/meta-pixel, at the Purchase) and on the server
 * (lib/meta-capi): each one normalised the way Meta asks and then SHA-256 hashed here, so the
 * details themselves never leave the site — Meta gets only the hashes.
 *
 *  - ph: the mobile number, digits with the country code (0300 1234567 → 923001234567).
 *  - external_id: the same number's hash — this site's one id for a customer.
 *  - fn / ln: the first and the last word of the name, lowercase, letters only.
 *  - ct / st / country: Karachi, Sindh, Pakistan. Every order is one (the shop delivers in Karachi
 *    only, and a pick-up is collected there).
 *
 * Nothing else: never the address, the area, the notes or the social handle. An order with no
 * valid phone gives no details at all.
 */
export interface MetaUserData {
  ph: string;
  external_id: string;
  fn?: string;
  ln?: string;
  ct: string;
  st: string;
  country: string;
}

/** Meta's spelling of the shop's city, province and country, before hashing. */
const CITY = 'karachi';
const STATE = 'sindh';
const COUNTRY = 'pk';

/** A Pakistani mobile number as Meta matches it: country code and number, digits only. Null if it is not one. */
export function metaPhone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const e164 = normalizePhone(raw);
  return e164 === null ? null : e164.slice(1);
}

/** One word of a name as Meta matches it: lowercase letters only (any script), else null. */
function nameWord(word: string | undefined): string | null {
  if (word === undefined) return null;
  const cleaned = word.normalize('NFKC').toLowerCase().replace(/[^\p{L}]/gu, '');
  return cleaned === '' ? null : cleaned;
}

/** The first and (when there are two or more words) the last word of a name. */
export function metaNames(raw: string | null | undefined): { fn: string | null; ln: string | null } {
  const words = typeof raw === 'string' ? raw.trim().split(/\s+/).map(nameWord).filter((w) => w !== null) : [];
  return { fn: words[0] ?? null, ln: words.length >= 2 ? (words[words.length - 1] ?? null) : null };
}

/** The hashed details for one customer, or null when the phone is not a Pakistani mobile number. */
export function metaUserData(customer: { phone?: string | null; name?: string | null }): MetaUserData | null {
  const phone = metaPhone(customer.phone);
  if (phone === null) return null;
  const hashedPhone = sha256Hex(phone);
  const { fn, ln } = metaNames(customer.name);
  return {
    ph: hashedPhone,
    external_id: hashedPhone,
    ...(fn !== null ? { fn: sha256Hex(fn) } : {}),
    ...(ln !== null ? { ln: sha256Hex(ln) } : {}),
    ct: sha256Hex(CITY),
    st: sha256Hex(STATE),
    country: sha256Hex(COUNTRY),
  };
}
