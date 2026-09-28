import * as React from 'react';
import type { PublishedSettings } from '@cheeseoclock/shared-types';
import { publishedSettingsSchema } from '@cheeseoclock/shared-schemas/web-settings';
import { sql } from './db';
import { DEFAULT_FACTS, factsFromBlock, type SiteFacts } from './delivery-facts';

/**
 * The owner's settings block as the website stored it (site_menu.menu_json
 * → settings), for the server: the pages (getSiteFacts), the checkout and
 * the order route. The pure side — merging it over the compiled list, fees
 * in words — is lib/delivery-facts.ts.
 */

/** A stored block, checked again on the way out (a hand-edited row must not break a page); null when none or unreadable. */
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
  const parsed = publishedSettingsSchema.safeParse(value);
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

async function readSiteFacts(): Promise<SiteFacts> {
  // No database (a build or a preview without one): the compiled list, as today.
  if (!process.env['DATABASE_URL']) return DEFAULT_FACTS;
  try {
    // Only the block: the row also carries the menu's data-URL images.
    const rows = (await sql()`
      SELECT menu_json -> 'settings' AS settings FROM site_menu WHERE id = 1
    `) as Array<{ settings: unknown }>;
    return factsFromBlock(parseStoredSettings(rows[0]?.settings ?? null));
  } catch (e) {
    if (isNextSignal(e)) throw e;
    // A page never fails to render over this: the compiled areas and fees, exactly as before settings.
    console.error('site facts read failed — rendering from the built-in areas and fees', e);
    return DEFAULT_FACTS;
  }
}

type Dedupe = <F extends (...args: never[]) => unknown>(fn: F) => F;
/** React's per-render cache where Next provides it (a page and its metadata read once); a plain call elsewhere (tests). */
const dedupe: Dedupe = ((React as unknown as { cache?: Dedupe }).cache ?? ((fn) => fn)) as Dedupe;

/**
 * The delivery areas, fees and pick-up offer the pages print: the stored
 * block over the compiled list; the compiled list itself (DEFAULT_FACTS)
 * with no block, no database, or a database error. The pages that call it
 * are ISR (force-static + revalidate): read at build and again whenever the
 * till's publish revalidates them (api/bridge/menu).
 */
export const getSiteFacts: () => Promise<SiteFacts> = dedupe(readSiteFacts);
