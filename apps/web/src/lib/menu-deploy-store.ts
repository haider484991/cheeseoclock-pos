import { randomUUID } from 'node:crypto';
import {
  MENU_DEPLOY_KEEP_CONTENT,
  MENU_DEPLOY_MAX_ATTEMPTS,
  MENU_PACKAGE_STATES,
  type MenuClaimRefusal,
  type MenuPackageState,
} from '@cheeseoclock/shared-types';
import {
  menuDeployCountsSchema,
  type MenuDeployClaimBody,
  type MenuDeployCounts,
  type MenuDeployEventRow,
  type MenuDeployKeyBody,
  type MenuDeployReportBody,
  type MenuDeployStatusResponse,
  type MenuPackageMeta,
} from '@cheeseoclock/shared-schemas/menu-deploy';
import { sql } from '@/lib/db';

/**
 * The website's side of the menu file auto-deploy (shared-types
 * menu-deploy.ts): the upload key's hash, the uploaded files ("packages")
 * and their history, in three tables of their own.
 *
 * The file holds the shop's costs and recipes. It lives ONLY in
 * menu_packages.content_gz_b64 (the gzip of the raw bytes, base64 — text, not
 * JSONB, so its SHA-256 stays true) and leaves only through the BRIDGE_SECRET
 * claim and content routes. Nothing here touches site_menu or the public menu.
 *
 * Neon over HTTP has no interactive transactions: every write that must be
 * atomic (a row and its history line; a claim and what it settles) is ONE
 * statement built from data-modifying CTEs. Intervals are SQL literals, never
 * parameters (lib/rate-limit.ts: a bare parameter in make_interval fails),
 * and every parameter carries an explicit cast.
 */

let schemaReady: Promise<void> | null = null;

/**
 * Created on demand by the new routes (and in db/schema.sql for fresh
 * installs), so no database has to be migrated by hand and no existing route
 * waits on it. Idempotent; run once per server instance; a failure is never
 * remembered (the next request tries again). Later columns may only ever be
 * added with ADD COLUMN IF NOT EXISTS, here and in schema.sql.
 */
