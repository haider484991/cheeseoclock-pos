import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, toBool, fromBool, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { recordStockMovement } from './stock-movement-repo.js';
import type {
  Supplier,
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseOrderStatus,
  PurchaseOrderWithItems,
} from '@cheeseoclock/shared-types';

// -----------------------------------------------------------------------------
// Suppliers
// -----------------------------------------------------------------------------

interface SupplierRow {
  id: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  is_active: number;
}

const SUP_SELECT = `id, name, contact_person, phone, email, address, notes, is_active`;

function rowToSupplier(r: SupplierRow): Supplier {
  return {
    id: r.id as Supplier['id'],
    name: r.name,
    contactPerson: r.contact_person,
    phone: r.phone,
    email: r.email,
    address: r.address,
    notes: r.notes,
    isActive: toBool(r.is_active),
  };
}

export function listSuppliers(
  db: AppDatabase,
  opts?: { activeOnly?: boolean },
): Supplier[] {
  const where = opts?.activeOnly
    ? 'WHERE deleted_at IS NULL AND is_active = 1'
    : 'WHERE deleted_at IS NULL';
  const rows = db
    .prepare(`SELECT ${SUP_SELECT} FROM suppliers ${where} ORDER BY name`)
    .all() as SupplierRow[];
  return rows.map(rowToSupplier);
}

export interface CreateSupplierInput {
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
}

export function createSupplier(
  db: AppDatabase,
  input: CreateSupplierInput,
  actor: Actor,
): Supplier {
  const id = uuidv7();
  const now = nowIso();
  const sup: Supplier = {
    id: id as Supplier['id'],
    name: input.name,
    contactPerson: input.contactPerson ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
    notes: input.notes ?? null,
    isActive: true,
  };
  writeWithSync({
    db,
    entityType: 'suppliers',
    entityId: id,
    op: 'upsert',
    action: 'create',
    actor,
    before: null,
    after: sup,
    writeRow: () => {
      db.prepare(
        `INSERT INTO suppliers (id, name, contact_person, phone, email, address, notes, is_active,
                                 created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)`,
      ).run(
        id,
        sup.name,
        sup.contactPerson,
        sup.phone,
        sup.email,
        sup.address,
        sup.notes,
        now,
        now,
        actor.deviceId,
      );
    },
  });
  return sup;
}

export interface UpdateSupplierInput extends Partial<CreateSupplierInput> {
  id: string;
  isActive?: boolean;
}

