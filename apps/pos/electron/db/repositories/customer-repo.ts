import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, toBool, fromBool, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { findOrder } from './order-repo.js';
import { normalizePhone, phoneSearchTerms, resolveAreaText } from '@cheeseoclock/pos-domain';
import type {
  CustomerAddressMatch,
  Customer,
  CustomerAddress,
  CustomerListRow,
  CustomerListSort,
  CustomerWithAddresses,
} from '@cheeseoclock/shared-types';

interface CustRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  loyalty_points: number;
  is_active: number;
  created_at: string;
}

interface AddrRow {
  id: string;
  customer_id: string;
  label: string;
  address_line: string;
  area: string | null;
  city: string | null;
  notes: string | null;
  is_default: number;
}

const CUST_SELECT = `id, name, phone, email, notes, loyalty_points, is_active, created_at`;
const ADDR_SELECT = `id, customer_id, label, address_line, area, city, notes, is_default`;

function rowToCustomer(r: CustRow): Customer {
  return {
    id: r.id as Customer['id'],
    name: r.name,
    phone: r.phone,
    email: r.email,
    notes: r.notes,
    loyaltyPoints: r.loyalty_points,
    isActive: toBool(r.is_active),
    createdAt: r.created_at,
  };
}

function rowToAddress(r: AddrRow): CustomerAddress {
  return {
    id: r.id as CustomerAddress['id'],
    customerId: r.customer_id as CustomerAddress['customerId'],
    label: r.label,
    addressLine: r.address_line,
    area: r.area,
    city: r.city,
    notes: r.notes,
    isDefault: toBool(r.is_default),
  };
}

/** Escape LIKE wildcards in user-typed text; pair with `ESCAPE '\'`. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// -----------------------------------------------------------------------------
// Customer CRUD
// -----------------------------------------------------------------------------

/**
 * WHERE fragment matching a typed name or phone. `col` prefixes the columns
 * ("c." inside a join). With `withAddress`, a house / street typed at the
 * counter ("41-C") finds whoever has it saved.
 */
function customerSearchClause(
  term: string,
  col = '',
  withAddress = false,
): { sql: string; params: unknown[] } {
  const clauses = [`LOWER(${col}name) LIKE ? ESCAPE '\\'`];
  const params: unknown[] = [`%${escapeLike(term.toLowerCase())}%`];
  // Phones are stored canonical ("+923001234567") while cashiers type the
  // local form ("03001234567"), so a raw LIKE on the typed text never
  // matched. Match the normalised number and the stripped digits instead.
  const { canonical, digits } = phoneSearchTerms(term);
  if (canonical) {
    clauses.push(`${col}phone = ?`, `${col}phone LIKE ? ESCAPE '\\'`);
    params.push(canonical, `${escapeLike(canonical)}%`);
  }
  if (digits) {
    clauses.push(`${col}phone LIKE ? ESCAPE '\\'`);
    params.push(`%${digits}%`);
  }
  if (withAddress) {
    clauses.push(
      `EXISTS (SELECT 1 FROM customer_addresses sa
                WHERE sa.customer_id = ${col}id AND sa.deleted_at IS NULL
                  AND LOWER(sa.address_line) LIKE ? ESCAPE '\\')`,
    );
    params.push(`%${escapeLike(term.toLowerCase())}%`);
  }
  return { sql: `(${clauses.join(' OR ')})`, params };
}

export function listCustomers(
  db: AppDatabase,
  opts?: { search?: string; activeOnly?: boolean; limit?: number },
): Customer[] {
  const where: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (opts?.activeOnly) where.push('is_active = 1');
  if (opts?.search && opts.search.trim()) {
    const clause = customerSearchClause(opts.search.trim());
    where.push(clause.sql);
    params.push(...clause.params);
  }
  const limit = opts?.limit ?? 100;
  const rows = db
    .prepare(
      `SELECT ${CUST_SELECT} FROM customers WHERE ${where.join(' AND ')}
        ORDER BY name LIMIT ?`,
    )
    .all(...params, limit) as CustRow[];
  return rows.map(rowToCustomer);
}

export interface PageCustomersOptions {
  search?: string;
  /** Keep customers with a saved address in these delivery zones. */
  zoneIds?: readonly string[];
  sort?: CustomerListSort;
  offset?: number;
  limit?: number;
}

