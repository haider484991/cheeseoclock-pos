import { formatCents, voucherNumberText, type VoucherListRead } from '@cheeseoclock/pos-domain';
import type { VoucherBatchSummary, VoucherFor, VoucherRow, VoucherState } from '@cheeseoclock/shared-types';

/**
 * The Vouchers page's words (v0.7.48): plain, for the owner and managers.
 * Pure, so they are tested without a screen.
 */

/** Where a voucher stands, in a word or two. */
export const VOUCHER_STATE_WORDS: Record<VoucherState, string> = {
  not_used: 'Not used',
  on_order: 'On an order',
  used: 'Used',
};

/** "37 of 100 used · 1 on an order not paid yet · 62 not used". */
export function batchCountWords(b: Pick<VoucherBatchSummary, 'count' | 'used' | 'onOrder' | 'notUsed'>): string {
  const parts = [`${b.used} of ${b.count} used`];
  if (b.onOrder > 0) parts.push(`${b.onOrder} on an order not paid yet`);
  parts.push(`${b.notUsed} not used`);
  return parts.join(' · ');
}

/** "No. 001–100", or "No. 007" for one; '' for none. */
export function batchNumbersWords(b: Pick<VoucherBatchSummary, 'firstNumber' | 'lastNumber'>): string {
  if (b.firstNumber === null || b.lastNumber === null) return '';
  if (b.firstNumber === b.lastNumber) return `No. ${voucherNumberText(b.firstNumber)}`;
  return `No. ${voucherNumberText(b.firstNumber)}–${voucherNumberText(b.lastNumber)}`;
}

/**
 * What a voucher is for, in a few words (v0.7.50): "Large · Pizza · the whole
 * item", "Any size · Burgers · up to Rs 700", "Any food · up to Rs 1,899" (a
 * batch from before, or one for any item). A category gone from the menu
 * since is left out.
 */
export function voucherForWords(
  b: Pick<VoucherBatchSummary, 'coversCents'> & { for?: VoucherFor | null; forCategoryNames?: readonly string[] },
): string {
  const f = b.for ?? null;
  const take = f?.wholeItem ? 'the whole item' : `up to ${formatCents(b.coversCents)}`;
  if (!f) return `Any food · ${take}`;
  const cats = (b.forCategoryNames ?? []).length > 0 ? (b.forCategoryNames ?? []).join(' or ') : f.categoryIds.length > 0 ? 'a category no longer on the menu' : 'any food';
  return `${f.size ?? 'Any size'} · ${cats} · ${take}`;
}

/**
 * What new vouchers are for until the owner says otherwise: one Large from
 * the regular pizza menu (the category named "Pizza" or "Regular Pizza"), the
 * whole item. Every voucher printed so far is that one.
 */
export function defaultVoucherFor(categories: ReadonlyArray<{ id: string; name: string }>): VoucherFor {
  return {
    categoryIds: categories.filter((c) => /^\s*(regular\s+)?pizzas?\s*$/i.test(c.name)).map((c) => c.id),
    size: 'Large',
    wholeItem: true,
  };
}

/** "Large · Pizza · the whole item · no end date" / "Any food · up to Rs 1,899 · until 31/12/2026". */
export function batchTermsWords(
  b: Pick<VoucherBatchSummary, 'coversCents' | 'goodUntil'> & { for?: VoucherFor | null; forCategoryNames?: readonly string[] },
): string {
  const [y, m, d] = (b.goodUntil ?? '').split('-');
  return `${voucherForWords(b)} · ${b.goodUntil ? `until ${d}/${m}/${y}` : 'no end date'}`;
}

/** The list as printed, one voucher a line ("001 AB3C"): to copy for the printer, or into the till again. */
export function voucherListText(rows: ReadonlyArray<Pick<VoucherRow, 'number' | 'code'>>): string {
  return rows.map((r) => `${voucherNumberText(r.number)} ${r.code}`).join('\n');
}

/** Does a voucher match what was typed in the search box (its number, with or without zeros, or its code)? */
export function voucherMatches(row: Pick<VoucherRow, 'number' | 'code' | 'use'>, query: string): boolean {
  const q = query.trim().toUpperCase().replace(/^NO\.?\s*/, '');
  if (q === '') return true;
  if (/^\d+$/.test(q)) return row.number === Number(q) || voucherNumberText(row.number).includes(q);
  if (row.code.includes(q)) return true;
  const orderNo = row.use?.orderNumber.split('-').pop() ?? '';
  return orderNo !== '' && `#${orderNo}`.includes(q.startsWith('#') ? q : `#${q}`);
}

/**
 * What a pasted list reads as, for the Add vouchers box: the count and
 * numbers, or what is wrong with it. `problems` stop Save.
 */
export function pastedListWords(read: VoucherListRead): { summary: string; problems: string[]; skipped: string | null } {
  const n = read.vouchers.length;
  const numbers = read.vouchers.map((v) => v.number);
  const summary =
    n === 0
      ? 'Choose the CSV file, or paste the list: one voucher a line, its number then its code (001,AB3C).'
      : `${n} voucher${n === 1 ? '' : 's'} read · No. ${voucherNumberText(Math.min(...numbers))}–${voucherNumberText(Math.max(...numbers))}`;
  const problems: string[] = [];
  if (read.repeatedNumbers.length > 0) {
    problems.push(`On the list twice: No. ${read.repeatedNumbers.slice(0, 5).map(voucherNumberText).join(', ')}${read.repeatedNumbers.length > 5 ? '…' : ''}`);
  }
  if (read.repeatedCodes.length > 0) {
    problems.push(`The same code twice: ${read.repeatedCodes.slice(0, 5).join(', ')}${read.repeatedCodes.length > 5 ? '…' : ''}`);
  }
  const skipped =
    read.skipped.length === 0
      ? null
      : `${read.skipped.length} line${read.skipped.length === 1 ? '' : 's'} left out (not a number and a code): ${read.skipped
          .slice(0, 3)
          .map((s) => `“${s.length > 30 ? `${s.slice(0, 30)}…` : s}”`)
          .join(', ')}${read.skipped.length > 3 ? '…' : ''}`;
  return { summary, problems, skipped };
}

/** Rupees typed ("1899", "1,899.50") → paisa; null when it is not an amount above 0. */
export function rupeesToCents(text: string): number | null {
  const t = text.replace(/[,\s]/g, '').replace(/^rs\.?/i, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return cents > 0 ? cents : null;
}

/** The largest voucher file the till reads (a list of 2,000 vouchers is about 20 KB). */
export const VOUCHER_FILE_MAX_BYTES = 1_000_000;

/** Why a chosen voucher file is not read, or null. */
export function voucherFileProblem(size: number): string | null {
  if (size === 0) return 'That file is empty.';
  if (size > VOUCHER_FILE_MAX_BYTES) return 'That file is too big for a list of vouchers. Choose the CSV of numbers and codes.';
  return null;
}
