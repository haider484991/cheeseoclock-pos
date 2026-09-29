/**
 * The words of the menu files from the costing PC on the till's screens
 * (v0.7.32): Settings → Kitchen & stock's two cards, the panel above Menu →
 * Import and the Dashboard's banner. The phase sentences themselves come
 * from the main process (pos-domain menu-deploy.ts).
 */
import type { MenuAutoUpdate, MenuAutoUpdateMode, MenuDeployPhase, MenuDeployView } from '@cheeseoclock/shared-types';

/** The card's two choices, in the owner's words. */
export const MENU_AUTO_UPDATE_OPTIONS: ReadonlyArray<{ mode: MenuAutoUpdateMode; label: string; help: string }> = [
  {
    mode: 'auto',
    label: 'Apply by themselves',
    help: 'A new file from the costing PC goes in on one till within minutes — the same safe update as Menu → Import, with the rules above, a backup copy first — and reaches the other till through the link.',
  },
  {
    mode: 'ask',
    label: 'Wait for my OK (Menu → Import)',
    help: 'A new file waits in Menu → Import: you see every change first, then put it in with one tap.',
  },
];

/** One line for History. */
export function menuAutoUpdateSummary(v: MenuAutoUpdate): string {
  return v.mode === 'ask' ? 'Menu files wait for your OK (Menu → Import)' : 'Menu files from the costing PC go in by themselves';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "29 Sep" (the till's own time; the same on every Windows build, unlike a locale's "Sept"). */
export function dayMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "29 Sep, 14:02" */
export function dayTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${dayMonth(iso)}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** "Upload key made 29 Sep on this till (…ab12)" — or that there is none. Never the key. */
export function keyStatusText(key: MenuDeployView['key']): string {
  if (!key) return 'No upload key yet: make one below, then put it on the costing PC.';
  const where = key.madeOnThisTill ? 'this till' : key.deviceName?.trim() || 'the other till';
  return `Upload key made ${dayMonth(key.createdAt)} on ${where} (…${key.keyHint}).`;
}

/** What the key dialog says under the key (shown once). */
export const KEY_ONCE_WORDS =
  'Put this on the costing PC (py -3 deploy_menu.py --setup). It is shown once. A new key stops the old one.';

/** The owner's question before a new key. */
export const NEW_KEY_QUESTION =
  'Make a new upload key for the costing PC?\n\nThe old key stops working at once: the costing PC needs the new one (py -3 deploy_menu.py --setup) before it can send another menu file.';

/** What a leaked key could do, and the fix (known limits, said to the owner). */
export const KEY_SAFETY_WORDS =
  'Anyone with the key can send a menu file — but it goes in only as the safe update (the till keeps its prices and your rules above, never a fresh start, a backup copy first) and every file is in the history. Worried the key got out? Make a new one: the old one stops at once.';

export type Tone = 'good' | 'warn' | 'bad' | 'plain';

/** How a phase is coloured on the screens. */
export function phaseTone(phase: MenuDeployPhase): Tone {
  switch (phase) {
    case 'applied':
    case 'received':
      return 'good';
    case 'refused':
    case 'gave_up':
    case 'too_old':
    case 'stalled':
      return 'bad';
    case 'waiting_for_owner':
    case 'waiting_link':
    case 'failed':
      return 'warn';
    default:
      return 'plain';
  }
}

/** The Apply button's words for the phase the file is in. */
export function applyButtonLabel(view: Pick<MenuDeployView, 'phase'>): string {
  if (view.phase === 'stalled') return 'Take it over and put it in';
  if (view.phase === 'gave_up') return 'Try again';
  return 'Put it in';
}

/**
 * The question before the Apply tap — today's Menu → Import wording, plus
 * the take-over's warning.
 */
export function applyQuestion(
  view: Pick<MenuDeployView, 'phase'>,
  s: { newItems: number; updatedItems: number; priceChanges: number; recipesSet: number; newIngredients: number; updatedIngredients: number; priceLine: string; keptLine: string | null },
): string {
  const base = `Apply this menu file?\n\n${s.newItems} new items, ${s.updatedItems} items changed (${s.priceChanges} price changes), ${s.recipesSet} recipes, ${s.newIngredients} new and ${s.updatedIngredients} changed ingredients.\n\n${s.priceLine} The till keeps the prices it has; the sheet's are kept beside them in Inventory.${s.keptLine ? `\n\n${s.keptLine}` : ''}`;
  if (view.phase !== 'stalled') return base;
  return `${base}\n\nThe other till started putting this file in and stopped. Take it over only if that till is off or broken: if it did finish, the menu may end up with doubled items.`;
}
