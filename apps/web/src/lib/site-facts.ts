import * as React from 'react';
import {
  closedNoticeInForce,
  deliveryZoneFeeItemIds,
  type PublishedMenuCategory,
  type PublishedSettings,
  type PublishedShop,
} from '@cheeseoclock/shared-types';
import { publishedSettingsReadSchema, publishedShopReadSchema } from '@cheeseoclock/shared-schemas/web-settings';
import { sql } from './db';
import { DEFAULT_FACTS, factsFromBlock, type CopyFacts, type SiteFacts } from './delivery-facts';
import { resolveHome, type HomeView } from './home-lineup';
import { DEFAULT_SHOP_FACTS, shopFactsFromBlock, type ShopFacts } from './shop-facts';
import { taxBpsOf } from './tax-words';

/**
 * What the owner stored with the menu (site_menu.menu_json), for the server:
 * the settings block (→ settings: areas, fees, website messages), the shop
 * block (→ shop, sweep B2 + B4: the shop's details) and the menu itself
 * without its photos. The pages read all three in ONE query
 * (getSiteFacts, getShopFacts, getMenuFacts, getCopyFacts); the checkout
 * and the order route read the settings block. The pure side — merging it
 * over the compiled list, fees and the shop's details in words — is
 * lib/delivery-facts.ts and lib/shop-facts.ts.
 */

/**
 * A stored block, checked again on the way out (a hand-edited row must not
 * break a page); null when none or unreadable. A website message that does
 * not fit (v0.7.30: the closed notice, the announcement, the delivery
 * minimum) reads as absent — its default, today's site — and never throws
 * the areas and fees away with it (shared-schemas publishedSettingsReadSchema).
 */
export function parseStoredSettings(raw: unknown): PublishedSettings | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = publishedSettingsReadSchema.safeParse(value);
  if (!parsed.success) {
    console.error('stored settings block unreadable — using the built-in areas and fees', parsed.error.flatten());
    return null;
  }
  return parsed.data;
}

/**
 * A stored shop block, checked again on the way out (THE SHOP BLOCK in
 * shared-types web-bridge.ts); null when none, or when its stamp does not
 * read (a hand-edited row). A section that does not read falls back to its
 * own default — today's — and never takes the other sections with it
 * (shared-schemas publishedShopReadSchema).
 */
export function parseStoredShop(raw: unknown): PublishedShop | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = publishedShopReadSchema.safeParse(value);
  if (!parsed.success) {
    console.error('stored shop block unreadable — using today’s shop details', parsed.error.flatten());
    return null;
  }
  return parsed.data;
}

/**
 * The published menu as the pages read it: its categories and items in the
 * till's order, WITHOUT the photos (every imageUrl null: the till's data URLs
 * run to hundreds of KB each, and no page but /menu — which reads the row
 * itself — shows one). Names and descriptions as the till has them —
 * a page shows them only through drinkFlavourName / withoutDrinkBrand
 * (lib/menu-view.ts): never a drink brand.
 */
export interface MenuFacts {
  categories: PublishedMenuCategory[];
  /**
   * The items the till sent a photo of: posItemId → a short version of the
   * photo (it changes when the photo does). The home page links a featured
   * item's photo by it (api/menu-photo) instead of carrying the data URL.
   */
  photos: Record<string, string>;
}

/** Everything a page reads from the database, in one query. */
interface PageData {
  site: SiteFacts;
  shop: ShopFacts;
  /** null = no menu published (or none read). */
  menu: MenuFacts | null;
}

/** One read, and whether it failed with nothing read before (then `data` is the built-in list and today's details). */
interface PageRead {
  data: PageData;
  /** The database could not be read and this server had read nothing yet: `data` is NOT the owner's. */
  unread: boolean;
}

const DEFAULT_PAGE_DATA: PageData = Object.freeze({ site: DEFAULT_FACTS, shop: DEFAULT_SHOP_FACTS, menu: null });

function jsonOf(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function menuFactsOf(rawCategories: unknown, rawPhotos: unknown): MenuFacts | null {
  const value = jsonOf(rawCategories);
  if (!Array.isArray(value)) return null;
  const photos: Record<string, string> = {};
  const p = jsonOf(rawPhotos);
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    for (const [id, v] of Object.entries(p as Record<string, unknown>)) if (typeof v === 'string') photos[id] = v;
  }
  return { categories: value as PublishedMenuCategory[], photos };
}

