/**
 * Plain-words backup status for the owner: one line for the copy on this
 * computer, one for the copy online, and an overall green / amber / red.
 * Pure functions, shared by Settings → Backups, the Settings overview and
 * the dashboard banner, so all three always say the same thing.
 */

export type Tone = 'good' | 'warn' | 'bad';
export type OnlineFrequency = 'off' | 'daily' | 'weekly' | 'monthly';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The daily copy on this computer is late after this long (same rule as backup-health.ts). */
const LOCAL_STALE_MS = 2 * DAY_MS;
const ONLINE_INTERVAL_MS: Record<Exclude<OnlineFrequency, 'off'>, number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
  monthly: 30 * DAY_MS,
};

export interface BackupHealthInput {
  lastLocalAt: string | null;
  lastLocalError: { at: string; message: string } | null;
  lastCloudAt: string | null;
  lastCloudError: { at: string; message: string } | null;
}

export interface OnlineSetupInput {
  frequency: OnlineFrequency;
  /** Website address and connection password are filled in. */
  connected: boolean;
  /** A password is stored but was sealed on another computer. */
  secretUnreadable: boolean;
}

export interface StatusLine {
  tone: Tone;
  text: string;
  /**
   * Worth a banner on the dashboard. "Online copies are not set up" is a
   * choice the owner may have made; a copy that stopped is not.
   */
  alert: boolean;
}

export interface BackupSummary {
  tone: Tone;
  headline: string;
  local: StatusLine;
  online: StatusLine;
  /** What would fix the online line, if anything. */
  onlineFix: 'connect' | 'turn-on' | null;
}

const worst = (a: Tone, b: Tone): Tone =>
  a === 'bad' || b === 'bad' ? 'bad' : a === 'warn' || b === 'warn' ? 'warn' : 'good';

function daysAgo(iso: string, now: number): number {
  return Math.max(1, Math.round((now - Date.parse(iso)) / DAY_MS));
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function clock(d: Date): string {
  // Newer ICU puts a narrow no-break space before AM/PM; keep a plain one.
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s+/g, ' ');
}

/** "today at 9:12 AM", "yesterday at 9:40 PM", "Mon 22 Sep at 10:00 AM", "22 Sep 2025". */
export function fmtWhen(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown time';
  const today = new Date(now);
  if (sameDay(d, today)) return `today at ${clock(d)}`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(d, yesterday)) return `yesterday at ${clock(d)}`;
  const day = d.getDate();
  const month = d.toLocaleDateString('en-US', { month: 'short' });
  if (d.getFullYear() !== today.getFullYear()) return `${day} ${month} ${d.getFullYear()}`;
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  return `${weekday} ${day} ${month} at ${clock(d)}`;
}

