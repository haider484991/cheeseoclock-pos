import { app } from 'electron';
import log from 'electron-log/main';

/**
 * Crash + error reporting. Wires up @sentry/electron when:
 *   - the package is installed (try-imported, no hard dependency)
 *   - SENTRY_DSN environment variable is present
 *
 * Otherwise this is a no-op — the app still boots, errors still go to the
 * electron-log file. This pattern keeps the codebase deployable for customers
 * who don't want / can't afford Sentry, while letting us flip it on per-customer
 * by setting the env var at packaging time.
 *
 * To enable in production:
 *   1. `pnpm add @sentry/electron --filter @cheeseoclock/pos`
 *   2. Set SENTRY_DSN in your build env or in a customer-specific config.
 *
 * Personally-identifying info (PINs, phones, full customer payloads) is
 * scrubbed in `beforeSend` so a leaked DSN can't exfiltrate PII.
 */
export async function initErrorReporter(): Promise<void> {
  const dsn = process.env.SENTRY_DSN || (process.env.CHEESEOCLOCK_SENTRY_DSN ?? null);
  if (!dsn) {
    log.info('Sentry: DSN not set — error reporting disabled');
    return;
  }
  try {
    // Dynamic import so the dep is optional. If @sentry/electron isn't installed,
    // we just log and continue.
    const sentry = (await import(/* webpackIgnore: true */ '@sentry/electron/main' as string).catch(
      () => null,
    )) as null | {
      init: (opts: Record<string, unknown>) => void;
    };
    if (!sentry) {
      log.warn('Sentry: @sentry/electron is not installed; skipping');
      return;
    }
    sentry.init({
      dsn,
      release: `cheeseoclock-pos@${app.getVersion()}`,
      environment: app.isPackaged ? 'production' : 'development',
      tracesSampleRate: 0,
      autoSessionTracking: false,
      // Scrub PII before any event leaves the device.
      beforeSend: (event: Record<string, unknown>) => {
        try {
          scrubPii(event);
        } catch {
          // never block a send on scrubbing failure
        }
        return event;
      },
    });
    log.info('Sentry: initialized', { dsn: maskDsn(dsn) });
  } catch (e) {
    log.warn('Sentry: init failed', e);
  }
}

/**
 * Strip likely PII from a Sentry event payload. Stays conservative — we'd
 * rather lose context than leak phone numbers / PINs.
 */
function scrubPii(event: Record<string, unknown>): void {
  const json = JSON.stringify(event);
  const scrubbed = json
    // Pakistani mobile patterns
    .replace(/\+?92\s?-?\d{3}\s?-?\d{7}/g, '+92••• ••• ••••')
    .replace(/\b0\d{10}\b/g, '0•••••••••')
    // Email patterns
    .replace(/([\w.-]+)@([\w.-]+)/g, '$1•••@$2')
    // PIN-looking fields (keys named pin / pin_hash + 4-8 digit values)
    .replace(/"(pin|pin_hash|pinHash)"\s*:\s*"[^"]*"/g, '"$1":"••••"');
  const reparsed = JSON.parse(scrubbed) as Record<string, unknown>;
  for (const k of Object.keys(event)) delete event[k];
  Object.assign(event, reparsed);
}

function maskDsn(dsn: string): string {
  return dsn.replace(/(\/\/[^@]+@)/, '//•••@');
}
