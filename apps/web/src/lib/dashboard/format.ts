import { formatCents } from '@/lib/format';

/**
 * The dashboard's words for numbers and times. Money goes through the
 * site's one formatter (lib/format formatCents); times are Karachi's, with
 * Intl doing the words (never a typed "1 pm").
 */

/** An exact amount. A negative zero (nothing short, say) is zero: never "Rs -0". */
export function money(cents: number): string {
  return formatCents(cents || 0);
}

/**
 * Whole rupees, for a headline figure or a summary tile (the till's "This
 * week" card does the same): the paisa a 15% tax leaves is noise at that
 * size. Lists, receipts and the drawer keep the exact amount (money).
 */
export function moneyWhole(cents: number): string {
  // || 0: a few paisa short round to a negative zero, which is shown as zero.
  const wholeRupeesInCents = Math.round(cents / 100) * 100 || 0;
  return formatCents(wholeRupeesInCents);
}

/** A signed difference: the amount with + or − in front (nothing in front of zero). */
export function signedMoney(cents: number): string {
  if (cents === 0) return formatCents(cents);
  return `${cents > 0 ? '+' : '−'}${formatCents(Math.abs(cents))}`;
}

/** A short amount for an axis: "48k", "1.2M", "850". */
export function compactRupees(cents: number): string {
  const r = Math.round(cents / 100);
  const a = Math.abs(r);
  if (a >= 1_000_000) return `${(r / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (a >= 1_000) return `${(r / 1_000).toFixed(a >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(r);
}

export function count(n: number): string {
  return n.toLocaleString('en-GB');
}

/** A count with its word: "1 order", "5 orders", "1,204 orders". */
export function counted(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** A share as a whole percent ("34%"), or "–" with nothing to share. */
export function percent(part: number, whole: number): string {
  if (!(whole > 0)) return '–';
  return `${Math.round((part / whole) * 100)}%`;
}

/** Basis points as a percent with one decimal ("28.9%"). */
export function bpsPercent(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps)) return '–';
  return `${(bps / 100).toFixed(1)}%`;
}

/** The change from `before` to `now` as a percent, or null when there is nothing to compare. */
export function changePercent(now: number, before: number): number | null {
  if (!(before > 0)) return null;
  return Math.round(((now - before) / before) * 100);
}

const TIME = new Intl.DateTimeFormat('en-PK', { timeZone: 'Asia/Karachi', hour: 'numeric', minute: '2-digit', hour12: true });
const DAY_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Karachi',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const FULL = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Karachi',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** "9:41 pm" in Karachi. */
export function clock(iso: string | Date | null | undefined): string {
  if (!iso) return '–';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return TIME.format(d).replace(/\s?([AP])M$/i, (_m, x: string) => ` ${x.toLowerCase()}m`);
}

/** "Wed 8 Oct, 9:41 pm" in Karachi. */
export function dayClock(iso: string | Date | null | undefined): string {
  if (!iso) return '–';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return `${DAY_TIME.format(d)}, ${clock(d)}`;
}

export function fullDay(iso: string | Date): string {
  return FULL.format(iso instanceof Date ? iso : new Date(iso));
}

/** "just now", "4 min ago", "2 h ago", "3 days ago". */
export function ago(iso: string | Date | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'never';
  const t = (iso instanceof Date ? iso : new Date(iso)).getTime();
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** "12 min", "1 h 5 min" — how long something has been waiting. */
export function waited(fromIso: string | null | undefined, now: Date = new Date()): string {
  if (!fromIso) return '–';
  const m = Math.max(0, Math.round((now.getTime() - new Date(fromIso).getTime()) / 60_000));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The hour of the day as Karachi says it ("1 pm", "12 am"), from 0–23. */
export function hourWord(h: number): string {
  const suffix = h < 12 ? 'am' : 'pm';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${suffix}`;
}

/** A quantity of stock in its unit, readable: 2,500 g → "2.5 kg", 750 ml → "750 ml". */
export function stockQty(qty: number, unit: string): string {
  const u = unit.trim().toLowerCase();
  const round = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-GB') : String(Math.round(n * 100) / 100));
  if ((u === 'g' || u === 'ml') && Math.abs(qty) >= 1000) return `${round(qty / 1000)} ${u === 'g' ? 'kg' : 'l'}`;
  return `${round(qty)} ${unit}`;
}

/** Order number for people: the till's "20261008-0042" → "#42" (with the day when it isn't today). */
export function orderNo(number: string): string {
  const m = /^(\d{8})-(\d+)$/.exec(number);
  if (!m) return number;
  return `#${Number(m[2])}`;
}

export const CHANNEL_WORDS: Record<string, string> = {
  takeaway: 'Takeaway',
  delivery: 'Delivery',
  web_pickup: 'Website pick-up',
  web_delivery: 'Website delivery',
  foodpanda: 'foodpanda',
  dine_in: 'Dine-in',
  online: 'Online',
};

export const CAME_BY_WORDS: Record<string, string> = {
  walk_in: 'Walk-in',
  phone: 'Phone call',
  whatsapp: 'WhatsApp',
  website: 'Website',
  foodpanda: 'foodpanda',
  not_asked: 'Not asked',
};

export const METHOD_WORDS: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  easypaisa: 'EasyPaisa',
  jazzcash: 'JazzCash',
  bank_transfer: 'Bank transfer',
  foodpanda: 'foodpanda',
};

export const STATUS_WORDS: Record<string, string> = {
  open: 'Not sent yet',
  sent_to_kitchen: 'In the kitchen',
  preparing: 'Preparing',
  ready: 'Ready',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  served: 'Handed over',
  paid: 'Done',
  void: 'Cancelled',
  refunded: 'Refunded',
};

/** The till's own words for the profit steps (apps/pos reports/profitFormat.ts PROFIT_STEP_LABEL). */
export const PROFIT_STEP_WORDS: Record<string, string> = {
  sales: 'Sales before tax',
  food_cost: 'Food cost',
  unknown_cost: 'Sales with an unknown cost (left out)',
  waste: 'Waste',
  sent_not_paid: 'Food sent out, not paid',
  stock_loss: 'Stock that went missing',
  commission: 'foodpanda commission and fees',
  uplift: 'foodpanda price uplift (estimated)',
  payment_fees: 'Card and wallet fees',
  rider: 'Rider cost',
};

/** A waste reason's words: the till's released names, and the two the Reports add. */
export function wasteWord(reason: string, released: Readonly<Record<string, string>>): string {
  if (reason === 'cancelled_made') return 'Made, then cancelled';
  if (reason === 'test_order') return 'Test orders';
  return released[reason] ?? reason.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