export function summarizeBackups(
  health: BackupHealthInput,
  online: OnlineSetupInput,
  now: number = Date.now(),
): BackupSummary {
  // --- this computer -------------------------------------------------------
  let local: StatusLine;
  if (health.lastLocalError) {
    local = {
      tone: 'bad',
      text: `On this computer: the last backup failed (${health.lastLocalError.message})`,
      alert: true,
    };
  } else if (!health.lastLocalAt) {
    local = { tone: 'bad', text: 'On this computer: no backup yet', alert: true };
  } else if (now - Date.parse(health.lastLocalAt) > LOCAL_STALE_MS) {
    local = {
      tone: 'warn',
      text: `On this computer: last backup ${daysAgo(health.lastLocalAt, now)} days ago`,
      alert: true,
    };
  } else {
    local = { tone: 'good', text: `On this computer: ${fmtWhen(health.lastLocalAt, now)}`, alert: false };
  }

  // --- online --------------------------------------------------------------
  let onlineLine: StatusLine;
  let onlineFix: BackupSummary['onlineFix'] = null;
  if (!online.connected) {
    onlineFix = 'connect';
    onlineLine = online.secretUnreadable
      ? {
          tone: 'warn',
          text: 'Online: stopped — the website connection password needs to be entered again',
          alert: true,
        }
      : {
          tone: 'warn',
          text: 'Online: not set up — connect the website to keep a copy away from this computer',
          alert: false,
        };
  } else if (online.frequency === 'off') {
    onlineFix = 'turn-on';
    onlineLine = { tone: 'warn', text: 'Online: switched off', alert: false };
  } else if (!health.lastCloudAt) {
    onlineLine = health.lastCloudError
      ? {
          tone: 'bad',
          text: `Online: no copy saved yet (${health.lastCloudError.message})`,
          alert: true,
        }
      : { tone: 'warn', text: 'Online: the first copy has not been saved yet', alert: false };
  } else if (now - Date.parse(health.lastCloudAt) > ONLINE_INTERVAL_MS[online.frequency] + DAY_MS) {
    const age = daysAgo(health.lastCloudAt, now);
    onlineLine = health.lastCloudError
      ? {
          tone: 'bad',
          text: `Online: last copy ${age} days ago — saving a new one fails (${health.lastCloudError.message})`,
          alert: true,
        }
      : { tone: 'warn', text: `Online: last copy ${age} days ago`, alert: true };
  } else {
    onlineLine = { tone: 'good', text: `Online: ${fmtWhen(health.lastCloudAt, now)}`, alert: false };
  }

  const tone = worst(local.tone, onlineLine.tone);
  const headline =
    tone === 'good'
      ? 'Your data is backed up'
      : tone === 'bad'
        ? 'Backups are not working'
        : local.tone === 'good' && !onlineLine.alert
          ? 'Backed up on this computer only'
          : 'Backups need a look';
  return { tone, headline, local, online: onlineLine, onlineFix };
}

// --- the list of copies ------------------------------------------------------

/** What kind of copy a file in the backups folder is, from its name. */
export function localCopyLabel(fileName: string): string {
  if (fileName.startsWith('auto-')) return 'Daily copy';
  if (fileName.startsWith('manual-')) return 'Saved with “Back up now”';
  if (fileName.startsWith('before-restore-')) return 'Safety copy, made before a restore';
  return 'Copy';
}

/** What kind of copy an online copy is, from the reason it was uploaded. */
export function copyReasonLabel(reason: string | null): string {
  switch (reason) {
    case 'scheduled':
      return 'Scheduled copy';
    case 'manual':
      return 'Saved with “Back up now”';
    case 'before-restore':
      return 'Safety copy, made before a restore';
    default:
      return 'Copy';
  }
}

export interface LocalCopy {
  fileName: string;
  fullPath: string;
  sizeBytes: number;
  createdAtIso: string;
}

export interface OnlineCopy {
  id: string;
  createdAt: string;
  deviceName: string | null;
  isThisDevice: boolean;
  orderCount: number | null;
  reason: string | null;
  sizeBytes: number;
}

export type CopyRow =
  | { where: 'local'; key: string; at: string; label: string; sizeBytes: number; copy: LocalCopy }
  | {
      where: 'online';
      key: string;
      at: string;
      label: string;
      sizeBytes: number;
      /** Name of the computer that made it, when it was not this one. */
      fromOtherPc: string | null;
      copy: OnlineCopy;
    };

/** Copies on this computer and online, in one list, newest first. */
export function mergeCopies(local: LocalCopy[], online: OnlineCopy[]): CopyRow[] {
  const rows: CopyRow[] = [
    ...local.map(
      (c): CopyRow => ({
        where: 'local',
        key: `local:${c.fileName}`,
        at: c.createdAtIso,
        label: localCopyLabel(c.fileName),
        sizeBytes: c.sizeBytes,
        copy: c,
      }),
    ),
    ...online.map(
      (c): CopyRow => ({
        where: 'online',
        key: `online:${c.id}`,
        at: c.createdAt,
        label: copyReasonLabel(c.reason),
        sizeBytes: c.sizeBytes,
        fromOtherPc: c.isThisDevice ? null : (c.deviceName ?? 'another computer'),
        copy: c,
      }),
    ),
  ];
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