/**
 * Next's own signals (a page asking to be dynamic, notFound, redirect) must
 * pass through: swallowing "Dynamic server usage" would freeze a page on the
 * compiled fees for good while every test and build still passed.
 */
function isNextSignal(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const digest = (e as { digest?: unknown }).digest;
  if (typeof digest === 'string' && (digest === 'DYNAMIC_SERVER_USAGE' || digest.startsWith('NEXT_'))) return true;
  return (e as { $$typeof?: unknown }).$$typeof === Symbol.for('react.postpone');
}

/**
 * The last facts this server read from the database. A read that fails
 * renders from them: an hourly refresh, or the render after a publish, that
 * meets a database error must not swap the owner's fees for the built-in
 * ones and keep that page for an hour. Held per server process (a cold
 * serverless instance has none yet, and uses the built-in list).
 */
let lastRead: PageData | null = null;

async function readPageData(): Promise<PageRead> {
  // No database (a build or a preview without one): the compiled list and today's details, as today.
  if (!process.env['DATABASE_URL']) return { data: DEFAULT_PAGE_DATA, unread: false };
  try {
    // The two blocks and the menu without its photos (the row carries the menu's data-URL images):
    // each item keeps its imageUrl key, as null. Categories and items in their stored order. Which
    // items HAVE a photo comes as a short version of each (the first 12 of its md5): the home page
    // links a featured item's photo (api/menu-photo), never inlines it.
    const rows = (await sql()`
      SELECT menu_json -> 'settings' AS settings,
             menu_json -> 'shop' AS shop,
             (SELECT COALESCE(jsonb_agg(
                       jsonb_set(c.v, '{items}',
                         (SELECT COALESCE(jsonb_agg(i.v || '{"imageUrl":null}'::jsonb ORDER BY i.o), '[]'::jsonb)
                            FROM jsonb_array_elements(COALESCE(c.v -> 'items', '[]'::jsonb)) WITH ORDINALITY AS i(v, o)))
                       ORDER BY c.o), '[]'::jsonb)
                FROM jsonb_array_elements(COALESCE(menu_json -> 'categories', '[]'::jsonb)) WITH ORDINALITY AS c(v, o)) AS categories,
             (SELECT COALESCE(jsonb_object_agg(p.v ->> 'posItemId', left(md5(p.v ->> 'imageUrl'), 12)), '{}'::jsonb)
                FROM jsonb_array_elements(COALESCE(menu_json -> 'categories', '[]'::jsonb)) AS q(v),
                     jsonb_array_elements(COALESCE(q.v -> 'items', '[]'::jsonb)) AS p(v)
               WHERE p.v ->> 'posItemId' IS NOT NULL AND p.v ->> 'imageUrl' LIKE 'data:image/%') AS photos
        FROM site_menu WHERE id = 1
    `) as Array<{ settings: unknown; shop: unknown; categories: unknown; photos: unknown }>;
    const row = rows[0];
    const data: PageData = {
      site: factsFromBlock(parseStoredSettings(row?.settings ?? null)),
      shop: shopFactsFromBlock(parseStoredShop(row?.shop ?? null)),
      menu: row ? menuFactsOf(row.categories, row.photos) : null,
    };
    lastRead = data;
    return { data, unread: false };
  } catch (e) {
    if (isNextSignal(e)) throw e;
    // A page never fails to render over this: the last facts read here, else the compiled areas and
    // fees and today's shop details exactly as before settings.
    console.error(
      `site facts read failed — rendering from ${lastRead ? 'the last areas and fees read' : 'the built-in areas and fees'}`,
      e,
    );
    return lastRead ? { data: lastRead, unread: false } : { data: DEFAULT_PAGE_DATA, unread: true };
  }
}

type Dedupe = <F extends (...args: never[]) => unknown>(fn: F) => F;
/** React's per-render cache where Next provides it (a page and its metadata read once); a plain call elsewhere (tests). */
const dedupe: Dedupe = ((React as unknown as { cache?: Dedupe }).cache ?? ((fn) => fn)) as Dedupe;

/** One read per render: the root layout, the page, its metadata and the header and footer share it. */
const getPageRead: () => Promise<PageRead> = dedupe(readPageData);
const getPageData = async (): Promise<PageData> => (await getPageRead()).data;

