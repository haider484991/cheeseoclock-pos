import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import log from 'electron-log/main';
import type {
  SyncAdapter,
  SyncChange,
  SyncCursor,
  PushResult,
  PullResult,
} from '@cheeseoclock/sync-core';

/**
 * No-network sync adapter for development. Pushes are written to
 * userData/sync-mock/ as JSON (a big one, such as "send everything", as a
 * summary; the newest 200 files are kept); pulls return empty. Lets you exercise the
 * worker + queue plumbing without standing up a Postgres backend.
 *
 * If you want to simulate inbound peer changes, drop a JSON file shaped like
 *   { changes: SyncChange[] }
 * into userData/sync-mock/inbox/ — the next pull picks them up and clears the
 * file. (This is how we test conflict resolution locally.)
 */
export class MockSyncAdapter implements SyncAdapter {
  readonly mode = 'cloud' as const;
  private readonly dir: string;
  private readonly inboxDir: string;

  constructor() {
    this.dir = path.join(app.getPath('userData'), 'sync-mock');
    this.inboxDir = path.join(this.dir, 'inbox');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.inboxDir, { recursive: true });
  }

  async pushChanges(changes: SyncChange[], cursor: SyncCursor): Promise<PushResult> {
    if (changes.length === 0) {
      return { accepted: [], rejected: [], newCursor: { ...cursor, lastPushedAt: new Date().toISOString() } };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(this.dir, `push-${stamp}.json`);
    const full = JSON.stringify(changes, null, 2);
    // A full send is the whole database: write what was in it, not all of it.
    fs.writeFileSync(file, full.length <= MOCK_FULL_PAYLOAD_BYTES ? full : summarize(changes));
    this.keepNewest();
    log.info('Mock sync wrote push', { file, count: changes.length });
    return {
      accepted: changes.map((c) => c.entityId),
      rejected: [],
      newCursor: { ...cursor, lastPushedAt: new Date().toISOString() },
    };
  }

  async pullChanges(cursor: SyncCursor): Promise<PullResult> {
    // Drain the inbox: any *.json file with { changes: [...] } is consumed.
    const files = fs.readdirSync(this.inboxDir).filter((f) => f.endsWith('.json'));
    const changes: SyncChange[] = [];
    for (const f of files) {
      const full = path.join(this.inboxDir, f);
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as { changes?: SyncChange[] };
        if (parsed.changes) changes.push(...parsed.changes);
        fs.unlinkSync(full);
      } catch (e) {
        log.warn('Mock sync inbox parse failed', { file: f, err: e });
      }
    }
    return {
      changes,
      newCursor: { ...cursor, lastPulledAt: new Date().toISOString() },
    };
  }

  subscribeRemote(): { unsubscribe: () => void } {
    return { unsubscribe: () => {} };
  }

  /** Only the newest push files stay; the folder must not grow without end. */
  private keepNewest(): void {
    try {
      const pushes = fs
        .readdirSync(this.dir)
        .filter((f) => f.startsWith('push-') && f.endsWith('.json'))
        .sort();
      for (const f of pushes.slice(0, Math.max(0, pushes.length - MOCK_KEEP_FILES))) {
        fs.unlinkSync(path.join(this.dir, f));
      }
    } catch (e) {
      log.warn('Mock sync could not tidy its folder', { err: e });
    }
  }
}

/** Pushes up to this size are written in full; bigger ones as a summary. */
const MOCK_FULL_PAYLOAD_BYTES = 256 * 1024;
const MOCK_KEEP_FILES = 200;

function summarize(changes: SyncChange[]): string {
  const byType: Record<string, number> = {};
  for (const c of changes) byType[c.entityType] = (byType[c.entityType] ?? 0) + 1;
  return JSON.stringify(
    {
      summary: true,
      count: changes.length,
      byType,
      first: changes.slice(0, 20).map((c) => ({ entityType: c.entityType, entityId: c.entityId, op: c.op })),
    },
    null,
    2,
  );
}
