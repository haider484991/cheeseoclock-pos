import { v7 as uuidv7 } from 'uuid';
import type { AppDatabase } from '../connection.js';
import { writeWithSync, nowIso, toBool, fromBool, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { recordStockMovement } from './stock-movement-repo.js';
import { setIngredientPrice } from './ingredient-cost-repo.js';
import { evaluatePriceAlerts, type PriceWritten } from './cost-alert-repo.js';
import { getBusinessSetting } from '../business-settings-read.js';
import { findCashMovement, getCurrentShift, linkPayoutToPurchase, recordCashMovement } from './shift-repo.js';
import { loadPriceBook } from '../price-book.js';
import {
  DEFAULT_ALERT_JUMP_BPS,
  billPack,
  checkBillPrice,
  costPerUnitFromPack,
  effectivePack,
  orderedValueCents,
  typedPricePack,
  unitCostMc,
  usesBillPrice,
  usualPackSize,
  valueCents,
  type Pack,
  type PriceCheckWhy,
  type TypedPrice,
} from '@cheeseoclock/pos-domain';
import type {
  Supplier,
  PurchaseKind,
  PurchaseOrder,
  PurchaseOrderItem,
  PurchaseOrderStatus,
  PurchaseOrderWithItems,
  PurchasePayout,
  RecordPurchaseResult,
  UUID,
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
// Purchase orders and purchases (costing spec Phase 5, migration 0035)
// -----------------------------------------------------------------------------

interface POrow {
  id: string;
  supplier_id: string | null;
  reference_no: string | null;
  status: PurchaseOrderStatus;
  ordered_at: string | null;
  expected_at: string | null;
  received_at: string | null;
  total_cents: number;
  notes: string | null;
  created_by_user_id: string;
  received_by_user_id: string | null;
  invoice_no: string | null;
  kind: string;
  billed_cents: number | null;
}

/**
 * A purchase's columns, plus what its bills came to so far (the lines'
 * received_value_cents, idx_poi_by_po): the figure the Purchases list shows for
 * anything received. Only ever read FROM purchase_orders (unaliased).
 */
const PO_SELECT = `
  id, supplier_id, reference_no, status, ordered_at, expected_at, received_at,
  total_cents, notes, created_by_user_id, received_by_user_id, invoice_no, kind,
  (SELECT COALESCE(SUM(i.received_value_cents), 0) FROM purchase_order_items i
    WHERE i.purchase_order_id = purchase_orders.id AND i.deleted_at IS NULL) AS billed_cents
`;

/** A stored kind as the type; anything unknown (a newer till's value) reads as a purchase order. */
function toPurchaseKind(v: string | null | undefined): PurchaseKind {
  return v === 'quick' ? 'quick' : 'order';
}

function rowToPO(r: POrow): PurchaseOrder {
  return {
    id: r.id as PurchaseOrder['id'],
    supplierId: r.supplier_id as PurchaseOrder['supplierId'],
    referenceNo: r.reference_no,
    status: r.status,
    orderedAt: r.ordered_at,
    expectedAt: r.expected_at,
    receivedAt: r.received_at,
    totalCents: Number(r.total_cents),
    notes: r.notes,
    createdByUserId: r.created_by_user_id as PurchaseOrder['createdByUserId'],
    receivedByUserId: r.received_by_user_id as PurchaseOrder['receivedByUserId'],
    invoiceNo: r.invoice_no,
    kind: toPurchaseKind(r.kind),
    billedCents: Number(r.billed_cents ?? 0),
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
  ordered_pack_size: number | null;
  ordered_pack_price_cents: number | null;
  received_value_cents: number;
}

const POI_SELECT = `
  id, purchase_order_id, ingredient_id, qty_ordered, qty_received,
  unit_cost_cents, line_total_cents, notes,
  ordered_pack_size, ordered_pack_price_cents, received_value_cents
`;

function rowToPOI(r: POIRow): PurchaseOrderItem {
  return {
    id: r.id as PurchaseOrderItem['id'],
    purchaseOrderId: r.purchase_order_id as PurchaseOrderItem['purchaseOrderId'],
    ingredientId: r.ingredient_id as PurchaseOrderItem['ingredientId'],
    qtyOrdered: Number(r.qty_ordered),
    qtyReceived: Number(r.qty_received),
    unitCostCents: Number(r.unit_cost_cents),
    lineTotalCents: Number(r.line_total_cents),
    notes: r.notes,
    orderedPackSize: r.ordered_pack_size === null ? null : Number(r.ordered_pack_size),
    orderedPackPriceCents: r.ordered_pack_price_cents === null ? null : Number(r.ordered_pack_price_cents),
    receivedValueCents: Number(r.received_value_cents ?? 0),
  };
}

/**
 * Purchase orders and purchases, newest first. `open`: only those still
 * open (draft, ordered, part received) — the Purchases screen fetches these
 * on their own, so an order still to be received never drops off a list
 * capped at the newest N (idx_pos_status_ordered).
 */
export function listPurchaseOrders(
  db: AppDatabase,
  opts?: { status?: PurchaseOrderStatus; open?: boolean; supplierId?: string; limit?: number },
): PurchaseOrder[] {
  const where: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (opts?.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts?.open === true) where.push(`status IN ('draft', 'ordered', 'partial')`);
  if (opts?.supplierId) {
    where.push('supplier_id = ?');
    params.push(opts.supplierId);
  }
  const limit = opts?.limit ?? 100;
  const rows = db
    .prepare(
      `SELECT ${PO_SELECT} FROM purchase_orders WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit) as POrow[];
  return rows.map(rowToPO);
}

/** The drawer payout that paid for a purchase, if any (idx_cash_movements_purchase). */
function payoutOf(db: AppDatabase, purchaseOrderId: string): PurchasePayout | null {
  const r = db
    .prepare(
      `SELECT id, shift_id, amount_cents, reason, created_at FROM cash_movements
        WHERE ref_purchase_order_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
    )
    .get(purchaseOrderId) as { id: string; shift_id: string; amount_cents: number; reason: string; created_at: string } | undefined;
  return r
    ? {
        cashMovementId: r.id as PurchasePayout['cashMovementId'],
        shiftId: r.shift_id as PurchasePayout['shiftId'],
        amountCents: Number(r.amount_cents),
        reason: r.reason,
        createdAt: r.created_at,
      }
    : null;
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
      `SELECT ${POI_SELECT} FROM purchase_order_items WHERE purchase_order_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid`,
    )
    .all(id) as POIRow[];
  return { ...rowToPO(row), items: items.map(rowToPOI), payout: payoutOf(db, id) };
}

interface IngredientPriceRow {
  name: string;
  unit: string;
  cost_per_unit_cents: number;
  pack_size: number | null;
  pack_price_cents: number | null;
}

function readIngredient(db: AppDatabase, id: string): IngredientPriceRow {
  const r = db
    .prepare(`SELECT name, unit, cost_per_unit_cents, pack_size, pack_price_cents FROM ingredients WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as IngredientPriceRow | undefined;
  if (!r) throw new Error('One of the ingredients is no longer in Inventory');
  return r;
}

function readSupplierName(db: AppDatabase, id: string): string {
  const r = db.prepare(`SELECT name FROM suppliers WHERE id = ? AND deleted_at IS NULL`).get(id) as { name: string } | undefined;
  if (!r) throw new Error('That supplier is no longer on file');
  return r.name;
}

export interface CreatePurchaseOrderInput {
  supplierId: string;
  referenceNo?: string | null;
  expectedAt?: string | null;
  notes?: string | null;
  items: Array<{
    ingredientId: string;
    qtyOrdered: number;
    /** The price as it is bought: Rs X per kg / litre, for a pack of N, or per piece (kept exactly). */
    price?: TypedPrice;
    /** Or, the older way, a price per base unit in whole paisa. */
    unitCostCents?: number;
    notes?: string | null;
  }>;
}

/**
 * A purchase order (kind 'order'), saved as a draft. Each line keeps the
 * price it was ordered at EXACTLY, as the pack it was typed in ("Rs 375 per
 * kg" = 1,000 g for Rs 375), and what it comes to, rounded once. The price
 * per unit in whole paisa is kept too, for older screens only. One
 * transaction; the order and each line sync, the order is audited.
 */
export function createPurchaseOrder(
  db: AppDatabase,
  input: CreatePurchaseOrderInput,
  actor: Actor & { userId: string },
): PurchaseOrderWithItems {
  if (input.items.length === 0) throw new Error('Purchase order needs at least one line item');
  const poId = uuidv7();
  const now = nowIso();

  const tx = db.transaction(() => {
    const lines = input.items.map((it) => {
      const ing = readIngredient(db, it.ingredientId);
      let pack: Pack;
      if (it.price) pack = typedPricePack(it.price, ing.unit);
      else if (it.unitCostCents !== undefined && Number.isSafeInteger(it.unitCostCents) && it.unitCostCents >= 0) {
        pack = { size: 1, priceCents: it.unitCostCents };
      } else throw new Error(`Give ${ing.name} a price: per kg, per pack or per piece`);
      if (!Number.isSafeInteger(it.qtyOrdered) || it.qtyOrdered < 1) throw new Error(`Order at least 1 ${ing.unit} of ${ing.name}`);
      return {
        ...it,
        pack,
        unitCostCents: costPerUnitFromPack(pack.priceCents, pack.size),
        lineTotalCents: valueCents(it.qtyOrdered, pack),
      };
    });
    const totalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
    db.prepare(
      `INSERT INTO purchase_orders
         (id, supplier_id, reference_no, status, expected_at, total_cents, notes,
          created_by_user_id, kind, created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, 'order', ?, ?, ?, 1)`,
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

    for (const l of lines) {
      const itemId = uuidv7();
      db.prepare(
        `INSERT INTO purchase_order_items
           (id, purchase_order_id, ingredient_id, qty_ordered, qty_received,
            unit_cost_cents, line_total_cents, notes, ordered_pack_size, ordered_pack_price_cents,
            received_value_cents, created_at, updated_at, device_id, version)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1)`,
      ).run(
        itemId,
        poId,
        l.ingredientId,
        l.qtyOrdered,
        l.unitCostCents,
        l.lineTotalCents,
        l.notes ?? null,
        l.pack.size,
        l.pack.priceCents,
        now,
        now,
        actor.deviceId,
      );
      enqueueSync(db, {
        entityType: 'purchase_order_items',
        entityId: itemId,
        op: 'upsert',
        payload: { id: itemId, purchaseOrderId: poId, ingredientId: l.ingredientId, qtyOrdered: l.qtyOrdered, lineTotalCents: l.lineTotalCents },
      });
    }

    writeAudit(db, {
      entityType: 'purchase_orders',
      entityId: poId,
      action: 'create',
      actorUserId: actor.userId,
      before: null,
      after: {
        supplierId: input.supplierId,
        items: lines.map((l) => ({
          ingredientId: l.ingredientId,
          qtyOrdered: l.qtyOrdered,
          orderedPackSize: l.pack.size,
          orderedPackPriceCents: l.pack.priceCents,
          lineTotalCents: l.lineTotalCents,
        })),
        totalCents,
      },
    });
  });
  tx();

  const fetched = getPurchaseOrderWithItems(db, poId);
  if (!fetched) throw new Error('PO vanished after insert');
  return fetched;
}

/**
 * The status changes a person may make by hand. 'partial' and 'received' only
 * ever come from receiving a delivery (receiveDelivery), which also moves the
 * stock; setting them by hand would say goods arrived that never went on the
 * shelf. A finished order (received or cancelled) stays finished.
 */
const MANUAL_STATUS_MOVES: Record<PurchaseOrderStatus, readonly PurchaseOrderStatus[]> = {
  draft: ['ordered', 'cancelled'],
  ordered: ['cancelled'],
  partial: ['cancelled'],
  received: [],
  cancelled: [],
};

export function setPurchaseOrderStatus(
  db: AppDatabase,
  id: string,
  status: PurchaseOrderStatus,
  actor: Actor & { userId: string },
): void {
  const now = nowIso();
  const tx = db.transaction(() => {
    const row = db
      .prepare(`SELECT ${PO_SELECT} FROM purchase_orders WHERE id = ? AND deleted_at IS NULL`)
      .get(id) as POrow | undefined;
    if (!row) throw new Error('Purchase order not found');
    const before = rowToPO(row);
    if (!MANUAL_STATUS_MOVES[before.status].includes(status)) {
      if (status === 'received' || status === 'partial') {
        throw new Error('Use Receive to book a delivery in — it also adds the stock');
      }
      throw new Error(`This purchase order is ${before.status}; it cannot be marked ${status}`);
    }
    const after: PurchaseOrder = {
      ...before,
      status,
      orderedAt: before.status === 'draft' && status === 'ordered' ? now : before.orderedAt,
    };
    db.prepare(
      `UPDATE purchase_orders SET status = ?, ordered_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(after.status, after.orderedAt, now, id);
    enqueueSync(db, {
      entityType: 'purchase_orders',
      entityId: id,
      op: 'upsert',
      payload: after,
    });
    writeAudit(db, {
      entityType: 'purchase_orders',
      entityId: id,
      action: `status:${status}`,
      actorUserId: actor.userId,
      before,
      after,
    });
  });
  tx();
}

