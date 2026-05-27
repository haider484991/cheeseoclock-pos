/**
 * IPC contract — single source of truth for every channel between the Electron
 * main process and the renderer. Lives in shared-types so both `preload.ts`
 * (renderer-side façade) and `electron/ipc/handlers/*` (main-side handlers)
 * reference the same type.
 *
 * Convention: 'domain:verb' — e.g. 'auth:login', 'users:create'.
 */

import type { ApiResult } from './ipc.js';
import type { AuthenticatedUser, User, Role } from './auth.js';
import type {
  Category,
  MenuItem,
  ModifierGroup,
  Modifier,
  Combo,
  TaxCategory,
  PrepStation,
} from './menu.js';
import type {
  Order,
  OrderMode,
  OrderSnapshot,
  PaymentMethod,
  Rider,
} from './order.js';
import type {
  PrinterConnectionConfig,
  PrintResult,
  PrinterTransport,
} from './printer.js';
import type {
  Ingredient,
  Recipe,
  StockMovement,
  StockMovementReason,
  Supplier,
  PurchaseOrder,
  PurchaseOrderStatus,
  PurchaseOrderWithItems,
} from './inventory.js';
import type { Customer, CustomerAddress, CustomerWithAddresses } from './customer.js';

export interface IpcContract {
  // System
  'system:getVersion': {
    request: undefined;
    response: ApiResult<{ version: string; isDev: boolean }>;
  };
  'system:getDeviceInfo': {
    request: undefined;
    response: ApiResult<{ deviceId: string; displayName: string; registeredAt: string }>;
  };
  'system:getSetupStatus': {
    request: undefined;
    response: ApiResult<{ completed: boolean; userCount: number }>;
  };
  'system:completeOnboarding': {
    request: {
      storeName: string;
      storeTagline?: string;
      branchLine?: string;
      phoneLine?: string;
      footerLine?: string;
      logoUrl?: string;
      taxCategories: Array<{ name: string; rateBps: number }>;
      admin: { fullName: string; pin: string };
    };
    response: ApiResult<{ adminUserId: string }>;
  };

  // Auth
  'auth:login': {
    request: { pin: string };
    response: ApiResult<AuthenticatedUser>;
  };
  'auth:logout': {
    request: undefined;
    response: ApiResult<{ loggedOut: true }>;
  };
  'auth:currentSession': {
    request: undefined;
    response: ApiResult<AuthenticatedUser | null>;
  };
  'auth:verifyManagerPin': {
    request: { pin: string };
    response: ApiResult<{ approverUserId: string; approverName: string }>;
  };

  // Users
  'users:list': {
    request: undefined;
    response: ApiResult<User[]>;
  };
  'users:create': {
    request: { fullName: string; role: Role; pin: string };
    response: ApiResult<User>;
  };
  'users:update': {
    request: {
      id: string;
      fullName?: string;
      role?: Role;
      isActive?: boolean;
      pin?: string;
    };
    response: ApiResult<User>;
  };
  'users:deactivate': {
    request: { id: string };
    response: ApiResult<{ id: string }>;
  };

  // Menu — categories
  'menu:listCategories': {
    request: { activeOnly?: boolean } | undefined;
    response: ApiResult<Category[]>;
  };
  'menu:createCategory': {
    request: { name: string; displayOrder: number; colorHex: string };
    response: ApiResult<Category>;
  };
  'menu:updateCategory': {
    request: {
      id: string;
      name?: string;
      displayOrder?: number;
      colorHex?: string;
      isActive?: boolean;
    };
    response: ApiResult<Category>;
  };
  'menu:deleteCategory': {
    request: { id: string };
    response: ApiResult<{ id: string }>;
  };

