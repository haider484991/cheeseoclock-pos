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

-- Cloud copies of the POS SQLite database, uploaded by the bridge on a
-- schedule (daily/weekly/monthly). Stored gzipped + base64. The upload
-- endpoint rotates: only the newest N per device are kept, so a small
-- free-tier Postgres comfortably holds months of disaster-recovery points.
CREATE TABLE IF NOT EXISTS pos_backups (
  id           UUID PRIMARY KEY,
  device_id    TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  size_bytes   INT NOT NULL,
  data_base64  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pos_backups_device
  ON pos_backups(device_id, created_at DESC);
