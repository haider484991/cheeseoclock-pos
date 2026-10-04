/**
 * One-time start-up step for tills set up before v0.8: they never stored a
 * receipt website line and printed the first shop's site by default. Now the
 * default is none, so each such till gets its line written into its settings
 * once, and its receipts keep printing exactly what they printed before:
 *   - the host of the website this till is linked to (Settings → Online
 *     orders), without "www.", when there is one;
 *   - otherwise the first shop's site, but only on a till whose receipt name
 *     is that shop's — any other till gets '' (no website line).
 * Nothing happens on a till with no branding saved yet (first-time setup
 * writes the line itself) or one that already has a line. Never throws.
 */
import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw, setSetting } from '../db/repositories/settings-repo.js';
import { BRANDING_KEY, LEGACY_STORE_NAME_PATTERN, LEGACY_WEBSITE_LINE } from './printer-config.js';
import { getWebBridgeConfig } from './web-bridge-config.js';

export type WebsiteBackfill =
  | { kind: 'none'; why: 'no-branding' | 'already-set' }
  | { kind: 'written'; websiteLine: string; from: 'website-link' | 'first-shop' | 'empty' };

export function websiteHost(siteUrl: string | null | undefined): string | null {
  if (!siteUrl) return null;
  try {
    const host = new URL(siteUrl).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

export function backfillReceiptWebsiteLine(db: AppDatabase): WebsiteBackfill {
  const raw = getSettingRaw(db, BRANDING_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'none', why: 'no-branding' };
  const branding = raw as Record<string, unknown>;
  if (typeof branding['websiteLine'] === 'string') return { kind: 'none', why: 'already-set' };

  let siteUrl: string | null = null;
  try {
    siteUrl = getWebBridgeConfig(db).siteUrl ?? null;
  } catch {
    siteUrl = null;
  }
  const linked = websiteHost(siteUrl);
  const storeName = typeof branding['storeName'] === 'string' ? branding['storeName'] : '';
  const chosen: { websiteLine: string; from: 'website-link' | 'first-shop' | 'empty' } = linked
    ? { websiteLine: linked, from: 'website-link' }
    : LEGACY_STORE_NAME_PATTERN.test(storeName)
      ? { websiteLine: LEGACY_WEBSITE_LINE, from: 'first-shop' }
      : { websiteLine: '', from: 'empty' };

  setSetting(db, BRANDING_KEY, { ...branding, websiteLine: chosen.websiteLine });
  return { kind: 'written', ...chosen };
}

/** For bootstrap: run it, say what happened, never throw. */
export function backfillReceiptWebsiteLineAtStart(db: AppDatabase): void {
  try {
    const result = backfillReceiptWebsiteLine(db);
    if (result.kind === 'written') {
      log.info('Receipt website line written once for a till from before v0.8', { websiteLine: result.websiteLine, from: result.from });
    }
  } catch (err) {
    log.error('Receipt website line: the one-time backfill failed; receipts print without a website line until the owner saves one', err);
  }
}
