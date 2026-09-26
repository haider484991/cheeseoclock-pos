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
import type { CashMovement, CashMovementType, Shift, ShiftSummary } from './shift.js';
import type { BusinessReport, BusinessReportRequest } from './reports.js';
import type {
  PrinterConnectionConfig,
  PrintPolicy,
  PrintResult,
  PrinterTransport,
  ReceiptLogoRasterSet,
  ReceiptLogoStatus,
  SystemPrinterInfo,
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
  BatchRecipe,
  IngredientCategory,
  StockMovementSearch,
  StockMovementPage,
} from './inventory.js';
import type {
  Customer,
  CustomerAddress,
  CustomerAddressMatch,
  CustomerListRow,
  CustomerListSort,
  CustomerWithAddresses,
} from './customer.js';
import type { MenuImportPreview, MenuImportSummary } from './menu-import.js';
import type { OrderHistoryFilter, OrderHistoryPage } from './order-history.js';

/** One cloud copy as listed for the operator (from any till). */
export interface CloudBackupEntry {
  id: string;
  deviceId: string;
  fileName: string;
  sizeBytes: number;
  /** Server clock at upload. */
  createdAt: string;
  deviceName: string | null;
  isThisDevice: boolean;
  orderCount: number | null;
  lastOrderAt: string | null;
  reason: string | null;
  appVersion: string | null;
  sha256: string | null;
  auditHeadHash: string | null;
}

/** Result of walking the hash-chained audit trail. */
export interface AuditTrailStatus {
  ok: boolean;
  totalRows: number;
  checkedRows: number;
  legacyRows: number;
  headHash: string | null;
  brokenAt: { rowid: number; id: string; createdAt: string; reason: string } | null;
  verifiedAt: string;
  anchor: { uploadedAt: string; headHash: string; present: boolean } | null;
}

