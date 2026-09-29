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
}

/** Everything a page reads from the database, in one query. */
interface PageData {
  site: SiteFacts;
  shop: ShopFacts;
  /** null = no menu published (or none read). */
  menu: MenuFacts | null;
}

const DEFAULT_PAGE_DATA: PageData = Object.freeze({ site: DEFAULT_FACTS, shop: DEFAULT_SHOP_FACTS, menu: null });

function menuFactsOf(raw: unknown): MenuFacts | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return Array.isArray(value) ? { categories: value as PublishedMenuCategory[] } : null;
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

async function readPageData(): Promise<PageData> {
  // No database (a build or a preview without one): the compiled list and today's details, as today.
  if (!process.env['DATABASE_URL']) return DEFAULT_PAGE_DATA;
  try {
    // The two blocks and the menu without its photos (the row carries the menu's data-URL images):
    // each item keeps its imageUrl key, as null. Categories and items in their stored order.
    const rows = (await sql()`
      SELECT menu_json -> 'settings' AS settings,
             menu_json -> 'shop' AS shop,
             (SELECT COALESCE(jsonb_agg(
                       jsonb_set(c.v, '{items}',
                         (SELECT COALESCE(jsonb_agg(i.v || '{"imageUrl":null}'::jsonb ORDER BY i.o), '[]'::jsonb)
                            FROM jsonb_array_elements(COALESCE(c.v -> 'items', '[]'::jsonb)) WITH ORDINALITY AS i(v, o)))
                       ORDER BY c.o), '[]'::jsonb)
                FROM jsonb_array_elements(COALESCE(menu_json -> 'categories', '[]'::jsonb)) WITH ORDINALITY AS c(v, o)) AS categories
        FROM site_menu WHERE id = 1
    `) as Array<{ settings: unknown; shop: unknown; categories: unknown }>;
    const row = rows[0];
    const data: PageData = {
      site: factsFromBlock(parseStoredSettings(row?.settings ?? null)),
      shop: shopFactsFromBlock(parseStoredShop(row?.shop ?? null)),
      menu: row ? menuFactsOf(row.categories) : null,
    };
    lastRead = data;
    return data;
  } catch (e) {
    if (isNextSignal(e)) throw e;
    // A page never fails to render over this: the last facts read here, else the compiled areas and
    // fees and today's shop details exactly as before settings.
    console.error(
      `site facts read failed — rendering from ${lastRead ? 'the last areas and fees read' : 'the built-in areas and fees'}`,
      e,
    );
    return lastRead ?? DEFAULT_PAGE_DATA;
  }
}

type Dedupe = <F extends (...args: never[]) => unknown>(fn: F) => F;
/** React's per-render cache where Next provides it (a page and its metadata read once); a plain call elsewhere (tests). */
const dedupe: Dedupe = ((React as unknown as { cache?: Dedupe }).cache ?? ((fn) => fn)) as Dedupe;

/** One read per render: the root layout, the page, its metadata and the header and footer share it. */
const getPageData: () => Promise<PageData> = dedupe(readPageData);

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
 * facts, the shop's details, and the food's tax rate from the published menu
 * (lib/tax-words: the settings block's charge items left out; the menu
 * unknown → today's 15%).
 */
export const getCopyFacts: () => Promise<CopyFacts> = dedupe(async () => {
  const { site, shop, menu } = await getPageData();
  const feeItemIds = deliveryZoneFeeItemIds(site.zones);
  return { ...site, shop, taxBps: menu ? taxBpsOf(menu, feeItemIds) : undefined };
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
