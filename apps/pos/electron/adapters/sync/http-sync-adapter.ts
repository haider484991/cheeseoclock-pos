import log from 'electron-log/main';
import type {
  SyncAdapter,
  SyncChange,
  SyncCursor,
  PushResult,
  PullResult,
} from '@cheeseoclock/sync-core';

/**
 * Real HTTP sync adapter. Talks to a configurable backend that implements:
 *
 *   POST   {baseUrl}/sync/push      body: { deviceId, changes: SyncChange[], lastPushedAt }
 *          → { accepted: string[], rejected: [{id,reason}], serverNow: string }
 *
 *   GET    {baseUrl}/sync/pull?since=<lastPulledAt>&deviceId=<id>
 *          → { changes: SyncChange[], serverNow: string }
 *
 * Auth: bearer token in `Authorization: Bearer <deviceSecret>`. The backend
 * scopes pushes/pulls to the device's tenant (single-tenant for v1).
 *
 * No server provided in this repo yet — pair this with any Postgres-backed
 * HTTP service that implements the two endpoints. Until then, use MockSyncAdapter.
 */
export class HttpSyncAdapter implements SyncAdapter {
  readonly mode = 'cloud' as const;
  private baseUrl: string;
  private deviceId: string;
  private bearer: string;

  constructor(opts: { baseUrl: string; deviceId: string; deviceSecret: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.deviceId = opts.deviceId;
    this.bearer = opts.deviceSecret;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.bearer}`,
      'X-Device-Id': this.deviceId,
    };
  }

  async pushChanges(changes: SyncChange[], cursor: SyncCursor): Promise<PushResult> {
    if (changes.length === 0) {
      return { accepted: [], rejected: [], newCursor: cursor };
    }
    try {
      const res = await fetch(`${this.baseUrl}/sync/push`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          deviceId: this.deviceId,
          changes,
          lastPushedAt: cursor.lastPushedAt,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn('Sync push HTTP error', { status: res.status, text });
        return {
          accepted: [],
          rejected: changes.map((c) => ({ id: c.entityId, reason: `HTTP ${res.status}` })),
          newCursor: cursor,
        };
      }
      const body = (await res.json()) as {
        accepted?: string[];
        rejected?: Array<{ id: string; reason: string }>;
        serverNow?: string;
      };
      return {
        accepted: body.accepted ?? changes.map((c) => c.entityId),
        rejected: body.rejected ?? [],
        newCursor: { ...cursor, lastPushedAt: body.serverNow ?? new Date().toISOString() },
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.warn('Sync push network error', { message });
      return {
        accepted: [],
        rejected: changes.map((c) => ({ id: c.entityId, reason: message })),
        newCursor: cursor,
      };
    }
  }

  async pullChanges(cursor: SyncCursor): Promise<PullResult> {
    const since = encodeURIComponent(cursor.lastPulledAt ?? '');
    try {
      const res = await fetch(
        `${this.baseUrl}/sync/pull?since=${since}&deviceId=${encodeURIComponent(this.deviceId)}`,
        { method: 'GET', headers: this.headers() },
      );
      if (!res.ok) {
        log.warn('Sync pull HTTP error', { status: res.status });
        return { changes: [], newCursor: cursor };
      }
      const body = (await res.json()) as { changes?: SyncChange[]; serverNow?: string };
      return {
        changes: body.changes ?? [],
        newCursor: { ...cursor, lastPulledAt: body.serverNow ?? new Date().toISOString() },
      };
    } catch (e) {
      log.warn('Sync pull network error', { message: e instanceof Error ? e.message : String(e) });
      return { changes: [], newCursor: cursor };
    }
  }

  subscribeRemote(): { unsubscribe: () => void } {
    // v1 is polling-only. Phase 8.5: switch to SSE/WebSocket.
    return { unsubscribe: () => {} };
  }
}