  // Menu — items
  'menu:listItems': {
    request: { categoryId?: string; activeOnly?: boolean } | undefined;
    response: ApiResult<MenuItem[]>;
  };
  'menu:findItemByBarcode': {
    request: { barcode: string };
    response: ApiResult<MenuItem | null>;
  };
  'menu:createItem': {
    request: {
      categoryId: string;
      name: string;
      description?: string | null;
      basePriceCents: number;
      sku?: string | null;
      barcode?: string | null;
      imageUrl?: string | null;
      prepStation?: PrepStation;
      taxCategoryId: string;
      sortOrder?: number;
    };
    response: ApiResult<MenuItem>;
  };
  'menu:updateItem': {
    request: {
      id: string;
      categoryId?: string;
      name?: string;
      description?: string | null;
      basePriceCents?: number;
      sku?: string | null;
      barcode?: string | null;
      imageUrl?: string | null;
      isActive?: boolean;
      prepStation?: PrepStation;
      taxCategoryId?: string;
      sortOrder?: number;
    };
    response: ApiResult<MenuItem>;
  };
  'menu:deleteItem': {
    request: { id: string };
    response: ApiResult<{ id: string }>;
  };
  'menu:listModifierGroupsForItem': {
    request: { menuItemId: string };
    response: ApiResult<Array<ModifierGroup & { modifiers: Modifier[]; sortOrder: number }>>;
  };
  'menu:setItemModifierGroups': {
    request: {
      menuItemId: string;
      groups: Array<{ modifierGroupId: string; sortOrder: number }>;
    };
    response: ApiResult<{ menuItemId: string }>;
  };

  // Menu — modifier groups + modifiers
  'menu:listModifierGroups': {
    request: undefined;
    response: ApiResult<Array<ModifierGroup & { modifiers: Modifier[] }>>;
  };
  'menu:createModifierGroup': {
    request: {
      name: string;
      selectionType: 'single' | 'multi';
      minSelect: number;
      maxSelect: number;
      isRequired: boolean;
    };
    response: ApiResult<ModifierGroup>;
  };
  'menu:updateModifierGroup': {
    request: {
      id: string;
      name?: string;
      selectionType?: 'single' | 'multi';
      minSelect?: number;
      maxSelect?: number;
      isRequired?: boolean;
    };
    response: ApiResult<ModifierGroup>;
  };
  'menu:deleteModifierGroup': {
    request: { id: string };
    response: ApiResult<{ id: string }>;
  };
  'menu:createModifier': {
    request: {
      modifierGroupId: string;
      name: string;
      priceDeltaCents: number;
      isDefault?: boolean;
      sortOrder?: number;
    };
    response: ApiResult<Modifier>;
  };
  'menu:updateModifier': {
    request: {
      id: string;
      name?: string;
      priceDeltaCents?: number;
      isDefault?: boolean;
      sortOrder?: number;
    };
    response: ApiResult<Modifier>;
  };
  'menu:deleteModifier': {
    request: { id: string };
    response: ApiResult<{ id: string }>;
  };

  // Menu — combos (high-level CRUD; structure managed separately in Phase 2.5)
  'menu:listCombos': {
    request: { activeOnly?: boolean } | undefined;
    response: ApiResult<Combo[]>;
  };

  // Menu — tax categories
  'menu:listTaxCategories': {
    request: undefined;
    response: ApiResult<TaxCategory[]>;
  };
  'menu:createTaxCategory': {
    request: { name: string; rateBps: number };
    response: ApiResult<TaxCategory>;
  };
  'menu:updateTaxCategory': {
    request: { id: string; name?: string; rateBps?: number };
    response: ApiResult<TaxCategory>;
  };
  'menu:deleteTaxCategory': {
    request: { id: string };
    response: ApiResult<{ id: string }>;
  };

