-- cheeseoclock.net — Neon Postgres schema.
-- Run once via `pnpm --filter @cheeseoclock/web db:init` (reads DATABASE_URL).

-- Single-row table holding the latest published menu as JSON. The POS
-- "Publish menu to website" action overwrites it. Keeping it as one JSONB
-- blob (vs normalized tables) is deliberate: the menu is small, the POS is
-- the source of truth, and atomic replace beats partial-update drift.
CREATE TABLE IF NOT EXISTS site_menu (
  id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  menu_json     JSONB NOT NULL,
  published_at  TIMESTAMPTZ NOT NULL
);

-- Whether the shop is taking online orders right now. Single row, written
-- only by the POS bridge heartbeat (PUT /api/bridge/status) and read by the
-- checkout. Defaults to false so a site that has never heard from a till is
-- closed rather than collecting orders nobody is watching. src/lib/
-- store-status.ts also creates this on demand, so an already-provisioned
-- database picks it up without re-running db:init.
CREATE TABLE IF NOT EXISTS store_status (
  id               INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  accepting_orders BOOLEAN NOT NULL DEFAULT false,
  device_id        TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The till announces it can import pickup orders (heartbeat `features`).
ALTER TABLE store_status ADD COLUMN IF NOT EXISTS pickup BOOLEAN NOT NULL DEFAULT false;
-- …and the pickup discount percent it applies (null = a v0.7.0 till: 10%).
ALTER TABLE store_status ADD COLUMN IF NOT EXISTS pickup_discount_pct INT;
-- …and that it bills the website's delivery % at import (heartbeat 'delivery_discount', v0.7.37).
ALTER TABLE store_status ADD COLUMN IF NOT EXISTS delivery_discount BOOLEAN NOT NULL DEFAULT false;

-- Orders placed on the website. The POS bridge polls status='new', imports
-- each into the local SQLite (source='web'), acks with the POS order number,
-- then pushes status updates as the order moves across the Live Orders board.
CREATE TABLE IF NOT EXISTS web_orders (
  id               UUID PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new','accepted','preparing','ready',
                                       'out_for_delivery','delivered','cancelled')),
  customer_name    TEXT NOT NULL,
  customer_phone   TEXT NOT NULL,
  address_line     TEXT NOT NULL,
  area             TEXT,
  notes            TEXT,
  items_json       JSONB NOT NULL,
  subtotal_cents   INT NOT NULL CHECK (subtotal_cents >= 0),
  tax_cents        INT NOT NULL CHECK (tax_cents >= 0),
  total_cents      INT NOT NULL CHECK (total_cents >= 0),
  payment_method   TEXT NOT NULL DEFAULT 'cod' CHECK (payment_method = 'cod'),
  pos_order_id     TEXT,
  pos_order_number TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_orders_status
  ON web_orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_web_orders_phone
  ON web_orders(customer_phone, created_at);

-- Pickup orders (collected from the shop, 10% off). src/lib/web-order-columns.ts
-- also adds these on demand, so an already-provisioned database picks them up.
ALTER TABLE web_orders ADD COLUMN IF NOT EXISTS fulfilment TEXT NOT NULL DEFAULT 'delivery'
  CHECK (fulfilment IN ('delivery','pickup'));
ALTER TABLE web_orders ADD COLUMN IF NOT EXISTS discount_cents INT NOT NULL DEFAULT 0
  CHECK (discount_cents >= 0);
