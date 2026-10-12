/**
 * Vouchers (v0.7.48, shared-types vouchers.ts): the pure maths the till, the
 * Vouchers page and the main process share — reading a typed number and
 * code, reading a pasted list of them, making new codes, the rule frozen on
 * a voucher's discount row, and which line a voucher comes off and how much.
 */
import {
  isDeliveryChargeLine,
  VOUCHER_CODE_LENGTH,
  VOUCHER_CODE_LETTERS,
  VOUCHER_SIZES,
  type VoucherFor,
  type VoucherNumberAndCode,
  type VoucherRule,
  type VoucherSize,
  type VoucherTerms,
} from '@cheeseoclock/shared-types';

// ------------------------------------------------------------- the words --

/** A voucher's number as printed: 1 → "001", 1234 → "1234". */
export function voucherNumberText(n: number): string {
  return String(n).padStart(3, '0');
}

/** What a voucher's discount row is called on the bill (its reason): "Voucher No. 001 · abhi". */
export function voucherBillReason(number: number, batchName: string): string {
  return `Voucher No. ${voucherNumberText(number)} · ${batchName}`;
}

// ------------------------------------------------------ what was typed --

/** A code as typed, the way it is stored: capitals, no spaces or dashes ("ab3c" / "AB 3C" → "AB3C"). */
export function normalizeVoucherCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s\-–—_.]/g, '');
}

/** A code the till takes: 3 to 12 letters and digits. */
export function isVoucherCode(code: string): boolean {
  return /^[A-Z0-9]{3,12}$/.test(code);
}