export function ensureMenuDeploySchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const q = sql();
      await q`
        CREATE TABLE IF NOT EXISTS menu_deploy_key (
          id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          key_hash    TEXT NOT NULL,
          key_hint    TEXT NOT NULL,
          device_id   TEXT NOT NULL,
          device_name TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
      await q`
        CREATE TABLE IF NOT EXISTS menu_packages (
          id               UUID PRIMARY KEY,
          seq              SERIAL UNIQUE,
          file_name        TEXT NOT NULL,
          sha256           TEXT NOT NULL,
          size_bytes       INT NOT NULL,
          format_version   INT NOT NULL,
          source           TEXT,
          generated_at     TIMESTAMPTZ NOT NULL,
          uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          uploader         TEXT,
          item_count       INT NOT NULL,
          ingredient_count INT NOT NULL,
          content_gz_b64   TEXT,
          state            TEXT NOT NULL DEFAULT 'pending',
          claimed_by       TEXT,
          claimed_at       TIMESTAMPTZ,
          lease_until      TIMESTAMPTZ,
          attempts         INT NOT NULL DEFAULT 0,
          next_try_at      TIMESTAMPTZ,
          applied_by       TEXT,
          applied_at       TIMESTAMPTZ,
          result_json      JSONB,
          error            TEXT
        )`;
      await q`CREATE INDEX IF NOT EXISTS idx_menu_packages_state ON menu_packages(state, seq)`;
      await q`
        CREATE TABLE IF NOT EXISTS menu_package_events (
          id          BIGSERIAL PRIMARY KEY,
          package_id  UUID REFERENCES menu_packages(id),
          at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          kind        TEXT NOT NULL,
          device_id   TEXT,
          device_name TEXT,
          ip_hash     TEXT,
          detail      JSONB
        )`;
      await q`CREATE INDEX IF NOT EXISTS idx_menu_package_events_package ON menu_package_events(package_id, at)`;
      await q`CREATE INDEX IF NOT EXISTS idx_menu_package_events_kind ON menu_package_events(kind, ip_hash, at)`;
    })().catch((e: unknown) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Rows → the wire
// ---------------------------------------------------------------------------

type Stamp = Date | string;

/** The columns every package read returns (never the file). */
export interface PackageRow {
  id: string;
  seq: number;
  file_name: string;
  sha256: string;
  size_bytes: number;
  format_version: number;
  source: string | null;
  generated_at: Stamp;
  uploaded_at: Stamp;
  uploader: string | null;
  item_count: number;
  ingredient_count: number;
  state: string;
  claimed_by: string | null;
  claimed_at: Stamp | null;
  lease_until: Stamp | null;
  lease_expired: boolean;
  attempts: number;
  next_try_at: Stamp | null;
  retry_ready: boolean;
  applied_by: string | null;
  applied_at: Stamp | null;
  result_json: unknown;
  error: string | null;
  has_content: boolean;
}

function iso(v: Stamp): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}
function isoOrNull(v: Stamp | null | undefined): string | null {
  return v === null || v === undefined ? null : iso(v);
}

function stateOf(s: string): MenuPackageState {
  return (MENU_PACKAGE_STATES as readonly string[]).includes(s) ? (s as MenuPackageState) : 'refused';
}

function countsOf(v: unknown): MenuDeployCounts | null {
  if (v === null || v === undefined) return null;
  const parsed = menuDeployCountsSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
}

export function toPackageMeta(r: PackageRow): MenuPackageMeta {
  return {
    id: r.id,
    seq: Number(r.seq),
    fileName: r.file_name,
    sha256: r.sha256,
    sizeBytes: Number(r.size_bytes),
    formatVersion: Number(r.format_version),
    source: r.source,
    generatedAt: iso(r.generated_at),
    uploadedAt: iso(r.uploaded_at),
    uploader: r.uploader,
    itemCount: Number(r.item_count),
    ingredientCount: Number(r.ingredient_count),
    state: stateOf(r.state),
    claimedBy: r.claimed_by,
    claimedAt: isoOrNull(r.claimed_at),
    leaseUntil: isoOrNull(r.lease_until),
    leaseExpired: Boolean(r.lease_expired),
    attempts: Number(r.attempts),
    nextTryAt: isoOrNull(r.next_try_at),
    retryReady: Boolean(r.retry_ready),
    appliedBy: r.applied_by,
    appliedAt: isoOrNull(r.applied_at),
    result: countsOf(r.result_json),
    error: r.error,
    hasContent: Boolean(r.has_content),
  };
}

function detailOf(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The rows of a query, typed (the driver's rows are untyped records). */
async function rowsOf<T>(query: PromiseLike<unknown>): Promise<T[]> {
  return (await query) as T[];
}

/** A JSON detail for the history, without undefined fields. */
function detailJson(o: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The newest package (highest seq), or null. */
export async function readLatestPackage(): Promise<MenuPackageMeta | null> {
  const rows = (await sql()`
    SELECT id, seq, file_name, sha256, size_bytes, format_version, source, generated_at,
           uploaded_at, uploader, item_count, ingredient_count, state, claimed_by, claimed_at,
           lease_until, (state = 'claimed' AND lease_until IS NOT NULL AND lease_until <= now()) AS lease_expired,
           attempts, next_try_at, (next_try_at IS NULL OR next_try_at <= now()) AS retry_ready,
           applied_by, applied_at, result_json, error, (content_gz_b64 IS NOT NULL) AS has_content
      FROM menu_packages
     ORDER BY seq DESC
     LIMIT 1
  `) as PackageRow[];
  return rows[0] ? toPackageMeta(rows[0]) : null;
}

/**
 * What the website holds, for the costing PC's --status and a till's check:
 * the key's hint, the newest package, the last one a till put in, and each
 * till's newest word about the newest package. `events` (the last 50 history
 * lines, newest first) only when asked. Never the file; never an ip hash.
 */
export async function readMenuDeployStatus(opts: { events: boolean }): Promise<MenuDeployStatusResponse> {
  const q = sql();
  const [keyRows, latest, appliedRows, tillRows, appliedByRows, eventRows] = await Promise.all([
    rowsOf<{ key_hint: string; created_at: Stamp; device_id: string; device_name: string | null }>(
      q`SELECT key_hint, created_at, device_id, device_name FROM menu_deploy_key WHERE id = 1`,
    ),
    readLatestPackage(),
    rowsOf<{ id: string; seq: number; applied_by: string | null; applied_at: Stamp | null }>(q`
      SELECT id, seq, applied_by, applied_at FROM menu_packages
       WHERE state = 'applied' ORDER BY seq DESC LIMIT 1
    `),
    rowsOf<{ device_id: string; device_name: string | null; kind: string; at: Stamp; detail: unknown }>(q`
      SELECT DISTINCT ON (e.device_id) e.device_id, e.device_name, e.kind, e.at, e.detail
        FROM menu_package_events e
       WHERE e.package_id = (SELECT id FROM menu_packages ORDER BY seq DESC LIMIT 1)
         AND e.device_id IS NOT NULL
       ORDER BY e.device_id, e.at DESC, e.id DESC
    `),
    rowsOf<{ device_id: string }>(q`
      SELECT DISTINCT e.device_id
        FROM menu_package_events e
       WHERE e.package_id = (SELECT id FROM menu_packages ORDER BY seq DESC LIMIT 1)
         AND e.kind = 'applied'
         AND e.device_id IS NOT NULL
       ORDER BY e.device_id
    `),
    opts.events
      ? rowsOf<{
          at: Stamp;
          kind: string;
          package_id: string | null;
          file_name: string | null;
          device_id: string | null;
          device_name: string | null;
          detail: unknown;
        }>(q`
          SELECT e.at, e.kind, e.package_id, p.file_name, e.device_id, e.device_name, e.detail
            FROM menu_package_events e
            LEFT JOIN menu_packages p ON p.id = e.package_id
           ORDER BY e.at DESC, e.id DESC
           LIMIT 50
        `)
      : Promise.resolve(null),
  ]);
  const key = keyRows[0];
  const applied = appliedRows[0];
  const out: MenuDeployStatusResponse = {
    ok: true,
    key: key
      ? { keyHint: key.key_hint, createdAt: iso(key.created_at), deviceId: key.device_id, deviceName: key.device_name }
      : null,
    latest,
    lastApplied: applied
      ? { id: applied.id, seq: Number(applied.seq), appliedBy: applied.applied_by, appliedAt: isoOrNull(applied.applied_at) }
      : null,
    appliedByTills: appliedByRows.map((r) => r.device_id),
    tills: tillRows
      .map((t) => ({
        deviceId: t.device_id,
        deviceName: t.device_name,
        kind: t.kind,
        at: iso(t.at),
        detail: detailOf(t.detail),
      }))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)),
  };
  if (eventRows) {
    out.events = eventRows.map(
      (e): MenuDeployEventRow => ({
        at: iso(e.at),
        kind: e.kind,
        packageId: e.package_id,
        fileName: e.file_name,
        deviceId: e.device_id,
        deviceName: e.device_name,
        detail: detailOf(e.detail),
      }),
    );
  }
  return out;
}

/** The file of one package, for the wait-mode preview. Changes nothing. */
export async function readPackageContent(
  id: string,
): Promise<{ kind: 'missing' } | { kind: 'gone' } | { kind: 'ok'; sha256: string; contentGzB64: string }> {
  const rows = (await sql()`
    SELECT sha256, content_gz_b64 FROM menu_packages WHERE id = ${id}::uuid
  `) as Array<{ sha256: string; content_gz_b64: string | null }>;
  const row = rows[0];
  if (!row) return { kind: 'missing' };
  if (row.content_gz_b64 === null) return { kind: 'gone' };
  return { kind: 'ok', sha256: row.sha256, contentGzB64: row.content_gz_b64 };
}

// ---------------------------------------------------------------------------
// The upload key
// ---------------------------------------------------------------------------

/** The registered key's hash, or null when none. */
export async function readKeyHash(): Promise<string | null> {
  const rows = (await sql()`SELECT key_hash FROM menu_deploy_key WHERE id = 1`) as Array<{ key_hash: string }>;
  return rows[0]?.key_hash ?? null;
}

/** Wrong keys from this address in the last 15 minutes. */
export async function countRecentBadKeys(ipHash: string): Promise<number> {
  const rows = (await sql()`
    SELECT count(*)::int AS n FROM menu_package_events
     WHERE kind = 'bad_key' AND ip_hash = ${ipHash}::text AND at > now() - interval '15 minutes'
  `) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

export async function recordBadKey(ipHash: string): Promise<void> {
  await sql()`INSERT INTO menu_package_events (kind, ip_hash) VALUES ('bad_key', ${ipHash}::text)`;
}

/**
 * A till registers the owner's new key (its hash): the one row is replaced,
 * so the old key stops working at once, with its history line.
 */
export async function storeKey(body: MenuDeployKeyBody): Promise<string> {
  const detail = detailJson({ keyHint: body.keyHint, appVersion: body.appVersion });
  const rows = (await sql()`
    WITH up AS (
      INSERT INTO menu_deploy_key (id, key_hash, key_hint, device_id, device_name, created_at)
      VALUES (1, ${body.keyHash}::text, ${body.keyHint}::text, ${body.deviceId}::text, ${body.deviceName}::text, now())
      ON CONFLICT (id) DO UPDATE
         SET key_hash = EXCLUDED.key_hash, key_hint = EXCLUDED.key_hint,
             device_id = EXCLUDED.device_id, device_name = EXCLUDED.device_name,
             created_at = EXCLUDED.created_at
      RETURNING created_at
    ), ev AS (
      INSERT INTO menu_package_events (kind, device_id, device_name, detail)
      VALUES ('key_created', ${body.deviceId}::text, ${body.deviceName}::text, ${detail}::jsonb)
      RETURNING id
    )
    SELECT created_at FROM up
  `) as Array<{ created_at: Stamp }>;
  const row = rows[0];
  if (!row) throw new Error('the upload key was not stored');
  return iso(row.created_at);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/** Packages uploaded in the last 24 hours. */
export async function countUploadsToday(): Promise<number> {
  const rows = (await sql()`
    SELECT count(*)::int AS n FROM menu_packages WHERE uploaded_at > now() - interval '24 hours'
  `) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

export interface NewPackage {
  fileName: string;
  sha256: string;
  sizeBytes: number;
  formatVersion: number;
  source: string | null;
  generatedAt: string;
  uploader: string | null;
  itemCount: number;
  ingredientCount: number;
  contentGzB64: string;
  ipHash: string | null;
}

/**
 * One statement: the new package, older files nobody is importing marked
 * superseded (a till never imports an old file after a newer one arrived),
 * and the history line.
 */
export async function insertPackage(p: NewPackage): Promise<MenuPackageMeta> {
  const id = randomUUID();
  const detail = detailJson({
    fileName: p.fileName,
    generatedAt: p.generatedAt,
    sizeBytes: p.sizeBytes,
    formatVersion: p.formatVersion,
    itemCount: p.itemCount,
    ingredientCount: p.ingredientCount,
    uploader: p.uploader ?? undefined,
  });
  const rows = (await sql()`
    WITH ins AS (
      INSERT INTO menu_packages (id, file_name, sha256, size_bytes, format_version, source, generated_at,
                                 uploader, item_count, ingredient_count, content_gz_b64)
      VALUES (${id}::uuid, ${p.fileName}::text, ${p.sha256}::text, ${p.sizeBytes}::int, ${p.formatVersion}::int,
              ${p.source}::text, ${p.generatedAt}::timestamptz, ${p.uploader}::text, ${p.itemCount}::int,
              ${p.ingredientCount}::int, ${p.contentGzB64}::text)
      RETURNING id, seq, file_name, sha256, size_bytes, format_version, source, generated_at,
                uploaded_at, uploader, item_count, ingredient_count, state, claimed_by, claimed_at,
                lease_until, false AS lease_expired, attempts, next_try_at,
                (next_try_at IS NULL OR next_try_at <= now()) AS retry_ready,
                applied_by, applied_at, result_json, error, (content_gz_b64 IS NOT NULL) AS has_content
    ), sup AS (
      UPDATE menu_packages SET state = 'superseded', next_try_at = NULL
       WHERE state IN ('pending', 'failed')
      RETURNING id
    ), ev AS (
      INSERT INTO menu_package_events (package_id, kind, ip_hash, detail)
      SELECT id, 'uploaded', ${p.ipHash}::text, ${detail}::jsonb FROM ins
      RETURNING id
    )
    SELECT * FROM ins
  `) as PackageRow[];
  const row = rows[0];
  if (!row) throw new Error('the menu package was not stored');
  return toPackageMeta(row);
}

/**
 * Best effort after an upload: only the newest packages keep their file
 * (never one a till may still be importing), and wrong-key lines older than
 * 30 days go.
 */
export async function pruneAfterUpload(): Promise<void> {
  await sql()`
    UPDATE menu_packages SET content_gz_b64 = NULL
     WHERE content_gz_b64 IS NOT NULL
       AND state NOT IN ('pending', 'claimed')
       AND seq NOT IN (SELECT seq FROM menu_packages ORDER BY seq DESC LIMIT ${MENU_DEPLOY_KEEP_CONTENT}::int)
  `;
  await sql()`DELETE FROM menu_package_events WHERE kind = 'bad_key' AND at < now() - interval '30 days'`;
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

interface ClaimedRow extends PackageRow {
  content_gz_b64: string;
}

export type ClaimResult =
  | { ok: true; meta: MenuPackageMeta; contentGzB64: string }
  | { ok: false; status: 404; error: 'not_found' }
  | {
      ok: false;
      status: 409;
      error: MenuClaimRefusal;
      meta: MenuPackageMeta;
      blockedBy: { id: string; seq: number; claimedBy: string | null; leaseExpired: boolean } | null;
    };

/**
 * A till asks for a package (the contract's claim rules, section 2.5).
 *
 * 'own' (a till with its link off imports for itself): the newest package,
 * still kept, in a format the till reads, not refused. Its state never
 * changes; a history line says the till took it.
 *
 * 'shared' (linked tills: ONE imports, the other gets the rows through the
 * link): one UPDATE claims it for a lease, and only when
 *  - it is the newest, still kept, in a format the till reads;
 *  - the till is not behind: no package newer than its marker was put in
 *    whose rows may still be on their way through the link — one another
 *    till put in, or one this till put in that another till has received
 *    (this till's menu lost it: a backup copy restored since; that till goes
 *    first). A package this till itself put in that no other till has is
 *    not waited for: nothing of it will ever come through the link;
 *  - no older file is being imported by another till (a live lease, or an
 *    expired one unless the owner takes over) — except one the till's
 *    marker already covers (it is in; only its report was lost);
 *  - it is pending and due, or already this till's (a re-claim, even after
 *    the lease ran out), or another till's that ran out when the owner takes
 *    over, or failed when the owner tries again.
 * The till's marker is read by its package id when it sends one: the
 * numbers start again if the website's database is ever reset, and an id
 * the website does not know counts as no marker.
 * The same statement settles older claims — this till's own (it came back
 * after a crash) and any its marker covers: put in when the marker is that
 * package, else superseded — and, on a take-over, other tills' expired
 * claims (superseded). Then the history line: 'taken_over' {from} when it
 * took another till's claim.
 */
export async function claimPackage(id: string, b: MenuDeployClaimBody): Promise<ClaimResult> {
  const detail = detailJson({ scope: b.scope, appVersion: b.appVersion, retry: b.retry || undefined });
  if (b.scope === 'own') {
    const rows = (await sql()`
      WITH p AS (
        SELECT p.*, (p.state = 'claimed' AND p.lease_until IS NOT NULL AND p.lease_until <= now()) AS lease_expired,
               (p.next_try_at IS NULL OR p.next_try_at <= now()) AS retry_ready, true AS has_content
          FROM menu_packages p
         WHERE p.id = ${id}::uuid
           AND p.content_gz_b64 IS NOT NULL
           AND p.format_version <= ${b.maxFormatVersion}::int
           AND p.state <> 'refused'
           AND NOT EXISTS (SELECT 1 FROM menu_packages n WHERE n.seq > p.seq)
      ), ev AS (
        INSERT INTO menu_package_events (package_id, kind, device_id, device_name, detail)
        SELECT id, 'claimed', ${b.deviceId}::text, ${b.deviceName}::text, ${detail}::jsonb FROM p
        RETURNING id
      )
      SELECT * FROM p
    `) as ClaimedRow[];
    const row = rows[0];
    if (row) return { ok: true, meta: toPackageMeta(row), contentGzB64: row.content_gz_b64 };
    return refuseClaim(id, b);
  }

  const rows = (await sql()`
    WITH mk AS (
      SELECT coalesce((SELECT m.seq FROM menu_packages m WHERE m.id = ${b.lastPackageId}::uuid),
                      CASE WHEN ${b.lastPackageId}::uuid IS NULL THEN ${b.lastPackageSeq}::int END,
                      -1) AS s,
             ${b.lastPackageId}::uuid AS id
    ), target AS (
      SELECT id, state, claimed_by FROM menu_packages WHERE id = ${id}::uuid
    ), upd AS (
      UPDATE menu_packages p
         SET state = 'claimed',
             claimed_by = ${b.deviceId}::text,
             claimed_at = now(),
             lease_until = now() + interval '600 seconds', -- MENU_DEPLOY_LEASE_SECONDS, as a literal
             attempts = CASE WHEN ${b.retry}::boolean THEN 0 ELSE p.attempts END,
             next_try_at = NULL
        FROM mk
       WHERE p.id = ${id}::uuid
         AND p.content_gz_b64 IS NOT NULL
         AND p.format_version <= ${b.maxFormatVersion}::int
         AND NOT EXISTS (SELECT 1 FROM menu_packages n WHERE n.seq > p.seq)
         AND NOT EXISTS (SELECT 1 FROM menu_packages a
                          WHERE a.state = 'applied' AND a.seq > mk.s
                            AND (a.applied_by IS DISTINCT FROM ${b.deviceId}::text
                                 OR EXISTS (SELECT 1 FROM menu_package_events e
                                             WHERE e.package_id = a.id AND e.kind = 'received'
                                               AND e.device_id IS DISTINCT FROM ${b.deviceId}::text)))
         AND NOT EXISTS (SELECT 1 FROM menu_packages c
                          WHERE c.seq < p.seq AND c.seq > mk.s AND c.state = 'claimed'
                            AND c.claimed_by IS DISTINCT FROM ${b.deviceId}::text
                            AND (c.lease_until > now() OR NOT ${b.takeOver}::boolean))
         AND (   (p.state = 'pending' AND (p.next_try_at IS NULL OR p.next_try_at <= now() OR ${b.retry}::boolean))
              OR (p.state = 'claimed' AND p.claimed_by = ${b.deviceId}::text)
              OR (p.state = 'claimed' AND p.lease_until <= now() AND ${b.takeOver}::boolean)
              OR (p.state = 'failed' AND ${b.retry}::boolean))
      RETURNING p.*, false AS lease_expired, true AS retry_ready, true AS has_content
    ), older AS (
      UPDATE menu_packages o
         SET state = CASE WHEN (mk.id IS NOT NULL AND o.id = mk.id)
                               OR (mk.id IS NULL AND o.claimed_by = ${b.deviceId}::text AND o.seq <= mk.s)
                          THEN 'applied' ELSE 'superseded' END,
             applied_by = CASE WHEN (mk.id IS NOT NULL AND o.id = mk.id)
                                    OR (mk.id IS NULL AND o.claimed_by = ${b.deviceId}::text AND o.seq <= mk.s)
                               THEN o.claimed_by ELSE o.applied_by END,
             applied_at = CASE WHEN (mk.id IS NOT NULL AND o.id = mk.id)
                                    OR (mk.id IS NULL AND o.claimed_by = ${b.deviceId}::text AND o.seq <= mk.s)
                               THEN now() ELSE o.applied_at END,
             claimed_by = NULL, claimed_at = NULL, lease_until = NULL, next_try_at = NULL
        FROM (SELECT id AS was_id, claimed_by AS was_claimed_by FROM menu_packages WHERE state = 'claimed') w, mk
       WHERE o.id = w.was_id
         AND o.state = 'claimed'
         AND o.seq < (SELECT seq FROM upd)
         AND (   o.claimed_by = ${b.deviceId}::text
              OR o.seq <= mk.s
              OR (${b.takeOver}::boolean AND o.lease_until <= now()))
      RETURNING o.id, o.seq, o.state, w.was_claimed_by,
                (w.was_claimed_by IS DISTINCT FROM ${b.deviceId}::text AND o.seq > mk.s) AS taken
    ), older_ev AS (
      -- Put in by the till that held it (this one after a crash, or the other one whose rows are here).
      INSERT INTO menu_package_events (package_id, kind, device_id, device_name, detail)
      SELECT o.id, 'applied', o.was_claimed_by,
             CASE WHEN o.was_claimed_by = ${b.deviceId}::text THEN ${b.deviceName}::text END,
             jsonb_build_object('scope', 'shared', 'recovered', true, 'noticedBy', ${b.deviceId}::text,
                                'appVersion', ${b.appVersion}::text)
        FROM older o WHERE o.state = 'applied'
      RETURNING id
    ), ev AS (
      INSERT INTO menu_package_events (package_id, kind, device_id, device_name, detail)
      SELECT u.id,
             CASE WHEN (t.state = 'claimed' AND t.claimed_by IS DISTINCT FROM ${b.deviceId}::text)
                       OR EXISTS (SELECT 1 FROM older o WHERE o.taken)
                  THEN 'taken_over' ELSE 'claimed' END,
             ${b.deviceId}::text, ${b.deviceName}::text,
             ${detail}::jsonb || jsonb_build_object(
               'from', coalesce(
                 CASE WHEN t.state = 'claimed' AND t.claimed_by IS DISTINCT FROM ${b.deviceId}::text THEN t.claimed_by END,
                 (SELECT o.was_claimed_by FROM older o WHERE o.taken ORDER BY o.seq DESC LIMIT 1)),
               'settled', (SELECT count(*)::int FROM older))
        FROM upd u CROSS JOIN target t
      RETURNING id
    )
    SELECT * FROM upd
  `) as ClaimedRow[];
  const row = rows[0];
  if (row) return { ok: true, meta: toPackageMeta(row), contentGzB64: row.content_gz_b64 };
  return refuseClaim(id, b);
}

/** The first reason that fits, in the contract's order (MENU_CLAIM_REFUSALS). Pure: tested on its own. */
export function claimRefusalReason(
  meta: MenuPackageMeta,
  ctx: {
    scope: MenuDeployClaimBody['scope'];
    deviceId: string;
    maxFormatVersion: number;
    takeOver: boolean;
    retry: boolean;
    hasNewer: boolean;
    behind: boolean;
    /** An older file another till holds (a live claim first). */
    blocker: { leaseExpired: boolean } | null;
  },
): MenuClaimRefusal {
  if (meta.state === 'superseded' || ctx.hasNewer) return 'superseded';
  if (meta.state === 'refused') return 'refused';
  if (meta.formatVersion > ctx.maxFormatVersion) return 'too_old';
  if (ctx.scope === 'own') return meta.hasContent ? 'busy' : 'gone';
  if (meta.state === 'applied') return 'already_applied';
  if (meta.state === 'failed' && !ctx.retry) return 'failed';
  if (meta.state === 'claimed' && meta.claimedBy !== ctx.deviceId) {
    if (!meta.leaseExpired) return 'claimed';
    if (!ctx.takeOver) return 'stalled';
  }
  if (ctx.blocker) {
    // An older file another till still holds: importing now could double
    // what it put in. A live claim is simply busy; one that ran out is
    // stalled — only the owner's take-over moves past it.
    if (!ctx.blocker.leaseExpired) return 'busy';
    if (!ctx.takeOver) return 'stalled';
  }
  if (ctx.behind) return 'behind';
  if (meta.state === 'pending' && !meta.retryReady && !ctx.retry) return 'retry_later';
  if (!meta.hasContent) return 'gone';
  // Only a race gets here (another request changed it a moment ago): ask again.
  return 'busy';
}

/** 0 rows claimed: read once and say why (409), or 404 for no such package. */
async function refuseClaim(id: string, b: MenuDeployClaimBody): Promise<ClaimResult> {
  const rows = (await sql()`
    WITH mk AS (
      SELECT coalesce((SELECT m.seq FROM menu_packages m WHERE m.id = ${b.lastPackageId}::uuid),
                      CASE WHEN ${b.lastPackageId}::uuid IS NULL THEN ${b.lastPackageSeq}::int END,
                      -1) AS s
    )
    SELECT p.id, p.seq, p.file_name, p.sha256, p.size_bytes, p.format_version, p.source, p.generated_at,
           p.uploaded_at, p.uploader, p.item_count, p.ingredient_count, p.state, p.claimed_by, p.claimed_at,
           p.lease_until, (p.state = 'claimed' AND p.lease_until IS NOT NULL AND p.lease_until <= now()) AS lease_expired,
           p.attempts, p.next_try_at, (p.next_try_at IS NULL OR p.next_try_at <= now()) AS retry_ready,
           p.applied_by, p.applied_at, p.result_json, p.error, (p.content_gz_b64 IS NOT NULL) AS has_content,
           EXISTS (SELECT 1 FROM menu_packages n WHERE n.seq > p.seq) AS has_newer,
           EXISTS (SELECT 1 FROM menu_packages a
                    WHERE a.state = 'applied' AND a.seq > mk.s
                      AND (a.applied_by IS DISTINCT FROM ${b.deviceId}::text
                           OR EXISTS (SELECT 1 FROM menu_package_events e
                                       WHERE e.package_id = a.id AND e.kind = 'received'
                                         AND e.device_id IS DISTINCT FROM ${b.deviceId}::text))) AS behind,
           mk.s AS marker_seq
      FROM menu_packages p, mk
     WHERE p.id = ${id}::uuid
  `) as Array<PackageRow & { has_newer: boolean; behind: boolean; marker_seq: number }>;
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: 'not_found' };
  const meta = toPackageMeta(row);
  // An older claim the till's marker covers is in (only its report was lost): it blocks nothing.
  const blockers = (await sql()`
    SELECT id, seq, claimed_by, (lease_until IS NOT NULL AND lease_until <= now()) AS lease_expired
      FROM menu_packages
     WHERE seq < ${meta.seq}::int AND seq > ${Number(row.marker_seq)}::int AND state = 'claimed'
       AND claimed_by IS DISTINCT FROM ${b.deviceId}::text
     ORDER BY (lease_until IS NOT NULL AND lease_until <= now()) ASC, seq DESC
     LIMIT 1
  `) as Array<{ id: string; seq: number; claimed_by: string | null; lease_expired: boolean }>;
  const first = blockers[0];
  const blocker = first
    ? { id: first.id, seq: Number(first.seq), claimedBy: first.claimed_by, leaseExpired: Boolean(first.lease_expired) }
    : null;
  const error = claimRefusalReason(meta, {
    scope: b.scope,
    deviceId: b.deviceId,
    maxFormatVersion: b.maxFormatVersion,
    takeOver: b.takeOver,
    retry: b.retry,
    hasNewer: Boolean(row.has_newer),
    behind: Boolean(row.behind),
    blocker,
  });
  if (error === 'too_old') {
    const detail = detailJson({
      scope: b.scope,
      appVersion: b.appVersion,
      formatVersion: meta.formatVersion,
      maxFormatVersion: b.maxFormatVersion,
    });
    await sql()`
      INSERT INTO menu_package_events (package_id, kind, device_id, device_name, detail)
      VALUES (${id}::uuid, 'too_old', ${b.deviceId}::text, ${b.deviceName}::text, ${detail}::jsonb)
    `;
  }
  return {
    ok: false,
    status: 409,
    error,
    meta,
    blockedBy: error === 'busy' || error === 'stalled' ? blocker : null,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type ReportResult =
  | { ok: true; state: MenuPackageState; duplicate: boolean; accepted: boolean }
  | { ok: false; status: 404; error: 'not_found' };

type ReportRow = { before_state: string; before_applied_by: string | null; new_state: string | null };

/**
 * A till says what became of a package: always one history line (kind =
 * the outcome); the package itself changes only for 'shared' (contract 2.6):
 *  - applied: put in — from a claim, a pending or failed package, or a
 *    superseded one (a late report) — whoever held it, unless another
 *    till's claim is still live. Already put in by another till =
 *    `duplicate` (the menu may now hold doubles). A resend from the till
 *    that put it in changes nothing and adds no line.
 *  - failed (this till's claim only): one more attempt; back to pending with
 *    the next try 1, 2, 4 or 8 minutes away, 'failed' at the 5th, or
 *    superseded if a newer file arrived meanwhile.
 *  - refused (this till's claim only): never tried again.
 *  - received, waiting_for_owner, too_old: the line only.
 */
export async function reportPackage(id: string, b: MenuDeployReportBody): Promise<ReportResult> {
  const detail = detailJson({
    scope: b.scope,
    appVersion: b.appVersion,
    counts: b.counts,
    error: b.error,
    retryable: b.retryable,
    formatVersion: b.formatVersion,
    maxFormatVersion: b.maxFormatVersion,
  });
  let rows: ReportRow[];
  if (b.scope === 'shared' && b.outcome === 'applied') {
    const counts = JSON.stringify(b.counts ?? menuDeployCountsSchema.parse({}));
    rows = (await sql()`
      WITH before AS (
        SELECT id, state, applied_by FROM menu_packages WHERE id = ${id}::uuid
      ), upd AS (
        UPDATE menu_packages p
           SET state = 'applied', applied_by = ${b.deviceId}::text, applied_at = now(),
               result_json = ${counts}::jsonb, claimed_by = NULL, claimed_at = NULL, lease_until = NULL,
               error = NULL, next_try_at = NULL
         WHERE p.id = ${id}::uuid
           AND p.state IN ('claimed', 'pending', 'failed', 'superseded')
           AND (p.claimed_by = ${b.deviceId}::text OR p.claimed_by IS NULL OR p.lease_until <= now())
        RETURNING p.state
      ), ev AS (
        INSERT INTO menu_package_events (package_id, kind, device_id, device_name, detail)
        SELECT b.id, 'applied', ${b.deviceId}::text, ${b.deviceName}::text,
               ${detail}::jsonb || jsonb_build_object(
                 'duplicate', b.state = 'applied',
                 'late', b.state = 'superseded',
                 'accepted', EXISTS (SELECT 1 FROM upd))
          FROM before b
         WHERE NOT (b.state = 'applied' AND b.applied_by IS NOT DISTINCT FROM ${b.deviceId}::text)
        RETURNING id
      )
      SELECT b.state AS before_state, b.applied_by AS before_applied_by, (SELECT state FROM upd) AS new_state
        FROM before b
    `) as ReportRow[];
  } else if (b.scope === 'shared' && b.outcome === 'failed') {
    rows = (await sql()`
      WITH before AS (
        SELECT id, state, applied_by FROM menu_packages WHERE id = ${id}::uuid
      ), upd AS (
        UPDATE menu_packages p
           SET attempts = p.attempts + 1,
               state = CASE WHEN EXISTS (SELECT 1 FROM menu_packages n WHERE n.seq > p.seq) THEN 'superseded'
                            WHEN p.attempts + 1 >= ${MENU_DEPLOY_MAX_ATTEMPTS}::int THEN 'failed'
                            ELSE 'pending' END,
               next_try_at = now() + CASE WHEN p.attempts <= 0 THEN interval '1 minute'
                                          WHEN p.attempts = 1 THEN interval '2 minutes'
                                          WHEN p.attempts = 2 THEN interval '4 minutes'
                                          ELSE interval '8 minutes' END,
               error = ${b.error ?? 'The import failed.'}::text,
               claimed_by = NULL, claimed_at = NULL, lease_until = NULL
         WHERE p.id = ${id}::uuid AND p.state = 'claimed' AND p.claimed_by = ${b.deviceId}::text
        RETURNING p.state
      ), ev AS (
        INSERT INTO menu_package_events (package_id, kind, device_id, device_name, detail)
        SELECT b.id, 'failed', ${b.deviceId}::text, ${b.deviceName}::text,
               ${detail}::jsonb || jsonb_build_object('accepted', EXISTS (SELECT 1 FROM upd))
          FROM before b
        RETURNING id
      )
      SELECT b.state AS before_state, b.applied_by AS before_applied_by, (SELECT state FROM upd) AS new_state
        FROM before b
    `) as ReportRow[];
  } else if (b.scope === 'shared' && b.outcome === 'refused') {
    rows = (await sql()`
      WITH before AS (
        SELECT id, state, applied_by FROM menu_packages WHERE id = ${id}::uuid
      ), upd AS (
        UPDATE menu_packages p
           SET state = 'refused', error = ${b.error ?? 'The till refused the file.'}::text,
               claimed_by = NULL, claimed_at = NULL, lease_until = NULL, next_try_at = NULL
         WHERE p.id = ${id}::uuid AND p.state = 'claimed' AND p.claimed_by = ${b.deviceId}::text
        RETURNING p.state
      ), ev AS (
        INSERT INTO menu_package_events (package_id, kind, device_id, device_name, detail)
        SELECT b.id, 'refused', ${b.deviceId}::text, ${b.deviceName}::text,
               ${detail}::jsonb || jsonb_build_object('accepted', EXISTS (SELECT 1 FROM upd))
          FROM before b
        RETURNING id
      )
      SELECT b.state AS before_state, b.applied_by AS before_applied_by, (SELECT state FROM upd) AS new_state
        FROM before b
    `) as ReportRow[];
  } else {
    // received / waiting_for_owner / too_old, and every 'own' report: the line only.
    rows = (await sql()`
      WITH before AS (
        SELECT id, state, applied_by FROM menu_packages WHERE id = ${id}::uuid
      ), ev AS (
        INSERT INTO menu_package_events (package_id, kind, device_id, device_name, detail)
        SELECT b.id, ${b.outcome}::text, ${b.deviceId}::text, ${b.deviceName}::text, ${detail}::jsonb
          FROM before b
        RETURNING id
      )
      SELECT b.state AS before_state, b.applied_by AS before_applied_by, NULL::text AS new_state
        FROM before b
    `) as ReportRow[];
  }
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: 'not_found' };
  const accepted = row.new_state !== null && row.new_state !== undefined;
  return {
    ok: true,
    state: stateOf(accepted ? String(row.new_state) : row.before_state),
    duplicate:
      b.scope === 'shared' &&
      b.outcome === 'applied' &&
      row.before_state === 'applied' &&
      row.before_applied_by !== b.deviceId,
    accepted,
  };
}
