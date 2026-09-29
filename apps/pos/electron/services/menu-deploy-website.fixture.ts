/**
 * A stand-in website for the till's tests of the menu files from the costing
 * PC (v0.7.32): the bridge routes of apps/web (contract 2.5–2.6, as
 * lib/menu-deploy-store.ts has them — the claim with its lease, "behind",
 * "busy"/"stalled", the reports and their back-off), in memory, on a clock
 * the test moves. Nothing leaves the process.
 *
 * Not a test file: imported by *.test.ts (which mock electron first).
 * EVERY MENU HERE IS MADE UP — the repo is public.
 */
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  MENU_DEPLOY_LEASE_SECONDS,
  MENU_DEPLOY_MAX_ATTEMPTS,
  MENU_FILE_MAX_BYTES,
} from '@cheeseoclock/shared-types';
import {
  menuDeployClaimBodySchema,
  menuDeployCountsSchema,
  menuDeployKeyBodySchema,
  menuDeployReportBodySchema,
  type MenuDeployClaimBody,
  type MenuDeployCounts,
  type MenuPackageMeta,
} from '@cheeseoclock/shared-schemas';

/** The shared clock (ms): the service and the website read the same one. */
export interface Clock {
  t: number;
}

export interface FakePackage {
  id: string;
  seq: number;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  formatVersion: number;
  source: string | null;
  generatedAt: string;
  uploadedAt: number;
  uploader: string | null;
  itemCount: number;
  ingredientCount: number;
  contentGzB64: string | null;
  state: MenuPackageMeta['state'];
  claimedBy: string | null;
  claimedAt: number | null;
  leaseUntil: number | null;
  attempts: number;
  nextTryAt: number | null;
  appliedBy: string | null;
  appliedAt: number | null;
  result: MenuDeployCounts | null;
  error: string | null;
}

export interface FakeEvent {
  at: number;
  kind: string;
  packageId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  detail: Record<string, unknown> | null;
}

export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
  deviceId?: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A made-up menu file (format 3), tagged so two files differ. */
export function madeUpMenu(tag: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'cheeseoclock-menu-import',
    version: 3,
    source: `test menu ${tag}`,
    tax: { name: 'Test Tax', rateBps: 1600 },
    categories: [
      { name: 'Test Pizzas', displayOrder: 1 },
      { name: 'Test Drinks', displayOrder: 2 },
    ],
    modifierGroups: [
      {
        name: 'Test dip',
        selectionType: 'single',
        minSelect: 1,
        maxSelect: 1,
        required: true,
        options: [
          { name: 'Test Garlic Dip', priceDeltaCents: 0, isDefault: true },
          { name: 'Test Chili Dip', priceDeltaCents: 5_000 },
        ],
      },
    ],
    ingredients: [
      { name: 'Test Dough', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 9_000 },
      { name: 'Test Cheese', unit: 'g', costPerUnitCents: 0, packSize: 1000, packPriceCents: 120_000 },
    ],
    items: [
      {
        name: 'Test Margherita',
        category: 'Test Pizzas',
        priceCents: 110_000,
        modifierGroups: ['Test dip'],
        recipe: [
          { ingredient: 'Test Dough', qty: 250 },
          { ingredient: 'Test Cheese', qty: 120 },
        ],
      },
      { name: 'Test Lemonade', category: 'Test Drinks', priceCents: 25_000 },
    ],
    ...over,
  };
}

export class FakeMenuWebsite {
  readonly packages: FakePackage[] = [];
  readonly events: FakeEvent[] = [];
  readonly calls: FakeCall[] = [];
  key: { keyHash: string; keyHint: string; deviceId: string; deviceName: string | null; createdAt: number } | null = null;
  /** Every route answers 404 (a website older than this feature). */
  old = false;
  /** Every call fails as if the network were down. */
  down = false;
  /** The next calls whose path matches fail as if the network dropped them (after the website did its work, when `afterWork`). */
  private drops: Array<{ re: RegExp; afterWork: boolean }> = [];
  private nextSeq = 1;

  constructor(readonly clock: Clock) {}

  private get now(): number {
    return this.clock.t;
  }

