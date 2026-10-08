import { DASH_SETUP_CODE_HOURS, type DashLoginView, type DashPushStatus } from '@cheeseoclock/shared-types';

/**
 * How Settings → Online orders → Phone dashboard says things (the owner's
 * phone dashboard, v0.7.40). Pure, so the words are tested.
 */

export type DashTone = 'good' | 'warn' | 'plain';

const TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

/** "Thu 8 Oct, 9:41 pm" in Karachi. */
export function dashTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '–' : TIME.format(d).replace(/\s?([ap])m$/i, (_m, x: string) => ` ${x.toLowerCase()}m`);
}

/** The status line under the card's title, and its colour. */
export function pushStatusText(s: DashPushStatus): { text: string; tone: DashTone } {
  switch (s.phase) {
    case 'off':
      return { text: 'Off on this till: its figures are not sent. The people below can still sign in and see the other till’s.', tone: 'plain' };
    case 'not_linked':
      return { text: 'Set up the website link above first: the figures go through it.', tone: 'plain' };
    case 'website_old':
      return { text: 'The website needs its update before it has the phone dashboard. This till tries again every hour.', tone: 'warn' };
    case 'starting':
      return { text: 'Starting: asking the website what it already has…', tone: 'plain' };
    case 'sending_history':
      return { text: `Sending this till’s history to the dashboard, a batch every few seconds (${s.ordersSent.toLocaleString('en-GB')} orders so far).`, tone: 'plain' };
    case 'failing':
      return { text: `Could not send just now${s.lastError ? `: ${s.lastError}` : ''}. It tries again by itself.`, tone: 'warn' };
    case 'up_to_date':
      return {
        text: `This till’s orders, shifts, cash, stock and menu are on the dashboard${s.lastSentAt ? `. Last sent ${dashTime(s.lastSentAt)}` : ''}. It sends again whenever something changes.`,
        tone: 'good',
      };
  }
}

/** One person's line: where their sign-in stands. */
export function loginStateText(l: DashLoginView): string {
  if (l.setupPending && !l.hasPassword) return `Waiting to set up · the code runs out ${dashTime(l.setupExpiresAt)}`;
  if (!l.hasPassword) return 'No password yet · make a setup code';
  const phones = l.signedInPhones === 0 ? 'not signed in' : `signed in on ${l.signedInPhones} phone${l.signedInPhones === 1 ? '' : 's'}`;
  const last = l.lastSignInAt ? ` · last signed in ${dashTime(l.lastSignInAt)}` : '';
  const pending = l.setupPending ? ' · a new setup code is waiting' : '';
  return `${phones}${last}${pending}`;
}

export function roleText(l: Pick<DashLoginView, 'role' | 'seesReports'>): string {
  if (l.role === 'owner') return 'Owner · sees everything';
  return l.seesReports ? 'Manager · also sees reports and past shifts' : 'Manager · orders, shifts open now, stock, menu';
}

export const CODE_DAYS = Math.round(DASH_SETUP_CODE_HOURS / 24);

/** What the owner sends the person (Copy): everything they need, in one message. */
export function setupMessage(p: { displayName: string; username: string; code: string; url: string | null }): string {
  const where = p.url ?? 'the dashboard on the shop’s website';
  return [
    `${p.displayName}, here is your sign-in for the shop’s phone dashboard.`,
    `1. Open ${where}`,
    '2. Tap “First time? Use your setup code”',
    `3. Username: ${p.username}`,
    `4. Setup code: ${p.code}`,
    '5. Pick your own password.',
    `The code works once, for ${CODE_DAYS} days.`,
  ].join('\n');
}

export const REMOVE_QUESTION = (name: string) =>
  `Remove ${name} from the phone dashboard? They are signed out of every phone at once and can no longer sign in.`;

export const SIGN_OUT_QUESTION = (name: string) => `Sign ${name} out of every phone? They can sign in again with their password.`;

export const NEW_CODE_QUESTION = (name: string) =>
  `Make a new setup code for ${name}? Use it for a forgotten password or a new phone: once they use it, their old password stops working.`;