/** Orders that count as the customer's: placed, not open drafts or voids. */
const PLACED_ORDER = `o.customer_id = c.id AND o.deleted_at IS NULL AND o.status NOT IN ('open', 'void')`;

/**
 * The Customers screen: one page plus the total, so the till never renders
 * thousands of rows. Order count / last order come from correlated
 * subqueries served by idx_orders_customer (migration 0025).
 */
export function pageCustomers(
  db: AppDatabase,
  opts: PageCustomersOptions = {},
): { rows: CustomerListRow[]; total: number } {
  const where: string[] = ['c.deleted_at IS NULL'];
  const params: unknown[] = [];
  const term = opts.search?.trim();
  if (term) {
    const clause = customerSearchClause(term, 'c.', true);
    where.push(clause.sql);
    params.push(...clause.params);
  }
  if (opts.zoneIds && opts.zoneIds.length > 0) {
    // Areas are saved as text ("Rahat Commercial, DHA Phase 6", or typed by
    // hand on an older till), so which zone an address is in is worked out
    // with the same reader the area picker uses. There are only as many
    // distinct areas as places people live, so this stays small.
    const wanted = new Set(opts.zoneIds);
    const areas = db
      .prepare(
        `SELECT DISTINCT area FROM customer_addresses
          WHERE deleted_at IS NULL AND area IS NOT NULL AND TRIM(area) != ''`,
      )
      .all() as Array<{ area: string }>;
    const matching = areas
      .map((r) => r.area)
      .filter((area) => {
        const { zoneIds } = resolveAreaText(area);
        return zoneIds.length > 0 && zoneIds.every((z) => wanted.has(z));
      });
    if (matching.length === 0) return { rows: [], total: 0 };
    where.push(
      `EXISTS (SELECT 1 FROM customer_addresses za
                WHERE za.customer_id = c.id AND za.deleted_at IS NULL
                  AND za.area IN (SELECT value FROM json_each(?)))`,
    );
    params.push(JSON.stringify(matching));
  }
  const whereSql = where.join(' AND ');
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM customers c WHERE ${whereSql}`).get(...params) as { n: number }
  ).n;

  const orderBy =
    opts.sort === 'recent'
      ? 'last_order_at IS NULL, last_order_at DESC, c.created_at DESC'
      : opts.sort === 'orders'
        ? 'order_count DESC, c.name COLLATE NOCASE, c.id'
        : 'c.name COLLATE NOCASE, c.id';
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.phone, c.email, c.notes, c.loyalty_points, c.is_active, c.created_at,
              (SELECT COUNT(*) FROM orders o WHERE ${PLACED_ORDER}) AS order_count,
              (SELECT MAX(o.created_at) FROM orders o WHERE ${PLACED_ORDER}) AS last_order_at,
              (SELECT a.area FROM customer_addresses a
                WHERE a.customer_id = c.id AND a.deleted_at IS NULL
                ORDER BY a.is_default DESC, a.updated_at DESC LIMIT 1) AS area
         FROM customers c
        WHERE ${whereSql}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<
    CustRow & { order_count: number; last_order_at: string | null; area: string | null }
  >;
  return {
    rows: rows.map((r) => ({
      ...rowToCustomer(r),
      orderCount: r.order_count,
      lastOrderAt: r.last_order_at,
      area: r.area,
    })),
    total,
  };
}

/**
 * How many saved addresses name each area, busiest first. The till's area
 * picker turns these into per-zone counts so the areas this shop actually
 * delivers to are offered first.
 */
export function listAreaUsage(db: AppDatabase, limit = 300): Array<{ area: string; count: number }> {
  return db
    .prepare(
      `SELECT area, COUNT(*) AS count FROM customer_addresses
        WHERE deleted_at IS NULL AND area IS NOT NULL AND TRIM(area) != ''
        GROUP BY area
        ORDER BY count DESC
        LIMIT ?`,
    )
    .all(Math.min(Math.max(1, limit), 1000)) as Array<{ area: string; count: number }>;
}

export function findCustomer(db: AppDatabase, id: string): Customer | null {
  const row = db
    .prepare(`SELECT ${CUST_SELECT} FROM customers WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as CustRow | undefined;
  return row ? rowToCustomer(row) : null;
}