// -----------------------------------------------------------------------------
// The price a bill gives (costing spec D1, 4.1)
// -----------------------------------------------------------------------------

/**
 * How far a bill's price may be from the usual one before the till asks
 * (costing spec D1: "the alert threshold, default 10%"): the owner's price
 * alert threshold ('costing.alerts' jumpBps), the same on both tills.
 */
export function priceGuardBps(db: AppDatabase): number {
  return getBusinessSetting(db, 'costing.alerts')?.value.jumpBps ?? DEFAULT_ALERT_JUMP_BPS;
}

/** What happened to one line's price, for the audit row and the answer. */
interface LinePrice {
  ingredientId: string;
  qty: number;
  billCents: number;
  /** D1's guard, in a word ('within', 'higher'…). */
  why: PriceCheckWhy;
  /** The bill's price became the ingredient's price. */
  used: boolean;
  /** The bill's price differs from the ingredient's and was not used. */
  kept: boolean;
}

/** The lines' prices, and the price writes the alerts look at once the whole bill is in. */
interface Priced {
  line: LinePrice;
  written: PriceWritten | null;
}

/**
 * D1's guard for one line, then — when the bill's price is to be used — the
 * one price path (setIngredientPrice): the ingredient keeps its usual pack at
 * the bill's price, its price history gets the bill EXACTLY as paid (q, B),
 * naming the supplier and the purchase, and the batches made from it roll
 * up. Its pack is never cleared. `answer` is the "Use it as the new price?"
 * given on screen; without one the guard's default stands (yes for a
 * purchase order delivered, no for a quick purchase outside the band — the
 * owner's price alert threshold, default 10%). The price alerts look at
 * every line's price once the whole bill is in (see `written`).
 */
