/**
 * Menu files from the costing PC (shared-types menu-deploy.ts), end to end
 * through the route handlers on a real Postgres (PGlite, in memory, with
 * db/schema.sql): the upload key, the upload checks and limits, the claim
 * lease between two tills, the reports, what the website keeps, and that the
 * file (costs and recipes) never reaches anyone without a key.
 *
 * Every menu here is made up.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MENU_CLAIM_REFUSALS,
  MENU_DEPLOY_KEEP_CONTENT,
  MENU_DEPLOY_LEASE_SECONDS,
  MENU_DEPLOY_MAX_ATTEMPTS,
  MENU_DEPLOY_UPLOADS_PER_DAY,
  MENU_IMPORT_FILE_FORMAT,
} from '@cheeseoclock/shared-types';
import {
  menuDeployClaimRefusalSchema,
  menuDeployClaimResponseSchema,
  menuDeployContentResponseSchema,
  menuDeployKeyResponseSchema,
  menuDeployReportResponseSchema,
  menuDeployStatusResponseSchema,
  menuDeployUploadResponseSchema,
  type MenuDeployCounts,
  type MenuPackageMeta,
} from '@cheeseoclock/shared-schemas/menu-deploy';
import { MAX_MENU_FILE_VERSION, menuImportFileSchema } from '@cheeseoclock/shared-schemas';

const db = vi.hoisted(() => ({ pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> } }));
vi.mock('@/lib/db', () => ({
  // The Neon client is a tagged template returning rows; PGlite takes $n params.
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows),
}));

// PGlite in a full parallel run is slow to start and to write; the checks are not about speed.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const upload = await import('@/app/api/menu-deploy/route');
const bridgeStatus = await import('@/app/api/bridge/menu-deploy/route');
const bridgeKey = await import('@/app/api/bridge/menu-deploy/key/route');
const bridgeContent = await import('@/app/api/bridge/menu-deploy/[id]/content/route');
const bridgeClaim = await import('@/app/api/bridge/menu-deploy/[id]/claim/route');
const bridgeReport = await import('@/app/api/bridge/menu-deploy/[id]/report/route');
const publicMenuRoute = await import('@/app/api/menu/route');
const store = await import('@/lib/menu-deploy-store');

const SECRET = 'test-bridge-secret-0123456789';
const SITE = 'https://site.test';
const PC_IP = '198.51.100.7';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every answer from the new routes, so each one can be checked for no-store. */
const answers: Array<{ route: string; res: Response }> = [];
async function call(route: string, res: Promise<Response> | Response): Promise<Response> {
  const r = await res;
  answers.push({ route, res: r });
  return r;
}

function newKey(): string {
  return `cocmenu_${randomBytes(32).toString('base64url')}`;
}
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function bridgeReq(path: string, init: { method?: string; body?: unknown; auth?: string } = {}): Request {
  return new Request(`${SITE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${init.auth ?? process.env['BRIDGE_SECRET']}`,
      'content-type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function registerKey(key: string, deviceId = 'till-1'): Promise<Response> {
  return call(
    'PUT /api/bridge/menu-deploy/key',
    bridgeKey.PUT(
      bridgeReq('/api/bridge/menu-deploy/key', {
        method: 'PUT',
        body: { keyHash: sha256(key), keyHint: key.slice(-4), deviceId, deviceName: 'Till 1', appVersion: '0.7.32' },
      }),
    ),
  );
}

/** A made-up menu import file. `secret` goes where the costs and recipes live. */
function menuFile(tag: string, opts: { version?: number; secret?: string; items?: number } = {}) {
  const items = Array.from({ length: opts.items ?? 2 }, (_, i) => ({
    name: `Test Pie ${tag} ${i + 1}`,
    category: 'Test Pies',
    priceCents: 100_00 + i * 50_00,
    recipe: [{ ingredient: 'Test cheese', qty: 120 + i }],
  }));
  return {
    format: 'cheeseoclock-menu-import',
    version: opts.version ?? 3,
    source: `made-up costing file ${tag}`,
    tax: null,
    categories: [{ name: 'Test Pies', displayOrder: 1 }],
    modifierGroups: [],
    ingredients: [
      { name: 'Test cheese', unit: 'g', costPerUnitCents: 7, notes: opts.secret ?? null },
      { name: 'Test flour', unit: 'g', costPerUnitCents: 1 },
    ],
    items,
  };
}

const T0 = Date.parse('2026-09-29T08:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function payload(file: unknown, generatedAt: string, extra: Record<string, unknown> = {}) {
  const raw = Buffer.from(JSON.stringify(file), 'utf8');
  return {
    fileName: 'cheeseoclock-menu-import.json',
    generatedAt,
    sha256: sha256(raw),
    sizeBytes: raw.length,
    contentGzB64: gzipSync(raw).toString('base64'),
    uploader: 'COSTING-PC',
    ...extra,
  };
}

function pcReq(key: string, init: { method?: string; body?: unknown; raw?: string; ip?: string; headers?: Record<string, string> } = {}) {
  return new Request(`${SITE}/api/menu-deploy`, {
    method: init.method ?? 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'x-forwarded-for': init.ip ?? PC_IP,
      ...(init.headers ?? {}),
    },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
}

async function send(key: string, body: unknown, ip?: string): Promise<Response> {
  return call('POST /api/menu-deploy', upload.POST(pcReq(key, { body, ip })));
}

/** Upload and return the package (201 or 200). */
async function uploadOk(key: string, file: unknown, generatedAt: string, extra: Record<string, unknown> = {}) {
  const res = await send(key, payload(file, generatedAt, extra));
  expect([200, 201]).toContain(res.status);
  return menuDeployUploadResponseSchema.parse(await res.json());
}

async function pcStatus(key: string, ip?: string): Promise<Response> {
  return call('GET /api/menu-deploy', upload.GET(pcReq(key, { method: 'GET', ip })));
}

const till = (deviceId: string) => ({ deviceId, deviceName: `Till ${deviceId.slice(-1)}`, appVersion: '0.7.32' });

async function claim(
  deviceId: string,
  id: string,
  opts: {
    scope?: 'shared' | 'own';
    last?: number | null;
    /** The marker's package id (the till sends it with its number). */
    lastId?: string | null;
    takeOver?: boolean;
    retry?: boolean;
    max?: number;
  } = {},
): Promise<Response> {
  return call(
    'POST /api/bridge/menu-deploy/[id]/claim',
    bridgeClaim.POST(
      bridgeReq(`/api/bridge/menu-deploy/${id}/claim`, {
        method: 'POST',
        body: {
          ...till(deviceId),
          scope: opts.scope ?? 'shared',
          maxFormatVersion: opts.max ?? MAX_MENU_FILE_VERSION,
          lastPackageSeq: opts.last ?? null,
          lastPackageId: opts.lastId,
          takeOver: opts.takeOver,
          retry: opts.retry,
        },
      }),
      { params: { id } },
    ),
  );
}

const COUNTS: MenuDeployCounts = {
  newItems: 3,
  updatedItems: 5,
  priceChanges: 0,
  newIngredients: 1,
  updatedIngredients: 2,
  newCategories: 0,
  recipesSet: 4,
  choiceGroupsChanged: 0,
  batchRecipesSet: 0,
  skipped: 0,
};

async function report(
  deviceId: string,
  id: string,
  outcome: 'applied' | 'received' | 'waiting_for_owner' | 'too_old' | 'failed' | 'refused',
  opts: { scope?: 'shared' | 'own'; error?: string; counts?: MenuDeployCounts } = {},
): Promise<Response> {
  return call(
    'POST /api/bridge/menu-deploy/[id]/report',
    bridgeReport.POST(
      bridgeReq(`/api/bridge/menu-deploy/${id}/report`, {
        method: 'POST',
        body: {
          ...till(deviceId),
          scope: opts.scope ?? 'shared',
          outcome,
          counts: outcome === 'applied' ? (opts.counts ?? COUNTS) : undefined,
          error: opts.error,
          retryable: outcome === 'failed' ? true : undefined,
        },
      }),
      { params: { id } },
    ),
  );
}

async function content(id: string): Promise<Response> {
  return call(
    'GET /api/bridge/menu-deploy/[id]/content',
    bridgeContent.GET(bridgeReq(`/api/bridge/menu-deploy/${id}/content`), { params: { id } }),
  );
}

async function tillStatus(history = false): Promise<Response> {
  return call(
    'GET /api/bridge/menu-deploy',
    bridgeStatus.GET(bridgeReq(`/api/bridge/menu-deploy${history ? '?history=1' : ''}`)),
  );
}

async function pkgRow(id: string) {
  const r = await db.pg.query(`SELECT * FROM menu_packages WHERE id = $1::uuid`, [id]);
  return r.rows[0] as Record<string, unknown>;
}
async function events(kind?: string) {
  const r = await db.pg.query(
    kind
      ? `SELECT * FROM menu_package_events WHERE kind = $1 ORDER BY id`
      : `SELECT * FROM menu_package_events ORDER BY id`,
    kind ? [kind] : [],
  );
  return r.rows as Array<Record<string, unknown>>;
}
async function count(table: string): Promise<number> {
  return ((await db.pg.query(`SELECT count(*)::int AS n FROM ${table}`, [])).rows[0] as { n: number }).n;
}
async function expireLease(id: string) {
  await db.pg.query(`UPDATE menu_packages SET lease_until = now() - interval '1 second' WHERE id = $1::uuid`, [id]);
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
});

beforeEach(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  await (db.pg as unknown as PGlite).exec(
    'TRUNCATE menu_package_events, menu_packages, menu_deploy_key RESTART IDENTITY CASCADE',
  );
});

