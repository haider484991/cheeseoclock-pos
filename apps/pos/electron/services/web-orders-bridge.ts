import log from 'electron-log/main';
import { BrowserWindow } from 'electron';
import type { AppDatabase } from '../db/connection.js';
import { nowIso } from '../db/repositories/base.js';
import {
  createOrder,
  addOrderItem,
  sendOrderToKitchen,
  findOrder,
  getOrderSnapshot,
} from '../db/repositories/order-repo.js';
import {
  createCustomer,
  createAddress,
  snapshotCustomerOntoOrder,
} from '../db/repositories/customer-repo.js';
import { printSpooler } from './print-spooler.js';
import {
  getWebBridgeConfig,
  isWebBridgeReady,
  type WebBridgeConfig,
} from './web-bridge-config.js';
import { getReceiptBranding } from './printer-config.js';
import type {
  PublishedMenu,
  PublishedMenuCategory,
  WebOrder,
  WebOrderStatus,
  OrderStatus,
} from '@cheeseoclock/shared-types';

/**
 * Web orders bridge — connects this POS to cheeseoclock.net.
 *
 * Inbound (every poll tick):
 *   1. GET {site}/api/bridge/orders → list of status='new' web orders
 *   2. For each: import locally (mode 'delivery', source 'web'), attach the
 *      customer (created/reused by phone), add items, send to kitchen so it
 *      lands on the Live Orders board, print a kitchen copy, then ACK.
 *      Idempotent via the web_order_imports table — a re-poll after a
 *      half-failed ack can't double-import.
 *
 * Outbound (same tick):
 *   3. For every imported order whose POS status maps to a different
 *      web-facing status than we last pushed → POST .../status so the
 *      customer's tracking page moves.
 *
 * Also owns "Publish menu" — serializes the active menu (categories, items,
 * modifiers, tax rates, images) and PUTs it to the site.
 */

const MAX_IMPORT_ATTEMPTS = 5;
/** The bridge's writes are attributed to this synthetic actor in audit logs. */
const WEB_ACTOR_NAME = 'web-bridge';

interface BridgeStatus {
  enabled: boolean;
  ready: boolean;
  lastPollAt: string | null;
  lastError: string | null;
  importedTotal: number;
  consecutiveFails: number;
}

class WebOrdersBridge {
  private db: AppDatabase | null = null;
  private deviceId = '';
  private systemUserId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private importedTotal = 0;
  private consecutiveFails = 0;

  init(db: AppDatabase, deviceId: string): void {
    this.db = db;
    this.deviceId = deviceId;
    this.reschedule();
  }