function priceFromLine(
  db: AppDatabase,
  line: { ingredientId: string; qty: number; billCents: number; answer: boolean | undefined },
  ctx: {
    kind: PurchaseKind;
    supplierId: string | null;
    purchaseOrderId: string;
    purchaseOrderItemId: string;
    invoiceNo: string | null;
    thresholdBps: number;
  },
  actor: Actor,
): Priced {
  const ing = readIngredient(db, line.ingredientId);
  const now = loadPriceBook(db).prices.get(line.ingredientId);
  const current = now
    ? { pack: now.pack, kind: now.kind, madeHere: now.batch?.complete === true }
    : { pack: effectivePack({ costPerUnitCents: Number(ing.cost_per_unit_cents), packSize: ing.pack_size, packPriceCents: ing.pack_price_cents }), kind: 'unset' as const };
  const check = checkBillPrice({
    kind: ctx.kind,
    current,
    usualSize: usualPackSize({ unit: ing.unit, packSize: ing.pack_size === null ? null : Number(ing.pack_size), packPriceCents: ing.pack_price_cents === null ? null : Number(ing.pack_price_cents) }),
    qty: line.qty,
    billCents: line.billCents,
    thresholdBps: ctx.thresholdBps,
  });
  const used = usesBillPrice(check, line.answer);
  let written: PriceWritten | null = null;
  if (used) {
    written = setIngredientPrice(
      db,
      {
        ingredientId: line.ingredientId,
        price: { costPerUnitCents: 0, packSize: check.newPack.size, packPriceCents: check.newPack.priceCents },
        priceKind: 'set',
        source: ctx.kind === 'order' ? 'delivery' : 'purchase',
        supplierId: ctx.supplierId,
        purchaseOrderId: ctx.purchaseOrderId,
        purchaseOrderItemId: ctx.purchaseOrderItemId,
        historyPack: billPack(line.qty, line.billCents),
        notes: ctx.invoiceNo ? `Bill ${ctx.invoiceNo}` : null,
      },
      actor,
      { alerts: false },
    ).written;
  }
  return {
    line: {
      ingredientId: line.ingredientId,
      qty: line.qty,
      billCents: line.billCents,
      why: check.why,
      used,
      kept: !used && check.why !== 'same' && check.why !== 'zero_bill',
    },
    written,
  };
}