afterEach(() => {
  // Every answer of every new route — refusals included — is never cached.
  for (const { route, res } of answers.splice(0)) {
    expect(res.headers.get('cache-control'), route).toBe('no-store');
  }
});

describe('the shared wire', () => {
  it('reads up to the newest menu file format, and no further', () => {
    const base = menuFile('v', { secret: 'made-up note' });
    expect(menuImportFileSchema.safeParse(base).success).toBe(true); // the made-up files are real import files
    expect(menuImportFileSchema.safeParse({ ...base, version: MAX_MENU_FILE_VERSION }).success).toBe(true);
    expect(menuImportFileSchema.safeParse({ ...base, version: MAX_MENU_FILE_VERSION + 1 }).success).toBe(false);
    // The format name the website looks for is the one the till's schema reads.
    expect(menuImportFileSchema.safeParse({ ...base, format: MENU_IMPORT_FILE_FORMAT }).success).toBe(true);
    expect(menuImportFileSchema.safeParse({ ...base, format: `${MENU_IMPORT_FILE_FORMAT}-x` }).success).toBe(false);
  });

  it('keeps the lease the SQL writes as a literal (600 seconds) and the limits the contract names', () => {
    expect(MENU_DEPLOY_LEASE_SECONDS).toBe(600);
    expect(MENU_DEPLOY_MAX_ATTEMPTS).toBe(5);
    expect(MENU_DEPLOY_KEEP_CONTENT).toBe(5);
    expect(MENU_DEPLOY_UPLOADS_PER_DAY).toBe(30);
    expect(newKey()).toMatch(/^cocmenu_[A-Za-z0-9_-]{43}$/);
  });
});