/** A number as typed ("001", "No. 7", "#12") → 1, 7, 12; null when it is not a whole number above 0. */
export function parseVoucherNumber(raw: string): number | null {
  const t = raw.trim().replace(/^(?:no\.?|#)\s*/i, '');
  if (!/^\d{1,6}$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

/** What a pasted list of vouchers reads as. */
export interface VoucherListRead {
  /** Each line that reads, in the list's order. */
  vouchers: VoucherNumberAndCode[];
  /** Lines with something on them that did not read as a number and a code (a heading, say). */
  skipped: string[];
  /** Numbers on more than one line. */
  repeatedNumbers: number[];
  /** Codes on more than one line. */
  repeatedCodes: string[];
}

const SEPARATED = /^(?:NO\.?\s*)?#?\s*(\d{1,6})\s*[\s,;:|.\-–—]+\s*([A-Z0-9]{3,12})(?![A-Z0-9])/;
const GLUED = /^(\d{1,6})([A-Z0-9]+)$/;

/**
 * A list of vouchers pasted from a sheet or the printer's file, or a CSV
 * file chosen on Add vouchers (v0.7.49), one a line: "001 AB3C", "1, AB3C",
 * "001	AB3C" (a spreadsheet's two columns), "001;AB3C", "\"001\",\"AB3C\""
 * (a CSV's quotes are dropped). Anything after the code is left (the paper
 * log's empty columns, a CSV's other columns). A number and code
 * run together, as some PDFs copy them ("029CY7N"), read as the code's last
 * VOUCHER_CODE_LENGTH letters and the number before them. Lines that don't
 * read — a heading — are skipped and listed, so nothing is dropped unseen.
 */
export function parseVoucherList(text: string): VoucherListRead {
  const vouchers: VoucherNumberAndCode[] = [];
  const skipped: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/["']/g, '').trim().toUpperCase();
    if (line === '') continue;
    const sep = SEPARATED.exec(line);
    if (sep) {
      const number = Number(sep[1]);
      if (number > 0) {
        vouchers.push({ number, code: sep[2]! });
        continue;
      }
    }
    const compact = line.replace(/\s+/g, '');
    const glued = GLUED.exec(compact);
    if (glued && compact.length > VOUCHER_CODE_LENGTH) {
      const digits = compact.slice(0, compact.length - VOUCHER_CODE_LENGTH);
      const code = compact.slice(compact.length - VOUCHER_CODE_LENGTH);
      const number = /^\d+$/.test(digits) ? Number(digits) : 0;
      if (number > 0 && isVoucherCode(code)) {
        vouchers.push({ number, code });
        continue;
      }
    }
    skipped.push(raw.trim());
  }
  return {
    vouchers,
    skipped,
    repeatedNumbers: repeated(vouchers.map((v) => v.number)),
    repeatedCodes: repeated(vouchers.map((v) => v.code)),
  };
}

function repeated<T>(xs: readonly T[]): T[] {
  const seen = new Set<T>();
  const twice = new Set<T>();
  for (const x of xs) (seen.has(x) ? twice : seen).add(x);
  return [...twice];
}

/**
 * `count` new codes of VOUCHER_CODE_LENGTH letters from VOUCHER_CODE_LETTERS,
 * none of them in `taken` (every live voucher's code) and none twice.
 * `random` returns [0, 1) — Math.random, or a fixed one in tests. Throws when
 * it can't find enough (never with the letters there are).
 */
export function makeVoucherCodes(count: number, taken: ReadonlySet<string>, random: () => number = Math.random): string[] {
  const out: string[] = [];
  const used = new Set(taken);
  let tries = 0;
  while (out.length < count) {
    if (++tries > count * 50 + 1000) throw new Error('Could not make enough new codes');
    let code = '';
    for (let i = 0; i < VOUCHER_CODE_LENGTH; i++) {
      code += VOUCHER_CODE_LETTERS[Math.floor(random() * VOUCHER_CODE_LETTERS.length) % VOUCHER_CODE_LETTERS.length];
    }
    if (used.has(code)) continue;
    used.add(code);
    out.push(code);
  }
  return out;
}

/** Is a voucher with this last day over on `tradingDay` (YYYY-MM-DD)? No last day: never. */
export function voucherEnded(goodUntil: string | null, tradingDay: string): boolean {
  return goodUntil !== null && tradingDay > goodUntil;
}

// --------------------------------------------------------------- the rule --

/**
 * The rule frozen on a voucher's discount row: a till discount on the food
 * only, never on a value deal (an older till reads exactly that), carrying
 * the voucher's terms.
 */
export function voucherRule(terms: VoucherTerms): VoucherRule {
  return { kind: 'discount_base', v: 1, alsoOffDeliveryCharge: false, from: 'till', skipsNoDiscountLines: true, voucher: terms };
}

const isWhole = (n: unknown, lo: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= lo;
const isId = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 64;

/** A voucher row's rule_json back as a rule, or null when it is not a voucher this version reads. */
export function parseVoucherRule(json: string | null | undefined): VoucherRule | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['kind'] !== 'discount_base' || r['v'] !== 1 || typeof r['alsoOffDeliveryCharge'] !== 'boolean') return null;
  const o = r['voucher'];
  if (typeof o !== 'object' || o === null) return null;
  const t = o as Record<string, unknown>;
  if (t['v'] !== 1 || !isId(t['id']) || !isId(t['batchId']) || !isId(t['lineId'])) return null;
  if (!isWhole(t['number'], 1) || !isWhole(t['coversCents'], 1)) return null;
  if (typeof t['batchName'] !== 'string' || typeof t['gives'] !== 'string') return null;
  // What it was for (v0.7.50): absent = any food item; one this version can't read = not a voucher it reads.
  const forRaw = t['for'];
  const forTerms = forRaw === undefined ? null : readVoucherFor(forRaw);
  if (forRaw !== undefined && forTerms === null) return null;
  return voucherRule({
    v: 1,
    id: t['id'],
    batchId: t['batchId'],
    number: t['number'],
    batchName: t['batchName'],
    gives: t['gives'],
    coversCents: t['coversCents'],
    ...(forTerms ? { for: forTerms } : {}),
    lineId: t['lineId'],
  });
}

/** A VoucherFor read from stored JSON (its own object, or for_json's), or null when it does not read. */
function readVoucherFor(raw: unknown): VoucherFor | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  const cats = f['categoryIds'];
  if (!Array.isArray(cats) || cats.length > 50 || !cats.every(isId) || new Set(cats).size !== cats.length) return null;
  const size = f['size'];
  if (size !== null && !(VOUCHER_SIZES as readonly unknown[]).includes(size)) return null;
  if (typeof f['wholeItem'] !== 'boolean') return null;
  return { categoryIds: [...(cats as string[])], size: size as VoucherSize | null, wholeItem: f['wholeItem'] };
}

/** voucher_batches.for_json as stored (format 1). */
export function voucherForJson(f: VoucherFor): string {
  return JSON.stringify({ v: 1, categoryIds: f.categoryIds, size: f.size, wholeItem: f.wholeItem });
}

/** voucher_batches.for_json back; null when there is none (any food item) or it is not format 1. */
export function parseVoucherForJson(json: string | null | undefined): VoucherFor | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as unknown;
    if (typeof raw !== 'object' || raw === null || (raw as Record<string, unknown>)['v'] !== 1) return null;
    return readVoucherFor(raw);
  } catch {
    return null;
  }
}

// ------------------------------------------------ the line it comes off --

