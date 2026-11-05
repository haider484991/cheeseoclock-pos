import type { PracticeClearPreview, PracticeClearResult, Role } from '@cheeseoclock/shared-types';

/**
 * The words of Settings → About → "Clear practice orders" (owner, 5 Nov
 * 2026: only the logs; the menu and items stay; customers and the drawer log
 * only when ticked; only during the trial). Pure, so they are tested on their
 * own. The main process decides what may be cleared and does it
 * (practice-clear-repo.ts); these only say it.
 */

export const PRACTICE_CLEAR_TITLE = 'Clear practice orders';

export const PRACTICE_CLEAR_INTRO =
  'Made test orders while learning the till? Clear them before you open for real. The menu, items, choices, tax, staff, printers and settings stay as they are.';

export const PRACTICE_CLEAR_NOTE =
  'Only during the free trial, before a licence key is entered. A safety copy is saved first (Settings → Backups). It can’t be undone.';

export const PRACTICE_CLEAR_CUSTOMERS_HELP = 'Names, phone numbers and addresses saved while practising.';
export const PRACTICE_CLEAR_DRAWER_HELP = 'The list of every time the cash drawer opened.';

export interface PracticeClearChoice {
  customers: boolean;
  drawerLog: boolean;
}

function many(n: number, one: string, more = `${one}s`): string {
  return `${n} ${n === 1 ? one : more}`;
}

function andList(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Whether the card shows at all: the owner (admin) login, and a till with no
 * licence key (a paying shop's history is never offered for clearing).
 */
export function showPracticeClear(role: Role | null | undefined, preview: PracticeClearPreview | null | undefined): boolean {
  return role === 'admin' && !!preview && !preview.blocks.some((b) => b.code === 'licensed');
}

export function customersLabel(n: number): string {
  return `Also delete the customers (${n})`;
}

export function drawerLogLabel(n: number): string {
  return `Also delete the drawer log (${n})`;
}

/** What the till holds now: "12 orders, 3 shifts and 2 cash in / out on this till." */
export function practiceHistoryLine(p: Pick<PracticeClearPreview, 'orders' | 'shifts' | 'cashMovements'>): string {
  const parts: string[] = [];
  if (p.orders > 0) parts.push(many(p.orders, 'order'));
  if (p.shifts > 0) parts.push(many(p.shifts, 'shift'));
  if (p.cashMovements > 0) parts.push(`${p.cashMovements} cash in / out`);
  return parts.length === 0 ? 'No orders or shifts on this till yet.' : `${andList(parts)} on this till.`;
}

/** Nothing would go with these ticks. */
export function practiceNothingToClear(p: PracticeClearPreview, choice: PracticeClearChoice): boolean {
  return (
    p.orders === 0 &&
    p.shifts === 0 &&
    p.cashMovements === 0 &&
    (!choice.customers || p.customers === 0) &&
    (!choice.drawerLog || p.drawerLog === 0)
  );
}

/** Why the button is still greyed out (null when it can be pressed). */
export function practiceClearMissing(input: { blocked: boolean; nothing: boolean; secret: string }): string | null {
  if (input.blocked) return 'Sort out what is listed above first.';
  if (input.nothing) return 'There is nothing to clear.';
  if (!input.secret) return 'Type your owner PIN or password.';
  return null;
}

/** The last question: "Delete 12 practice orders and 3 shifts? The customers go too. This can't be undone." */
export function practiceConfirmQuestion(p: PracticeClearPreview, choice: PracticeClearChoice): string {
  const parts: string[] = [];
  if (p.orders > 0) parts.push(many(p.orders, 'practice order'));
  if (p.shifts > 0) parts.push(many(p.shifts, 'shift'));
  if (p.cashMovements > 0) parts.push(`${p.cashMovements} cash in / out`);
  const customers = choice.customers && p.customers > 0;
  const drawer = choice.drawerLog && p.drawerLog > 0;
  const tail =
    customers && drawer
      ? ' The saved customers and the drawer log go too.'
      : customers
        ? ' The saved customers go too.'
        : drawer
          ? ' The drawer log goes too.'
          : '';
  const head = parts.length > 0 ? `Delete ${andList(parts)}?` : 'Delete them?';
  return `${head}${tail} This can’t be undone.`;
}

/** The toast after it: "Practice orders cleared: 12 orders and 3 shifts. Order numbers start again at 1." */
export function practiceClearToast(r: PracticeClearResult): string {
  const parts: string[] = [];
  if (r.orders > 0) parts.push(many(r.orders, 'order'));
  if (r.shifts > 0) parts.push(many(r.shifts, 'shift'));
  if (r.cashMovements > 0) parts.push(`${r.cashMovements} cash in / out`);
  if (r.customers > 0) parts.push(many(r.customers, 'customer'));
  if (r.drawerLog > 0) parts.push(`${r.drawerLog} drawer log ${r.drawerLog === 1 ? 'entry' : 'entries'}`);
  const what = parts.length > 0 ? `: ${andList(parts)}` : '';
  return `Practice orders cleared${what}. Order numbers start again at 1.`;
}