describe('the upload key', () => {
  it('says no_key while no till has made one', async () => {
    const res = await send(newKey(), payload(menuFile('a'), at(0)));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'no_key' });
  });

  it('refuses a wrong key and writes it down against the address (never the address itself)', async () => {
    const key = newKey();
    expect((await registerKey(key)).status).toBe(200);
    const res = await send(newKey(), payload(menuFile('a'), at(0)));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
    const bad = await events('bad_key');
    expect(bad).toHaveLength(1);
    expect(bad[0]!['ip_hash']).toMatch(/^[0-9a-f]{32}$/);
    expect(bad[0]!['ip_hash']).not.toContain(PC_IP);
    expect(await count('menu_packages')).toBe(0);
  });

  it('refuses even the right key after ten wrong ones from one address in 15 minutes', async () => {
    const key = newKey();
    await registerKey(key);
    for (let i = 0; i < 10; i++) {
      expect((await send(newKey(), payload(menuFile('a'), at(0)))).status).toBe(401);
    }
    const res = await send(key, payload(menuFile('a'), at(0)));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('900');
    expect(await res.json()).toEqual({ ok: false, error: 'rate_limited' });
    expect((await pcStatus(key)).status).toBe(429);
    // Another address is not held up.
    expect((await send(key, payload(menuFile('a'), at(0)), '192.0.2.44')).status).toBe(201);
    // Fifteen minutes on, the address may try again.
    await db.pg.query(`UPDATE menu_package_events SET at = now() - interval '16 minutes' WHERE kind = 'bad_key'`, []);
    expect((await send(key, payload(menuFile('b'), at(1)))).status).toBe(201);
  });

  it('never takes BRIDGE_SECRET as an upload key, nor an upload key on a till route', async () => {
    const key = newKey();
    await registerKey(key);
    const res = await send(SECRET, payload(menuFile('a'), at(0)));
    expect(res.status).toBe(401);
    expect(await events('bad_key')).toHaveLength(0); // refused before any look-up

    for (const r of [
      await call('GET /api/bridge/menu-deploy', bridgeStatus.GET(bridgeReq('/api/bridge/menu-deploy', { auth: key }))),
      await call(
        'PUT /api/bridge/menu-deploy/key',
        bridgeKey.PUT(
          bridgeReq('/api/bridge/menu-deploy/key', {
            method: 'PUT',
            auth: key,
            body: { keyHash: sha256(newKey()), keyHint: 'abcd', ...till('till-1') },
          }),
        ),
      ),
    ]) {
      expect(r.status).toBe(401);
    }

    // Even a BRIDGE_SECRET shaped like a key is never one: the till can't register it, and it never passes.
    const keyShaped = newKey();
    process.env['BRIDGE_SECRET'] = keyShaped;
    const reg = await call(
      'PUT /api/bridge/menu-deploy/key',
      bridgeKey.PUT(
        bridgeReq('/api/bridge/menu-deploy/key', {
          method: 'PUT',
          body: { keyHash: sha256(keyShaped), keyHint: keyShaped.slice(-4), ...till('till-1') },
        }),
      ),
    );
    expect(reg.status).toBe(400);
    expect((await send(keyShaped, payload(menuFile('a'), at(0)))).status).toBe(401);
  });

  it('stops the old key the moment a new one is made', async () => {
    const first = newKey();
    await registerKey(first);
    expect((await pcStatus(first)).status).toBe(200);
    const second = newKey();
    const res = await registerKey(second, 'till-2');
    const body = menuDeployKeyResponseSchema.parse(await res.json());
    expect(Date.parse(body.createdAt)).not.toBeNaN();
    expect((await pcStatus(first)).status).toBe(401);
    const st = menuDeployStatusResponseSchema.parse(await (await pcStatus(second)).json());
    expect(st.key).toMatchObject({ keyHint: second.slice(-4), deviceId: 'till-2' });
    expect(await count('menu_deploy_key')).toBe(1);
    const made = await events('key_created');
    expect(made).toHaveLength(2);
    // Only the hash and the hint were ever stored.
    const all = JSON.stringify((await db.pg.query('SELECT * FROM menu_deploy_key', [])).rows) + JSON.stringify(made);
    expect(all).not.toContain(second);
    expect(all).not.toContain(first);
  });

  it('refuses a key body that is not a hash and a hint', async () => {
    for (const body of [
      { keyHash: 'nothex', keyHint: 'abcd', ...till('till-1') },
      { keyHash: sha256('x'), keyHint: 'ab', ...till('till-1') },
      { keyHash: sha256('x'), keyHint: 'abcd', ...till('till-1'), key: newKey() },
    ]) {
      const r = await call(
        'PUT /api/bridge/menu-deploy/key',
        bridgeKey.PUT(bridgeReq('/api/bridge/menu-deploy/key', { method: 'PUT', body })),
      );
      expect(r.status).toBe(400);
    }
    expect(await count('menu_deploy_key')).toBe(0);
  });
});

