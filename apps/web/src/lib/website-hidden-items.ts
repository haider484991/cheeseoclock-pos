import type { PublishedMenuCategory } from '@cheeseoclock/shared-types';

/**
 * Items the WEBSITE keeps off itself, whatever the till publishes.
 *
 * Owner 2026-10-01, urgent: take Meat Lovers off the website. Only the cashier was at the shop, and
 * the till's own switch (Menu → Items → the item → On the website → "Not on the website", then
 * Settings → Online orders → "Publish menu to website") needs the owner's login, or a manager's for
 * the switch. So the website hides it until then.
 *
 * TEMPORARY. Once the till has the item set "Not on the website" and has published, empty this list
 * (and redeploy): while an id is here, the till cannot put that item back on the website.
 *
 * By the till's own item id (posItemId), so only the shop's real item is hidden — the same item the
 * till's switch would leave out. Hidden here means exactly what the till's "Not on the website" does:
 * the item is not on the menu the website reads, so it is not shown (/menu, /api/menu, the menu's
 * JSON-LD, the home page's lineup and carousel, price words in page copy) and the checkout refuses a
 * basket that still has it ("The menu was just updated — please refresh the page and try again.").
 * A deal's choices are not items and are left alone, as the till leaves them (no deal offers these).
 */
export const HIDDEN_ON_WEBSITE: ReadonlySet<string> = new Set([
  '01a0ed81-9cff-7554-a66a-4365c43741ea', // Meat Lovers — Large (Signature Pizzas), the shop till's item
]);

/**
 * The menu without the hidden items. A category left with no items is left out (one that had none
 * to begin with stays as it was). Everything else passes through untouched, and a menu with no
 * hidden item in it comes back as the very same object.
 */
export function withoutHiddenItems<M extends { categories: PublishedMenuCategory[] }>(
  menu: M,
  hidden: ReadonlySet<string> = HIDDEN_ON_WEBSITE,
): M {
  if (!menu.categories.some((c) => c.items.some((i) => hidden.has(i.posItemId)))) return menu;
  return {
    ...menu,
    categories: menu.categories.flatMap((c) => {
      const items = c.items.filter((i) => !hidden.has(i.posItemId));
      if (items.length === c.items.length) return [c];
      return items.length > 0 ? [{ ...c, items }] : [];
    }),
  };
}