export function findCustomerByPhone(db: AppDatabase, phone: string): Customer | null {
  // Try the canonical form first (the form we always store), then fall back to
  // raw match for legacy rows that might exist in case the schema pre-dated
  // normalization.
  const canonical = normalizePhone(phone);
  const candidates = canonical ? [canonical, phone.trim()] : [phone.trim()];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const row = db
      .prepare(
        `SELECT ${CUST_SELECT} FROM customers WHERE phone = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(candidate) as CustRow | undefined;
    if (row) return rowToCustomer(row);
  }
  return null;
}

export function getCustomerWithAddresses(
  db: AppDatabase,
  id: string,
): CustomerWithAddresses | null {
  const c = findCustomer(db, id);
  if (!c) return null;
  return { ...c, addresses: listAddresses(db, id) };
}

export interface CreateCustomerInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
}

export function createCustomer(
  db: AppDatabase,
  input: CreateCustomerInput,
  actor: Actor,
): Customer {
  const id = uuidv7();
  const now = nowIso();
  // Normalize the phone to canonical +92 form so we don't create duplicates
  // for the same human (e.g. "0300…" vs "+92 300 …" vs "92300…").
  const normalizedPhone = input.phone ? normalizePhone(input.phone) ?? input.phone.trim() : null;

  // If a customer with this phone already exists, reuse it — the cashier hit
  // create instead of pick due to a race. (UNIQUE index would throw otherwise.)
  if (normalizedPhone) {
    const existing = findCustomerByPhone(db, normalizedPhone);
    if (existing) return existing;
  }

  const cust: Customer = {
    id: id as Customer['id'],
    name: input.name,
    phone: normalizedPhone,
    email: input.email ?? null,
    notes: input.notes ?? null,
    loyaltyPoints: 0,
    isActive: true,
    createdAt: now,
  };
  writeWithSync({
    db,
    entityType: 'customers',
    entityId: id,
    op: 'upsert',
    action: 'create',
    actor,
    before: null,
    after: cust,
    writeRow: () => {
      db.prepare(
        `INSERT INTO customers (id, name, phone, email, notes, loyalty_points, is_active,
                                  created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, 1)`,
      ).run(
        id,
        cust.name,
        cust.phone,
        cust.email,
        cust.notes,
        now,
        now,
        actor.deviceId,
      );
    },
  });
  return cust;
}

export interface UpdateCustomerInput {
  id: string;
  name?: string;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export function updateCustomer(
  db: AppDatabase,
  input: UpdateCustomerInput,
  actor: Actor,
): Customer {
  const row = db
    .prepare(`SELECT ${CUST_SELECT} FROM customers WHERE id = ? AND deleted_at IS NULL`)
    .get(input.id) as CustRow | undefined;
  if (!row) throw new Error('Customer not found');
  const before = rowToCustomer(row);
  const normalizedPhone =
    input.phone !== undefined
      ? input.phone
        ? normalizePhone(input.phone) ?? input.phone.trim()
        : null
      : before.phone;
  const after: Customer = {
    ...before,
    name: input.name ?? before.name,
    phone: normalizedPhone,
    email: input.email !== undefined ? input.email : before.email,
    notes: input.notes !== undefined ? input.notes : before.notes,
    isActive: input.isActive ?? before.isActive,
  };
  const now = nowIso();
  writeWithSync({
    db,
    entityType: 'customers',
    entityId: input.id,
    op: 'upsert',
    action: 'update',
    actor,
    before,
    after,
    writeRow: () => {
      db.prepare(
        `UPDATE customers SET name = ?, phone = ?, email = ?, notes = ?, is_active = ?,
                              updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(
        after.name,
        after.phone,
        after.email,
        after.notes,
        fromBool(after.isActive),
        now,
        input.id,
      );
    },
  });
  return after;
}

// -----------------------------------------------------------------------------
// Addresses
// -----------------------------------------------------------------------------

export function listAddresses(db: AppDatabase, customerId: string): CustomerAddress[] {
  const rows = db
    .prepare(
      `SELECT ${ADDR_SELECT} FROM customer_addresses
        WHERE customer_id = ? AND deleted_at IS NULL
        ORDER BY is_default DESC, label`,
    )
    .all(customerId) as AddrRow[];
  return rows.map(rowToAddress);
}

