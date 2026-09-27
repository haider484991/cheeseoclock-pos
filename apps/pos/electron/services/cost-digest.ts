/**
 * The Monday price digest (costing spec Phase 6): once a trading week, from
 * Monday 05:00 PKT, Costing → Alerts lists the dishes that price changes
 * moved across their target (cost-alert-repo runWeeklyDigestIfDue: frozen
 * picks, a 1-point margin). It is looked for a little after the till opens
 * and then every hour, and whenever the Alerts tab is opened; once this
 * week's digest is there (written here, or arrived from the other till —
 * the same id on both), looking again reads one row and writes nothing.
 * The till's own work: no login is its author.
 */
import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import { runWeeklyDigestIfDue } from '../db/repositories/cost-alert-repo.js';

/** After the boot jobs, so the digest never slows the till opening. */
const FIRST_LOOK_MS = 3 * 60_000;
const EVERY_MS = 60 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

export function startWeeklyDigest(db: AppDatabase, deviceId: string): void {
  if (timer) return;
  const look = () => {
    try {
      const id = runWeeklyDigestIfDue(db, { userId: null, deviceId });
      if (id) log.info('Costing: this week\'s price digest written', { id });
    } catch (err) {
      log.warn('Costing: the weekly price digest was not looked at', err);
    }
  };
  const first = setTimeout(look, FIRST_LOOK_MS);
  first.unref?.();
  timer = setInterval(look, EVERY_MS);
  timer.unref?.();
}