  // Orders
  'orders:create': {
    request: {
      mode: OrderMode;
      tableId?: string | null;
      customerId?: string | null;
      customerAddressId?: string | null;
      notes?: string | null;
    };
    response: ApiResult<Order>;
  };
  'orders:attachCustomer': {
    request: {
      orderId: string;
      customerId: string;
      addressId?: string | null;
      deliveryNotes?: string | null;
    };
    response: ApiResult<OrderSnapshot>;
  };
  'orders:detachCustomer': {
    request: { orderId: string };
    response: ApiResult<OrderSnapshot>;
  };
  'orders:list': {
    request: { status?: Order['status']; sinceIso?: string; limit?: number } | undefined;
    response: ApiResult<Order[]>;
  };
  'orders:get': {
    request: { id: string };
    response: ApiResult<OrderSnapshot | null>;
  };
  'orders:addItem': {
    request: {
      orderId: string;
      menuItemId: string;
      quantity: number;
      modifierIds: string[];
      notes?: string | null;
    };
    response: ApiResult<OrderSnapshot>;
  };
  'orders:updateItemQuantity': {
    request: { orderId: string; orderItemId: string; quantity: number };
    response: ApiResult<OrderSnapshot>;
  };
  'orders:removeItem': {
    request: { orderId: string; orderItemId: string };
    response: ApiResult<OrderSnapshot>;
  };
  'orders:applyDiscount': {
    request: {
      orderId: string;
      discountType: 'percent' | 'flat';
      value: number;
      reason?: string | null;
      approverPin?: string;
    };
    response: ApiResult<OrderSnapshot>;
  };
  'orders:clearDiscount': {
    request: { orderId: string };
    response: ApiResult<OrderSnapshot>;
  };
  'orders:tender': {
    request: {
      orderId: string;
      payments: Array<{
        method: PaymentMethod;
        amountCents: number;
        tenderedCents?: number | null;
        referenceNo?: string | null;
      }>;
    };
    response: ApiResult<OrderSnapshot>;
  };
  'orders:void': {
    request: { orderId: string; reason: string; approverPin: string };
    response: ApiResult<OrderSnapshot>;
  };
  'orders:refund': {
    request: { orderId: string; reason: string; approverPin: string };
    response: ApiResult<OrderSnapshot>;
  };

  // Live order tracking — state transitions for the Live Orders board.
  // Server enforces legal transitions; client passes the orderId only.
  'orders:listActive': {
    request: { mode?: OrderMode } | undefined;
    response: ApiResult<OrderSnapshot[]>;
  };
  /**
   * Richer list for the Order History page: includes customer snapshot,
   * cashier name, item count, and primary payment method. Supports text
   * search + date/status/mode filters.
   */
  'orders:history': {
    request:
      | {
          search?: string;
          status?: Order['status'] | 'any';
          mode?: OrderMode | 'any';
          sinceIso?: string;
          untilIso?: string;
          limit?: number;
        }
      | undefined;
    response: ApiResult<
      Array<{
        id: string;
        orderNumber: string;
        mode: OrderMode;
        status: Order['status'];
        customerName: string | null;
        customerPhone: string | null;
        tableLabel: string | null;
        cashierName: string;
        itemCount: number;
        totalCents: number;
        paidAt: string | null;
        createdAt: string;
        primaryPaymentMethod: PaymentMethod | null;
      }>
    >;
  };
  /**
   * Commit a still-open order without tendering. The COD entry path: cashier
   * builds a delivery order, hits "Send to kitchen", and the order goes onto
   * the Live Orders board. Payment is captured later when the rider returns.
   */
  'orders:sendToKitchen': {
    request: { orderId: string };
    response: ApiResult<OrderSnapshot>;
  };
  'orders:markPreparing': {
    request: { orderId: string };
    response: ApiResult<OrderSnapshot>;
  };
  'orders:markReady': {
    request: { orderId: string };
    response: ApiResult<OrderSnapshot>;
  };
  'orders:assignRider': {
    request: { orderId: string; riderId: string };
    response: ApiResult<OrderSnapshot>;
  };
  'orders:unassignRider': {
    request: { orderId: string };
    response: ApiResult<OrderSnapshot>;
  };
  /**
   * Mark a takeaway/dine-in order served. Optional `payment` mirrors
   * markDelivered: if provided, captures the COD payment in the same
   * transaction and moves status straight to `paid`. Otherwise moves
   * status to `served` and a tender call is expected later (typical for
   * dine-in: customer eats, then asks for the bill).
   */
  'orders:markServed': {
    request: {
      orderId: string;
      payment?: {
        method: PaymentMethod;
        amountCents: number;
        tenderedCents?: number | null;
        referenceNo?: string | null;
      };
    };
    response: ApiResult<OrderSnapshot>;
  };
  /**
   * Mark a delivery order delivered. If `payment` is provided we also record
   * the COD payment in the same transaction so the order moves directly to
   * paid + delivered. If omitted, the order moves to `delivered` and a tender
   * call is expected later.
   */
  'orders:markDelivered': {
    request: {
      orderId: string;
      payment?: {
        method: PaymentMethod;
        amountCents: number;
        tenderedCents?: number | null;
        referenceNo?: string | null;
      };
    };
    response: ApiResult<OrderSnapshot>;
  };

