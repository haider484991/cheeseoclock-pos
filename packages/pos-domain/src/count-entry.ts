/**
 * The stock-take count sheet (costing spec Phase 8): a cook counts what is on
 * the shelf in the way it is easiest to see — kilos or litres ("2.35"),
 * whole packs plus what is loose ("3 packs + 250 g"), or plain grams / ml /
 * pieces — and the till keeps whole base units (stock is an INTEGER). Pure,
 * so every way of typing is tested.
 */
import { normalizeUnit } from './units.js';

/** How a line is typed: base units, the bigger unit (kg / litres), or packs + loose base units. */
export type CountEntryMode = 'base' | 'big' | 'packs';

export interface CountEntry {
  mode: CountEntryMode;
  /** Base units, kg / litres, or whole packs — as typed. */
  amount: string;
  /** 'packs' only: loose base units besides the packs (blank = none). */
  loose?: string;
}

/** The most one line may hold (a typing slip, not a count). */
export const MAX_COUNT_QTY = 100_000_000;

/** The bigger unit a weighed base unit is counted in: g → kg, ml → litres. */
export function bigUnitOf(unit: string): { label: 'kg' | 'litres'; factor: 1000 } | null {
  const u = normalizeUnit(unit);
  if (u === 'g') return { label: 'kg', factor: 1000 };
  if (u === 'ml') return { label: 'litres', factor: 1000 };
  return null;
}

/** The ways a line of this unit (and pack) can be typed, the easiest first. */
export function countEntryModes(unit: string, packSize: number | null): CountEntryMode[] {
  const modes: CountEntryMode[] = [];
  if (bigUnitOf(unit)) modes.push('big');
  if (packSize !== null && packSize > 1) modes.push('packs');
  modes.push('base');
  return modes;
}

export type CountEntryResult =
  /** A count, in base units; null when the line was left blank. */
  | { ok: true; qty: number | null }
  | { ok: false; message: string };

const WHOLE = /^\d+$/;
const DECIMAL = /^(\d+)(?:\.(\d*))?$|^\.(\d+)$/;
/** "2,500" or "12,000": commas between thousands, as a whole number is often written. */
const THOUSANDS = /^\d{1,3}(?:,\d{3})+$/;
/** "1,250.5": commas between thousands with a point after them — nothing else it can mean. */
const THOUSANDS_THEN_POINT = /^\d{1,3}(?:,\d{3})+\.\d*$/;
/** "2,5" or "2,25": a comma where the point goes (as many phones and scales write it). */
const DECIMAL_COMMA = /^\d+,\d{1,2}$/;

/**
 * A box as typed, commas read the one way they can be meant — never simply
 * dropped (that read "2,5" kg as 25 kg):
 *  - kilos / litres: a comma before one or two digits is the point ("2,5" is
 *    2.5); commas between thousands only with a point after them
 *    ("1,250.5"); any other comma is refused (is "2,500" 2.5 kg or 2,500 kg?);
 *  - whole grams, pieces or packs: commas between thousands ("2,500") go;
 *    any other comma is refused.
 */
function clean(s: string | undefined, big: boolean): { ok: true; text: string } | { ok: false } {
  const t = (s ?? '').trim();
  if (!t.includes(',')) return { ok: true, text: t };
  if (big) {
    if (DECIMAL_COMMA.test(t)) return { ok: true, text: t.replace(',', '.') };
    return THOUSANDS_THEN_POINT.test(t) ? { ok: true, text: t.replace(/,/g, '') } : { ok: false };
  }
  return THOUSANDS.test(t) ? { ok: true, text: t.replace(/,/g, '') } : { ok: false };
}

/**
 * What a typed line comes to in base units. Blank is "not counted" (null),
 * never 0: an empty box must not zero an ingredient. Kilos take up to three
 * decimals (to the gram); packs are whole, loose units whole.
 */
export function countEntryQty(e: CountEntry, unit: string, packSize: number | null): CountEntryResult {
  const u = normalizeUnit(unit);
  const big = e.mode === 'big' ? bigUnitOf(unit) : null;
  const a = clean(e.amount, big !== null);
  const l = clean(e.loose, false);
  if (!a.ok) return { ok: false, message: big ? `Use a point for part of a ${big.label === 'kg' ? 'kilo' : 'litre'}, like 2.5` : 'Type it without commas' };
  if (!l.ok) return { ok: false, message: `Type the loose ${u} without commas` };
  const amount = a.text;
  const loose = l.text;
  if (amount === '' && (e.mode !== 'packs' || loose === '')) return { ok: true, qty: null };
  let qty: number;
  switch (e.mode) {
    case 'base': {
      if (!WHOLE.test(amount)) return { ok: false, message: `Type whole ${u}` };
      qty = Number(amount);
      break;
    }
    case 'big': {
      const big = bigUnitOf(unit);
      if (!big) return { ok: false, message: `${u} is not counted in kg or litres` };
      const m = DECIMAL.exec(amount);
      if (!m) return { ok: false, message: `Type the ${big.label}, like 2.5` };
      const whole = m[1] ?? '0';
      const frac = m[2] ?? m[3] ?? '';
      if (frac.length > 3) return { ok: false, message: `Up to 3 decimals: that is to the ${u}` };
      qty = Number(whole) * big.factor + Number(frac.padEnd(3, '0') || '0');
      break;
    }
    case 'packs': {
      if (packSize === null || !(packSize > 0)) return { ok: false, message: 'It has no pack size: count it another way' };
      if (amount !== '' && !WHOLE.test(amount)) return { ok: false, message: 'Type whole packs' };
      if (loose !== '' && !WHOLE.test(loose)) return { ok: false, message: `Type the loose ${u} as a whole number` };
      qty = Number(amount || '0') * packSize + Number(loose || '0');
      break;
    }
  }
  if (!Number.isSafeInteger(qty) || qty > MAX_COUNT_QTY) return { ok: false, message: 'That count is too large' };
  return { ok: true, qty };
}

/** 1234567 → "1,234,567". */
function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * What a box was read as, exactly — to the gram, never rounded — shown under
 * it so a slip ("2500" typed into a kilo box) is seen before the stock take
 * is finished: "= 7.25 kg", "= 250 g", "= 1,200 pcs".
 */
export function countReadBack(qty: number, unit: string): string {
  const big = bigUnitOf(unit);
  if (big && Math.abs(qty) >= big.factor) {
    const whole = Math.trunc(qty / big.factor);
    const frac = Math.abs(qty % big.factor);
    const decimals = frac === 0 ? '' : `.${String(frac).padStart(3, '0').replace(/0+$/, '')}`;
    return `= ${grouped(whole)}${decimals} ${big.label === 'kg' ? 'kg' : 'L'}`;
  }
  return `= ${grouped(qty)} ${unit}`;
}

/** A saved count shown again in a mode (what the box is filled with when the sheet reopens). */
export function countEntryOf(qty: number | null, mode: CountEntryMode, unit: string, packSize: number | null): CountEntry {
  if (qty === null) return { mode, amount: '', loose: '' };
  if (mode === 'big' && bigUnitOf(unit)) {
    const whole = Math.floor(qty / 1000);
    const frac = qty % 1000;
    return { mode, amount: frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(3, '0').replace(/0+$/, '')}` };
  }
  if (mode === 'packs' && packSize !== null && packSize > 1) {
    return { mode, amount: String(Math.floor(qty / packSize)), loose: String(qty % packSize) };
  }
  return { mode: 'base', amount: String(qty), loose: '' };
}
