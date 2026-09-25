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