  // Riders / delivery staff
  'riders:list': {
    request: { activeOnly?: boolean } | undefined;
    response: ApiResult<Rider[]>;
  };
  'riders:create': {
    request: { name: string; phone: string; notes?: string | null };
    response: ApiResult<Rider>;
  };
  'riders:update': {
    request: {
      id: string;
      name?: string;
      phone?: string;
      notes?: string | null;
      isActive?: boolean;
    };
    response: ApiResult<Rider>;
  };
  'riders:deactivate': {
    request: { id: string };
    response: ApiResult<{ id: string }>;
  };

  // Printer
  'printer:getConfig': {
    request: undefined;
    response: ApiResult<{
      config: PrinterConnectionConfig;
      branding: {
        storeName: string;
        storeTagline?: string;
        branchLine?: string;
        phoneLine?: string;
        footerLine?: string;
        logoUrl?: string;
      };
      transports: PrinterTransport[];
      mockEnabled: boolean;
    }>;
  };
  'printer:setConfig': {
    request: {
      config: PrinterConnectionConfig;
    };
    response: ApiResult<{ ok: true }>;
  };
  'printer:setBranding': {
    request: {
      storeName: string;
      storeTagline?: string;
      branchLine?: string;
      phoneLine?: string;
      footerLine?: string;
      logoUrl?: string;
    };
    response: ApiResult<{ ok: true }>;
  };
  'printer:test': {
    request: undefined;
    response: ApiResult<PrintResult>;
  };
  'printer:reprint': {
    request: { orderId: string };
    response: ApiResult<{ enqueued: true }>;
  };

  // FBR (Pakistan Digital Invoicing)
  'fbr:getConfig': {
    request: undefined;
    response: ApiResult<{
      mode: 'noop' | 'sandbox' | 'production';
      endpoint?: string;
      bearerToken?: string;
      sellerNTNCNIC: string;
      sellerBusinessName: string;
      sellerProvince: string;
      sellerAddress: string;
      paused: boolean;
      ready: { ok: boolean; missing: string[] };
    }>;
  };
  'fbr:setConfig': {
    request: {
      mode: 'noop' | 'sandbox' | 'production';
      endpoint?: string;
      bearerToken?: string;
      sellerNTNCNIC: string;
      sellerBusinessName: string;
      sellerProvince: string;
      sellerAddress: string;
      paused?: boolean;
    };
    response: ApiResult<{ ok: true }>;
  };
  'fbr:getQueueStats': {
    request: undefined;
    response: ApiResult<{
      mode: 'noop' | 'sandbox' | 'production';
      pending: number;
      failed: number;
      sent: number;
      skipped: number;
      oldestPendingIso: string | null;
      paused: boolean;
    }>;
  };
  'fbr:retryFailed': {
    request: undefined;
    response: ApiResult<{ requeued: number }>;
  };
  'fbr:getInvoiceStatus': {
    request: { orderId: string };
    response: ApiResult<{
      status: 'none' | 'pending' | 'sent' | 'failed' | 'skipped';
      attempts: number;
      lastError?: string | null;
      irn?: string | null;
      qrPayload?: string | null;
      submittedAt?: string | null;
    }>;
  };