describe('uploading a menu file', () => {
  let key: string;
  beforeEach(async () => {
    key = newKey();
    await registerKey(key);
  });

  it('stores a good file and says what it holds', async () => {
    const file = menuFile('a', { items: 4 });
    const res = await send(key, payload(file, at(0)));
    expect(res.status).toBe(201);
    const body = menuDeployUploadResponseSchema.parse(await res.json());
    expect(body.duplicate).toBe(false);
    const raw = Buffer.from(JSON.stringify(file));
    expect(body.package).toMatchObject({
      seq: 1,
      fileName: 'cheeseoclock-menu-import.json',
      sha256: sha256(raw),
      sizeBytes: raw.length,
      formatVersion: 3,
      source: 'made-up costing file a',
      generatedAt: at(0),
      uploader: 'COSTING-PC',
      itemCount: 4,
      ingredientCount: 2,
      state: 'pending',
      claimedBy: null,
      leaseExpired: false,
      attempts: 0,
      retryReady: true,
      hasContent: true,
      result: null,
    });
    expect(Object.keys(body.package)).not.toContain('contentGzB64');
    const up = await events('uploaded');
    expect(up).toHaveLength(1);
    expect(up[0]!['detail']).toMatchObject({ itemCount: 4, ingredientCount: 2, formatVersion: 3 });
  });

  it('refuses a file that is not what the PC says it is', async () => {
    const file = menuFile('a');
    const good = payload(file, at(0));
    const cases: Array<[unknown, number, string]> = [
      [{ ...good, sha256: sha256('something else') }, 400, 'checksum_mismatch'],
      [{ ...good, sizeBytes: good.sizeBytes + 1 }, 400, 'size_mismatch'],
      [{ ...good, contentGzB64: Buffer.from('not gzip at all').toString('base64') }, 400, 'bad_gzip'],
      [{ ...good, fileName: '..\\secret.json' }, 400, 'validation'],
      [{ ...good, extra: 1 }, 400, 'validation'],
      [payload({ format: 'something-else', version: 3, categories: [], items: [], ingredients: [] }, at(0)), 400, 'not_a_menu_file'],
      [payload({ format: 'cheeseoclock-menu-import', version: 2.5, categories: [], items: [], ingredients: [] }, at(0)), 400, 'not_a_menu_file'],
      [payload({ format: 'cheeseoclock-menu-import', version: 3, categories: [], items: {} , ingredients: [] }, at(0)), 400, 'not_a_menu_file'],
    ];
    const notJson = Buffer.from('{ this is not json');
    cases.push([
      { ...good, sha256: sha256(notJson), sizeBytes: notJson.length, contentGzB64: gzipSync(notJson).toString('base64') },
      400,
      'not_json',
    ]);
    for (const [body, status, error] of cases) {
      const res = await send(key, body);
      expect(res.status, error).toBe(status);
      expect(await res.json(), error).toEqual({ ok: false, error });
    }
    expect(await count('menu_packages')).toBe(0);
  });

  it('reads a file saved with a byte-order mark', async () => {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(menuFile('bom')))]);
    const res = await send(key, {
      fileName: 'cheeseoclock-menu-import.json',
      generatedAt: at(0),
      sha256: sha256(raw),
      sizeBytes: raw.length,
      contentGzB64: gzipSync(raw).toString('base64'),
    });
    expect(res.status).toBe(201);
  });

  it('stops a gzip bomb and a body over the limit before storing anything', async () => {
    const bomb = gzipSync(Buffer.alloc(3_000_000, 0x20));
    const res = await send(key, {
      fileName: 'bomb.json',
      generatedAt: at(0),
      sha256: sha256('x'),
      sizeBytes: 1000,
      contentGzB64: bomb.toString('base64'),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: 'too_large' });

    // Declared too large: refused before the key is even looked at.
    const declared = await call(
      'POST /api/menu-deploy',
      upload.POST(pcReq(newKey(), { raw: '{}', headers: { 'content-length': '3600000' } })),
    );
    expect(declared.status).toBe(413);
    expect(await events('bad_key')).toHaveLength(0);

    // A body over the limit with no length declared.
    const big = await call('POST /api/menu-deploy', upload.POST(pcReq(key, { raw: `"${'a'.repeat(3_600_000)}"` })));
    expect(big.status).toBe(413);
    expect(await count('menu_packages')).toBe(0);
  });

  it('answers "already there" for the same file again, adding nothing', async () => {
    const first = await uploadOk(key, menuFile('a'), at(0));
    const again = await send(key, payload(menuFile('a'), at(5)));
    expect(again.status).toBe(200);
    const body = menuDeployUploadResponseSchema.parse(await again.json());
    expect(body).toMatchObject({ duplicate: true, package: { id: first.package.id, seq: 1 } });
    expect(await count('menu_packages')).toBe(1);
    expect(await events('uploaded')).toHaveLength(1);
  });

  it('answers "already there" for a file a till refused or gave up on, adding nothing', async () => {
    const p = (await uploadOk(key, menuFile('bad'), at(0))).package;
    await claim('till-A', p.id);
    await report('till-A', p.id, 'refused', { error: 'Test: a choice group asks for more picks than it has' });
    const again = await send(key, payload(menuFile('bad'), at(5)));
    expect(again.status).toBe(200);
    expect(menuDeployUploadResponseSchema.parse(await again.json())).toMatchObject({
      duplicate: true,
      package: { id: p.id, state: 'refused', error: 'Test: a choice group asks for more picks than it has' },
    });

    const q = (await uploadOk(key, menuFile('flaky'), at(10))).package;
    for (let i = 0; i < MENU_DEPLOY_MAX_ATTEMPTS; i++) {
      expect((await claim('till-A', q.id)).status).toBe(200);
      await report('till-A', q.id, 'failed', { error: 'Test: the disk is full' });
      await db.pg.query(`UPDATE menu_packages SET next_try_at = now() - interval '1 second' WHERE id = $1::uuid`, [q.id]);
    }
    expect((await pkgRow(q.id))['state']).toBe('failed');
    const twice = await send(key, payload(menuFile('flaky'), at(11)));
    expect(twice.status).toBe(200);
    expect(menuDeployUploadResponseSchema.parse(await twice.json())).toMatchObject({ duplicate: true, package: { id: q.id, state: 'failed' } });
    expect(await count('menu_packages')).toBe(2);
  });

  it('refuses control characters in the names --status prints, and takes them out of the file’s source', async () => {
    const esc = '\u001b[3A\u001b[2K';
    for (const extra of [{ fileName: `x${esc}menu.json` }, { uploader: `PC${esc}` }, { fileName: 'a\u009bmenu.json' }]) {
      const res = await send(key, payload(menuFile('c'), at(0), extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'validation' });
    }
    expect(await count('menu_packages')).toBe(0);
    const sourced = { ...menuFile('c'), source: `made-up${esc}source` };
    const ok = await uploadOk(key, sourced, at(0));
    expect(ok.package.source).toBe('made-up [3A [2Ksource');
  });

  it('refuses a file made before the one it holds, unless forced', async () => {
    await uploadOk(key, menuFile('new'), at(10));
    const res = await send(key, payload(menuFile('old'), at(5)));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'older_than_current',
      current: { fileName: 'cheeseoclock-menu-import.json', generatedAt: at(10), uploadedAt: expect.any(String) },
    });
    const forced = await send(key, payload(menuFile('old'), at(5), { force: true }));
    expect(forced.status).toBe(201);
    expect(menuDeployUploadResponseSchema.parse(await forced.json()).package.seq).toBe(2);
  });

  it('supersedes an older file nobody is importing when a newer one arrives', async () => {
    const p1 = await uploadOk(key, menuFile('1'), at(0));
    const p2 = await uploadOk(key, menuFile('2'), at(1));
    expect((await pkgRow(p1.package.id))['state']).toBe('superseded');
    expect((await pkgRow(p2.package.id))['state']).toBe('pending');
  });

  it('takes 30 uploads a day and refuses the 31st', async () => {
    for (let i = 0; i < MENU_DEPLOY_UPLOADS_PER_DAY; i++) {
      expect((await send(key, payload(menuFile(`n${i}`), at(i)))).status).toBe(201);
    }
    const res = await send(key, payload(menuFile('one too many'), at(99)));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: 'too_many_uploads' });
    expect(await count('menu_packages')).toBe(MENU_DEPLOY_UPLOADS_PER_DAY);
  });

  it('keeps the file of the newest 5 only; an older one answers 410', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await uploadOk(key, menuFile(`r${i}`), at(i))).package.id);
    const kept = (await db.pg.query(
      `SELECT seq FROM menu_packages WHERE content_gz_b64 IS NOT NULL ORDER BY seq`,
      [],
    )).rows as Array<{ seq: number }>;
    expect(kept.map((r) => r.seq)).toEqual([3, 4, 5, 6, 7]);
    const gone = await content(ids[0]!);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toEqual({ ok: false, error: 'gone' });
    const here = await content(ids[6]!);
    expect(here.status).toBe(200);
    const body = menuDeployContentResponseSchema.parse(await here.json());
    expect(sha256(gunzipSync(Buffer.from(body.contentGzB64, 'base64')))).toBe(body.sha256);
  });

  it('never drops the file of a package a till still holds', async () => {
    const p1 = await uploadOk(key, menuFile('held'), at(0));
    expect((await claim('till-A', p1.package.id)).status).toBe(200);
    for (let i = 1; i <= 6; i++) await uploadOk(key, menuFile(`later${i}`), at(i));
    expect((await pkgRow(p1.package.id))['content_gz_b64']).not.toBeNull();
  });
});