  /** The costing PC's upload (the website's own checks are apps/web's tests): a raw file, as bytes or an object. */
  upload(file: Record<string, unknown> | string, opts: { fileName?: string; generatedAt?: string; uploader?: string } = {}): FakePackage {
    const text = typeof file === 'string' ? file : JSON.stringify(file);
    const raw = Buffer.from(text, 'utf8');
    const obj = (typeof file === 'string' ? (() => { try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return {}; } })() : file) as Record<string, unknown>;
    const p: FakePackage = {
      id: randomUUID(),
      seq: this.nextSeq++,
      fileName: opts.fileName ?? 'test-menu-import.json',
      sha256: createHash('sha256').update(raw).digest('hex'),
      sizeBytes: raw.length,
      formatVersion: typeof obj['version'] === 'number' ? (obj['version'] as number) : 1,
      source: typeof obj['source'] === 'string' ? (obj['source'] as string) : null,
      generatedAt: opts.generatedAt ?? iso(this.now),
      uploadedAt: this.now,
      uploader: opts.uploader ?? 'TEST-COSTING-PC',
      itemCount: Array.isArray(obj['items']) ? (obj['items'] as unknown[]).length : 0,
      ingredientCount: Array.isArray(obj['ingredients']) ? (obj['ingredients'] as unknown[]).length : 0,
      contentGzB64: gzipSync(raw).toString('base64'),
      state: 'pending',
      claimedBy: null,
      claimedAt: null,
      leaseUntil: null,
      attempts: 0,
      nextTryAt: null,
      appliedBy: null,
      appliedAt: null,
      result: null,
      error: null,
    };
    for (const o of this.packages) {
      if (o.state === 'pending' || o.state === 'failed') {
        o.state = 'superseded';
        o.nextTryAt = null;
      }
    }
    this.packages.push(p);
    this.event('uploaded', p.id, null, null, {
      fileName: p.fileName,
      generatedAt: p.generatedAt,
      itemCount: p.itemCount,
      ingredientCount: p.ingredientCount,
      uploader: p.uploader,
    });
    return p;
  }

  /** The next call to a path like `re` is lost on the network — before the website sees it, or after it did its work. */
  drop(re: RegExp, opts: { afterWork?: boolean } = {}): void {
    this.drops.push({ re, afterWork: opts.afterWork === true });
  }

  byId(id: string): FakePackage | undefined {
    return this.packages.find((p) => p.id === id);
  }

  latest(): FakePackage | null {
    return this.packages.length ? this.packages[this.packages.length - 1]! : null;
  }

  callsTo(re: RegExp, deviceId?: string): FakeCall[] {
    return this.calls.filter((c) => re.test(c.path) && (deviceId === undefined || c.deviceId === deviceId));
  }

  claims(deviceId?: string): FakeCall[] {
    return this.callsTo(/\/claim$/, deviceId);
  }

  reports(outcome?: string, deviceId?: string): FakeCall[] {
    return this.callsTo(/\/report$/, deviceId).filter((c) => outcome === undefined || (c.body as { outcome?: string })?.outcome === outcome);
  }

  private event(kind: string, packageId: string | null, deviceId: string | null, deviceName: string | null, detail: Record<string, unknown> | null): void {
    this.events.push({ at: this.now, kind, packageId, deviceId, deviceName, detail });
  }

  meta(p: FakePackage): MenuPackageMeta {
    return {
      id: p.id,
      seq: p.seq,
      fileName: p.fileName,
      sha256: p.sha256,
      sizeBytes: p.sizeBytes,
      formatVersion: p.formatVersion,
      source: p.source,
      generatedAt: p.generatedAt,
      uploadedAt: iso(p.uploadedAt),
      uploader: p.uploader,
      itemCount: p.itemCount,
      ingredientCount: p.ingredientCount,
      state: p.state,
      claimedBy: p.claimedBy,
      claimedAt: p.claimedAt !== null ? iso(p.claimedAt) : null,
      leaseUntil: p.leaseUntil !== null ? iso(p.leaseUntil) : null,
      leaseExpired: p.state === 'claimed' && p.leaseUntil !== null && p.leaseUntil <= this.now,
      attempts: p.attempts,
      nextTryAt: p.nextTryAt !== null ? iso(p.nextTryAt) : null,
      retryReady: p.nextTryAt === null || p.nextTryAt <= this.now,
      appliedBy: p.appliedBy,
      appliedAt: p.appliedAt !== null ? iso(p.appliedAt) : null,
      result: p.result,
      error: p.error,
      hasContent: p.contentGzB64 !== null,
    };
  }

  /** The till's callWebsite, as one till (its bridge secret is taken as given). */
  fetchFor(deviceId: string): (path: string, init?: RequestInit) => Promise<Response> {
    return async (path, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: unknown = null;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      this.calls.push({ method, path, body, deviceId });
      if (this.down) throw new TypeError('fetch failed');
      const i = this.drops.findIndex((d) => d.re.test(path));
      const drop = i >= 0 ? this.drops.splice(i, 1)[0]! : null;
      if (drop && !drop.afterWork) throw new TypeError('fetch failed');
      const res = this.route(method, path, body);
      if (drop) throw new TypeError('fetch failed');
      return res;
    };
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  private route(method: string, path: string, body: unknown): Response {
    if (this.old) return this.json({ ok: false, error: 'not_found' }, 404);
    const url = new URL(path, 'https://test.invalid');
    const m = /^\/api\/bridge\/menu-deploy(?:\/([^/]+)(?:\/(claim|report|content))?)?$/.exec(url.pathname);
    if (!m) return this.json({ ok: false, error: 'not_found' }, 404);
    const [, id, action] = m;
    if (!id && method === 'GET') return this.json(this.status(url.searchParams.get('history') === '1'));
    if (id === 'key' && !action && method === 'PUT') return this.putKey(body);
    if (id && action === 'content' && method === 'GET') return this.content(id);
    if (id && action === 'claim' && method === 'POST') return this.claim(id, body);
    if (id && action === 'report' && method === 'POST') return this.report(id, body);
    return this.json({ ok: false, error: 'not_found' }, 404);
  }

  private status(history: boolean): Record<string, unknown> {
    const latest = this.latest();
    const applied = [...this.packages].reverse().find((p) => p.state === 'applied');
    const tills = new Map<string, FakeEvent>();
    if (latest) {
      for (const e of this.events) if (e.packageId === latest.id && e.deviceId) tills.set(e.deviceId, e);
    }
    const out: Record<string, unknown> = {
      ok: true,
      key: this.key ? { keyHint: this.key.keyHint, createdAt: iso(this.key.createdAt), deviceId: this.key.deviceId, deviceName: this.key.deviceName } : null,
      latest: latest ? this.meta(latest) : null,
      lastApplied: applied ? { id: applied.id, seq: applied.seq, appliedBy: applied.appliedBy, appliedAt: applied.appliedAt ? iso(applied.appliedAt) : null } : null,
      tills: [...tills.values()].map((e) => ({ deviceId: e.deviceId, deviceName: e.deviceName, kind: e.kind, at: iso(e.at), detail: e.detail })),
    };
    if (history) {
      out['events'] = [...this.events]
        .reverse()
        .slice(0, 50)
        .map((e) => ({
          at: iso(e.at),
          kind: e.kind,
          packageId: e.packageId,
          fileName: e.packageId ? (this.byId(e.packageId)?.fileName ?? null) : null,
          deviceId: e.deviceId,
          deviceName: e.deviceName,
          detail: e.detail,
        }));
    }
    return out;
  }

  private putKey(body: unknown): Response {
    const b = menuDeployKeyBodySchema.safeParse(body);
    if (!b.success) return this.json({ ok: false, error: 'validation' }, 400);
    this.key = { keyHash: b.data.keyHash, keyHint: b.data.keyHint, deviceId: b.data.deviceId, deviceName: b.data.deviceName, createdAt: this.now };
    this.event('key_created', null, b.data.deviceId, b.data.deviceName, { keyHint: b.data.keyHint });
    return this.json({ ok: true, createdAt: iso(this.now) });
  }

  private content(id: string): Response {
    const p = this.byId(id);
    if (!p) return this.json({ ok: false, error: 'not_found' }, 404);
    if (p.contentGzB64 === null) return this.json({ ok: false, error: 'gone' }, 410);
    return this.json({ ok: true, sha256: p.sha256, contentGzB64: p.contentGzB64 });
  }

  private expired(p: FakePackage): boolean {
    return p.state === 'claimed' && p.leaseUntil !== null && p.leaseUntil <= this.now;
  }

  private claim(id: string, raw: unknown): Response {
    const parsed = menuDeployClaimBodySchema.safeParse(raw);
    if (!parsed.success) return this.json({ ok: false, error: 'validation' }, 400);
    const b = parsed.data;
    const p = this.byId(id);
    if (!p) return this.json({ ok: false, error: 'not_found' }, 404);
    const newest = this.latest()?.id === p.id;
    const ok = (kind: string, detail: Record<string, unknown>) => {
      this.event(kind, p.id, b.deviceId, b.deviceName, { scope: b.scope, appVersion: b.appVersion, ...detail });
      return this.json({ ok: true, leaseSeconds: MENU_DEPLOY_LEASE_SECONDS, package: this.meta(p), contentGzB64: p.contentGzB64 });
    };
    if (b.scope === 'own') {
      if (newest && p.contentGzB64 !== null && p.formatVersion <= b.maxFormatVersion && p.state !== 'refused') return ok('claimed', {});
      return this.refuse(p, b);
    }
    const behind = this.packages.some((a) => a.state === 'applied' && a.seq > (b.lastPackageSeq ?? -1));
    const blocked = this.packages.some(
      (c) => c.seq < p.seq && c.state === 'claimed' && c.claimedBy !== b.deviceId && (!this.expired(c) || !b.takeOver),
    );
    const stateOk =
      (p.state === 'pending' && (p.nextTryAt === null || p.nextTryAt <= this.now || b.retry)) ||
      (p.state === 'claimed' && p.claimedBy === b.deviceId) ||
      (p.state === 'claimed' && this.expired(p) && b.takeOver) ||
      (p.state === 'failed' && b.retry);
    if (!(newest && p.contentGzB64 !== null && p.formatVersion <= b.maxFormatVersion && !behind && !blocked && stateOk)) {
      return this.refuse(p, b);
    }
    const from = p.state === 'claimed' && p.claimedBy !== b.deviceId ? p.claimedBy : null;
    p.state = 'claimed';
    p.claimedBy = b.deviceId;
    p.claimedAt = this.now;
    p.leaseUntil = this.now + MENU_DEPLOY_LEASE_SECONDS * 1000;
    if (b.retry) p.attempts = 0;
    p.nextTryAt = null;
    // Older claims settled: this till's own (put in when its marker covers it), or taken over.
    for (const o of this.packages) {
      if (o.seq >= p.seq || o.state !== 'claimed') continue;
      if (o.claimedBy !== b.deviceId && !(b.takeOver && this.expired(o))) continue;
      const mine = o.claimedBy === b.deviceId && o.seq <= (b.lastPackageSeq ?? -1);
      o.state = mine ? 'applied' : 'superseded';
      if (mine) {
        o.appliedBy = o.claimedBy;
        o.appliedAt = this.now;
        this.event('applied', o.id, b.deviceId, b.deviceName, { scope: 'shared', recovered: true });
      }
      o.claimedBy = null;
      o.claimedAt = null;
      o.leaseUntil = null;
      o.nextTryAt = null;
    }
    return ok(from ? 'taken_over' : 'claimed', from ? { from } : {});
  }

  private refuse(p: FakePackage, b: MenuDeployClaimBody): Response {
    const hasNewer = this.packages.some((n) => n.seq > p.seq);
    const behind = this.packages.some((a) => a.state === 'applied' && a.seq > (b.lastPackageSeq ?? -1));
    const blockers = this.packages
      .filter((c) => c.seq < p.seq && c.state === 'claimed' && c.claimedBy !== b.deviceId)
      .sort((x, y) => Number(this.expired(x)) - Number(this.expired(y)) || y.seq - x.seq);
    const blocker = blockers[0] ?? null;
    const meta = this.meta(p);
    let error: string;
    if (p.state === 'superseded' || hasNewer) error = 'superseded';
    else if (p.state === 'refused') error = 'refused';
    else if (p.formatVersion > b.maxFormatVersion) error = 'too_old';
    else if (b.scope === 'own') error = meta.hasContent ? 'busy' : 'gone';
    else if (p.state === 'applied') error = 'already_applied';
    else if (p.state === 'failed' && !b.retry) error = 'failed';
    else if (p.state === 'claimed' && p.claimedBy !== b.deviceId && !meta.leaseExpired) error = 'claimed';
    else if (p.state === 'claimed' && p.claimedBy !== b.deviceId && !b.takeOver) error = 'stalled';
    else if (blocker && !this.expired(blocker)) error = 'busy';
    else if (blocker && !b.takeOver) error = 'stalled';
    else if (behind) error = 'behind';
    else if (p.state === 'pending' && !meta.retryReady && !b.retry) error = 'retry_later';
    else if (!meta.hasContent) error = 'gone';
    else error = 'busy';
    if (error === 'too_old') {
      this.event('too_old', p.id, b.deviceId, b.deviceName, { scope: b.scope, formatVersion: p.formatVersion, maxFormatVersion: b.maxFormatVersion });
    }
    return this.json(
      {
        ok: false,
        error,
        package: meta,
        blockedBy:
          (error === 'busy' || error === 'stalled') && blocker
            ? { id: blocker.id, seq: blocker.seq, claimedBy: blocker.claimedBy, leaseExpired: this.expired(blocker) }
            : null,
      },
      409,
    );
  }

  private report(id: string, raw: unknown): Response {
    const parsed = menuDeployReportBodySchema.safeParse(raw);
    if (!parsed.success) return this.json({ ok: false, error: 'validation' }, 400);
    const b = parsed.data;
    const p = this.byId(id);
    if (!p) return this.json({ ok: false, error: 'not_found' }, 404);
    const before = { state: p.state, appliedBy: p.appliedBy };
    let accepted = false;
    const detail = { scope: b.scope, appVersion: b.appVersion, counts: b.counts, error: b.error, retryable: b.retryable };
    if (b.scope === 'shared' && b.outcome === 'applied') {
      if (
        ['claimed', 'pending', 'failed', 'superseded'].includes(p.state) &&
        (p.claimedBy === b.deviceId || p.claimedBy === null || this.expired(p))
      ) {
        p.state = 'applied';
        p.appliedBy = b.deviceId;
        p.appliedAt = this.now;
        p.result = b.counts ?? menuDeployCountsSchema.parse({});
        p.claimedBy = null;
        p.claimedAt = null;
        p.leaseUntil = null;
        p.error = null;
        p.nextTryAt = null;
        accepted = true;
      }
      if (!(before.state === 'applied' && before.appliedBy === b.deviceId)) {
        this.event('applied', p.id, b.deviceId, b.deviceName, { ...detail, duplicate: before.state === 'applied', late: before.state === 'superseded', accepted });
      }
    } else if (b.scope === 'shared' && b.outcome === 'failed') {
      if (p.state === 'claimed' && p.claimedBy === b.deviceId) {
        const hasNewer = this.packages.some((n) => n.seq > p.seq);
        const was = p.attempts;
        p.attempts += 1;
        p.state = hasNewer ? 'superseded' : p.attempts >= MENU_DEPLOY_MAX_ATTEMPTS ? 'failed' : 'pending';
        p.nextTryAt = this.now + (was <= 0 ? 1 : was === 1 ? 2 : was === 2 ? 4 : 8) * 60_000;
        p.error = b.error ?? 'The import failed.';
        p.claimedBy = null;
        p.claimedAt = null;
        p.leaseUntil = null;
        accepted = true;
      }
      this.event('failed', p.id, b.deviceId, b.deviceName, { ...detail, accepted });
    } else if (b.scope === 'shared' && b.outcome === 'refused') {
      if (p.state === 'claimed' && p.claimedBy === b.deviceId) {
        p.state = 'refused';
        p.error = b.error ?? 'The till refused the file.';
        p.claimedBy = null;
        p.claimedAt = null;
        p.leaseUntil = null;
        p.nextTryAt = null;
        accepted = true;
      }
      this.event('refused', p.id, b.deviceId, b.deviceName, { ...detail, accepted });
    } else {
      this.event(b.outcome, p.id, b.deviceId, b.deviceName, { ...detail, formatVersion: b.formatVersion, maxFormatVersion: b.maxFormatVersion });
    }
    return this.json({
      ok: true,
      state: accepted ? p.state : before.state,
      duplicate: b.scope === 'shared' && b.outcome === 'applied' && before.state === 'applied' && before.appliedBy !== b.deviceId,
      accepted,
    });
  }
}

/** A file's bytes as the till would read them back from a package (for checks in tests). */
export function unpack(p: FakePackage): string {
  if (!p.contentGzB64) throw new Error('no content');
  return gunzipSync(Buffer.from(p.contentGzB64, 'base64'), { maxOutputLength: MENU_FILE_MAX_BYTES }).toString('utf8');
}