  // Inventory — ingredients
  'inventory:listIngredients': {
    request: { activeOnly?: boolean; lowStockOnly?: boolean } | undefined;
    response: ApiResult<Ingredient[]>;
  };
  'inventory:createIngredient': {
    request: {
      name: string;
      unit: string;
      currentQty?: number;
      lowThreshold?: number;
      costPerUnitCents?: number;
      defaultSupplierId?: string | null;
      sku?: string | null;
      notes?: string | null;
    };
    response: ApiResult<Ingredient>;
  };
  'inventory:updateIngredient': {
    request: {
      id: string;
      name?: string;
      unit?: string;
      lowThreshold?: number;
      costPerUnitCents?: number;
      defaultSupplierId?: string | null;
      sku?: string | null;
      notes?: string | null;
      isActive?: boolean;
    };
    response: ApiResult<Ingredient>;
  };
  'inventory:deleteIngredient': {
    request: { id: string };
    response: ApiResult<{ id: string }>;
  };

  // Inventory — recipes (per menu item)
  'inventory:getRecipe': {
    request: { menuItemId: string };
    response: ApiResult<
      Array<Recipe & { ingredientName: string; unit: string }>
    >;
  };
  'inventory:setRecipe': {
    request: {
      menuItemId: string;
      lines: Array<{ ingredientId: string; qtyPerUnit: number }>;
    };
    response: ApiResult<{ menuItemId: string }>;
  };

  // Inventory — movements (audit log + manual adjustments)
  'inventory:listMovements': {
    request: {
      ingredientId?: string;
      reason?: StockMovementReason;
      sinceIso?: string;
      limit?: number;
    } | undefined;
    response: ApiResult<StockMovement[]>;
  };
  'inventory:recordMovement': {
    request: {
      ingredientId: string;
      deltaQty: number;
      reason: 'delivery' | 'waste' | 'count' | 'adjustment';
      notes?: string | null;
    };
    response: ApiResult<{ movementId: string; resultingQty: number }>;
  };

  // Procurement — suppliers
  'inventory:listSuppliers': {
    request: { activeOnly?: boolean } | undefined;
    response: ApiResult<Supplier[]>;
  };
  'inventory:createSupplier': {
    request: {
      name: string;
      contactPerson?: string | null;
      phone?: string | null;
      email?: string | null;
      address?: string | null;
      notes?: string | null;
    };
    response: ApiResult<Supplier>;
  };
  'inventory:updateSupplier': {
    request: {
      id: string;
      name?: string;
      contactPerson?: string | null;
      phone?: string | null;
      email?: string | null;
      address?: string | null;
      notes?: string | null;
      isActive?: boolean;
    };
    response: ApiResult<Supplier>;
  };

  // Procurement — purchase orders
  'inventory:listPurchaseOrders': {
    request: { status?: PurchaseOrderStatus; supplierId?: string; limit?: number } | undefined;
    response: ApiResult<PurchaseOrder[]>;
  };
  'inventory:getPurchaseOrder': {
    request: { id: string };
    response: ApiResult<PurchaseOrderWithItems | null>;
  };
  'inventory:createPurchaseOrder': {
    request: {
      supplierId: string;
      referenceNo?: string | null;
      expectedAt?: string | null;
      notes?: string | null;
      items: Array<{
        ingredientId: string;
        qtyOrdered: number;
        unitCostCents: number;
        notes?: string | null;
      }>;
    };
    response: ApiResult<PurchaseOrderWithItems>;
  };
  'inventory:setPurchaseOrderStatus': {
    request: { id: string; status: PurchaseOrderStatus };
    response: ApiResult<{ ok: true }>;
  };
  'inventory:receiveDelivery': {
    request: {
      purchaseOrderId: string;
      receipts: Array<{ purchaseOrderItemId: string; qtyReceivedNow: number }>;
      updateCosts?: boolean;
    };
    response: ApiResult<PurchaseOrderWithItems>;
  };

