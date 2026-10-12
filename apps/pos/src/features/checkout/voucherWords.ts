import { formatCents, voucherLineEachCents, voucherNumberText, type VoucherLine } from '@cheeseoclock/pos-domain';
import type { VoucherCheck } from '@cheeseoclock/shared-types';
import { voucherForWords } from '../vouchers/voucherPageWords';

/**
 * The till's words for a typed voucher (v0.7.48, Use a voucher): what it
 * gets and what it is for (v0.7.50) when it can be used, else why not (the main process's own
 * words: used on which order, ended…).
 */
export function voucherCheckWords(check: VoucherCheck): { ok: boolean; title: string; detail: string | null } {
  if (!check.ok) return { ok: false, title: check.message, detail: null };
  const b = check.batch;
  const until = b.goodUntil ? ` · until ${dayWords(b.goodUntil)}` : '';
  return {
    ok: true,
    title: `Voucher No. ${voucherNumberText(check.number)} · ${b.name}`,
    detail: `${b.gives} · ${voucherForWords(b)}${until}`,
  };
}

/** A line as the voucher picker lists it: "Fajita Pizza — Large", "2× Fajita Pizza — Large (Rs 1,899 each)". */
export function voucherLineWords(line: Pick<VoucherLine, 'menuItemName' | 'quantity' | 'lineTotalCents'>): string {
  if (line.quantity <= 1) return line.menuItemName;
  return `${line.quantity}× ${line.menuItemName} (${formatCents(voucherLineEachCents(line))} each)`;
}

/** "2026-12-31" → "31/12/2026", the way the papers write a day. */
export function dayWords(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}