/** The price alerts for a whole bill's prices, once (costing spec Phase 6). */
function alertsFor(db: AppDatabase, priced: readonly Priced[], actor: Actor): void {
  evaluatePriceAlerts(
    db,
    priced.flatMap((p) => (p.written ? [p.written] : [])),
    actor,
  );
}

/** A stock row at its bill: a delivery or a purchase, worth exactly what was paid. */
function billValue(qty: number, billCents: number) {
  return { valueCents: billCents, unitCostMc: unitCostMc(billPack(qty, billCents)), basis: 'bill' as const };
}

const cleanText = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
};

// -----------------------------------------------------------------------------
// Receiving a purchase order, at its bill
// -----------------------------------------------------------------------------

/**
 * Receive a delivery (costing spec Phase 5): stock goes up by what came, and
 * each line is booked at what its BILL says — typed per line, or the ordered
 * price for that quantity. The stock row is worth exactly the bill; the
 * line keeps what was billed on it so far. Whether a bill's price becomes
 * the ingredient's price is D1's guard (see priceFromLine). The order
 * becomes 'received' (or 'partial' if not everything came in). One
 * transaction, synced and audited.
 */
export interface ReceiveDeliveryInput {
  purchaseOrderId: string;
  receipts: Array<{
    purchaseOrderItemId: string;
    qtyReceivedNow: number;
    /** What the bill says for this line; omitted = the ordered price for that quantity. */
    billCents?: number;
    /** "Use it as the new price?" as answered on screen; omitted = the guard's default (yes for a delivery). */
    usePrice?: boolean;
  }>;
  /** The supplier's bill number. */
  invoiceNo?: string | null;
  /** The older all-lines answer to "use the bill's price?", for a line that gives none. */
  updateCosts?: boolean;
}

