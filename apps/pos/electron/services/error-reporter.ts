import { app } from 'electron';
import log from 'electron-log/main';
import { scrubEventForSend } from '@cheeseoclock/pos-domain';

/**
 * Crash + error reporting. Wires up @sentry/electron when:
 *   - the package is installed (try-imported, no hard dependency)
 *   - SENTRY_DSN was set when the build was made (the release workflow passes
 *     the repository secret; empty = off)
 *
 * Otherwise this is a no-op — the app still boots, errors still go to the
 * electron-log file.
 *
 * Nothing personal leaves the till: every event is scrubbed (phones, e-mails,
 * PINs, passwords, tokens — pos-domain pii-scrub.ts) and an event that cannot
 * be scrubbed is DROPPED, never sent as it is. Sentry's own PII collection is
 * off. The till's device id is a tag so a report can be matched to a shop.
 *
 * Unhandled promise rejections in the main process are logged (and reported
 * when Sentry is on) instead of ending the process: a till keeps selling.
 */
interface SentryMainLike {
  init: (opts: Record<string, unknown>) => void;
  setTag?: (key: string, value: string) => void;
  captureException?: (err: unknown) => unknown;
}

let sentryRef: SentryMainLike | null = null;
let rejectionsHooked = false;

export async function initErrorReporter(): Promise<void> {
  hookUnhandledRejections();
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
    )) as null | SentryMainLike;
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
      sendDefaultPii: false,
      // Scrub PII before any event leaves the device; drop what cannot be scrubbed.
      beforeSend: (event: Record<string, unknown>) => {
        const clean = scrubEventForSend(event);
        if (!clean) log.warn('Sentry: an event could not be scrubbed and was not sent');
        return clean;
      },
    });
    sentryRef = sentry;
    log.info('Sentry: initialized', { dsn: maskDsn(dsn) });
  } catch (e) {
    log.warn('Sentry: init failed', e);
  }
}

/** Facts that identify the till, not a person (the device id, its name). No-op when Sentry is off. */
export function tagErrorReporter(tags: Record<string, string>): void {
  const s = sentryRef;
  if (!s?.setTag) return;
  for (const [k, v] of Object.entries(tags)) {
    try {
      s.setTag(k, v);
    } catch {
      // a tag is never worth an error
    }
  }
}

function hookUnhandledRejections(): void {
  if (rejectionsHooked) return;
  rejectionsHooked = true;
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection in the main process', reason);
    try {
      sentryRef?.captureException?.(reason);
    } catch {
      // the log line is the record
    }
  });
}

function maskDsn(dsn: string): string {
  return dsn.replace(/(\/\/[^@]+@)/, '//•••@');
}
