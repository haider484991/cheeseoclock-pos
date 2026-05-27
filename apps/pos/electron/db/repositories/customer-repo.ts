import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, toBool, fromBool, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { normalizePhone } from '@cheeseoclock/pos-domain';
import type {
  Customer,
  CustomerAddress,
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

// -----------------------------------------------------------------------------
// Customer CRUD
// -----------------------------------------------------------------------------

export function listCustomers(
  db: AppDatabase,
  opts?: { search?: string; activeOnly?: boolean; limit?: number },
): Customer[] {
  const where: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (opts?.activeOnly) where.push('is_active = 1');
  if (opts?.search && opts.search.trim()) {
    where.push('(LOWER(name) LIKE ? OR phone LIKE ?)');
    const q = `%${opts.search.trim().toLowerCase()}%`;
    params.push(q, q);
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
    // Honor a fresh isDefault flag if asked, even on the reused row.
    if (input.isDefault) {
      const now = nowIso();
      db.prepare(
        `UPDATE customer_addresses SET is_default = 0, updated_at = ?, version = version + 1
          WHERE customer_id = ? AND deleted_at IS NULL AND id != ?`,
      ).run(now, input.customerId, existing.id);
      db.prepare(
        `UPDATE customer_addresses SET is_default = 1, updated_at = ?, version = version + 1
          WHERE id = ?`,
      ).run(now, existing.id);
      return { ...rowToAddress(existing), isDefault: true };
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
    // If this address is set as default, clear any other defaults for the same customer.
    if (addr.isDefault) {
      db.prepare(
        `UPDATE customer_addresses SET is_default = 0, updated_at = ?, version = version + 1
          WHERE customer_id = ? AND deleted_at IS NULL`,
      ).run(now, input.customerId);
    }
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

export function setDefaultAddress(db: AppDatabase, addressId: string, actor: Actor): void {
  const row = db
    .prepare(
      `SELECT ${ADDR_SELECT} FROM customer_addresses WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(addressId) as AddrRow | undefined;
  if (!row) throw new Error('Address not found');
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE customer_addresses SET is_default = 0, updated_at = ?, version = version + 1
        WHERE customer_id = ? AND deleted_at IS NULL`,
    ).run(now, row.customer_id);
    db.prepare(
      `UPDATE customer_addresses SET is_default = 1, updated_at = ?, version = version + 1
        WHERE id = ?`,
    ).run(now, addressId);
    enqueueSync(db, {
      entityType: 'customer_addresses',
      entityId: addressId,
      op: 'upsert',
      payload: { id: addressId, isDefault: true, customerId: row.customer_id },
    });
    writeAudit(db, {
      entityType: 'customer_addresses',
      entityId: addressId,
      action: 'set_default',
      actorUserId: actor.userId,
      before: null,
      after: { isDefault: true },
    });
  });
  tx();
}

export function deleteAddress(db: AppDatabase, addressId: string, actor: Actor): void {
  const now = nowIso();
  db.prepare(
    `UPDATE customer_addresses SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
  ).run(now, now, addressId);
  enqueueSync(db, {
    entityType: 'customer_addresses',
    entityId: addressId,
    op: 'delete',
    payload: { id: addressId, deletedAt: now },
  });
  writeAudit(db, {
    entityType: 'customer_addresses',
    entityId: addressId,
    action: 'delete',
    actorUserId: actor.userId,
    before: null,
    after: null,
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
        WHERE customer_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(customerId, limit) as CustomerOrderHistoryRow[];
}

// -----------------------------------------------------------------------------
// Snapshot helper — used by order tender to freeze customer info onto the order.
// -----------------------------------------------------------------------------

export function snapshotCustomerOntoOrder(
  db: AppDatabase,
  orderId: string,
  customerId: string,
  addressId: string | null,
): void {
  const customer = findCustomer(db, customerId);
  if (!customer) return;
  let addressSnap: string | null = null;
  if (addressId) {
    const addr = db
      .prepare(`SELECT ${ADDR_SELECT} FROM customer_addresses WHERE id = ?`)
      .get(addressId) as AddrRow | undefined;
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
  const now = nowIso();
  db.prepare(
    `UPDATE orders SET
        customer_id = ?, customer_name_snapshot = ?, customer_phone_snapshot = ?,
        delivery_address_snapshot = ?, updated_at = ?, version = version + 1
      WHERE id = ?`,
  ).run(customerId, customer.name, customer.phone, addressSnap, now, orderId);
}
