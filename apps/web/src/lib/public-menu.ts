import { isBuy1Get1Category, type Buy1Get1Rules, type PublishedMenu, type PublishedSettings } from '@cheeseoclock/shared-types';
import { menuWithoutDrinkBrand } from './menu-view';

/**
 * What the public gets of the owner's settings block: the areas (with their
 * fee items, so the ordering app keeps charges off the menu) and the pick-up
 * offer — never the sending till's device id or the block's stamps. Those
 * are operational detail, as /api/store-status keeps the heartbeat's device
 * id to itself; the bridge alone reads them (GET /api/bridge/status).
 */
export type PublicSettings = Pick<PublishedSettings, 'v' | 'pickup' | 'zones'>;

/**
 * The menu as the public gets it: GET /api/menu, and the /menu page's props
 * (sent whole to the browser). Never the shop block (THE SHOP BLOCK): its
 * stamps and device id are the bridge's; the pages hand the browser the
 * shop's details as ShopFacts (lib/shop-facts.ts) instead.
 */
export type PublicMenu = Omit<PublishedMenu, 'settings' | 'shop'> & { settings?: PublicSettings };

/** The stored menu as the public gets it (no drink brand; the settings block without its device id and stamps; no shop block). */
export function publicMenu(menu: PublishedMenu): PublicMenu {
  const { settings, shop: _shop, ...rest } = menuWithoutDrinkBrand(menu);
  if (!settings) return rest;
  return { ...rest, settings: { v: settings.v, pickup: settings.pickup, zones: settings.zones } };
}

/**
 * The menu without its Buy 1 Get 1 deals while the owner has them switched off (Settings → Money & discounts on the
 * till; SiteFacts.buy1Get1 from the stored block): the /menu page and GET /api/menu never show a deal nobody can
 * order. Switched on (or never set): the menu as it is — a deal outside its hours still shows, closed.
 */
export function withDealsForSale<M extends Pick<PublishedMenu, 'categories'>>(menu: M, rules: Pick<Buy1Get1Rules, 'on'>): M {
  if (rules.on) return menu;
  return { ...menu, categories: menu.categories.filter((c) => !isBuy1Get1Category(c.name)) };
}