  // Reports / analytics
  'reports:salesSummary': {
    request: { sinceIso: string; untilIso: string };
    response: ApiResult<{
      orderCount: number;
      itemCount: number;
      subtotalCents: number;
      discountCents: number;
      taxCents: number;
      totalCents: number;
      avgTicketCents: number;
      voidedCount: number;
      voidedCents: number;
    }>;
  };
  'reports:salesByDay': {
    request: { sinceIso: string; untilIso: string };
    response: ApiResult<Array<{ day: string; orderCount: number; totalCents: number }>>;
  };
  'reports:salesByHour': {
    request: { sinceIso: string; untilIso: string };
    response: ApiResult<Array<{ hour: number; orderCount: number; totalCents: number }>>;
  };
  'reports:salesByCategory': {
    request: { sinceIso: string; untilIso: string };
    response: ApiResult<
      Array<{ categoryId: string; categoryName: string; itemCount: number; revenueCents: number }>
    >;
  };
  'reports:topItems': {
    request: { sinceIso: string; untilIso: string; limit?: number };
    response: ApiResult<
      Array<{
        menuItemId: string;
        menuItemName: string;
        categoryName: string;
        quantity: number;
        revenueCents: number;
      }>
    >;
  };
  'reports:salesByMode': {
    request: { sinceIso: string; untilIso: string };
    response: ApiResult<
      Array<{
        mode: 'dine_in' | 'takeaway' | 'delivery' | 'online';
        orderCount: number;
        totalCents: number;
      }>
    >;
  };
  'reports:salesByPaymentMethod': {
    request: { sinceIso: string; untilIso: string };
    response: ApiResult<Array<{ method: string; paymentCount: number; amountCents: number }>>;
  };
  'reports:salesByCashier': {
    request: { sinceIso: string; untilIso: string };
    response: ApiResult<
      Array<{
        cashierId: string;
        cashierName: string;
        orderCount: number;
        totalCents: number;
        voidedCount: number;
      }>
    >;
  };
  'reports:discounts': {
    request: { sinceIso: string; untilIso: string };
    response: ApiResult<{
      count: number;
      totalAmountCents: number;
      byReason: Array<{ reason: string; count: number; amountCents: number }>;
    }>;
  };
  /**
   * End-of-day cash reconciliation summary. Returns per-method totals
   * (sales + refunds) plus a cash-specific roll-up. `openingCashCents`
   * gets added to expected cash on hand — pass the float you opened with.
   */
  'reports:cashSummary': {
    request: { sinceIso: string; untilIso: string; openingCashCents?: number };
    response: ApiResult<{
      byMethod: Array<{
        method: string;
        salesCents: number;
        refundCents: number;
        netCents: number;
        paymentCount: number;
        refundCount: number;
      }>;
      cashSalesCents: number;
      cashRefundsCents: number;
      expectedCashCents: number;
      totalRevenueCents: number;
      totalRefundsCents: number;
      netRevenueCents: number;
      paidOrderCount: number;
      refundedOrderCount: number;
    }>;
  };
  'reports:lowStock': {
    request: undefined;
    response: ApiResult<
      Array<{
        ingredientId: string;
        name: string;
        unit: string;
        currentQty: number;
        lowThreshold: number;
      }>
    >;
  };
  'reports:cogs': {
    request: { sinceIso: string; untilIso: string };
    response: ApiResult<{
      totalCogsCents: number;
      byIngredient: Array<{
        ingredientId: string;
        name: string;
        unit: string;
        qtyConsumed: number;
        costCents: number;
      }>;
    }>;
  };

  // Customers
  'customers:list': {
    request: { search?: string; activeOnly?: boolean; limit?: number } | undefined;
    response: ApiResult<Customer[]>;
  };
  'customers:findByPhone': {
    request: { phone: string };
    response: ApiResult<Customer | null>;
  };
  'customers:get': {
    request: { id: string };
    response: ApiResult<CustomerWithAddresses | null>;
  };
  'customers:create': {
    request: {
      name: string;
      phone?: string | null;
      email?: string | null;
      notes?: string | null;
    };
    response: ApiResult<Customer>;
  };
  'customers:update': {
    request: {
      id: string;
      name?: string;
      phone?: string | null;
      email?: string | null;
      notes?: string | null;
      isActive?: boolean;
    };
    response: ApiResult<Customer>;
  };
  'customers:listAddresses': {
    request: { customerId: string };
    response: ApiResult<CustomerAddress[]>;
  };
  'customers:createAddress': {
    request: {
      customerId: string;
      label?: string;
      addressLine: string;
      area?: string | null;
      city?: string | null;
      notes?: string | null;
      isDefault?: boolean;
    };
    response: ApiResult<CustomerAddress>;
  };
  'customers:setDefaultAddress': {
    request: { addressId: string };
    response: ApiResult<{ addressId: string }>;
  };
  'customers:deleteAddress': {
    request: { addressId: string };
    response: ApiResult<{ addressId: string }>;
  };
  'customers:orderHistory': {
    request: { customerId: string; limit?: number };
    response: ApiResult<
      Array<{
        orderId: string;
        orderNumber: string;
        createdAt: string;
        mode: string;
        status: string;
        totalCents: number;
      }>
    >;
  };