  /** Re-read config and restart the polling loop (after settings change). */
  reschedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.db) return;
    const cfg = getWebBridgeConfig(this.db);
    if (!cfg.enabled || !isWebBridgeReady(cfg).ok) return;
    this.timer = setInterval(() => void this.tick(), cfg.pollIntervalMs);
    void this.tick();
  }

  status(): BridgeStatus {
    const cfg = this.db ? getWebBridgeConfig(this.db) : null;
    return {
      enabled: cfg?.enabled ?? false,
      ready: cfg ? isWebBridgeReady(cfg).ok : false,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      importedTotal: this.importedTotal,
      consecutiveFails: this.consecutiveFails,
    };
  }

  kick(): void {
    void this.tick();
  }

  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.running || !this.db) return;
    const cfg = getWebBridgeConfig(this.db);
    if (!cfg.enabled || !isWebBridgeReady(cfg).ok) return;
    this.running = true;
    try {
      await this.pullNewOrders(cfg);
      await this.pushStatusUpdates(cfg);
      this.lastPollAt = nowIso();
      this.lastError = null;
      this.consecutiveFails = 0;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.consecutiveFails += 1;
      // Quiet warn — network blips are normal on shop Wi-Fi.
      log.warn('Web bridge tick failed', { error: this.lastError });
    } finally {
      this.running = false;
    }
  }

  private async api(
    cfg: WebBridgeConfig,
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const res = await fetch(`${cfg.siteUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.bridgeSecret}`,
        ...(init?.headers ?? {}),
      },
    });
    return res;
  }

  /**
   * Resolve the actor for bridge-created records. Web orders need a
   * cashier_id (FK to users) — we use the first active admin as the
   * system actor. Cached after first lookup.
   */
  private resolveActor(): { userId: string; deviceId: string } | null {
    if (!this.db) return null;
    if (!this.systemUserId) {
      const row = this.db
        .prepare(
          `SELECT id FROM users
            WHERE is_active = 1 AND deleted_at IS NULL
            ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END
            LIMIT 1`,
        )
        .get() as { id: string } | undefined;
      this.systemUserId = row?.id ?? null;
    }
    if (!this.systemUserId) return null;
    return { userId: this.systemUserId, deviceId: this.deviceId };
  }

  // ---- inbound ------------------------------------------------------------

  private async pullNewOrders(cfg: WebBridgeConfig): Promise<void> {
    if (!this.db) return;
    const res = await this.api(cfg, '/api/bridge/orders');
    if (!res.ok) throw new Error(`Pull failed: HTTP ${res.status}`);
    const json = (await res.json()) as { ok: boolean; data?: WebOrder[] };
    if (!json.ok || !json.data) throw new Error('Pull failed: bad response');

    for (const order of json.data) {
      await this.importOne(cfg, order);
    }
  }

  private async importOne(cfg: WebBridgeConfig, web: WebOrder): Promise<void> {
    const db = this.db!;
    const now = nowIso();

    // Idempotency: skip anything we've already imported (or permanently failed).
    const existing = db
      .prepare(`SELECT pos_order_id, status, attempts FROM web_order_imports WHERE web_order_id = ?`)
      .get(web.id) as
      | { pos_order_id: string | null; status: string; attempts: number }
      | undefined;
    if (existing?.pos_order_id) {
      // Imported before but the ack may have failed — re-ack and move on.
      const local = findOrder(db, existing.pos_order_id);
      if (local) {
        await this.api(cfg, `/api/bridge/orders/${web.id}/ack`, {
          method: 'POST',
          body: JSON.stringify({
            posOrderId: local.id,
            posOrderNumber: local.orderNumber,
          }),
        }).catch(() => undefined);
      }
      return;
    }
    if (existing && existing.status === 'failed') return;
    if (existing && existing.attempts >= MAX_IMPORT_ATTEMPTS) {
      db.prepare(
        `UPDATE web_order_imports SET status = 'failed', updated_at = ? WHERE web_order_id = ?`,
      ).run(now, web.id);
      // Tell the site so the customer isn't watching a dead tracker.
      await this.api(cfg, `/api/bridge/orders/${web.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'cancelled' }),
      }).catch(() => undefined);
      notifyRenderer('web-order:import-failed', { webOrderId: web.id });
      return;
    }

    const actor = this.resolveActor();
    if (!actor) {
      log.warn('Web bridge: no active admin/manager user to attribute orders to');
      return;
    }

    // Record the attempt BEFORE importing so a crash mid-import is visible.
    db.prepare(
      `INSERT INTO web_order_imports (web_order_id, attempts, created_at, updated_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(web_order_id) DO UPDATE SET
         attempts = web_order_imports.attempts + 1, updated_at = excluded.updated_at`,
    ).run(web.id, now, now);

    try {
      // 1. Local order shell (delivery, source web).
      const order = createOrder(
        db,
        {
          mode: 'delivery',
          source: 'web',
          notes: web.notes ? `[web] ${web.notes}` : '[web order]',
        },
        actor,
      );

      // 2. Customer + address (both dedupe internally).
      const customer = createCustomer(
        db,
        { name: web.customerName, phone: web.customerPhone },
        actor,
      );
      const address = createAddress(
        db,
        {
          customerId: customer.id,
          label: 'Web order',
          addressLine: web.addressLine,
          area: web.area ?? null,
        },
        actor,
      );
      snapshotCustomerOntoOrder(db, order.id, customer.id, address.id);

      // 3. Items. POS re-prices from its own menu (authoritative). If an item
      //    vanished from the menu since publish, the whole import throws and
      //    retries — after MAX_IMPORT_ATTEMPTS it's cancelled with a notice.
      for (const line of web.items) {
        addOrderItem(
          db,
          {
            orderId: order.id,
            menuItemId: line.posItemId,
            quantity: line.quantity,
            modifierIds: line.modifiers.map((m) => m.posModifierId),
            notes: line.notes,
          },
          actor,
        );
      }

      // 4. Onto the Live Orders board (also validates customer/address).
      sendOrderToKitchen(db, order.id, actor);

      // 5. Kitchen copy so the team sees a paper ticket for web orders too.
      printSpooler.enqueueReceipt(order.id, false);

      db.prepare(
        `UPDATE web_order_imports
            SET pos_order_id = ?, status = 'imported', imported_at = ?,
                last_pushed_status = 'accepted', updated_at = ?
          WHERE web_order_id = ?`,
      ).run(order.id, now, now, web.id);
      this.importedTotal += 1;

      // 6. Ack to the site (flips 'new' → 'accepted').
      await this.api(cfg, `/api/bridge/orders/${web.id}/ack`, {
        method: 'POST',
        body: JSON.stringify({
          posOrderId: order.id,
          posOrderNumber: order.orderNumber,
        }),
      });

      log.info('Web order imported', {
        webOrderId: web.id,
        posOrder: order.orderNumber,
        totalCents: getOrderSnapshot(db, order.id)?.order.totalCents,
      });
      notifyRenderer('web-order:received', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerName: web.customerName,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      db.prepare(
        `UPDATE web_order_imports SET last_error = ?, updated_at = ? WHERE web_order_id = ?`,
      ).run(message, nowIso(), web.id);
      log.warn('Web order import failed (will retry)', { webOrderId: web.id, message });
    }
  }

  // ---- outbound -----------------------------------------------------------

  private async pushStatusUpdates(cfg: WebBridgeConfig): Promise<void> {
    const db = this.db!;
    const rows = db
      .prepare(
        `SELECT wi.web_order_id, wi.last_pushed_status, o.status AS pos_status
           FROM web_order_imports wi
           JOIN orders o ON o.id = wi.pos_order_id
          WHERE wi.status = 'imported'
            -- Stop tracking once the customer-facing journey is over.
            AND IFNULL(wi.last_pushed_status, '') NOT IN ('delivered', 'cancelled')`,
      )
      .all() as Array<{
      web_order_id: string;
      last_pushed_status: string | null;
      pos_status: OrderStatus;
    }>;

    for (const row of rows) {
      const webStatus = mapPosStatusToWeb(row.pos_status);
      if (!webStatus || webStatus === row.last_pushed_status) continue;
      const res = await this.api(cfg, `/api/bridge/orders/${row.web_order_id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: webStatus }),
      });
      if (res.ok) {
        db.prepare(
          `UPDATE web_order_imports SET last_pushed_status = ?, updated_at = ? WHERE web_order_id = ?`,
        ).run(webStatus, nowIso(), row.web_order_id);
      }
    }
  }

  // ---- menu publish -------------------------------------------------------

  async publishMenu(): Promise<{ categories: number; items: number }> {
    if (!this.db) throw new Error('Bridge not initialized');
    const cfg = getWebBridgeConfig(this.db);
    const ready = isWebBridgeReady(cfg);
    if (!ready.ok) throw new Error(`Configure first: ${ready.missing.join(', ')}`);

    const menu = buildPublishedMenu(this.db);
    const res = await this.api(cfg, '/api/bridge/menu', {
      method: 'PUT',
      body: JSON.stringify(menu),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Publish failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const itemCount = menu.categories.reduce((s, c) => s + c.items.length, 0);
    log.info('Menu published to website', {
      categories: menu.categories.length,
      items: itemCount,
    });
    return { categories: menu.categories.length, items: itemCount };
  }
}

// ---------------------------------------------------------------------------

function mapPosStatusToWeb(pos: OrderStatus): Exclude<WebOrderStatus, 'new'> | null {
  switch (pos) {
    case 'open':
    case 'sent_to_kitchen':
      return 'accepted';
    case 'preparing':
      return 'preparing';
    case 'ready':
      return 'ready';
    case 'out_for_delivery':
      return 'out_for_delivery';
    case 'delivered':
    case 'served':
    case 'paid':
      return 'delivered';
    case 'void':
    case 'refunded':
      return 'cancelled';
    default:
      return null;
  }
}

/**
 * Serialize the active menu for the website. Read-only — direct SELECTs are
 * fine here (the repositories rule covers writes).
 *
 * Images: data-URLs over ~300KB are dropped (null) so a handful of photos
 * can't blow past Vercel's request-body limit.
 */
function buildPublishedMenu(db: AppDatabase): PublishedMenu {
  const MAX_IMAGE_CHARS = 300_000;
  const branding = getReceiptBranding(db);

  const categories = db
    .prepare(
      `SELECT id, name, display_order FROM categories
        WHERE deleted_at IS NULL AND is_active = 1
        ORDER BY display_order`,
    )
    .all() as Array<{ id: string; name: string; display_order: number }>;

  const items = db
    .prepare(
      `SELECT mi.id, mi.category_id, mi.name, mi.description, mi.base_price_cents,
              mi.image_url, mi.sort_order, IFNULL(tc.rate_bps, 0) AS rate_bps
         FROM menu_items mi
         LEFT JOIN tax_categories tc ON tc.id = mi.tax_category_id AND tc.deleted_at IS NULL
        WHERE mi.deleted_at IS NULL AND mi.is_active = 1
        ORDER BY mi.sort_order`,
    )
    .all() as Array<{
    id: string;
    category_id: string;
    name: string;
    description: string | null;
    base_price_cents: number;
    image_url: string | null;
    sort_order: number;
    rate_bps: number;
  }>;

  const itemGroups = db
    .prepare(
      `SELECT mig.menu_item_id, mig.sort_order AS group_sort,
              mg.id AS group_id, mg.name AS group_name, mg.selection_type,
              mg.min_select, mg.max_select, mg.is_required
         FROM menu_item_modifier_groups mig
         JOIN modifier_groups mg ON mg.id = mig.modifier_group_id AND mg.deleted_at IS NULL
        WHERE mig.deleted_at IS NULL
        ORDER BY mig.sort_order`,
    )
    .all() as Array<{
    menu_item_id: string;
    group_sort: number;
    group_id: string;
    group_name: string;
    selection_type: 'single' | 'multi';
    min_select: number;
    max_select: number;
    is_required: number;
  }>;

  const modifiers = db
    .prepare(
      `SELECT id, modifier_group_id, name, price_delta_cents, is_default, sort_order
         FROM modifiers WHERE deleted_at IS NULL ORDER BY sort_order`,
    )
    .all() as Array<{
    id: string;
    modifier_group_id: string;
    name: string;
    price_delta_cents: number;
    is_default: number;
    sort_order: number;
  }>;

  const modsByGroup = new Map<string, typeof modifiers>();
  for (const m of modifiers) {
    const arr = modsByGroup.get(m.modifier_group_id) ?? [];
    arr.push(m);
    modsByGroup.set(m.modifier_group_id, arr);
  }
  const groupsByItem = new Map<string, typeof itemGroups>();
  for (const g of itemGroups) {
    const arr = groupsByItem.get(g.menu_item_id) ?? [];
    arr.push(g);
    groupsByItem.set(g.menu_item_id, arr);
  }

  const publishedCategories: PublishedMenuCategory[] = categories
    .map((c) => ({
      posCategoryId: c.id,
      name: c.name,
      displayOrder: c.display_order,
      items: items
        .filter((i) => i.category_id === c.id)
        .map((i) => ({
          posItemId: i.id,
          name: i.name,
          description: i.description,
          basePriceCents: i.base_price_cents,
          taxRateBps: i.rate_bps,
          imageUrl:
            i.image_url && i.image_url.length <= MAX_IMAGE_CHARS ? i.image_url : null,
          sortOrder: i.sort_order,
          modifierGroups: (groupsByItem.get(i.id) ?? []).map((g) => ({
            posGroupId: g.group_id,
            name: g.group_name,
            selectionType: g.selection_type,
            minSelect: g.min_select,
            maxSelect: g.max_select,
            isRequired: g.is_required === 1,
            sortOrder: g.group_sort,
            modifiers: (modsByGroup.get(g.group_id) ?? []).map((m) => ({
              posModifierId: m.id,
              name: m.name,
              priceDeltaCents: m.price_delta_cents,
              isDefault: m.is_default === 1,
              sortOrder: m.sort_order,
            })),
          })),
        })),
    }))
    .filter((c) => c.items.length > 0);

  return {
    categories: publishedCategories,
    publishedAt: nowIso(),
    store: {
      name: branding.storeName,
      phone: branding.phoneLine ?? null,
      whatsapp: null,
      addressLine: branding.branchLine ?? null,
      tagline: branding.storeTagline ?? null,
    },
  };
}

function notifyRenderer(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(channel, payload);
  }
}

export const webOrdersBridge = new WebOrdersBridge();
void WEB_ACTOR_NAME; // reserved: future dedicated system-user row