export interface IpcContract {
  // System
  'system:getVersion': {
    request: undefined;
    response: ApiResult<{ version: string; isDev: boolean }>;
  };
  /** Shop name, tagline and logo for the PIN screen — readable before anyone logs in. */
  'system:getBranding': {
    request: undefined;
    response: ApiResult<{ storeName: string; storeTagline: string | null; logoUrl: string | null }>;
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
  /** Human input on the till (throttled by the renderer); keeps an owner/manager login alive. */
  'auth:activity': {
    request: undefined;
    response: ApiResult<null>;
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

  // Menu — import from a menu file. Pick opens a file dialog in the main
  // process and returns what the file would change (null when cancelled);
  // apply writes the picked file, re-checked against the live menu.
  'menu:importPick': {
    request: undefined;
    response: ApiResult<MenuImportPreview | null>;
  };
  /** Re-plan the picked file, as an update (fresh false) or a fresh start. */
  'menu:importPreview': {
    request: { fresh: boolean };
    response: ApiResult<MenuImportPreview>;
  };
  /**
   * fresh: remove the whole current menu first (owner login; refused while
   * orders are open; a local backup is taken before anything changes).
   */
  'menu:importApply': {
    request: { fresh: boolean } | undefined;
    response: ApiResult<MenuImportSummary>;
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
  /** "Customize" a cart line: its choices (leave-outs, extras…) and its allergy / special-request note. */
  'orders:updateItemOptions': {
    request: { orderId: string; orderItemId: string; modifierIds: string[]; notes: string | null };
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
  /**
   * After a restart: the unfinished order the till was building, if any
   * (drafts with no items are discarded on the way). Null when there is none.
   */
  'orders:resumeDraft': {
    request: undefined;
    response: ApiResult<OrderSnapshot | null>;
  };
  /**
   * Drop an open till draft: the cart is abandoned, nothing sent or charged.
   * Refused for anything past 'open' — those are voids, with a manager PIN.
   */
  'orders:discardDraft': {
    request: { orderId: string };
    response: ApiResult<null>;
  };
  /** Change the mode of an open order (e.g. Takeaway → Delivery mid-order). */
  'orders:setMode': {
    request: { orderId: string; mode: OrderMode };
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
    request: {
      orderId: string;
      reason: string;
      approverPin: string;
      /** Omit for a full refund; provide cents for a partial. */
      amountCents?: number;
      /** Override the auto-picked method (defaults to dominant payment method). */
      method?: PaymentMethod;
    };
    response: ApiResult<OrderSnapshot>;
  };

  // Live order tracking — state transitions for the Live Orders board.
  // Server enforces legal transitions; client passes the orderId only.
  'orders:listActive': {
    request: { mode?: OrderMode } | undefined;
    response: ApiResult<OrderSnapshot[]>;
  };
  /**
   * Order History page: one page of PLACED orders (never an open cart) plus
   * totals across every page. Search by order number / name / phone; filter
   * by date, status group, channel and payment method.
   */
  'orders:history': {
    request: OrderHistoryFilter | undefined;
    response: ApiResult<OrderHistoryPage>;
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

  // Shifts (cashier cash-drawer reconciliation)
  'shifts:current': {
    request: undefined;
    response: ApiResult<Shift | null>;
  };
  'shifts:open': {
    request: { openingCashCents: number; notes?: string | null };
    response: ApiResult<Shift>;
  };
  'shifts:close': {
    request: { shiftId: string; countedCashCents: number; notes?: string | null };
    response: ApiResult<Shift>;
  };
  'shifts:list': {
    request: { sinceIso?: string; limit?: number; deviceId?: string } | undefined;
    response: ApiResult<Shift[]>;
  };
  'shifts:summary': {
    request: { shiftId: string };
    response: ApiResult<ShiftSummary>;
  };
  /** What the drawer was counted at when this till's last shift closed (the next float). */
  'shifts:lastCount': {
    request: undefined;
    response: ApiResult<{ countedCashCents: number; closedAt: string } | null>;
  };
  /** Cash in / out of the drawer that is not a sale. A cashier needs a manager PIN. */
  'shifts:recordCashMovement': {
    request: { type: CashMovementType; amountCents: number; reason: string; approverPin?: string };
    response: ApiResult<CashMovement>;
  };
  'shifts:listCashMovements': {
    request: { shiftId: string };
    response: ApiResult<CashMovement[]>;
  };

  // Website bridge (online ordering ↔ POS)
  'webBridge:getConfig': {
    request: undefined;
    response: ApiResult<{
      enabled: boolean;
      siteUrl?: string;
      /** Masked (****1234) — never the raw secret. */
      bridgeSecret?: string;
      pollIntervalMs: number;
      cloudBackupFrequency: 'off' | 'daily' | 'weekly' | 'monthly';
      /** A secret is stored but was sealed on another PC; enter it again. */
      secretUnreadable: boolean;
      ready: { ok: boolean; missing: string[] };
    }>;
  };
  'webBridge:setConfig': {
    request: {
      enabled: boolean;
      siteUrl?: string;
      bridgeSecret?: string;
      pollIntervalMs?: number;
      cloudBackupFrequency?: 'off' | 'daily' | 'weekly' | 'monthly';
    };
    response: ApiResult<{ ok: true }>;
  };
  'webBridge:getStatus': {
    request: undefined;
    response: ApiResult<{
      enabled: boolean;
      ready: boolean;
      lastPollAt: string | null;
      lastError: string | null;
      importedTotal: number;
      consecutiveFails: number;
      lastCloudBackupAt: string | null;
      lastCloudBackupError: string | null;
      lastImportError: string | null;
    }>;
  };
  /** Upload a fresh gzipped database backup to the cloud right now. */
  'webBridge:backupNow': {
    request: undefined;
    response: ApiResult<{ fileName: string; sizeBytes: number }>;
  };
  'webBridge:listCloudBackups': {
    request: undefined;
    response: ApiResult<CloudBackupEntry[]>;
  };
  /** Download + stage a cloud backup; renderer confirms via backup:applyAndRelaunch. Owner only. */
  'webBridge:restoreCloudBackup': {
    request: { id: string };
    response: ApiResult<{ staged: boolean }>;
  };
  /** List cloud copies with a connection that is not saved yet (onboarding restore). */
  'webBridge:previewCloudBackups': {
    request: { siteUrl: string; bridgeSecret: string };
    response: ApiResult<CloudBackupEntry[]>;
  };
  /** Download + stage a cloud copy with an unsaved connection; it is re-attached after the restart. */
  'webBridge:restoreCloudBackupWith': {
    request: { siteUrl: string; bridgeSecret: string; id: string };
    response: ApiResult<{ staged: boolean }>;
  };
  /** Serialize the active menu and PUT it to the website. */
  'webBridge:publishMenu': {
    request: undefined;
    response: ApiResult<{ categories: number; items: number }>;
  };
  'webBridge:pollNow': {
    request: undefined;
    response: ApiResult<{ kicked: true }>;
  };
  /** One-shot self-test — reports why orders are/aren't importing. */
  'webBridge:diagnose': {
    request: undefined;
    response: ApiResult<Record<string, unknown>>;
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
      /** What prints automatically, and when. */
      policy: PrintPolicy;
      /** Separate kitchen printer, or null when tickets share the receipt printer. */
      kitchenPrinter: PrinterConnectionConfig | null;
      /** The logo on the receipt printer: what will happen to it (no picture data). */
      logo: ReceiptLogoStatus;
    }>;
  };
  'printer:setPolicy': {
    request: PrintPolicy;
    response: ApiResult<{ ok: true }>;
  };
  'printer:setKitchenPrinter': {
    request: { config: PrinterConnectionConfig | null };
    response: ApiResult<{ ok: true }>;
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
  /**
   * The logo as 1-bit pictures for the receipt printer, made on screen from the
   * saved logo. `saved` is false when the logo changed in the meantime.
   */
  'printer:setLogoRaster': {
    request: ReceiptLogoRasterSet;
    response: ApiResult<{ saved: boolean }>;
  };
  /** Test page on the receipt printer, or on the kitchen printer when asked. */
  'printer:test': {
    request: { station?: 'receipt' | 'kitchen' } | undefined;
    response: ApiResult<PrintResult>;
  };
  /**
   * Printer queues installed in the OS, for the USB picker. `supported` is
   * false on platforms where the USB transport isn't implemented (the list
   * is then empty).
   */
  'printer:listSystemPrinters': {
    request: undefined;
    response: ApiResult<{ printers: SystemPrinterInfo[]; supported: boolean }>;
  };
  'printer:reprint': {
    request: { orderId: string };
    response: ApiResult<{ enqueued: true }>;
  };
  /** Kitchen ticket again, stamped REPRINT. */
  'printer:reprintKitchen': {
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
      packSize?: number | null;
      packPriceCents?: number | null;
      defaultSupplierId?: string | null;
      sku?: string | null;
      notes?: string | null;
      /** Omitted or null = guessed from the name. */
      category?: IngredientCategory | null;
    };
    response: ApiResult<Ingredient>;
  };
  'inventory:updateIngredient': {
    request: {
      id: string;
      name?: string;
      /** null = back to "guess from the name". */
      category?: IngredientCategory | null;
      unit?: string;
      lowThreshold?: number;
      costPerUnitCents?: number;
      packSize?: number | null;
      packPriceCents?: number | null;
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
  'inventory:convertIngredientUnit': {
    request: { id: string };
    response: ApiResult<Ingredient>;
  };

  // Inventory — recipes (per menu item)
  'inventory:getRecipe': {
    request: { menuItemId: string };
    response: ApiResult<
      Array<Recipe & { ingredientName: string; unit: string; modifierName: string | null }>
    >;
  };
  'inventory:setRecipe': {
    request: {
      menuItemId: string;
      lines: Array<{ ingredientId: string; qtyPerUnit: number; modifierId?: string | null }>;
    };
    response: ApiResult<{ menuItemId: string }>;
  };
  /** How many recipe lines each menu item has (items with none never take stock). */
  'inventory:listRecipeLineCounts': {
    request: undefined;
    response: ApiResult<Array<{ menuItemId: string; lineCount: number }>>;
  };

  // Inventory — batch recipes (what the kitchen makes itself)
  'inventory:getBatchRecipe': {
    request: { ingredientId: string };
    response: ApiResult<BatchRecipe>;
  };
  'inventory:setBatchRecipe': {
    request: {
      ingredientId: string;
      batchYield: number | null;
      batchMethod?: string | null;
      lines: Array<{ inputIngredientId: string; qty: number }>;
    };
    response: ApiResult<{ ingredientId: string }>;
  };
  /** Record batches made: inputs come out of stock, the yield goes in. */
  'inventory:makeBatch': {
    request: { ingredientId: string; batches: number };
    response: ApiResult<{ made: number; resultingQty: number }>;
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
  /** The movement history screen: filtered, one page at a time, names resolved. */
  'inventory:searchMovements': {
    request: StockMovementSearch | undefined;
    response: ApiResult<StockMovementPage>;
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
      /** After partial refunds; fully refunded orders are not counted at all. */
      totalCents: number;
      partialRefundCents: number;
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
        mode: OrderMode;
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
      cashInCents: number;
      cashOutCents: number;
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
  /** Everything on the Reports page for one period (plus comparison KPIs), in one call. */
  'reports:business': {
    request: BusinessReportRequest;
    response: ApiResult<BusinessReport>;
  };

  // Customers
  'customers:list': {
    request: { search?: string; activeOnly?: boolean; limit?: number } | undefined;
    response: ApiResult<Customer[]>;
  };
  /**
   * One page of the Customers screen. `search` matches name, phone or house /
   * street; `zoneIds` keeps customers with a saved address in those delivery
   * zones (the shared DELIVERY_ZONES ids).
   */
  'customers:page': {
    request: {
      search?: string;
      zoneIds?: string[];
      sort?: CustomerListSort;
      offset?: number;
      limit?: number;
    };
    response: ApiResult<{ rows: CustomerListRow[]; total: number }>;
  };
  /** How many saved addresses name each area — the area picker puts the busiest first. */
  'customers:areaUsage': {
    request: { limit?: number } | undefined;
    response: ApiResult<Array<{ area: string; count: number }>>;
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
  /** Saved addresses across all customers whose house/street starts with the text typed. */
  'customers:searchAddresses': {
    request: { query: string; limit?: number };
    response: ApiResult<CustomerAddressMatch[]>;
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
  'customers:attachToOrder': {
    request: {
      orderId: string;
      customerId: string;
      addressId?: string | null;
      deliveryNotes?: string | null;
      /** Per-order snapshot name; the customer's master record is left untouched. */
      nameOverride?: string;
    };
    response: ApiResult<OrderSnapshot>;
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
      /** Everything is owed to the other till once (being queued, or waiting for the link). */
      sendingEverything: boolean;
      /** Changes from the other till that could not be saved here (kept and retried). */
      notSaved: number;
    }>;
  };
  'sync:triggerNow': {
    request: undefined;
    response: ApiResult<{ kicked: true }>;
  };
  'sync:sendEverything': {
    request: undefined;
    response: ApiResult<{ ok: true }>;
  };
  /** Forget the changes dropped past the waiting list's cap (after the other till sent everything again). */
  'sync:clearNotSaved': {
    request: undefined;
    response: ApiResult<{ cleared: number }>;
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
    /**
     * The cloud safety copy of today's data is uploaded first. If that fails
     * the call is refused (details.safetyCopyFailed) until the owner says to
     * go ahead without it.
     */
    request: { withoutSafetyCopy?: boolean } | undefined;
    response: ApiResult<{ relaunching: true }>;
  };
  /** The owner said no: drop the staged copy so the next start does not apply it. */
  'backup:cancelStagedRestore': {
    request: undefined;
    response: ApiResult<{ cancelled: boolean }>;
  };
  /** Are the backups working? Warnings in plain words, for the dashboard. */
  'backup:health': {
    request: undefined;
    response: ApiResult<{
      lastLocalAt: string | null;
      lastLocalError: { at: string; message: string } | null;
      cloudOn: boolean;
      lastCloudAt: string | null;
      lastCloudError: { at: string; message: string } | null;
      warnings: string[];
    }>;
  };

  // Audit trail (hash-chained; see apps/pos/electron/db/audit-chain.ts)
  'audit:verifyChain': {
    request: undefined;
    response: ApiResult<AuditTrailStatus>;
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