/**
 * For a page Next KEEPS — the ISR pages (force-static + revalidate), the app
 * manifest, the not-found page built once — called first: when the database
 * can't be read and this server has read nothing yet, rendering would keep
 * the built-in details (no menu prices; today's name, numbers and hours over
 * the owner's) for up to an hour. It throws instead: Next keeps serving the
 * last good page and tries again within seconds (a failed refresh leaves the
 * stale page in place), and a build fails with the live site left as it is.
 * A read that fails AFTER one succeeded renders from that one (as before),
 * and no database at all is today's site (a build or preview without one).
 * The dynamic pages (/menu, /track) never call it: they render from the
 * built-in details, as before, rather than fail. (/_not-found is kept too:
 * built once, and rendered again after a publish revalidates the site; no
 * page calls notFound() on demand — an unknown area slug is rewritten to
 * it by the middleware before the area page runs.)
 */
export async function requireStoredFacts(): Promise<void> {
  if ((await getPageRead()).unread) {
    throw new Error(
      'The website could not read the owner’s settings and menu from the database, and has read none yet: the last good page stays.',
    );
  }
}

/**
 * The delivery areas, fees and pick-up offer the pages print: the stored
 * block over the compiled list; the compiled list itself (DEFAULT_FACTS)
 * with no block or no database; on a database error, the last facts this
 * server read, else the compiled list. The pages that call it
 * are ISR (force-static + revalidate): read at build and again whenever the
 * till's publish revalidates them (api/bridge/menu).
 */
export const getSiteFacts: () => Promise<SiteFacts> = dedupe(async () => (await getPageData()).site);

/**
 * The shop's details the pages print (sweep B2 + B4): the stored shop block,
 * else today's (DEFAULT_SHOP_FACTS) — with none stored, no database, or a
 * database error with nothing read yet; on an error, the last read. Read by
 * the root layout (metadata, JSON-LD) on every page: /_not-found is
 * force-static so this read never turns it dynamic.
 */
export const getShopFacts: () => Promise<ShopFacts> = dedupe(async () => (await getPageData()).shop);

/** The published menu without its photos (MenuFacts), or null while none is published or none could be read. */
export const getMenuFacts: () => Promise<MenuFacts | null> = dedupe(async () => (await getPageData()).menu);

/**
 * What page copy is written from (delivery-facts CopyFacts): the delivery
 * facts, the shop's details, the food's tax rate from the published menu
 * (lib/tax-words: the settings block's charge items left out; the menu
 * unknown → today's 15%) and the menu itself for the price tokens (sweep B2,
 * lib/menu-prices; unknown → none print). Server only.
 */
export const getCopyFacts: () => Promise<CopyFacts> = dedupe(async () => {
  const { site, shop, menu } = await getPageData();
  const feeItemIds = deliveryZoneFeeItemIds(site.zones);
  return { ...site, shop, taxBps: menu ? taxBpsOf(menu, feeItemIds) : undefined, menu };
});

/**
 * The home page's featured items (sweep B2, lib/home-lineup): the owner's
 * lineup (today's with none saved) found on the published menu, with its
 * prices and deal worth; the menu unknown → the lineup without prices. The
 * page and its 3D carousel share this one read.
 */
export const getHomeView: () => Promise<HomeView> = dedupe(async () => {
  const { site, shop, menu } = await getPageData();
  return resolveHome(shop.home, menu, deliveryZoneFeeItemIds(site.zones));
});

/**
 * The owner's closed notice in force at `nowMs` (v0.7.30), or null: the
 * page's own closed words. Worked out per request, like the order route and
 * /menu do, for the store-status poll (api/store-status): a /menu page left
 * open drops a notice whose last Karachi day has ended — and shows one saved
 * since — within one poll, instead of keeping what it was served. Never
 * throws. undefined = no word (no database — a local preview from
 * DEV_MENU_FILE — or a failed read): the page keeps what it was served.
 */
export async function readClosedNotice(nowMs: number = Date.now()): Promise<string | null | undefined> {
  if (!process.env['DATABASE_URL']) return undefined;
  try {
    const rows = (await sql()`
      SELECT menu_json -> 'settings' AS settings FROM site_menu WHERE id = 1
    `) as Array<{ settings: unknown }>;
    return closedNoticeInForce(parseStoredSettings(rows[0]?.settings ?? null)?.closedNotice, nowMs);
  } catch (e) {
    console.error('closed notice read failed — the page keeps the words it was served', e);
    return undefined;
  }
}
