import { sql } from '@/lib/db';

/**
 * The phone dashboard's tables (shared-types dashboard.ts), created on demand
 * by its routes and pages (and in db/schema.sql for fresh installs), so no
 * database is migrated by hand and no existing route waits on them.
 * Idempotent; run once per server instance; a failure is never remembered.
 * Later columns may only ever be added with ADD COLUMN IF NOT EXISTS, here
 * and in schema.sql together.
 *
 * Two families:
 *  - dash_logins / dash_sessions / dash_events: who may sign in;
 *  - dash_tills / dash_orders / dash_order_lines / dash_shifts /
 *    dash_cash_moves / dash_drawer_opens / dash_stock / dash_stock_moves /
 *    dash_menu: the till's figures, each row the till's own id, written only
 *    through POST /api/bridge/dashboard/push (BRIDGE_SECRET).
 *
 * Private data (customers' names and phones, the shop's sales and costs)
 * lives only here and leaves only through a signed-in dashboard page.
 */

let schemaReady: Promise<void> | null = null;

export function ensureDashSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const q = sql();
      for (const statement of DASH_SCHEMA_STATEMENTS) await q(statementParts(statement));
    })().catch((e: unknown) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

/** A plain statement as a tagged-template call (the Neon client and the tests' PGlite take only that form). */
function statementParts(text: string): TemplateStringsArray {
  const parts = [text] as string[] & { raw?: string[] };
  parts.raw = [text];
  return parts as unknown as TemplateStringsArray;
}

/**
 * Every statement, in order. db/schema.sql carries the same text (a test
 * keeps the two equal), so a fresh database and an on-demand one match.
 */
export const DASH_SCHEMA_STATEMENTS: readonly string[] = [
  // --- sign-ins -------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS dash_logins (
    id                   UUID PRIMARY KEY,
    username             TEXT NOT NULL,
    display_name         TEXT NOT NULL,
    role                 TEXT NOT NULL CHECK (role IN ('owner','manager')),
    sees_reports         BOOLEAN NOT NULL DEFAULT false,
    password_hash        TEXT,
    setup_code_hash      TEXT,
    setup_expires_at     TIMESTAMPTZ,
    setup_tries          INT NOT NULL DEFAULT 0,
    wrong_passwords      INT NOT NULL DEFAULT 0,
    locked_until         TIMESTAMPTZ,
    sessions_valid_after TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_sign_in_at      TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at           TIMESTAMPTZ
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_dash_logins_username ON dash_logins(username) WHERE removed_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS dash_sessions (
    token_hash   TEXT PRIMARY KEY,
    login_id     UUID NOT NULL REFERENCES dash_logins(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_agent   TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dash_sessions_login ON dash_sessions(login_id)`,
  `CREATE TABLE IF NOT EXISTS dash_events (
    id          BIGSERIAL PRIMARY KEY,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind        TEXT NOT NULL,
    login_id    UUID,
    ip_hash     TEXT,
    device_id   TEXT,
    detail      JSONB
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dash_events_kind ON dash_events(kind, ip_hash, at)`,
  `CREATE INDEX IF NOT EXISTS idx_dash_events_login ON dash_events(login_id, at)`,
  // --- the till's figures ---------------------------------------------------
  `CREATE TABLE IF NOT EXISTS dash_tills (
    device_id     TEXT PRIMARY KEY,
    device_name   TEXT,
    app_version   TEXT,
    first_push_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_push_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    till_sent_at  TIMESTAMPTZ,
    live          JSONB,
    cursors       JSONB,
    caught_up     BOOLEAN NOT NULL DEFAULT false
  )`,
  `CREATE TABLE IF NOT EXISTS dash_orders (
    id             TEXT PRIMARY KEY,
    device_id      TEXT NOT NULL,
    number         TEXT NOT NULL,
    status         TEXT NOT NULL,
    mode           TEXT NOT NULL,
    source         TEXT NOT NULL,
    channel        TEXT NOT NULL,
    came_by        TEXT,
    created_at     TIMESTAMPTZ NOT NULL,
    paid_at        TIMESTAMPTZ,
    trading_day    DATE NOT NULL,
    hour           SMALLINT NOT NULL,
    counted        BOOLEAN NOT NULL,
    deleted        TEXT,
    subtotal_cents BIGINT NOT NULL,
    discount_cents BIGINT NOT NULL,
    tax_cents      BIGINT NOT NULL,
    total_cents    BIGINT NOT NULL,
    refunded_cents BIGINT NOT NULL,
    net_cents      BIGINT NOT NULL,
    customer_name  TEXT,
    customer_phone TEXT,
    area           TEXT,
    cashier        TEXT,
    rider          TEXT,
    shift_id       TEXT,
    item_count     INT NOT NULL,
    doc            JSONB NOT NULL,
    doc_updated_at TIMESTAMPTZ NOT NULL,
    received_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dash_orders_day ON dash_orders(trading_day, counted)`,
  `CREATE INDEX IF NOT EXISTS idx_dash_orders_created ON dash_orders(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_dash_orders_shift ON dash_orders(shift_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dash_orders_status ON dash_orders(status, created_at)`,
  `CREATE TABLE IF NOT EXISTS dash_shifts (
    id                  TEXT PRIMARY KEY,
    device_id           TEXT NOT NULL,
    opened_at           TIMESTAMPTZ NOT NULL,
    closed_at           TIMESTAMPTZ,
    opened_by           TEXT,
    closed_by           TEXT,
    opening_cash_cents  BIGINT NOT NULL,
    expected_cash_cents BIGINT,
    counted_cash_cents  BIGINT,
    variance_cents      BIGINT,
    doc                 JSONB NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dash_shifts_opened ON dash_shifts(opened_at)`,
  `CREATE TABLE IF NOT EXISTS dash_cash_moves (
    id           TEXT PRIMARY KEY,
    shift_id     TEXT NOT NULL,
    device_id    TEXT NOT NULL,
    type         TEXT NOT NULL,
    amount_cents BIGINT NOT NULL,
    reason       TEXT NOT NULL,
    by_name      TEXT,
    approved_by  TEXT,
    order_id     TEXT,
    purchase     BOOLEAN NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL,
    deleted      BOOLEAN NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dash_cash_moves_shift ON dash_cash_moves(shift_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dash_cash_moves_created ON dash_cash_moves(created_at)`,
  `CREATE TABLE IF NOT EXISTS dash_drawer_opens (
    id           TEXT PRIMARY KEY,
    shift_id     TEXT,
    device_id    TEXT NOT NULL,
    kind         TEXT NOT NULL,
    reason       TEXT,
    by_name      TEXT,
    approved_by  TEXT,
    order_id     TEXT,
    amount_cents BIGINT,
    outcome      TEXT,
    created_at   TIMESTAMPTZ NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dash_drawer_opens_created ON dash_drawer_opens(created_at)`,
  `CREATE TABLE IF NOT EXISTS dash_stock (
    device_id                TEXT NOT NULL,
    id                       TEXT NOT NULL,
    name                     TEXT NOT NULL,
    unit                     TEXT NOT NULL,
    category                 TEXT,
    on_hand                  DOUBLE PRECISION NOT NULL,
    low_at                   DOUBLE PRECISION,
    price_per_thousand_cents BIGINT,
    price_kind               TEXT,
    key_item                 BOOLEAN NOT NULL,
    batch                    BOOLEAN NOT NULL,
    active                   BOOLEAN NOT NULL,
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS dash_stock_moves (
    id            TEXT PRIMARY KEY,
    device_id     TEXT NOT NULL,
    ingredient_id TEXT NOT NULL,
    ingredient    TEXT NOT NULL,
    delta         DOUBLE PRECISION NOT NULL,
    unit          TEXT NOT NULL,
    reason        TEXT NOT NULL,
    detail        TEXT,
    value_cents   BIGINT,
    order_id      TEXT,
    note          TEXT,
    by_name       TEXT,
    at            TIMESTAMPTZ NOT NULL,
    deleted       BOOLEAN NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dash_stock_moves_at ON dash_stock_moves(at)`,
  `CREATE INDEX IF NOT EXISTS idx_dash_stock_moves_ingredient ON dash_stock_moves(ingredient_id, at)`,
  `CREATE TABLE IF NOT EXISTS dash_menu (
    device_id   TEXT PRIMARY KEY,
    doc         JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS dash_days (
    device_id     TEXT NOT NULL,
    day           DATE NOT NULL,
    shop_wide     BOOLEAN NOT NULL,
    doc           JSONB NOT NULL,
    worked_out_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (device_id, day)
  )`,
];