-- Which till is importing a 'new' order (api/bridge/orders GET): two tills
-- polling at once must not both cook it. Also added on demand (web-order-columns).
ALTER TABLE web_orders ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE web_orders ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Append-only counter behind the order endpoint's per-IP flood limit. Only a
-- salted hash is stored, never a raw IP. src/lib/rate-limit.ts also creates
-- this on demand, so an already-provisioned database picks the limit up
-- without re-running db:init; it lives here for fresh installs.
CREATE TABLE IF NOT EXISTS order_rate_events (
  id           BIGSERIAL PRIMARY KEY,
  ip_hash      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_rate_events_ip
  ON order_rate_events(ip_hash, created_at);

-- Cloud copies of the POS SQLite database, uploaded by the bridge on a
-- schedule (daily/weekly/monthly). Stored gzipped + base64. Retention per
-- device: the newest 3, the earliest copy of each of the last 14 days, and
-- every before-restore safety copy for 30 days — a burst of uploads cannot
-- evict history. There is no API to modify or delete a copy.
CREATE TABLE IF NOT EXISTS pos_backups (
  id           UUID PRIMARY KEY,
  device_id    TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  size_bytes   INT NOT NULL,
  data_base64  TEXT NOT NULL,
  -- SHA-256 of the gzip bytes, computed by the server at upload. The POS
  -- refuses to restore a copy whose bytes no longer match it.
  sha256       TEXT,
  -- What the copy says about itself: device name, order count, last sale,
  -- app version, reason (scheduled / manual / before-restore), and the head of
  -- the POS audit hash chain at upload time.
  meta_json    JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Databases created before 0.4.9 (the route also does this lazily):
ALTER TABLE pos_backups ADD COLUMN IF NOT EXISTS sha256 TEXT;
ALTER TABLE pos_backups ADD COLUMN IF NOT EXISTS meta_json JSONB;
-- Chunked copies (0.6.6+, src/lib/backup-store.ts): no blob, just the ordered
-- list of chunk hashes; sha256 is then the SHA-256 of the whole copy (the
-- POS's row export, apps/pos/electron/services/cloud-copy-rows.ts).
ALTER TABLE pos_backups ADD COLUMN IF NOT EXISTS format TEXT;
ALTER TABLE pos_backups ADD COLUMN IF NOT EXISTS chunk_hashes JSONB;
ALTER TABLE pos_backups ALTER COLUMN data_base64 DROP NOT NULL;

-- One row per distinct chunk (named by the SHA-256 of its raw bytes, stored
-- gzipped), shared by every copy that contains it. Chunks no copy refers to
-- are removed a day after their last use.
CREATE TABLE IF NOT EXISTS pos_backup_chunks (
  hash          TEXT PRIMARY KEY,
  size_raw      INT NOT NULL,
  size_stored   INT NOT NULL,
  data          BYTEA NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pos_backups_device
  ON pos_backups(device_id, created_at DESC);

-- Menu files from the costing PC (v0.7.32, src/lib/menu-deploy-store.ts, which
-- also creates these on demand). The PC uploads the generated menu import file
-- with the owner's upload key, and one linked till claims and imports it. The
-- file holds costs and recipes: it lives only in menu_packages.content_gz_b64
-- (gzip of the raw bytes, base64 - text, so its SHA-256 stays true) and is
-- handed out only behind BRIDGE_SECRET, never with the public menu. Later
-- columns only ever through ADD COLUMN IF NOT EXISTS (here and in the store).

-- The one upload key: only its SHA-256. A new key replaces the row.
CREATE TABLE IF NOT EXISTS menu_deploy_key (
  id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  key_hash    TEXT NOT NULL,
  key_hint    TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  device_name TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per uploaded file. state: pending, claimed, applied, failed,
-- refused, superseded (checked in code, no CHECK). Only the newest few keep
-- their file (content_gz_b64 NULL after that).
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
);

CREATE INDEX IF NOT EXISTS idx_menu_packages_state
  ON menu_packages(state, seq);

-- The history: uploads, claims, what each till reported, keys made, wrong
-- keys (with a salted hash of the address, never shown - wrong keys are
-- counted per address and dropped after 30 days).
CREATE TABLE IF NOT EXISTS menu_package_events (
  id          BIGSERIAL PRIMARY KEY,
  package_id  UUID REFERENCES menu_packages(id),
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind        TEXT NOT NULL,
  device_id   TEXT,
  device_name TEXT,
  ip_hash     TEXT,
  detail      JSONB
);

CREATE INDEX IF NOT EXISTS idx_menu_package_events_package
  ON menu_package_events(package_id, at);
CREATE INDEX IF NOT EXISTS idx_menu_package_events_kind
  ON menu_package_events(kind, ip_hash, at);

-- The owner's phone dashboard (shared-types dashboard.ts; v0.7.40). The same
-- statements as apps/web/src/lib/dashboard/schema.ts (a test keeps the two equal):
-- sign-ins (dash_logins, dash_sessions, dash_events) and the tills' figures, written
-- only through POST /api/bridge/dashboard/push.
CREATE TABLE IF NOT EXISTS dash_logins (
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
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_dash_logins_username ON dash_logins(username) WHERE removed_at IS NULL;
CREATE TABLE IF NOT EXISTS dash_sessions (
    token_hash   TEXT PRIMARY KEY,
    login_id     UUID NOT NULL REFERENCES dash_logins(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_agent   TEXT
  );
CREATE INDEX IF NOT EXISTS idx_dash_sessions_login ON dash_sessions(login_id);
CREATE TABLE IF NOT EXISTS dash_events (
    id          BIGSERIAL PRIMARY KEY,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind        TEXT NOT NULL,
    login_id    UUID,
    ip_hash     TEXT,
    device_id   TEXT,
    detail      JSONB
  );
CREATE INDEX IF NOT EXISTS idx_dash_events_kind ON dash_events(kind, ip_hash, at);
CREATE INDEX IF NOT EXISTS idx_dash_events_login ON dash_events(login_id, at);
CREATE TABLE IF NOT EXISTS dash_tills (
    device_id     TEXT PRIMARY KEY,
    device_name   TEXT,
    app_version   TEXT,
    first_push_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_push_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    till_sent_at  TIMESTAMPTZ,
    live          JSONB,
    cursors       JSONB,
    caught_up     BOOLEAN NOT NULL DEFAULT false
  );
CREATE TABLE IF NOT EXISTS dash_orders (
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
  );
CREATE INDEX IF NOT EXISTS idx_dash_orders_day ON dash_orders(trading_day, counted);
CREATE INDEX IF NOT EXISTS idx_dash_orders_created ON dash_orders(created_at);
CREATE INDEX IF NOT EXISTS idx_dash_orders_shift ON dash_orders(shift_id);
CREATE INDEX IF NOT EXISTS idx_dash_orders_status ON dash_orders(status, created_at);
CREATE TABLE IF NOT EXISTS dash_shifts (
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
  );
CREATE INDEX IF NOT EXISTS idx_dash_shifts_opened ON dash_shifts(opened_at);
CREATE TABLE IF NOT EXISTS dash_cash_moves (
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
  );
CREATE INDEX IF NOT EXISTS idx_dash_cash_moves_shift ON dash_cash_moves(shift_id);
CREATE INDEX IF NOT EXISTS idx_dash_cash_moves_created ON dash_cash_moves(created_at);
CREATE TABLE IF NOT EXISTS dash_drawer_opens (
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
  );
CREATE INDEX IF NOT EXISTS idx_dash_drawer_opens_created ON dash_drawer_opens(created_at);
CREATE TABLE IF NOT EXISTS dash_stock (
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
  );
CREATE TABLE IF NOT EXISTS dash_stock_moves (
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
  );
CREATE INDEX IF NOT EXISTS idx_dash_stock_moves_at ON dash_stock_moves(at);
CREATE INDEX IF NOT EXISTS idx_dash_stock_moves_ingredient ON dash_stock_moves(ingredient_id, at);
CREATE TABLE IF NOT EXISTS dash_menu (
    device_id   TEXT PRIMARY KEY,
    doc         JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
CREATE TABLE IF NOT EXISTS dash_days (
    device_id     TEXT NOT NULL,
    day           DATE NOT NULL,
    shop_wide     BOOLEAN NOT NULL,
    doc           JSONB NOT NULL,
    worked_out_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (device_id, day)
  );