  // Sync
  'sync:getConfig': {
    request: undefined;
    response: ApiResult<{
      mode: 'off' | 'mock' | 'http';
      baseUrl?: string;
      deviceSecret?: string;
      pollIntervalMs: number;
      paused: boolean;
      ready: { ok: boolean; missing: string[] };
    }>;
  };
  'sync:setConfig': {
    request: {
      mode: 'off' | 'mock' | 'http';
      baseUrl?: string;
      deviceSecret?: string;
      pollIntervalMs?: number;
      paused?: boolean;
    };
    response: ApiResult<{ ok: true }>;
  };
  'sync:getStatus': {
    request: undefined;
    response: ApiResult<{
      mode: 'off' | 'mock' | 'http';
      paused: boolean;
      pending: number;
      pushedAt: string | null;
      pulledAt: string | null;
      lastAttempt: string | null;
      lastError: string | null;
      eventsPushed: number;
      eventsPulled: number;
      consecutiveFails: number;
    }>;
  };
  'sync:triggerNow': {
    request: undefined;
    response: ApiResult<{ kicked: true }>;
  };

  // Backup / restore — local SQLite snapshots, no cloud required
  'backup:list': {
    request: undefined;
    response: ApiResult<
      Array<{
        fileName: string;
        fullPath: string;
        sizeBytes: number;
        createdAtIso: string;
        kind: 'auto' | 'manual';
      }>
    >;
  };
  'backup:create': {
    request: undefined;
    response: ApiResult<{ fileName: string; fullPath: string; sizeBytes: number }>;
  };
  'backup:export': {
    request: undefined;
    response: ApiResult<{ path: string | null }>;
  };
  'backup:stageRestoreFromPicker': {
    request: undefined;
    response: ApiResult<{ staged: boolean }>;
  };
  'backup:stageRestoreFromPath': {
    request: { path: string };
    response: ApiResult<{ staged: boolean }>;
  };
  'backup:delete': {
    request: { fileName: string };
    response: ApiResult<{ fileName: string }>;
  };
  'backup:applyAndRelaunch': {
    request: undefined;
    response: ApiResult<{ relaunching: true }>;
  };

  // Tables (floor sections + dine-in tables)
  'tables:listSections': {
    request: undefined;
    response: ApiResult<Array<{ id: string; name: string; sortOrder: number }>>;
  };
  'tables:list': {
    request: { sectionId?: string } | undefined;
    response: ApiResult<
      Array<{
        id: string;
        floorSectionId: string;
        label: string;
        capacity: number;
        status: 'free' | 'occupied' | 'reserved' | 'cleaning';
        currentOrderId: string | null;
      }>
    >;
  };
}

export type IpcChannel = keyof IpcContract;
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request'];
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['response'];

/**
 * Derive the `window.api` shape from the contract. Groups by `domain:` prefix
 * and turns request/response into method signatures.
 *
 * `domain:verb` becomes `api.domain.verb(req): Promise<resp>`.
 * Methods whose request is `undefined` take no argument.
 */
export type RendererApi = {
  [Domain in IpcChannel as Domain extends `${infer D}:${string}` ? D : never]: {
    [Channel in IpcChannel as Channel extends `${Domain extends `${infer D}:${string}` ? D : never}:${infer M}`
      ? M
      : never]: IpcRequest<Channel> extends undefined
      ? () => Promise<IpcResponse<Channel>>
      : (req: IpcRequest<Channel>) => Promise<IpcResponse<Channel>>;
  };
};