describe('claiming a file (two linked tills)', () => {
  let key: string;
  beforeEach(async () => {
    key = newKey();
    await registerKey(key);
  });

  it('gives it to one till with a lease; the other is told it is claimed; the first may claim again', async () => {
    const file = menuFile('a');
    const p = (await uploadOk(key, file, at(0))).package;
    const a = await claim('till-A', p.id);
    expect(a.status).toBe(200);
    const got = menuDeployClaimResponseSchema.parse(await a.json());
    expect(got.leaseSeconds).toBe(600);
    expect(got.package).toMatchObject({ id: p.id, state: 'claimed', claimedBy: 'till-A', leaseExpired: false });
    const raw = gunzipSync(Buffer.from(got.contentGzB64, 'base64'));
    expect(raw.toString('utf8')).toBe(JSON.stringify(file));
    expect(Date.parse(got.package.leaseUntil!) - Date.parse(got.package.claimedAt!)).toBe(600_000);

    const b = await claim('till-B', p.id);
    expect(b.status).toBe(409);
    const refusal = menuDeployClaimRefusalSchema.parse(await b.json());
    expect(refusal.error).toBe('claimed');
    expect(refusal.package?.claimedBy).toBe('till-A');
    expect(JSON.stringify(refusal)).not.toContain('contentGzB64');

    expect((await claim('till-A', p.id)).status).toBe(200);
    expect(await events('claimed')).toHaveLength(2);
  });

  it('reports a claim that ran out as stalled; only a take-over claims it', async () => {
    const p = (await uploadOk(key, menuFile('a'), at(0))).package;
    await claim('till-A', p.id);
    await expireLease(p.id);
    const st = menuDeployStatusResponseSchema.parse(await (await tillStatus()).json());
    expect(st.latest).toMatchObject({ state: 'claimed', leaseExpired: true });

    const b = await claim('till-B', p.id);
    expect(b.status).toBe(409);
    expect((await b.json()).error).toBe('stalled');

    const over = await claim('till-B', p.id, { takeOver: true });
    expect(over.status).toBe(200);
    expect(menuDeployClaimResponseSchema.parse(await over.json()).package.claimedBy).toBe('till-B');
    const taken = await events('taken_over');
    expect(taken).toHaveLength(1);
    expect(taken[0]!['detail']).toMatchObject({ from: 'till-A', scope: 'shared' });
  });

  it('a take-over never takes a claim whose lease is still live — the file, or an older one another till holds (the till asks from a "stalled" view that may be old)', async () => {
    const p = (await uploadOk(key, menuFile('a'), at(0))).package;
    expect((await claim('till-A', p.id)).status).toBe(200);
    // Till A's lease has not run out: till B's owner taps "Take it over" from a view that said stalled.
    const over = await claim('till-B', p.id, { takeOver: true, retry: true });
    expect(over.status).toBe(409);
    expect(menuDeployClaimRefusalSchema.parse(await over.json())).toMatchObject({ error: 'claimed', package: { claimedBy: 'till-A', leaseExpired: false } });
    expect(await pkgRow(p.id)).toMatchObject({ state: 'claimed', claimed_by: 'till-A' });
    expect(await events('taken_over')).toHaveLength(0);
    // Till A still holds it, and reports it in.
    expect((await report('till-A', p.id, 'applied')).status).toBe(200);
    expect(await pkgRow(p.id)).toMatchObject({ state: 'applied', applied_by: 'till-A' });

    // An older file another till holds, its lease live: a take-over of the newer one is still refused ("busy").
    const p2 = (await uploadOk(key, menuFile('b'), at(1))).package;
    expect((await claim('till-A', p2.id, { last: p.seq, lastId: p.id })).status).toBe(200);
    const p3 = (await uploadOk(key, menuFile('c'), at(2))).package;
    const busy = await claim('till-B', p3.id, { last: p.seq, lastId: p.id, takeOver: true });
    expect(busy.status).toBe(409);
    expect(menuDeployClaimRefusalSchema.parse(await busy.json())).toMatchObject({ error: 'busy', blockedBy: { id: p2.id, leaseExpired: false } });
    expect(await pkgRow(p2.id)).toMatchObject({ state: 'claimed', claimed_by: 'till-A' });
    expect(await events('taken_over')).toHaveLength(0);
  });

  it('the first till may still claim its own run-out claim again', async () => {
    const p = (await uploadOk(key, menuFile('a'), at(0))).package;
    await claim('till-A', p.id);
    await expireLease(p.id);
    expect((await claim('till-A', p.id)).status).toBe(200);
  });

  it('holds back a till that has not yet received the last file another till put in', async () => {
    const p1 = (await uploadOk(key, menuFile('1'), at(0))).package;
    await claim('till-A', p1.id);
    expect((await report('till-A', p1.id, 'applied')).status).toBe(200);
    const p2 = (await uploadOk(key, menuFile('2'), at(1))).package;

    const behind = await claim('till-B', p2.id, { last: null });
    expect(behind.status).toBe(409);
    expect((await behind.json()).error).toBe('behind');
    expect((await pkgRow(p2.id))['state']).toBe('pending');

    expect((await claim('till-B', p2.id, { last: p1.seq })).status).toBe(200);
  });

  it('refuses a file newer than the till reads, writes it down, and leaves it pending', async () => {
    const p = (await uploadOk(key, menuFile('v4', { version: MAX_MENU_FILE_VERSION + 1 }), at(0))).package;
    expect(p.formatVersion).toBe(MAX_MENU_FILE_VERSION + 1);
    const res = await claim('till-A', p.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('too_old');
    const old = await events('too_old');
    expect(old).toHaveLength(1);
    expect(old[0]!['detail']).toMatchObject({ formatVersion: 4, maxFormatVersion: 3 });
    expect((await pkgRow(p.id))['state']).toBe('pending');
    // A till that reads it may claim it.
    expect((await claim('till-B', p.id, { max: 4 })).status).toBe(200);
  });

  it('is busy while another till imports an older file, stalled once that claim runs out', async () => {
    const p1 = (await uploadOk(key, menuFile('1'), at(0))).package;
    await claim('till-A', p1.id);
    const p2 = (await uploadOk(key, menuFile('2'), at(1))).package;
    expect((await pkgRow(p1.id))['state']).toBe('claimed'); // an upload never supersedes a file in hand

    const busy = await claim('till-B', p2.id);
    expect(busy.status).toBe(409);
    const b1 = menuDeployClaimRefusalSchema.parse(await busy.json());
    expect(b1.error).toBe('busy');
    expect(b1.blockedBy).toMatchObject({ id: p1.id, claimedBy: 'till-A', leaseExpired: false });

    // till-A never came back: the owner sees stalled and may take over (P1 is set aside).
    await expireLease(p1.id);
    const stalled = await claim('till-B', p2.id);
    expect(stalled.status).toBe(409);
    expect(menuDeployClaimRefusalSchema.parse(await stalled.json())).toMatchObject({
      error: 'stalled',
      blockedBy: { id: p1.id, leaseExpired: true },
    });
    const over = await claim('till-B', p2.id, { takeOver: true });
    expect(over.status).toBe(200);
    expect((await pkgRow(p1.id))['state']).toBe('superseded');
    const taken = await events('taken_over');
    expect(taken[0]!['detail']).toMatchObject({ from: 'till-A', settled: 1 });
  });

  it('a till back from a crash moves on from its own older claim (put in, as its marker says)', async () => {
    const p1 = (await uploadOk(key, menuFile('1'), at(0))).package;
    await claim('till-A', p1.id); // imported, then the till died before its report
    await expireLease(p1.id);
    const p2 = (await uploadOk(key, menuFile('2'), at(1))).package;
    // Its marker says it has P1: P1 is recorded as put in, and P2 is its.
    const res = await claim('till-A', p2.id, { last: p1.seq });
    expect(res.status).toBe(200);
    const row = await pkgRow(p1.id);
    expect(row).toMatchObject({ state: 'applied', applied_by: 'till-A', claimed_by: null });
    const recovered = (await events('applied')).filter((e) => (e['detail'] as { recovered?: boolean }).recovered);
    expect(recovered).toHaveLength(1);
  });

  it('an older claim the till’s marker covers blocks nothing, and is recorded as put in by the till that held it', async () => {
    // Till A put P1 in but its report was lost (P1 still claimed); the link brought P1's rows and marker to till B.
    const p1 = (await uploadOk(key, menuFile('1'), at(0))).package;
    await claim('till-A', p1.id);
    const p2 = (await uploadOk(key, menuFile('2'), at(1))).package;
    // While A's lease is live, and after it ran out: B (its marker is P1) is neither "busy" nor "stalled".
    const res = await claim('till-B', p2.id, { last: p1.seq, lastId: p1.id });
    expect(res.status).toBe(200);
    expect(await pkgRow(p1.id)).toMatchObject({ state: 'applied', applied_by: 'till-A', claimed_by: null });
    const recovered = (await events('applied')).filter((e) => (e['detail'] as { recovered?: boolean }).recovered);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ device_id: 'till-A' });
    expect(recovered[0]!['detail']).toMatchObject({ noticedBy: 'till-B' });
    // A claim, not a take-over.
    expect(await events('taken_over')).toHaveLength(0);

    // The same once the lease ran out.
    const p3 = (await uploadOk(key, menuFile('3'), at(2))).package;
    await expireLease(p2.id);
    const late = await claim('till-A', p3.id, { last: p2.seq, lastId: p2.id });
    expect(late.status).toBe(200);
    expect(await pkgRow(p2.id)).toMatchObject({ state: 'applied', applied_by: 'till-B' });
    expect(await events('taken_over')).toHaveLength(0);
  });

  it('a till whose menu lost a file it put in itself (a backup restored) is not held back by it, unless another till received it', async () => {
    const p1 = (await uploadOk(key, menuFile('1'), at(0))).package;
    await claim('till-A', p1.id);
    await report('till-A', p1.id, 'applied');
    const p2 = (await uploadOk(key, menuFile('2'), at(1))).package;
    // Till A's marker went back with the restore; no other till has P1: nothing will ever come through the link.
    expect((await claim('till-A', p2.id, { last: null })).status).toBe(200);

    // With another till holding P1's rows, that till goes first.
    await report('till-A', p2.id, 'applied');
    await report('till-B', p2.id, 'received');
    const p3 = (await uploadOk(key, menuFile('3'), at(2))).package;
    const behind = await claim('till-A', p3.id, { last: p1.seq, lastId: p1.id });
    expect(behind.status).toBe(409);
    expect((await behind.json()).error).toBe('behind');
    expect((await claim('till-B', p3.id, { last: p2.seq, lastId: p2.id })).status).toBe(200);
  });

  it('goes by the marker’s package id: one the website does not know (its database was reset) counts as none', async () => {
    const p1 = (await uploadOk(key, menuFile('1'), at(0))).package;
    await claim('till-A', p1.id);
    await report('till-A', p1.id, 'applied');
    const p2 = (await uploadOk(key, menuFile('2'), at(1))).package;
    // Till B's marker is file #12 of the website's old numbers: it has NOT got P1.
    const unknown = '0190a0a0-0000-7000-8000-00000000000c';
    const res = await claim('till-B', p2.id, { last: 12, lastId: unknown });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('behind');
    expect((await claim('till-B', p2.id, { last: p1.seq, lastId: p1.id })).status).toBe(200);
  });

  it('two tills asking at once: exactly one gets it', async () => {
    const p = (await uploadOk(key, menuFile('a'), at(0))).package;
    const [a, b] = await Promise.all([claim('till-A', p.id), claim('till-B', p.id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('only the newest file is ever claimed; an unknown or malformed id is not found', async () => {
    const p1 = (await uploadOk(key, menuFile('1'), at(0))).package;
    await uploadOk(key, menuFile('2'), at(1));
    const res = await claim('till-A', p1.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('superseded');
    expect((await claim('till-A', '0190a0a0-0000-7000-8000-000000000000')).status).toBe(404);
    expect((await claim('till-A', 'not-a-uuid')).status).toBe(404);
    expect((await content('not-a-uuid')).status).toBe(404);
  });

  it('refuses a claim body that is not the contract', async () => {
    const p = (await uploadOk(key, menuFile('a'), at(0))).package;
    const res = await call(
      'POST /api/bridge/menu-deploy/[id]/claim',
      bridgeClaim.POST(
        bridgeReq(`/api/bridge/menu-deploy/${p.id}/claim`, {
          method: 'POST',
          body: { ...till('till-A'), scope: 'everyone', maxFormatVersion: 3, lastPackageSeq: null },
        }),
        { params: { id: p.id } },
      ),
    );
    expect(res.status).toBe(400);
    expect((await pkgRow(p.id))['state']).toBe('pending');
  });
});

describe('reporting what became of a file', () => {
  let key: string;
  let p: MenuPackageMeta;
  beforeEach(async () => {
    key = newKey();
    await registerKey(key);
    p = (await uploadOk(key, menuFile('a'), at(0))).package;
  });

  it('records the claimer putting it in, with the counts', async () => {
    await claim('till-A', p.id);
    const res = await report('till-A', p.id, 'applied');
    expect(menuDeployReportResponseSchema.parse(await res.json())).toEqual({
      ok: true,
      state: 'applied',
      duplicate: false,
      accepted: true,
    });
    const st = menuDeployStatusResponseSchema.parse(await (await tillStatus()).json());
    expect(st.latest).toMatchObject({ state: 'applied', appliedBy: 'till-A', claimedBy: null, result: COUNTS });
    expect(st.lastApplied).toMatchObject({ id: p.id, seq: 1, appliedBy: 'till-A' });
    expect(st.tills).toEqual([expect.objectContaining({ deviceId: 'till-A', kind: 'applied' })]);

    // The other till then says it received it through the link.
    await report('till-B', p.id, 'received');
    const after = menuDeployStatusResponseSchema.parse(await (await tillStatus()).json());
    expect(after.tills.map((t) => [t.deviceId, t.kind]).sort()).toEqual([
      ['till-A', 'applied'],
      ['till-B', 'received'],
    ]);
    expect(after.latest?.state).toBe('applied');

    // A resend from till-A (its answer was lost) changes nothing and adds no line.
    const again = await report('till-A', p.id, 'applied');
    expect(await again.json()).toEqual({ ok: true, state: 'applied', duplicate: false, accepted: false });
    expect(await events('applied')).toHaveLength(1);
  });

  it('accepts a late report after the lease ran out', async () => {
    await claim('till-A', p.id);
    await expireLease(p.id);
    const res = await report('till-A', p.id, 'applied');
    expect(await res.json()).toMatchObject({ state: 'applied', accepted: true });
  });

  it('marks a second till putting in the same file as a duplicate', async () => {
    await claim('till-A', p.id);
    await report('till-A', p.id, 'applied');
    const res = await report('till-B', p.id, 'applied');
    expect(await res.json()).toEqual({ ok: true, state: 'applied', duplicate: true, accepted: false });
    const lines = await events('applied');
    expect(lines[1]!['detail']).toMatchObject({ duplicate: true });
    expect((await pkgRow(p.id))['applied_by']).toBe('till-A');
  });

  it('does not let a till report over another till’s live claim', async () => {
    await claim('till-A', p.id);
    const res = await report('till-B', p.id, 'applied');
    expect(await res.json()).toMatchObject({ state: 'claimed', accepted: false });
    expect((await report('till-B', p.id, 'failed')).status).toBe(200);
    expect(await pkgRow(p.id)).toMatchObject({ state: 'claimed', claimed_by: 'till-A', attempts: 0 });
  });

  it('backs off after each failure, stops at the 5th, and tries again only when asked', async () => {
    const backoffMinutes: number[] = [];
    for (let i = 1; i <= MENU_DEPLOY_MAX_ATTEMPTS; i++) {
      expect((await claim('till-A', p.id)).status).toBe(200);
      const res = await report('till-A', p.id, 'failed', { error: `made-up failure ${i}` });
      const body = menuDeployReportResponseSchema.parse(await res.json());
      const row = await pkgRow(p.id);
      backoffMinutes.push(
        Math.round((new Date(row['next_try_at'] as Date).getTime() - Date.now()) / 60_000),
      );
      if (i < MENU_DEPLOY_MAX_ATTEMPTS) {
        expect(body.state).toBe('pending');
        // Before its next try: not yet.
        const early = await claim('till-A', p.id);
        expect(early.status).toBe(409);
        expect((await early.json()).error).toBe('retry_later');
        await db.pg.query(`UPDATE menu_packages SET next_try_at = now() - interval '1 second' WHERE id = $1::uuid`, [p.id]);
      } else {
        expect(body.state).toBe('failed');
      }
      expect(row).toMatchObject({ attempts: i, error: `made-up failure ${i}`, claimed_by: null });
    }
    expect(backoffMinutes).toEqual([1, 2, 4, 8, 8]);

    const stopped = await claim('till-A', p.id);
    expect(stopped.status).toBe(409);
    expect((await stopped.json()).error).toBe('failed');
    const st = menuDeployStatusResponseSchema.parse(await (await tillStatus()).json());
    expect(st.latest).toMatchObject({ state: 'failed', error: 'made-up failure 5' });

    const again = await claim('till-A', p.id, { retry: true });
    expect(again.status).toBe(200);
    expect(await pkgRow(p.id)).toMatchObject({ state: 'claimed', attempts: 0 });
  });

  it('a failure after a newer file arrived sets the old one aside', async () => {
    await claim('till-A', p.id);
    await uploadOk(key, menuFile('b'), at(1));
    const res = await report('till-A', p.id, 'failed', { error: 'made-up' });
    expect((await res.json()).state).toBe('superseded');
  });

  it('never retries a refused file', async () => {
    await claim('till-A', p.id);
    const res = await report('till-A', p.id, 'refused', { error: 'Item 1: made-up problem' });
    expect(await res.json()).toMatchObject({ state: 'refused', accepted: true });
    const again = await claim('till-A', p.id, { retry: true });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('refused');
    expect((await claim('till-A', p.id, { scope: 'own' })).status).toBe(409);
  });

  it('a till with its link off imports for itself and never changes the shared state', async () => {
    const own = await claim('till-C', p.id, { scope: 'own' });
    expect(own.status).toBe(200);
    expect(menuDeployClaimResponseSchema.parse(await own.json()).package.state).toBe('pending');
    for (const outcome of ['failed', 'refused', 'applied'] as const) {
      const r = await report('till-C', p.id, outcome, { scope: 'own', error: outcome === 'applied' ? undefined : 'x' });
      expect(await r.json()).toMatchObject({ state: 'pending', accepted: false });
    }
    expect(await pkgRow(p.id)).toMatchObject({ state: 'pending', attempts: 0, claimed_by: null, applied_by: null });
    // A linked till still gets it.
    expect((await claim('till-A', p.id)).status).toBe(200);
    expect((await claim('till-C', p.id, { scope: 'own' })).status).toBe(200);
  });

  it('names the tills that said they put the latest file in, in either scope', async () => {
    const st0 = menuDeployStatusResponseSchema.parse(await (await tillStatus()).json());
    expect(st0.appliedByTills).toEqual([]);
    await claim('till-A', p.id, { scope: 'own' });
    await report('till-A', p.id, 'applied', { scope: 'own' });
    await report('till-B', p.id, 'waiting_for_owner');
    const st = menuDeployStatusResponseSchema.parse(await (await tillStatus()).json());
    // The package itself is untouched by a till with its link off …
    expect(st.latest?.state).toBe('pending');
    // … but the website remembers that till put it in (its menu may lose it to a restore).
    expect(st.appliedByTills).toEqual(['till-A']);
    const pc = menuDeployStatusResponseSchema.parse(await (await pcStatus(key)).json());
    expect(pc.appliedByTills).toEqual(['till-A']);
    // A newer file starts afresh.
    await uploadOk(key, menuFile('b'), at(5));
    expect(menuDeployStatusResponseSchema.parse(await (await tillStatus()).json()).appliedByTills).toEqual([]);
  });

  it('writes down a till waiting for the owner, and a till too old for the file', async () => {
    await report('till-A', p.id, 'waiting_for_owner');
    await report('till-B', p.id, 'too_old');
    expect((await pkgRow(p.id))['state']).toBe('pending');
    const st = menuDeployStatusResponseSchema.parse(await (await tillStatus()).json());
    expect(st.tills.map((t) => t.kind).sort()).toEqual(['too_old', 'waiting_for_owner']);
    expect((await report('till-A', '0190a0a0-0000-7000-8000-000000000000', 'received')).status).toBe(404);
  });
});

describe('what the website shows, and to whom', () => {
  it('shows the history to the key holder, and to a till only when it asks', async () => {
    const key = newKey();
    await registerKey(key);
    const p = (await uploadOk(key, menuFile('a'), at(0))).package;
    await claim('till-A', p.id);
    await report('till-A', p.id, 'applied');
    await send(newKey(), payload(menuFile('x'), at(1))); // a wrong key

    const pc = menuDeployStatusResponseSchema.parse(await (await pcStatus(key)).json());
    expect(pc.events?.map((e) => e.kind)).toEqual(['bad_key', 'applied', 'claimed', 'uploaded', 'key_created']);
    expect(pc.events?.[1]).toMatchObject({ packageId: p.id, fileName: 'cheeseoclock-menu-import.json', deviceId: 'till-A' });
    // The wrong-key line shows without the address's hash.
    const ipHash = String((await events('bad_key'))[0]!['ip_hash']);
    expect(JSON.stringify(pc)).not.toContain(ipHash);
    expect(JSON.stringify(pc)).not.toMatch(/ip_?hash/i);

    const plain = menuDeployStatusResponseSchema.parse(await (await tillStatus()).json());
    expect(plain.events).toBeUndefined();
    const withHistory = menuDeployStatusResponseSchema.parse(await (await tillStatus(true)).json());
    expect(withHistory.events).toHaveLength(5);
  });

  it('answers an empty website plainly', async () => {
    const st = menuDeployStatusResponseSchema.parse(await (await tillStatus()).json());
    expect(st).toEqual({ ok: true, key: null, latest: null, lastApplied: null, appliedByTills: [], tills: [] });
  });

  it('never lets the file out without a key: not the public menu, not a refusal, not a status', async () => {
    const MARKER = `MADE-UP-COST-MARKER-${randomBytes(6).toString('hex')}`;
    const key = newKey();
    await registerKey(key);
    const file = menuFile('private', { secret: MARKER });
    const up = await send(key, payload(file, at(0)));
    expect(up.status).toBe(201);
    const p = menuDeployUploadResponseSchema.parse(await up.clone().json()).package;
    const gz = payload(file, at(0)).contentGzB64;

    const texts: Array<[string, string]> = [];
    const keep = async (label: string, res: Response | Promise<Response>) => {
      const r = await res;
      texts.push([label, await r.text()]);
      return r;
    };
    await keep('upload answer', up);
    await keep('public menu', publicMenuRoute.GET());
    const noAuth = (path: string, method = 'GET', body?: unknown) =>
      new Request(`${SITE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.9' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const claimBody = { ...till('till-X'), scope: 'shared', maxFormatVersion: 3, lastPackageSeq: null };
    const refusals = [
      await keep('pc status, no key', call('GET /api/menu-deploy', upload.GET(noAuth('/api/menu-deploy')))),
      await keep('pc status, wrong key', pcStatus(newKey(), '192.0.2.10')),
      await keep('till status, no secret', call('GET /api/bridge/menu-deploy', bridgeStatus.GET(noAuth('/api/bridge/menu-deploy?history=1')))),
      await keep('till status, upload key', call('GET /api/bridge/menu-deploy', bridgeStatus.GET(bridgeReq('/api/bridge/menu-deploy?history=1', { auth: key })))),
      await keep('content, no secret', call('GET /api/bridge/menu-deploy/[id]/content', bridgeContent.GET(noAuth(`/api/bridge/menu-deploy/${p.id}/content`), { params: { id: p.id } }))),
      await keep('content, upload key', call('GET /api/bridge/menu-deploy/[id]/content', bridgeContent.GET(bridgeReq(`/api/bridge/menu-deploy/${p.id}/content`, { auth: key }), { params: { id: p.id } }))),
      await keep('claim, no secret', call('POST /api/bridge/menu-deploy/[id]/claim', bridgeClaim.POST(noAuth(`/api/bridge/menu-deploy/${p.id}/claim`, 'POST', claimBody), { params: { id: p.id } }))),
      await keep('claim, upload key', call('POST /api/bridge/menu-deploy/[id]/claim', bridgeClaim.POST(bridgeReq(`/api/bridge/menu-deploy/${p.id}/claim`, { method: 'POST', auth: key, body: claimBody }), { params: { id: p.id } }))),
      await keep('report, no secret', call('POST /api/bridge/menu-deploy/[id]/report', bridgeReport.POST(noAuth(`/api/bridge/menu-deploy/${p.id}/report`, 'POST', { ...claimBody, outcome: 'received' }), { params: { id: p.id } }))),
      await keep('key, no secret', call('PUT /api/bridge/menu-deploy/key', bridgeKey.PUT(noAuth('/api/bridge/menu-deploy/key', 'PUT', { keyHash: sha256('x'), keyHint: 'abcd', ...till('till-X') })))),
    ];
    for (const r of refusals) expect(r.status).toBe(401);
    await keep('pc status', pcStatus(key));
    await keep('till status', tillStatus());
    await keep('till status with history', tillStatus(true));

    for (const [label, text] of texts) {
      expect(text, label).not.toContain(MARKER);
      expect(text, label).not.toContain(gz.slice(0, 40));
      expect(text, label).not.toContain('contentGzB64');
    }
    // Nothing was claimed by any of that.
    expect((await pkgRow(p.id))['state']).toBe('pending');

    // The file does reach a till that claims it with the secret (so the checks above are not vacuous).
    const got = menuDeployClaimResponseSchema.parse(await (await claim('till-A', p.id)).json());
    expect(gunzipSync(Buffer.from(got.contentGzB64, 'base64')).toString('utf8')).toContain(MARKER);
  });
});

describe('the claim refusal order', () => {
  it('names every reason the contract lists, and no other', async () => {
    const base: MenuPackageMeta = {
      id: '0190a0a0-0000-7000-8000-000000000001',
      seq: 2,
      fileName: 'f.json',
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
      formatVersion: 3,
      source: null,
      generatedAt: at(0),
      uploadedAt: at(0),
      uploader: null,
      itemCount: 1,
      ingredientCount: 1,
      state: 'pending',
      claimedBy: null,
      claimedAt: null,
      leaseUntil: null,
      leaseExpired: false,
      attempts: 0,
      nextTryAt: null,
      retryReady: true,
      appliedBy: null,
      appliedAt: null,
      result: null,
      error: null,
      hasContent: true,
    };
    const ctx = {
      scope: 'shared' as 'shared' | 'own',
      deviceId: 'till-A',
      maxFormatVersion: 3,
      takeOver: false,
      retry: false,
      hasNewer: false,
      behind: false,
      blocker: null as { leaseExpired: boolean } | null,
    };
    const why = (m: Partial<MenuPackageMeta>, c: Partial<typeof ctx> = {}) =>
      store.claimRefusalReason({ ...base, ...m }, { ...ctx, ...c });
    const seen = new Set([
      why({ state: 'superseded' }),
      why({}, { hasNewer: true, behind: true }),
      why({ state: 'refused' }),
      why({ formatVersion: 4 }),
      why({ state: 'applied' }),
      why({ state: 'failed' }),
      why({ state: 'claimed', claimedBy: 'till-B', leaseExpired: true }),
      why({ state: 'claimed', claimedBy: 'till-B' }),
      why({}, { blocker: { leaseExpired: false } }),
      why({}, { behind: true }),
      why({ retryReady: false }),
      why({ hasContent: false }),
    ]);
    expect([...seen].sort()).toEqual([...MENU_CLAIM_REFUSALS].sort());
    expect(why({}, { hasNewer: true, behind: true })).toBe('superseded');
    expect(why({ state: 'claimed', claimedBy: 'till-B', leaseExpired: true }, { takeOver: true, behind: true })).toBe('behind');
    expect(why({}, { blocker: { leaseExpired: true } })).toBe('stalled');
    expect(why({ retryReady: false }, { retry: true, behind: false })).toBe('busy');
    expect(why({ state: 'applied' }, { scope: 'own' })).toBe('busy');
  });
});