/**
 * Saved addresses whose house/street starts with what was typed, newest first,
 * with the customer they belong to. House numbers are what regulars are known
 * by at the counter — "41-C" typed once brings back the whole address and the
 * customer behind it.
 */
export function searchAddresses(
  db: AppDatabase,
  query: string,
  limit = 6,
): CustomerAddressMatch[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const rows = db
    .prepare(
      `SELECT a.id, a.customer_id, a.label, a.address_line, a.area, a.city, a.notes, a.is_default,
              c.name AS customer_name, c.phone AS customer_phone
         FROM customer_addresses a
         JOIN customers c ON c.id = a.customer_id
        WHERE a.deleted_at IS NULL AND c.deleted_at IS NULL AND c.is_active = 1
          AND LOWER(a.address_line) LIKE ? ESCAPE '\\'
        ORDER BY a.updated_at DESC
        LIMIT ?`,
    )
    .all(`${escapeLike(q)}%`, Math.min(Math.max(1, limit), 20)) as Array<
    AddrRow & { customer_name: string; customer_phone: string | null }
  >;
  return rows.map((r) => ({
    ...rowToAddress(r),
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
  }));
}

export interface CreateAddressInput {
  customerId: string;
  label?: string;
  addressLine: string;
  area?: string | null;
  city?: string | null;
  notes?: string | null;
  isDefault?: boolean;
}