/** An order line as a voucher sees it. */
export interface VoucherLine {
  id: string;
  menuItemName: string;
  menuItemId?: string | null;
  quantity: number;
  lineTotalCents: number;
  /** One of the item at its menu price, without its choices (order_items.unit_price_cents); absent = not known. */
  unitPriceCents?: number;
  /** A value deal (order_items.no_discount): a voucher never comes off one. */
  noDiscount?: boolean;
  /** A line inside a combo: the combo's own line is the one sold. */
  parentOrderItemId?: string | null;
  /** The menu category its item is in now; absent = not known. */
  categoryId?: string | null;
}

/** One of the line's items, as sold (its choices included): the line's total over its quantity. */
export function voucherLineEachCents(line: Pick<VoucherLine, 'lineTotalCents' | 'quantity'>): number {
  return Math.floor(line.lineTotalCents / Math.max(1, line.quantity));
}

/** Can a voucher come off this line at all? Food the customer pays for: not a delivery charge, not a value deal, not inside a combo. */
export function voucherCanCover(line: VoucherLine): boolean {
  return (
    !line.parentOrderItemId &&
    line.noDiscount !== true &&
    line.lineTotalCents > 0 &&
    !isDeliveryChargeLine({ menuItemName: line.menuItemName, menuItemId: line.menuItemId ?? null })
  );
}

/** The size after the dash in an item's name, as the menu writes it ("Fajita Pizza — Large" → 'Large'); null = none. */
export function menuItemSize(name: string): VoucherSize | null {
  const m = /\s[—–-]\s*(medium|large)\s*$/i.exec(name);
  if (!m) return null;
  return m[1]!.toLowerCase() === 'large' ? 'Large' : 'Medium';
}

/**
 * Does a line fit what a voucher is for (v0.7.50)? Food it can come off at
 * all, in one of its categories (none named = any) and of its size (null =
 * any). A batch with no rule (added before 0.7.50): any food line.
 */
export function voucherFits(rule: VoucherFor | null | undefined, line: VoucherLine): boolean {
  if (!voucherCanCover(line)) return false;
  if (!rule) return true;
  if (rule.categoryIds.length > 0 && !(line.categoryId && rule.categoryIds.includes(line.categoryId))) return false;
  return rule.size === null || menuItemSize(line.menuItemName) === rule.size;
}

/**
 * What a voucher takes off a line: for the whole item (v0.7.50), one of the
 * item at its menu price — its extras paid; else one of the line's items as
 * sold, never more than the voucher covers.
 */
export function voucherAmountCents(
  terms: { coversCents: number; for?: VoucherFor | null },
  line: Pick<VoucherLine, 'lineTotalCents' | 'quantity' | 'unitPriceCents'>,
): number {
  const each = voucherLineEachCents(line);
  if (terms.for?.wholeItem) return Math.max(0, Math.min(each, line.unitPriceCents ?? each));
  return Math.max(0, Math.min(terms.coversCents, each));
}

/** The lines a voucher can come off (what it is for), each with what it would take off: the dearest first, then the till's order. */
export function voucherLinesFor(
  terms: { coversCents: number; for?: VoucherFor | null },
  lines: ReadonlyArray<VoucherLine>,
): Array<{ line: VoucherLine; amountCents: number }> {
  return lines
    .filter((l) => voucherFits(terms.for, l))
    .map((line) => ({ line, amountCents: voucherAmountCents(terms, line) }))
    .sort((a, b) => b.amountCents - a.amountCents);
}

/**
 * The line a voucher comes off now: the one it was put on, while it is on
 * the order and still fits; else — the cashier swapped the flavour — the
 * dearest line that fits what it is for (a voucher for a Large regular pizza
 * moves to the other Large regular pizza, never the drink). A voucher with no
 * rule (before 0.7.50) moves only within the menu category of the line it
 * was put on (`categoryId`). Null when there is none: the voucher comes off
 * the order and is free again.
 */
export function voucherLineOf(
  lineId: string,
  lines: ReadonlyArray<VoucherLine>,
  categoryId: string | null | undefined,
  terms: { coversCents: number; for?: VoucherFor | null } = { coversCents: 0 },
): VoucherLine | null {
  const own = lines.find((l) => l.id === lineId);
  if (own && voucherFits(terms.for, own)) return own;
  if (terms.for) return voucherLinesFor(terms, lines)[0]?.line ?? null;
  if (!categoryId) return null;
  let best: VoucherLine | null = null;
  for (const l of lines) {
    if (!voucherCanCover(l) || l.categoryId !== categoryId) continue;
    if (!best || voucherLineEachCents(l) > voucherLineEachCents(best)) best = l;
  }
  return best;
}
