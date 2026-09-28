import * as React from 'react';
import { closedNoticeInForce, type PublishedSettings } from '@cheeseoclock/shared-types';
import { publishedSettingsReadSchema } from '@cheeseoclock/shared-schemas/web-settings';
import { sql } from './db';
import { DEFAULT_FACTS, factsFromBlock, type SiteFacts } from './delivery-facts';

/**
 * The owner's settings block as the website stored it (site_menu.menu_json
 * → settings), for the server: the pages (getSiteFacts), the checkout and
 * the order route. The pure side — merging it over the compiled list, fees
 * in words — is lib/delivery-facts.ts.
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
let lastRead: SiteFacts | null = null;

async function readSiteFacts(): Promise<SiteFacts> {
  // No database (a build or a preview without one): the compiled list, as today.
  if (!process.env['DATABASE_URL']) return DEFAULT_FACTS;
  try {
    // Only the block: the row also carries the menu's data-URL images.
    const rows = (await sql()`
      SELECT menu_json -> 'settings' AS settings FROM site_menu WHERE id = 1
    `) as Array<{ settings: unknown }>;
    const facts = factsFromBlock(parseStoredSettings(rows[0]?.settings ?? null));
    lastRead = facts;
    return facts;
  } catch (e) {
    if (isNextSignal(e)) throw e;
    // A page never fails to render over this: the last facts read here, else the compiled areas and
    // fees exactly as before settings.
    console.error(
      `site facts read failed — rendering from ${lastRead ? 'the last areas and fees read' : 'the built-in areas and fees'}`,
      e,
    );
    return lastRead ?? DEFAULT_FACTS;
  }
}

type Dedupe = <F extends (...args: never[]) => unknown>(fn: F) => F;
/** React's per-render cache where Next provides it (a page and its metadata read once); a plain call elsewhere (tests). */
const dedupe: Dedupe = ((React as unknown as { cache?: Dedupe }).cache ?? ((fn) => fn)) as Dedupe;

/**
 * The delivery areas, fees and pick-up offer the pages print: the stored
 * block over the compiled list; the compiled list itself (DEFAULT_FACTS)
 * with no block or no database; on a database error, the last facts this
 * server read, else the compiled list. The pages that call it
 * are ISR (force-static + revalidate): read at build and again whenever the
 * till's publish revalidates them (api/bridge/menu).
 */
export const getSiteFacts: () => Promise<SiteFacts> = dedupe(readSiteFacts);

/**
 * The owner's closed notice in force at `nowMs` (v0.7.30), or null: the
 * page's own closed words. Worked out per request, like the order route and
 * /menu do, for the store-status poll (api/store-status): a /menu page left
 * open drops a notice whose last Karachi day has ended — and shows one saved
 * since — within one poll, instead of keeping what it was served. Never
 * throws: with no database, or on any failure, null (today's words).
 */
export async function readClosedNotice(nowMs: number = Date.now()): Promise<string | null> {
  if (!process.env['DATABASE_URL']) return null;
  try {
    const rows = (await sql()`
      SELECT menu_json -> 'settings' AS settings FROM site_menu WHERE id = 1
    `) as Array<{ settings: unknown }>;
    return closedNoticeInForce(parseStoredSettings(rows[0]?.settings ?? null)?.closedNotice, nowMs);
  } catch (e) {
    console.error('closed notice read failed — the page says its own closed words', e);
    return null;
  }
}