export function createAddress(
  db: AppDatabase,
  input: CreateAddressInput,
  actor: Actor,
): CustomerAddress {
  // Idempotent: if an address with the same (line, area, city) already exists
  // for this customer, return it instead of creating a duplicate. Without
  // this, every order using the inline customer panel was creating another
  // "Order" record — leading to chips that all looked the same in the picker.
  const normLine = input.addressLine.trim().toLowerCase();
  const normArea = (input.area ?? '').trim().toLowerCase();
  const normCity = (input.city ?? '').trim().toLowerCase();
  const existing = db
    .prepare(
      `SELECT ${ADDR_SELECT} FROM customer_addresses
        WHERE customer_id = ? AND deleted_at IS NULL
          AND LOWER(TRIM(address_line)) = ?
          AND LOWER(TRIM(IFNULL(area, ''))) = ?
          AND LOWER(TRIM(IFNULL(city, ''))) = ?
        LIMIT 1`,
    )
    .get(input.customerId, normLine, normArea, normCity) as AddrRow | undefined;
  if (existing) {
    // Honor a fresh isDefault flag if asked, even on the reused row. This
    // used to be two bare UPDATEs — the default moved on this till but never
    // reached the sync queue or the audit trail.
    if (input.isDefault && existing.is_default !== 1) {
      let after: CustomerAddress = rowToAddress(existing);
      db.transaction(() => {
        after = makeDefaultAddress(db, existing, actor, nowIso());
      })();
      return after;
    }
    return rowToAddress(existing);
  }

  const id = uuidv7();
  const now = nowIso();
  const addr: CustomerAddress = {
    id: id as CustomerAddress['id'],
    customerId: input.customerId as CustomerAddress['customerId'],
    label: input.label ?? 'Home',
    addressLine: input.addressLine,
    area: input.area ?? null,
    city: input.city ?? null,
    notes: input.notes ?? null,
    isDefault: input.isDefault ?? false,
  };

  const tx = db.transaction(() => {
    // If this address is set as default, clear any other defaults for the
    // same customer — each cleared row with its own sync + audit entry.
    if (addr.isDefault) clearOtherDefaults(db, input.customerId, id, actor, now);
    db.prepare(
      `INSERT INTO customer_addresses
         (id, customer_id, label, address_line, area, city, notes, is_default,
          created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      id,
      input.customerId,
      addr.label,
      addr.addressLine,
      addr.area,
      addr.city,
      addr.notes,
      fromBool(addr.isDefault),
      now,
      now,
      actor.deviceId,
    );
    enqueueSync(db, {
      entityType: 'customer_addresses',
      entityId: id,
      op: 'upsert',
      payload: addr,
    });
    writeAudit(db, {
      entityType: 'customer_addresses',
      entityId: id,
      action: 'create',
      actorUserId: actor.userId,
      before: null,
      after: addr,
    });
  });
  tx();
  return addr;
}

/**
 * Inside a transaction: every OTHER default address of this customer stops
 * being the default. Each row that changes gets its own sync post-image and
 * audit entry — a bare multi-row UPDATE moved defaults on this till only.
 */
function clearOtherDefaults(
  db: AppDatabase,
  customerId: string,
  keepId: string,
  actor: Actor,
  now: string,
): void {
  const others = db
    .prepare(
      `SELECT ${ADDR_SELECT} FROM customer_addresses
        WHERE customer_id = ? AND deleted_at IS NULL AND is_default = 1 AND id != ?`,
    )
    .all(customerId, keepId) as AddrRow[];
  for (const o of others) {
    db.prepare(
      `UPDATE customer_addresses SET is_default = 0, updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(now, o.id);
    const before = rowToAddress(o);
    const after: CustomerAddress = { ...before, isDefault: false };
    enqueueSync(db, { entityType: 'customer_addresses', entityId: o.id, op: 'upsert', payload: after });
    writeAudit(db, {
      entityType: 'customer_addresses',
      entityId: o.id,
      action: 'unset_default',
      actorUserId: actor.userId,
      before,
      after,
    });
  }
}

/** Inside a transaction: `row` becomes the customer's one default address. */
function makeDefaultAddress(db: AppDatabase, row: AddrRow, actor: Actor, now: string): CustomerAddress {
  clearOtherDefaults(db, row.customer_id, row.id, actor, now);
  const before = rowToAddress(row);
  const after: CustomerAddress = { ...before, isDefault: true };
  if (before.isDefault) return after;
  db.prepare(
    `UPDATE customer_addresses SET is_default = 1, updated_at = ?, version = version + 1
      WHERE id = ?`,
  ).run(now, row.id);
  enqueueSync(db, { entityType: 'customer_addresses', entityId: row.id, op: 'upsert', payload: after });
  writeAudit(db, {
    entityType: 'customer_addresses',
    entityId: row.id,
    action: 'set_default',
    actorUserId: actor.userId,
    before,
    after,
  });
  return after;
}

export function setDefaultAddress(db: AppDatabase, addressId: string, actor: Actor): void {
  const row = db
    .prepare(
      `SELECT ${ADDR_SELECT} FROM customer_addresses WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(addressId) as AddrRow | undefined;
  if (!row) throw new Error('Address not found');
  db.transaction(() => {
    makeDefaultAddress(db, row, actor, nowIso());
  })();
}

/**
 * Soft-delete a saved address — row, sync entry and audit (with what was
 * deleted) in one transaction. It used to be three separate statements with
 * no transaction and an empty audit "before".
 */
export function deleteAddress(db: AppDatabase, addressId: string, actor: Actor): void {
  const row = db
    .prepare(
      `SELECT ${ADDR_SELECT} FROM customer_addresses WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(addressId) as AddrRow | undefined;
  if (!row) throw new Error('Address not found');
  const now = nowIso();
  writeWithSync({
    db,
    entityType: 'customer_addresses',
    entityId: addressId,
    op: 'delete',
    action: 'delete',
    actor,
    before: rowToAddress(row),
    after: null,
    writeRow: () => {
      db.prepare(
        `UPDATE customer_addresses SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(now, now, addressId);
    },
  });
}

// -----------------------------------------------------------------------------
// Order history
// -----------------------------------------------------------------------------

export interface CustomerOrderHistoryRow {
  orderId: string;
  orderNumber: string;
  createdAt: string;
  mode: string;
  status: string;
  totalCents: number;
}

export function getCustomerOrderHistory(
  db: AppDatabase,
  customerId: string,
  limit = 50,
): CustomerOrderHistoryRow[] {
  return db
    .prepare(
      `SELECT id AS orderId, order_number AS orderNumber, created_at AS createdAt,
              mode, status, total_cents AS totalCents
         FROM orders
        WHERE customer_id = ? AND deleted_at IS NULL AND status <> 'open'
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(customerId, limit) as CustomerOrderHistoryRow[];
}

// -----------------------------------------------------------------------------
// Snapshot helper — used by order tender to freeze customer info onto the order.
// -----------------------------------------------------------------------------

/** The customer-facing part of an order row — the audit before/after image. */
interface OrderCustomerImage {
  id: string;
  status: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  deliveryNotes: string | null;
  version: number;
}

function orderCustomerImage(db: AppDatabase, orderId: string): OrderCustomerImage | null {
  const row = db
    .prepare(
      `SELECT id, status, customer_id, customer_name_snapshot, customer_phone_snapshot,
              delivery_address_snapshot, delivery_notes, version
         FROM orders WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(orderId) as
    | {
        id: string;
        status: string;
        customer_id: string | null;
        customer_name_snapshot: string | null;
        customer_phone_snapshot: string | null;
        delivery_address_snapshot: string | null;
        delivery_notes: string | null;
        version: number;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    customerId: row.customer_id,
    customerName: row.customer_name_snapshot,
    customerPhone: row.customer_phone_snapshot,
    deliveryAddress: row.delivery_address_snapshot,
    deliveryNotes: row.delivery_notes,
    version: row.version,
  };
}

export interface AttachCustomerInput {
  orderId: string;
  customerId: string;
  addressId: string | null;
  /** Omit to leave the notes alone; null clears them. */
  deliveryNotes?: string | null;
  /**
   * Name to freeze onto this order instead of the customer's master name
   * (what the till typed for this one delivery). Only the order snapshot
   * sees it — a tender never rewrites the customer row.
   */
  nameOverride?: string;
}

/**
 * Copy a customer (and optionally one of their saved addresses) onto an order.
 * The snapshot columns are copies, not foreign keys: editing the customer
 * later must not rewrite yesterday's order.
 *
 * A business write like any other — one transaction carrying the row update,
 * the sync post-image and a hash-chained audit row. It used to be a bare
 * UPDATE (and the IPC handler wrote delivery_notes on its own), so attaching a
 * customer never reached the sync queue or the audit trail.
 */
export function snapshotCustomerOntoOrder(
  db: AppDatabase,
  input: AttachCustomerInput,
  actor: Actor,
): void {
  const customer = findCustomer(db, input.customerId);
  if (!customer) throw new Error('Customer not found');
  let addressSnap: string | null = null;
  if (input.addressId) {
    const addr = db
      .prepare(`SELECT ${ADDR_SELECT} FROM customer_addresses WHERE id = ?`)
      .get(input.addressId) as AddrRow | undefined;
    if (addr) {
      addressSnap = JSON.stringify({
        label: addr.label,
        addressLine: addr.address_line,
        area: addr.area,
        city: addr.city,
        notes: addr.notes,
      });
    }
  }
  const tx = db.transaction(() => {
    const before = orderCustomerImage(db, input.orderId);
    if (!before) throw new Error('Order not found');
    const now = nowIso();
    const nameSnap = input.nameOverride?.trim() || customer.name;
    const params: unknown[] = [customer.id, nameSnap, customer.phone, addressSnap];
    let notesClause = '';
    if (input.deliveryNotes !== undefined) {
      notesClause = ', delivery_notes = ?';
      params.push(input.deliveryNotes);
    }
    db.prepare(
      `UPDATE orders SET
          customer_id = ?, customer_name_snapshot = ?, customer_phone_snapshot = ?,
          delivery_address_snapshot = ?${notesClause},
          updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(...params, now, input.orderId);
    enqueueSync(db, {
      entityType: 'orders',
      entityId: input.orderId,
      op: 'upsert',
      payload: findOrder(db, input.orderId),
    });
    writeAudit(db, {
      entityType: 'orders',
      entityId: input.orderId,
      action: 'attach_customer',
      actorUserId: actor.userId,
      before,
      after: orderCustomerImage(db, input.orderId),
    });
  });
  tx();
}

/** Clear the customer snapshot (and delivery notes) from an order. */
export function detachCustomerFromOrder(db: AppDatabase, orderId: string, actor: Actor): void {
  const tx = db.transaction(() => {
    const before = orderCustomerImage(db, orderId);
    if (!before) throw new Error('Order not found');
    db.prepare(
      `UPDATE orders SET
          customer_id = NULL, customer_name_snapshot = NULL, customer_phone_snapshot = NULL,
          delivery_address_snapshot = NULL, delivery_notes = NULL,
          updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(nowIso(), orderId);
    enqueueSync(db, {
      entityType: 'orders',
      entityId: orderId,
      op: 'upsert',
      payload: findOrder(db, orderId),
    });
    writeAudit(db, {
      entityType: 'orders',
      entityId: orderId,
      action: 'detach_customer',
      actorUserId: actor.userId,
      before,
      after: orderCustomerImage(db, orderId),
    });
  });
  tx();
}
