/**
 * Settings → Delivery areas & fees → "Tax on the delivery charge" (owner,
 * 10 Oct 2026; shared-types delivery-charge-tax.ts): what is typed ↔ the
 * choice, and the card's words. The main process checks the choice again
 * (shared-schemas saveDeliveryChargeTaxInputSchema). Every number in the
 * words comes from the values.
 */
import { deliveryChargeTaxExample, deliveryChargeTaxRates, formatCents } from '@cheeseoclock/pos-domain';
import type {
  DeliveryChargeTaxCategory,
  DeliveryChargeTaxChoice,
  DeliveryChargeTaxSaved,
  DeliveryChargeTaxView,
} from '@cheeseoclock/shared-types';
import type { Parsed } from './foodpandaForm';

/** The card as typed: which choice, and for a rate of its own its two boxes (percent). */
export interface ChargeTaxForm {
  kind: DeliveryChargeTaxChoice['kind'] | null;
  /** "15", "7.5" — the rate in cash. */
  rate: string;
  /** The rate by card / wallet / bank; empty = the same as `rate`. */
  card: string;
}

/** 1500 → "15", 750 → "7.5", 1625 → "16.25". */
export function percentText(bps: number): string {
  return String(Number((bps / 100).toFixed(2)));
}

/** The form for what the charges carry now; the charges on different taxes: nothing picked (the owner picks). */
export function chargeTaxToForm(now: DeliveryChargeTaxChoice | null): ChargeTaxForm {
  if (now === null) return { kind: null, rate: '', card: '' };
  if (now.kind === 'rate') {
    return {
      kind: 'rate',
      rate: percentText(now.rateBps),
      card: now.digitalRateBps === null ? '' : percentText(now.digitalRateBps),
    };
  }
  return { kind: now.kind, rate: '', card: '' };
}

/** A percent box as basis points: "15" → 1500, "7.5%" → 750; up to two decimals, 0 to 100. Null: not a rate. */
export function bpsOfPercent(text: string): number | null {
  const t = text.trim().replace(/\s*%$/, '');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n <= 100 ? Math.round(n * 100) : null;
}

export function chargeTaxFromForm(f: ChargeTaxForm): Parsed<DeliveryChargeTaxChoice> {
  if (f.kind === null) return { value: null, problem: 'Pick how the delivery charge is taxed.' };
  if (f.kind !== 'rate') return { value: { kind: f.kind }, problem: null };
  const rateBps = bpsOfPercent(f.rate);
  if (rateBps === null) return { value: null, problem: 'Type the tax on the delivery charge: 0 to 100%.' };
  if (f.card.trim() === '') return { value: { kind: 'rate', rateBps, digitalRateBps: null }, problem: null };
  const card = bpsOfPercent(f.card);
  if (card === null) {
    return { value: null, problem: 'Type the tax when paid by card (0 to 100%), or leave that box empty.' };
  }
  return { value: { kind: 'rate', rateBps, digitalRateBps: card === rateBps ? null : card }, problem: null };
}

/** "15%", "15% (8% by card)", "no tax". */
export function ratesWords(rates: { rateBps: number; digitalRateBps: number | null }): string {
  const card = rates.digitalRateBps ?? rates.rateBps;
  if (rates.rateBps === 0 && card === 0) return 'no tax';
  const cash = `${percentText(rates.rateBps)}%`;
  return card === rates.rateBps ? cash : `${cash} (${percentText(card)}% by card)`;
}

/** The first option's words: "The same as the food — Test GST, 15% (8% by card)". */
export function foodOptionWords(food: DeliveryChargeTaxCategory | null): string {
  return food ? `The same as the food — ${food.name}, ${ratesWords(food)}` : 'The same as the food';
}

/**
 * The line under the title: what the charges carry now. On different taxes:
 * each one's fee and rate, and that Save puts them all on the one picked.
 */
export function chargeTaxNowWords(view: DeliveryChargeTaxView): string {
  if (view.charges.length === 0) {
    return 'No delivery charge yet: set a fee for an area below, then choose its tax here.';
  }
  const now = view.now;
  if (now === null) {
    const on = view.charges.filter((c) => c.isActive);
    const shown = on.length > 0 ? on : view.charges;
    const each = shown.map((c) => `${formatCents(c.feeCents)} at ${ratesWords(c.tax)}`).join(', ');
    return `Now the delivery charges are taxed differently: ${each}. Save puts every one on the tax you pick.`;
  }
  if (now.kind === 'food') return `Now: ${ratesWords(view.food!)}, the same as the food (${view.food!.name}).`;
  if (now.kind === 'none') return 'Now: no tax on the delivery charge.';
  return `Now: ${ratesWords(now)}, a rate of its own.`;
}

/**
 * The worked example on the lowest fee that is on: "Rs 200 delivery charge
 * + 15% tax (Rs 30) = Rs 230 on the bill. Paid by card: 8% tax (Rs 16) =
 * Rs 216." Null when there is no charge or nothing is picked yet.
 */
export function chargeTaxExampleWords(view: DeliveryChargeTaxView, choice: DeliveryChargeTaxChoice | null): string | null {
  const charge = view.charges.find((c) => c.isActive) ?? view.charges[0];
  if (!charge || !choice) return null;
  const rates = deliveryChargeTaxRates(choice, view.food);
  if (!rates) return null;
  const fee = formatCents(charge.feeCents);
  const ex = deliveryChargeTaxExample(charge.feeCents, rates);
  if (ex.taxCents === 0 && !ex.card) return `${fee} delivery charge, no tax: ${fee} on the bill.`;
  const cash =
    ex.taxCents === 0
      ? `${fee} delivery charge, no tax in cash: ${fee} on the bill.`
      : `${fee} delivery charge + ${percentText(rates.rateBps)}% tax (${formatCents(ex.taxCents)}) = ${formatCents(ex.withTaxCents)} on the bill.`;
  if (!ex.card) return cash;
  const card =
    ex.card.taxCents === 0
      ? `Paid by card: no tax, ${fee}.`
      : `Paid by card: ${percentText(ex.card.rateBps)}% tax (${formatCents(ex.card.taxCents)}) = ${formatCents(ex.card.withTaxCents)}.`;
  return `${cash} ${card}`;
}

/** What happens after a Save, under the example. */
export function chargeTaxSaveNote(view: Pick<DeliveryChargeTaxView, 'website'>): string {
  const website =
    view.website === 'itself'
      ? 'The website’s checkout gets it by itself when you save.'
      : 'The website’s checkout gets it with the next menu Publish (Settings → Online orders).';
  return `Orders already open keep the tax they have; the next delivery bills take this one. ${website}`;
}

/** The toast after a Save. */
export function chargeTaxSavedToast(saved: Pick<DeliveryChargeTaxSaved, 'changed' | 'itemsChanged' | 'sentToWebsite' | 'view'>): {
  title: string;
  description: string;
} {
  if (!saved.changed) return { title: 'Saved', description: 'The delivery charges were already on that tax: nothing changed.' };
  const now = saved.view.now ? chargeTaxNowWords(saved.view) : 'Saved.';
  const website = saved.sentToWebsite
    ? ' The website gets it too.'
    : saved.view.website === 'publish'
      ? ' The website gets it with the next menu Publish.'
      : '';
  return { title: 'Delivery charge tax saved', description: `${now}${website}` };
}