export function updateSupplier(
  db: AppDatabase,
  input: UpdateSupplierInput,
  actor: Actor,
): Supplier {
  const row = db
    .prepare(`SELECT ${SUP_SELECT} FROM suppliers WHERE id = ? AND deleted_at IS NULL`)
    .get(input.id) as SupplierRow | undefined;
  if (!row) throw new Error('Supplier not found');
  const before = rowToSupplier(row);
  const after: Supplier = {
    ...before,
    name: input.name ?? before.name,
    contactPerson: input.contactPerson !== undefined ? input.contactPerson : before.contactPerson,
    phone: input.phone !== undefined ? input.phone : before.phone,
    email: input.email !== undefined ? input.email : before.email,
    address: input.address !== undefined ? input.address : before.address,
    notes: input.notes !== undefined ? input.notes : before.notes,
    isActive: input.isActive ?? before.isActive,
  };
  const now = nowIso();
  writeWithSync({
    db,
    entityType: 'suppliers',
    entityId: input.id,
    op: 'upsert',
    action: 'update',
    actor,
    before,
    after,
    writeRow: () => {
      db.prepare(
        `UPDATE suppliers SET name = ?, contact_person = ?, phone = ?, email = ?, address = ?,
                              notes = ?, is_active = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(
        after.name,
        after.contactPerson,
        after.phone,
        after.email,
        after.address,
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
// Purchase orders
// -----------------------------------------------------------------------------

interface POrow {
  id: string;
  supplier_id: string;
  reference_no: string | null;
  status: PurchaseOrderStatus;
  ordered_at: string | null;
  expected_at: string | null;
  received_at: string | null;
  total_cents: number;
  notes: string | null;
  created_by_user_id: string;
  received_by_user_id: string | null;
}

const PO_SELECT = `
  id, supplier_id, reference_no, status, ordered_at, expected_at, received_at,
  total_cents, notes, created_by_user_id, received_by_user_id
`;

function rowToPO(r: POrow): PurchaseOrder {
  return {
    id: r.id as PurchaseOrder['id'],
    supplierId: r.supplier_id as PurchaseOrder['supplierId'],
    referenceNo: r.reference_no,
    status: r.status,
    orderedAt: r.ordered_at,
    expectedAt: r.expected_at,
    receivedAt: r.received_at,
    totalCents: r.total_cents,
    notes: r.notes,
    createdByUserId: r.created_by_user_id as PurchaseOrder['createdByUserId'],
    receivedByUserId: r.received_by_user_id as PurchaseOrder['receivedByUserId'],
  };
}

interface POIRow {
  id: string;
  purchase_order_id: string;
  ingredient_id: string;
  qty_ordered: number;
  qty_received: number;
  unit_cost_cents: number;
  line_total_cents: number;
  notes: string | null;
}

const POI_SELECT = `
  id, purchase_order_id, ingredient_id, qty_ordered, qty_received,
  unit_cost_cents, line_total_cents, notes
`;

function rowToPOI(r: POIRow): PurchaseOrderItem {
  return {
    id: r.id as PurchaseOrderItem['id'],
    purchaseOrderId: r.purchase_order_id as PurchaseOrderItem['purchaseOrderId'],
    ingredientId: r.ingredient_id as PurchaseOrderItem['ingredientId'],
    qtyOrdered: r.qty_ordered,
    qtyReceived: r.qty_received,
    unitCostCents: r.unit_cost_cents,
    lineTotalCents: r.line_total_cents,
    notes: r.notes,
  };
}

export function listPurchaseOrders(
  db: AppDatabase,
  opts?: { status?: PurchaseOrderStatus; supplierId?: string; limit?: number },
): PurchaseOrder[] {
  const where: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (opts?.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts?.supplierId) {
    where.push('supplier_id = ?');
    params.push(opts.supplierId);
  }
  const limit = opts?.limit ?? 100;
  const rows = db
    .prepare(
      `SELECT ${PO_SELECT} FROM purchase_orders WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as POrow[];
  return rows.map(rowToPO);
}

export function getPurchaseOrderWithItems(
  db: AppDatabase,
  id: string,
): PurchaseOrderWithItems | null {
  const row = db
    .prepare(`SELECT ${PO_SELECT} FROM purchase_orders WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as POrow | undefined;
  if (!row) return null;
  const items = db
    .prepare(
      `SELECT ${POI_SELECT} FROM purchase_order_items WHERE purchase_order_id = ? AND deleted_at IS NULL`,
    )
    .all(id) as POIRow[];
  return { ...rowToPO(row), items: items.map(rowToPOI) };
}

export interface CreatePurchaseOrderInput {
  supplierId: string;
  referenceNo?: string | null;
  expectedAt?: string | null;
  notes?: string | null;
  items: Array<{ ingredientId: string; qtyOrdered: number; unitCostCents: number; notes?: string | null }>;
}

export function createPurchaseOrder(
  db: AppDatabase,
  input: CreatePurchaseOrderInput,
  actor: Actor & { userId: string },
): PurchaseOrderWithItems {
  if (input.items.length === 0) throw new Error('Purchase order needs at least one line item');
  const poId = uuidv7();
  const now = nowIso();
  const totalCents = input.items.reduce(
    (sum, it) => sum + it.qtyOrdered * it.unitCostCents,
    0,
  );

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO purchase_orders
         (id, supplier_id, reference_no, status, expected_at, total_cents, notes,
          created_by_user_id, created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      poId,
      input.supplierId,
      input.referenceNo ?? null,
      input.expectedAt ?? null,
      totalCents,
      input.notes ?? null,
      actor.userId,
      now,
      now,
      actor.deviceId,
    );
    enqueueSync(db, {
      entityType: 'purchase_orders',
      entityId: poId,
      op: 'upsert',
      payload: { id: poId, supplierId: input.supplierId, status: 'draft', totalCents },
    });

    for (const it of input.items) {
      const itemId = uuidv7();
      const lineTotal = it.qtyOrdered * it.unitCostCents;
      db.prepare(
        `INSERT INTO purchase_order_items
           (id, purchase_order_id, ingredient_id, qty_ordered, qty_received,
            unit_cost_cents, line_total_cents, notes,
            created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        itemId,
        poId,
        it.ingredientId,
        it.qtyOrdered,
        it.unitCostCents,
        lineTotal,
        it.notes ?? null,
        now,
        now,
        actor.deviceId,
      );
      enqueueSync(db, {
        entityType: 'purchase_order_items',
        entityId: itemId,
        op: 'upsert',
        payload: { id: itemId, purchaseOrderId: poId, ...it, lineTotalCents: lineTotal },
      });
    }

    writeAudit(db, {
      entityType: 'purchase_orders',
      entityId: poId,
      action: 'create',
      actorUserId: actor.userId,
      before: null,
      after: { supplierId: input.supplierId, items: input.items, totalCents },
    });
  });
  tx();

  const fetched = getPurchaseOrderWithItems(db, poId);
  if (!fetched) throw new Error('PO vanished after insert');
  return fetched;
}

export function setPurchaseOrderStatus(
  db: AppDatabase,
  id: string,
  status: PurchaseOrderStatus,
  actor: Actor & { userId: string },
): void {
  const now = nowIso();
  db.prepare(
    `UPDATE purchase_orders SET status = ?,
       ordered_at = CASE WHEN status = 'draft' AND ? = 'ordered' THEN ? ELSE ordered_at END,
       updated_at = ?, version = version + 1 WHERE id = ?`,
  ).run(status, status, now, now, id);
  enqueueSync(db, {
    entityType: 'purchase_orders',
    entityId: id,
    op: 'upsert',
    payload: { id, status },
  });
  writeAudit(db, {
    entityType: 'purchase_orders',
    entityId: id,
    action: `status:${status}`,
    actorUserId: actor.userId,
    before: null,
    after: { status },
  });
}

/**
 * Receive a delivery — increments stock for each PO line by qty_received and
 * appends a 'delivery' stock movement. PO status becomes 'received' (or
 * 'partial' if not everything came in).
 */
export interface ReceiveDeliveryInput {
  purchaseOrderId: string;
  receipts: Array<{ purchaseOrderItemId: string; qtyReceivedNow: number }>;
  /** Optionally update cost_per_unit_cents on the ingredient to this delivery's cost. */
  updateCosts?: boolean;
}

export function receiveDelivery(
  db: AppDatabase,
  input: ReceiveDeliveryInput,
  actor: Actor & { userId: string },
): PurchaseOrderWithItems {
  const now = nowIso();
  const tx = db.transaction(() => {
    const po = getPurchaseOrderWithItems(db, input.purchaseOrderId);
    if (!po) throw new Error('Purchase order not found');
    if (po.status === 'received' || po.status === 'cancelled') {
      throw new Error(`Cannot receive into a ${po.status} purchase order`);
    }

    for (const receipt of input.receipts) {
      if (receipt.qtyReceivedNow <= 0) continue;
      const item = po.items.find((i) => i.id === receipt.purchaseOrderItemId);
      if (!item) continue;

      const newReceived = item.qtyReceived + receipt.qtyReceivedNow;
      db.prepare(
        `UPDATE purchase_order_items SET qty_received = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(newReceived, now, item.id);
      enqueueSync(db, {
        entityType: 'purchase_order_items',
        entityId: item.id,
        op: 'upsert',
        payload: { id: item.id, qtyReceived: newReceived },
      });

      // Bump stock + write a movement
      recordStockMovement(
        db,
        {
          ingredientId: item.ingredientId,
          deltaQty: receipt.qtyReceivedNow,
          reason: 'delivery',
          refPurchaseOrderId: input.purchaseOrderId,
          notes: `PO ${po.referenceNo ?? po.id.slice(0, 8)}`,
        },
        actor,
      );

      // Optionally roll the unit cost forward
      if (input.updateCosts) {
        db.prepare(
          `UPDATE ingredients SET cost_per_unit_cents = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        ).run(item.unitCostCents, now, item.ingredientId);
        enqueueSync(db, {
          entityType: 'ingredients',
          entityId: item.ingredientId,
          op: 'upsert',
          payload: { id: item.ingredientId, costPerUnitCents: item.unitCostCents },
        });
      }
    }

    // Recompute fully-received vs partial
    const updated = db
      .prepare(
        `SELECT qty_ordered, qty_received FROM purchase_order_items WHERE purchase_order_id = ? AND deleted_at IS NULL`,
      )
      .all(input.purchaseOrderId) as Array<{ qty_ordered: number; qty_received: number }>;
    const allDone = updated.every((it) => it.qty_received >= it.qty_ordered);
    const any = updated.some((it) => it.qty_received > 0);
    const newStatus: 'received' | 'partial' | 'ordered' = allDone
      ? 'received'
      : any
      ? 'partial'
      : 'ordered';
    db.prepare(
      `UPDATE purchase_orders SET status = ?,
         received_at = CASE WHEN ? = 'received' THEN ? ELSE received_at END,
         received_by_user_id = CASE WHEN ? = 'received' THEN ? ELSE received_by_user_id END,
         updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(newStatus, newStatus, now, newStatus, actor.userId, now, input.purchaseOrderId);
    enqueueSync(db, {
      entityType: 'purchase_orders',
      entityId: input.purchaseOrderId,
      op: 'upsert',
      payload: { id: input.purchaseOrderId, status: newStatus },
    });
    writeAudit(db, {
      entityType: 'purchase_orders',
      entityId: input.purchaseOrderId,
      action: 'receive',
      actorUserId: actor.userId,
      before: null,
      after: { receipts: input.receipts, newStatus },
    });
  });
  tx();

  const final = getPurchaseOrderWithItems(db, input.purchaseOrderId);
  if (!final) throw new Error('PO vanished');
  return final;
}
