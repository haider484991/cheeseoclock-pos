/**
 * What may leave the till in a crash report. Pure, used by the main process
 * (services/error-reporter.ts) and the renderer (main.tsx) before any Sentry
 * event is sent: phone numbers, e-mail addresses and sign-in secrets are
 * blanked wherever they appear in the event, and an event that cannot be
 * scrubbed is dropped rather than sent as it is.
 */

const PHONE_INTL = /\+?92\s?-?\d{3}\s?-?\d{7}/g;
const PHONE_LOCAL = /\b0\d{10}\b/g;
const EMAIL = /([\w.-]+)@([\w.-]+)/g;
/** Any value under a key that holds a PIN or a password (escape-aware: a password may hold quotes). */
const SECRET_FIELDS = /"(pin|pin_hash|pinHash|approverPin|password|secret|newPin|currentPin|bridgeSecret|bearerToken|token)"\s*:\s*"(?:[^"\\]|\\.)*"/g;

/** Blank phones, e-mails and secrets in a JSON text. */
export function scrubPiiText(json: string): string {
  return json
    .replace(PHONE_INTL, '+92••• ••• ••••')
    .replace(PHONE_LOCAL, '0•••••••••')
    .replace(EMAIL, '$1•••@$2')
    .replace(SECRET_FIELDS, '"$1":"••••"');
}

/**
 * The event with its PII blanked, or null when it cannot be scrubbed (not an
 * object, not serialisable, cyclic): a report that cannot be cleaned is not
 * sent. Never throws.
 */
export function scrubEventForSend<T extends object>(event: T): T | null {
  try {
    if (!event || typeof event !== 'object') return null;
    const json = JSON.stringify(event);
    if (typeof json !== 'string') return null;
    const reparsed = JSON.parse(scrubPiiText(json)) as unknown;
    if (!reparsed || typeof reparsed !== 'object') return null;
    return reparsed as T;
  } catch {
    return null;
  }
}
