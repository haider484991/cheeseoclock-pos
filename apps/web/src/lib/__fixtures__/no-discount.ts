/**
 * The one change a menu with its value deals marked makes to a page (v0.7.34,
 * shared-types web-bridge.ts NO DISCOUNT ON VALUE DEALS: a v0.7.34 till
 * publishes each item of "Value Deals" with `noDiscount: true`), spelled out
 * against the golden taken before it (pages-v0.7.30.json): the /menu chip,
 * while pick-up is on, says the deals are left out — in fewer words, so it
 * stays one line on a 375 px phone. Every other byte stays
 * (deals-not-discounted.test.ts). With nothing marked every page is the
 * golden exactly (pages-golden.test.ts).
 *
 * The replacement names the exact markup it removes and must find it (an
 * edit that stops matching fails the test instead of passing quietly).
 */
import type { PublishedMenu } from '@cheeseoclock/shared-types';
import { goldenMenu } from './golden-menu';

type Swap = readonly [find: string, replace: string, times: number];

/** The items a v0.7.34 till marks on the golden menu: its Value Deals, by the category's name. */
export const MARKED_DEALS: readonly string[] = ['Big Two', 'Family Feast', 'Perfect Pair'];

/** The golden menu as a v0.7.34 till publishes it: each value deal with `noDiscount: true` (its last key), nothing else. */
export function goldenMenuDealsMarked(): PublishedMenu {
  const m = goldenMenu();
  return {
    ...m,
    categories: m.categories.map((c) =>
      c.name === 'Value Deals' ? { ...c, items: c.items.map((i) => ({ ...i, noDiscount: true })) } : c,
    ),
  };
}

/** /menu while pick-up is on: the chip (once). */
const MENU_OPEN: readonly Swap[] = [
  [
    '<li class="rounded-full bg-cheese px-3.5 py-1.5 text-ink shadow-glow">10% off when you order online &amp; pick up</li>',
    '<li class="rounded-full bg-cheese px-3.5 py-1.5 text-ink shadow-glow">10% off online pick-up · not on value deals</li>',
    1,
  ],
];

function apply(html: string, swaps: readonly Swap[], where: string): string {
  let out = html;
  for (const [find, replace, times] of swaps) {
    const found = out.split(find).length - 1;
    if (found !== times) throw new Error(`${where}: expected ${times} of ${JSON.stringify(find)} in the golden, found ${found}`);
    out = out.replaceAll(find, replace);
  }
  return out;
}

/** The routes whose HTML marked value deals change. */
export const DEALS_MARKED_ROUTES: readonly string[] = ['/menu (open)'];

/** A golden page's HTML as served with the value deals marked (unchanged for every other route). */
export function htmlWithDealsMarked(route: string, html: string): string {
  return route === '/menu (open)' ? apply(html, MENU_OPEN, route) : html;
}
