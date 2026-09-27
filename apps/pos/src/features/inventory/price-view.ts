/**
 * How Inventory says prices (costing spec Phase 4, D15: plain words): the
 * price per kg / litre / piece, where it came from (a chip), up or down on
 * the price before, and the "Set price" entry — Rs X per kg, for a pack of
 * N, or per piece — read into the exact pack the till keeps. Pure, so the
 * wording and the arithmetic are tested.
 */
import {
  formatCents,
  isWeighedUnit,
  packInUnit,
  priceChangeBps,
  priceEntryChoices,
  thousandSize,
  thousandWord,
  typedPricePack,
  unitCostMc,
  type Pack,
} from '@cheeseoclock/pos-domain';
import type { IngredientPriceTag, PriceHistoryEntry, PriceKind, PriceSource } from '@cheeseoclock/shared-types';
import { formatUnitPrice, parseRupees } from '../costing/costingFormat';

// ---------------------------------------------------------------------------
// Where a price came from
// ---------------------------------------------------------------------------

export type ChipTone = 'stone' | 'sky' | 'emerald' | 'violet' | 'amber';

/** The chip beside a price: where it came from, in the owner's words. */
export const SOURCE_CHIP: Record<PriceSource, { label: string; tone: ChipTone; hint: string }> = {
  seed: { label: 'Starting price', tone: 'stone', hint: 'The price it had when the till started keeping price history' },
  manual: { label: 'Typed', tone: 'sky', hint: 'Typed in by a manager or the owner' },
  delivery: { label: 'Bill', tone: 'emerald', hint: 'From a delivery, at its bill' },
  purchase: { label: 'Bill', tone: 'emerald', hint: 'From a purchase, at what was paid' },
  import: { label: 'Sheet', tone: 'violet', hint: 'From the costing sheet, through the menu file' },
  batch: { label: 'Batch', tone: 'amber', hint: 'Made here: worked out from what goes into it' },
  convert: { label: 'Unit change', tone: 'stone', hint: 'The same price, now counted in grams / ml' },
};

// ---------------------------------------------------------------------------
// A price, and its change
// ---------------------------------------------------------------------------

/** "Rs 375 / kg", "Rs 40 / pcs", "free", "no price yet". */
export function priceText(p: { unitCostMc: number; unit: string; priceKind: PriceKind }): string {
  if (p.priceKind === 'unset') return 'no price yet';
  if (p.priceKind === 'free') return 'free';
  return formatUnitPrice(p.unitCostMc, p.unit);
}

/** "6,000 g for Rs 2,250" when bought in packs of more than one, else null. */
export function packText(p: { packSize: number; packPriceCents: number; unit: string; priceKind: PriceKind }): string | null {
  if (p.priceKind === 'unset' || p.priceKind === 'free' || p.packSize <= 1) return null;
  if (thousandSize(p.unit) === p.packSize) return null; // "Rs 375 / kg" says it already
  return `${new Intl.NumberFormat('en-PK').format(p.packSize)} ${p.unit} for ${formatCents(p.packPriceCents)}`;
}

export interface PriceChange {
  /** "▲ 10%", "▼ 2.5%", "same", "was free". */
  text: string;
  tone: 'up' | 'down' | 'same';
}

/** Up or down on the price before (per base unit, in the same unit); null when there was none. */
export function priceChange(prevUnitCostMc: number | null, unitCostMc: number, priceKind: PriceKind): PriceChange | null {
  if (prevUnitCostMc === null || priceKind === 'unset') return null;
  if (prevUnitCostMc === 0) return unitCostMc > 0 ? { text: 'was free', tone: 'up' } : null;
  const bps = priceChangeBps(prevUnitCostMc, unitCostMc);
  if (bps === null) return null;
  if (bps === 0) return { text: 'same', tone: 'same' };
  const pct = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 1 }).format(Math.abs(bps) / 100);
  return bps > 0 ? { text: `▲ ${pct}%`, tone: 'up' } : { text: `▼ ${pct}%`, tone: 'down' };
}

/** The price column's figures from the newest history entry. */
export function tagView(tag: IngredientPriceTag): { price: string; pack: string | null; change: PriceChange | null } {
  return {
    price: priceText(tag),
    pack: packText(tag),
    change: tag.source === 'convert' ? null : priceChange(tag.prevUnitCostMc, tag.unitCostMc, tag.priceKind),
  };
}

// ---------------------------------------------------------------------------
// The history, as a line
// ---------------------------------------------------------------------------

export interface PricePoint {
  at: number;
  /** One base unit of the ingredient's unit NOW, in millicents (entries kept in kg before a Convert are turned into g). */
  unitCostMc: number;
  label: string;
}

/**
 * When an entry's price came in, for the drawer: the starting price is in
 * force from the start (its effectiveAt is the start of time), so it says
 * so, with the day price history began on this till.
 */
export function whenText(e: Pick<PriceHistoryEntry, 'source' | 'effectiveAt' | 'recordedAt'>): { main: string; sub: string | null } {
  if (e.source === 'seed') return { main: 'From the start', sub: `history began ${dayText(e.recordedAt)}` };
  return { main: dateTimeText(e.effectiveAt), sub: null };
}