export function receiveDelivery(
  db: AppDatabase,
  input: ReceiveDeliveryInput,
  actor: Actor & { userId: string },
): PurchaseOrderWithItems {
  const now = nowIso();
  const invoiceNo = cleanText(input.invoiceNo);
  const tx = db.transaction(() => {
    const po = getPurchaseOrderWithItems(db, input.purchaseOrderId);
    if (!po) throw new Error('Purchase order not found');
    if (po.status === 'received' || po.status === 'cancelled') {
      throw new Error(`Cannot receive into a ${po.status} purchase order`);
    }

    const booked: Priced[] = [];
    const thresholdBps = priceGuardBps(db);
    for (const receipt of input.receipts) {
      if (receipt.qtyReceivedNow <= 0) continue;
      const item = po.items.find((i) => i.id === receipt.purchaseOrderItemId);
      if (!item) continue;
      const bill = receipt.billCents ?? orderedValueCents(receipt.qtyReceivedNow, item);
      if (!Number.isSafeInteger(bill) || bill < 0) throw new Error('A bill must be Rs 0 or more, in whole paisa');

      const newReceived = item.qtyReceived + receipt.qtyReceivedNow;
      const newValue = item.receivedValueCents + bill;
      db.prepare(
        `UPDATE purchase_order_items SET qty_received = ?, received_value_cents = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(newReceived, newValue, now, item.id);
      enqueueSync(db, {
        entityType: 'purchase_order_items',
        entityId: item.id,
        op: 'upsert',
        payload: { id: item.id, qtyReceived: newReceived, receivedValueCents: newValue },
      });
      // The item carries on to the next receipt of the same line with what it has now.
      item.qtyReceived = newReceived;
      item.receivedValueCents = newValue;

      // Stock up, worth exactly what the bill says for it.
      recordStockMovement(
        db,
        {
          ingredientId: item.ingredientId,
          deltaQty: receipt.qtyReceivedNow,
          reason: 'delivery',
          refPurchaseOrderId: input.purchaseOrderId,
          notes: `PO ${po.referenceNo ?? po.id.slice(0, 8)}${invoiceNo ? ` · bill ${invoiceNo}` : ''}`,
          value: billValue(receipt.qtyReceivedNow, bill),
        },
        actor,
      );

      booked.push(
        priceFromLine(
          db,
          { ingredientId: item.ingredientId, qty: receipt.qtyReceivedNow, billCents: bill, answer: receipt.usePrice ?? input.updateCosts },
          { kind: 'order', supplierId: po.supplierId, purchaseOrderId: po.id, purchaseOrderItemId: item.id, invoiceNo, thresholdBps },
          actor,
        ),
      );
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
         invoice_no = COALESCE(?, invoice_no),
         updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(newStatus, newStatus, now, newStatus, actor.userId, invoiceNo, now, input.purchaseOrderId);
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
      after: { receipts: booked.map((b) => b.line), invoiceNo, newStatus },
    });
    alertsFor(db, booked, actor);
  });
  tx();

  const final = getPurchaseOrderWithItems(db, input.purchaseOrderId);
  if (!final) throw new Error('PO vanished');
  return final;
}

// -----------------------------------------------------------------------------
// Purchases recorded on the spot (kind 'quick')
// -----------------------------------------------------------------------------

export interface PurchaseLineInput {
  ingredientId: string;
  /** How much was bought, in whole base units of the ingredient. */
  qty: number;
  /** What was paid for it, paisa. */
  billCents: number;
  /** "Use it as the new price?" as answered on screen; omitted = the guard's default (no outside 10%). */
  usePrice?: boolean;
}

export interface RecordPurchaseInput {
  supplierId?: string | null;
  invoiceNo?: string | null;
  notes?: string | null;
  /** The money came out of this till's drawer now: a payout of the total, written with the purchase. */
  paidFromDrawer?: boolean;
  lines: PurchaseLineInput[];
}

/**
 * Write a quick purchase (inside the caller's transaction): the purchase,
 * received as it is written, each line kept exactly as paid ((q, B) is its
 * ordered pack), its stock up at the bill, and D1's guard on its price.
 * `how.boughtAt` dates the purchase and its stock rows when the goods came
 * in earlier than now (a drawer payout turned into a purchase later: the
 * spend belongs to the day the cash went out). A price the bill gives takes
 * effect now, when it is decided. Returns the purchase's id and what
 * happened to each price.
 */
function writeQuickPurchase(
  db: AppDatabase,
  input: RecordPurchaseInput,
  actor: Actor & { userId: string },
  how: { fromDrawer: boolean; payoutReason: string | null; boughtAt?: string },
): { id: string; lines: LinePrice[]; priced: Priced[]; totalCents: number; supplierName: string | null } {
  if (input.lines.length === 0) throw new Error('Add at least one thing that was bought');
  const seen = new Set<string>();
  for (const l of input.lines) {
    if (seen.has(l.ingredientId)) throw new Error('Each ingredient once per purchase: add the amounts together');
    seen.add(l.ingredientId);
    if (!Number.isSafeInteger(l.qty) || l.qty < 1) throw new Error('Say how much was bought, at least 1 whole unit');
    if (!Number.isSafeInteger(l.billCents) || l.billCents < 0) throw new Error('Say what was paid, Rs 0 or more');
  }
  const supplierId = input.supplierId ?? null;
  const supplierName = supplierId ? readSupplierName(db, supplierId) : null;
  const invoiceNo = cleanText(input.invoiceNo);
  // Every ingredient is still there, before anything is written.
  for (const l of input.lines) readIngredient(db, l.ingredientId);
  const id = uuidv7();
  const now = nowIso();
  const boughtAt = how.boughtAt ?? now;
  const totalCents = input.lines.reduce((s, l) => s + l.billCents, 0);

  db.prepare(
    `INSERT INTO purchase_orders
       (id, supplier_id, reference_no, status, ordered_at, received_at, total_cents, notes,
        created_by_user_id, received_by_user_id, invoice_no, kind, created_at, updated_at, device_id, version)
     VALUES (?, ?, NULL, 'received', ?, ?, ?, ?, ?, ?, ?, 'quick', ?, ?, ?, 1)`,
  ).run(id, supplierId, boughtAt, boughtAt, totalCents, cleanText(input.notes) ?? how.payoutReason, actor.userId, actor.userId, invoiceNo, now, now, actor.deviceId);
  enqueueSync(db, { entityType: 'purchase_orders', entityId: id, op: 'upsert', payload: { id, kind: 'quick', totalCents } });

  const priced: Priced[] = [];
  const thresholdBps = priceGuardBps(db);
  for (const l of input.lines) {
    const itemId = uuidv7();
    db.prepare(
      `INSERT INTO purchase_order_items
         (id, purchase_order_id, ingredient_id, qty_ordered, qty_received, unit_cost_cents, line_total_cents,
          notes, ordered_pack_size, ordered_pack_price_cents, received_value_cents, created_at, updated_at, device_id, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(itemId, id, l.ingredientId, l.qty, l.qty, costPerUnitFromPack(l.billCents, l.qty), l.billCents, l.qty, l.billCents, l.billCents, now, now, actor.deviceId);
    enqueueSync(db, {
      entityType: 'purchase_order_items',
      entityId: itemId,
      op: 'upsert',
      payload: { id: itemId, purchaseOrderId: id, ingredientId: l.ingredientId, qtyReceived: l.qty, receivedValueCents: l.billCents },
    });
    recordStockMovement(
      db,
      {
        ingredientId: l.ingredientId,
        deltaQty: l.qty,
        reason: 'delivery',
        refPurchaseOrderId: id,
        notes: `Bought${supplierName ? ` from ${supplierName}` : ''}${invoiceNo ? ` · bill ${invoiceNo}` : ''}${how.fromDrawer ? ' · paid from the drawer' : ''}`,
        value: billValue(l.qty, l.billCents),
        occurredAtIso: boughtAt,
      },
      actor,
    );
    priced.push(
      priceFromLine(
        db,
        { ingredientId: l.ingredientId, qty: l.qty, billCents: l.billCents, answer: l.usePrice },
        { kind: 'quick', supplierId, purchaseOrderId: id, purchaseOrderItemId: itemId, invoiceNo, thresholdBps },
        actor,
      ),
    );
  }
  return { id, lines: priced.map((p) => p.line), priced, totalCents, supplierName };
}

/**
 * What a payout written with a purchase says it was for: "Stock purchase",
 * with the bill number when one was typed. Neutral on purpose: a cashier
 * sees the drawer's cash in and out (they count it at close), but what was
 * bought, from whom and at what price is purchase figures (COST_CAPABILITY,
 * costing spec §2). Managers see the purchase through its link.
 */
export function purchasePayoutReason(invoiceNo: string | null): string {
  return invoiceNo ? `Stock purchase · bill ${invoiceNo}` : 'Stock purchase';
}

function resultOf(db: AppDatabase, id: string, lines: LinePrice[]): RecordPurchaseResult {
  const purchase = getPurchaseOrderWithItems(db, id);
  if (!purchase) throw new Error('The purchase vanished after it was written');
  return {
    purchase,
    pricesUsed: lines.filter((l) => l.used).map((l) => l.ingredientId as UUID),
    pricesKept: lines.filter((l) => l.kept).map((l) => l.ingredientId as UUID),
  };
}

/**
 * "Record a purchase" (costing spec Phase 5, kind 'quick'): what was bought
 * and what was paid, received at once, supplier optional. Paid from the
 * drawer: the total goes out of this till's open shift as a payout linked
 * to the purchase, in the SAME transaction, so the shift's expected cash
 * includes it. A quick purchase's price is used within 10% of the usual
 * one; outside it, only when the screen said yes (D1). One transaction:
 * the purchase, its lines, the stock, the prices and the payout, each
 * synced and audited — or none of it.
 */
export function recordPurchase(
  db: AppDatabase,
  input: RecordPurchaseInput,
  actor: Actor & { userId: string },
): RecordPurchaseResult {
  return db.transaction((): RecordPurchaseResult => {
    const fromDrawer = input.paidFromDrawer === true;
    if (fromDrawer) {
      const total = input.lines.reduce((s, l) => s + l.billCents, 0);
      if (!(total > 0)) throw new Error('Nothing to pay from the drawer: the bill comes to Rs 0');
      if (!getCurrentShift(db, actor.deviceId)) throw new Error('No shift is open on this till — open a shift first, or untick "Paid from the drawer"');
    }
    const q = writeQuickPurchase(db, input, actor, { fromDrawer, payoutReason: null });
    let payout: { id: string } | null = null;
    if (fromDrawer) {
      payout = recordCashMovement(
        db,
        { type: 'payout', amountCents: q.totalCents, reason: purchasePayoutReason(cleanText(input.invoiceNo)), refPurchaseOrderId: q.id },
        actor,
      );
    }
    writeAudit(db, {
      entityType: 'purchase_orders',
      entityId: q.id,
      action: 'purchase',
      actorUserId: actor.userId,
      before: null,
      after: {
        kind: 'quick',
        supplierId: input.supplierId ?? null,
        invoiceNo: cleanText(input.invoiceNo),
        totalCents: q.totalCents,
        lines: q.lines,
        paidFromDrawer: fromDrawer,
        cashMovementId: payout?.id ?? null,
      },
    });
    alertsFor(db, q.priced, actor);
    return resultOf(db, q.id, q.lines);
  })();
}

/**
 * "Turn this payout into a purchase" (costing spec Phase 5, managers): a
 * free-text drawer payout (a market run a cashier paid with a manager's PIN)
 * becomes a quick purchase, linked ONCE. The payout itself — its amount, so
 * the shift's expected cash — never changes; only its link does. The
 * purchase and its stock rows are dated when the cash went out (the
 * payout's time), not when the paperwork is done, so a month's purchases
 * still match that month's drawer payouts (Reports date spend by the stock
 * rows). A price the bill gives takes effect now, when it is decided. Asked
 * again for a payout already linked, it answers with that purchase and
 * writes nothing. One transaction, synced and audited.
 */
export function payoutToPurchase(
  db: AppDatabase,
  input: RecordPurchaseInput & { cashMovementId: string },
  actor: Actor & { userId: string },
): RecordPurchaseResult & { alreadyLinked: boolean } {
  return db.transaction((): RecordPurchaseResult & { alreadyLinked: boolean } => {
    const m = findCashMovement(db, input.cashMovementId);
    if (!m) throw new Error('That cash payout was not found');
    if (m.type !== 'payout') throw new Error('Only cash taken out of the drawer can be turned into a purchase');
    if (m.refPurchaseOrderId) {
      const purchase = getPurchaseOrderWithItems(db, m.refPurchaseOrderId);
      if (!purchase) throw new Error('That payout is linked to a purchase that is no longer there');
      return { purchase, pricesUsed: [], pricesKept: [], alreadyLinked: true };
    }
    const q = writeQuickPurchase(db, { ...input, paidFromDrawer: false }, actor, { fromDrawer: true, payoutReason: m.reason, boughtAt: m.createdAt });
    linkPayoutToPurchase(db, m.id, q.id, actor);
    writeAudit(db, {
      entityType: 'purchase_orders',
      entityId: q.id,
      action: 'purchase_from_payout',
      actorUserId: actor.userId,
      before: null,
      after: {
        kind: 'quick',
        supplierId: input.supplierId ?? null,
        invoiceNo: cleanText(input.invoiceNo),
        totalCents: q.totalCents,
        lines: q.lines,
        cashMovementId: m.id,
        payoutCents: m.amountCents,
        // The purchase and its stock rows are dated at the payout.
        boughtAt: m.createdAt,
      },
    });
    alertsFor(db, q.priced, actor);
    return { ...resultOf(db, q.id, q.lines), alreadyLinked: false };
  })();
}
