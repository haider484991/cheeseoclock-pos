import type { PublishedMenu, PublishedSettings } from '@cheeseoclock/shared-types';
import { menuWithoutDrinkBrand } from './menu-view';

/**
 * What the public gets of the owner's settings block: the areas (with their
 * fee items, so the ordering app keeps charges off the menu) and the pick-up
 * offer — never the sending till's device id or the block's stamps. Those
 * are operational detail, as /api/store-status keeps the heartbeat's device
 * id to itself; the bridge alone reads them (GET /api/bridge/status).
 */
export type PublicSettings = Pick<PublishedSettings, 'v' | 'pickup' | 'zones'>;

/** The menu as the public gets it: GET /api/menu, and the /menu page's props (sent whole to the browser). */
export type PublicMenu = Omit<PublishedMenu, 'settings'> & { settings?: PublicSettings };

/** The stored menu as the public gets it (no drink brand; the settings block without its device id and stamps). */
export function publicMenu(menu: PublishedMenu): PublicMenu {
  const { settings, ...rest } = menuWithoutDrinkBrand(menu);
  if (!settings) return rest;
  return { ...rest, settings: { v: settings.v, pickup: settings.pickup, zones: settings.zones } };
}