const dayText = (iso: string) => new Date(iso).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeText = (iso: string) =>
  new Date(iso).toLocaleString('en-PK', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * The history (newest first, as the drawer gets it) as points oldest first,
 * every price in the ingredient's unit now; unpriced entries and ones whose
 * unit does not convert are left off the line. The starting price sits at
 * the day history began (never after a later change: the other till may
 * have begun later).
 */
export function historyPoints(entries: readonly PriceHistoryEntry[], unitNow: string): PricePoint[] {
  const out: PricePoint[] = [];
  for (const e of [...entries].reverse()) {
    if (e.priceKind === 'unset') continue;
    const pack = packInUnit({ size: e.packSize, priceCents: e.packPriceCents }, e.unit, unitNow);
    if (pack === null) continue;
    const mc = unitCostMc(pack);
    out.push({ at: Date.parse(e.source === 'seed' ? e.recordedAt : e.effectiveAt), unitCostMc: mc, label: formatUnitPrice(mc, unitNow) });
  }
  for (let i = out.length - 2; i >= 0; i--) out[i]!.at = Math.min(out[i]!.at, out[i + 1]!.at);
  return out;
}

// ---------------------------------------------------------------------------
// "Set price": what was typed, as the exact pack
// ---------------------------------------------------------------------------

export type PricePer = 'thousand' | 'pack' | 'piece';

export interface PriceEntry {
  per: PricePer;
  /** Rs X as typed. */
  rupees: string;
  /** N for a pack, as typed. */
  packSize: string;
  guess: boolean;
  free: boolean;
}

/** "per kg", "per litre", "for a pack", "per piece". */
export function perLabel(per: PricePer, unit: string): string {
  if (per === 'thousand') return `per ${thousandWord(unit) ?? 'kg'}`;
  if (per === 'pack') return 'for a pack';
  return 'per piece';
}

/** The ways this unit can be priced, in the order offered. */
export function perChoices(unit: string): PricePer[] {
  return priceEntryChoices(unit);
}

/** Paisa as it would be typed: 37500 → "375", 15550 → "155.5". */
export function rupeesInput(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const part = Math.abs(cents % 100);
  return part === 0 ? String(whole) : `${whole}.${String(part).padStart(2, '0').replace(/0$/, '')}`;
}

/** The entry a price opens with: the way it is kept now ("Rs 375 per kg", "12 for Rs 10", "Rs 40 per piece"). */
export function initialPriceEntry(i: {
  unit: string;
  costPerUnitCents: number;
  packSize: number | null;
  packPriceCents: number | null;
  priceKind: PriceKind;
}): PriceEntry {
  const weighed = isWeighedUnit(i.unit);
  const base: PriceEntry = { per: weighed ? 'thousand' : 'piece', rupees: '', packSize: '', guess: i.priceKind === 'estimate', free: i.priceKind === 'free' };
  if (i.priceKind === 'unset' || i.priceKind === 'free') return base;
  const big = thousandSize(i.unit);
  if (i.packSize && i.packSize > 0 && i.packPriceCents !== null) {
    if (weighed && i.packSize === big) return { ...base, per: 'thousand', rupees: rupeesInput(i.packPriceCents) };
    if (!weighed && i.packSize === 1) return { ...base, per: 'piece', rupees: rupeesInput(i.packPriceCents) };
    return { ...base, per: 'pack', rupees: rupeesInput(i.packPriceCents), packSize: String(i.packSize) };
  }
  // A cost per unit typed the old way: per kg is 1,000 of them (whole paisa × 1,000 is still whole).
  if (weighed && big !== null) return { ...base, per: 'thousand', rupees: rupeesInput(i.costPerUnitCents * big) };
  return { ...base, rupees: rupeesInput(i.costPerUnitCents) };
}

export type PriceEntryReading =
  | { ok: true; free: true }
  | { ok: true; free: false; pack: Pack; unitCostMc: number; priceKind: 'set' | 'estimate' }
  | { ok: false; empty: boolean; problem: string };

/** What the "Set price" boxes say, as the exact pack; or what is wrong, in plain words. */
export function readPriceEntry(e: PriceEntry, unit: string): PriceEntryReading {
  if (e.free) return { ok: true, free: true };
  const text = e.rupees.trim();
  if (text === '') return { ok: false, empty: true, problem: `Type the price in rupees, ${perLabel(e.per, unit)}.` };
  const cents = parseRupees(text);
  if (cents === null) return { ok: false, empty: false, problem: 'Type a price like 375 or 375.50.' };
  if (cents === 0) return { ok: false, empty: false, problem: 'Rs 0 is no price: tick "Free" if it costs nothing.' };
  let packSize: number | null = null;
  if (e.per === 'pack') {
    const t = e.packSize.trim().replace(/,/g, '');
    if (!/^\d{1,9}$/.test(t) || Number(t) < 1) return { ok: false, empty: false, problem: `Say how much one pack holds, in whole ${unit}.` };
    packSize = Number(t);
  }
  try {
    const pack = typedPricePack({ per: e.per, priceCents: cents, packSize }, unit);
    return { ok: true, free: false, pack, unitCostMc: unitCostMc(pack), priceKind: e.guess ? 'estimate' : 'set' };
  } catch (err) {
    return { ok: false, empty: false, problem: err instanceof Error ? err.message : String(err) };
  }
}
