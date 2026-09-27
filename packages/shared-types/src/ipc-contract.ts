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
  OrderStatus,
  PaymentMethod,
  Rider,
} from './order.js';
import type { FoodMade, OrderStockStatus, StockSettlement } from './order-stock.js';

/**
 * The stock half of a cancel or a full refund (see order-stock.ts). Needed
 * only when the order holds stock on this till.
 */
export interface OrderStockAnswer {
  /**
   * "Was the food made?" Required while the order is still with the kitchen
   * or ready (the till never guesses); once the food has left the shop only
   * 'made' is accepted, and it is the default. Ignored when the order holds
   * no stock here, and for a part refund that leaves money on the order.
   */
  foodMade?: FoodMade;
  /**
   * Sealed drinks (Drinks shelf) to put back although the food was made.
   * Omit for "every drink on the order", before it was handed over.
   */
  putBack?: string[];
  /**
   * The status the dialog showed. If the order has moved on since (the
   * kitchen tapped "Start preparing"), it is refused: "check again".
   */
  expectStatus?: OrderStatus;
}

/** An order after a cancel / refund, with what it did to stock. */
export type OrderSnapshotWithStock = OrderSnapshot & { stock: StockSettlement | null };
import type {
  CashMovement,
  CashMovementType,
  DrawerOpenResult,
  Shift,
  ShiftSummary,
} from './shift.js';
import type {
  DayNoteInput,
  DaypartsView,
  OwnerWeek,
  OwnerWeekRequest,
  ReportChannelsTab,
  ReportDayNote,
  ReportFoodStockTab,
  ReportMenuTab,
  ReportOverviewTab,
  ReportTabRequest,
  ReportTeamTab,
  ReportTrends,
  ReportWhenTab,
  SetDaypartsRequest,
} from './reports.js';
import type {
  PrinterConnectionConfig,
  PrintPolicy,
  PrintResult,
  PrinterTransport,
  ReceiptLogoRasterSet,
  ReceiptLogoStatus,
  ReceiptCopy,
  ReprintResult,
  SystemPrinterInfo,
} from './printer.js';
import type {
  Ingredient,
  Recipe,
  StockMovement,
  StockMovementReason,
  WasteReason,
  Supplier,
  PurchaseOrder,
  PurchaseOrderStatus,
  PurchaseOrderWithItems,
  RecordPurchaseResult,
  DrawerPayout,
  BatchRecipe,
  IngredientCategory,
  PriceKind,
  PriceHistoryEntry,
  TypedPricePer,
  StockMovementSearch,
  StockMovementPage,
} from './inventory.js';
import type {
  BatchCalc,
  CostAlertSettingsView,
  CostAlertsView,
  CostingTargetsView,
  ItemCostSheet,
  MenuCostsView,
  MissingCosts,
  RecipeCostPreview,
  SetCostAlertSettingsRequest,
  SetCostingTargetsRequest,
} from './costing.js';
import type {
  Customer,
  CustomerAddress,
  CustomerAddressMatch,
  CustomerListRow,
  CustomerListSort,
  CustomerWithAddresses,
} from './customer.js';
import type { MenuImportPreview, MenuImportSummary } from './menu-import.js';
import type { CostedRecipeCalc, RecipeCalc, RecipeCalcRequest, TypicalPicksView } from './recipe-calc.js';
import type { OrderHistoryFilter, OrderHistoryPage, RecentCounterOrder } from './order-history.js';
import type { AcknowledgeAlertsRequest, AlertSoundSettings, PendingAlerts } from './alerts.js';
import type {
  ReportVariance,
  StockCountDetail,
  StockCountFinish,
  StockCountScope,
  StockCountSummary,
  TillsSetting,
  TillsSettingView,
  VarianceRequest,
} from './stock-count.js';

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
  /** Who is signed in; a held stepping-in login comes back with `stepInHeld` (see AuthenticatedUser). */
  'auth:currentSession': {
    request: undefined;
    response: ApiResult<AuthenticatedUser | null>;
  };
  /**
   * A manager or the owner stepping in keeps their login: their OWN PIN or
   * password, before or after it is held. Anyone else's is refused
   * ('forbidden'). The answer is the login, now a normal one.
   */
  'auth:keepStepIn': {
    request: { pin: string };
    response: ApiResult<AuthenticatedUser>;
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
    request: { orderId: string; reason: string; approverPin: string } & OrderStockAnswer;
    /** The order after the cancel, plus what it did to stock (null: it held none here). */
    response: ApiResult<OrderSnapshotWithStock>;
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
    } & OrderStockAnswer;
    /** `stock` is null for a part refund that leaves money on the order (money only). */
    response: ApiResult<OrderSnapshotWithStock>;
  };
  /**
   * What cancelling (or fully refunding) this order would do to stock — the
   * "Was the food made?" question and the lines behind it — or, once done,
   * what it did. Read-only.
   */
  'orders:stockStatus': {
    request: { orderId: string };
    response: ApiResult<OrderStockStatus>;
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
   * The counter's Recent Orders: orders taken on THIS till in the shift open
   * now (or, with no shift open, today's), newest first, at most
   * RECENT_AT_COUNTER_LIMIT. Anyone who takes orders; no totals.
   * `orderNumber`: the one order of that same set with this WHOLE number
   * ("1043", "#1043" or the full "20260926-1043" off the receipt) — how an
   * order past the newest few is found. Never a part of a number.
   */
  'orders:recentAtCounter': {
    request: { orderNumber?: string } | undefined;
    response: ApiResult<RecentCounterOrder[]>;
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
  /**
   * Open the cash drawer with no sale ('no_sale'), or to count it while
   * closing the shift ('count' — managers and the owner, open shift only). A
   * cashier's no-sale open needs a manager's PIN or password. Saved and
   * audited before the drawer is pulsed.
   */
  'shifts:openDrawer': {
    request: { kind: 'no_sale' | 'count'; reason?: string | null; approverPin?: string };
    response: ApiResult<DrawerOpenResult>;
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
        /** At the bottom of receipts. '' = none; a till that never set one reads the shop's own site. */
        websiteLine?: string;
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
      /** Send '' to print no website (left out, a till reads the shop's own site). */
      websiteLine?: string;
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
  /** Just the drawer pulse, straight to the receipt printer (no order, no queue). printer.manage. */
  'printer:testDrawer': {
    request: undefined;
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
  /**
   * The order's customer paper again: the receipt (PAID), the bill (NOT PAID)
   * or the cancelled-order slip, whichever the order is now. A second or later
   * paper says DUPLICATE. A counter login needs a manager's PIN or password
   * for most duplicates of a paid receipt: then it is refused 'forbidden' with
   * details `{ needs: 'manager_pin' }`, and asked again with `approverPin`.
   * `copy: 'shop'` prints the SHOP COPY again (a manager's, always).
   */
  'printer:reprint': {
    request: { orderId: string; copy?: ReceiptCopy; approverPin?: string };
    response: ApiResult<ReprintResult>;
  };
  /** Kitchen ticket again, stamped REPRINT (only while the kitchen still has the order). */
  'printer:reprintKitchen': {
    request: { orderId: string };
    response: ApiResult<ReprintResult>;
  };
  /** How many times each order's receipt or bill was printed by hand (Reprint button). At most 100 ids. */
  'printer:reprintCounts': {
    request: { orderIds: string[] };
    response: ApiResult<Record<string, number>>;
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
      /** Omitted = worked out from the price: Rs 0 is 'unset' (not priced yet). */
      priceKind?: PriceKind;
      defaultSupplierId?: string | null;
      sku?: string | null;
      notes?: string | null;
      /** Omitted or null = guessed from the name. */
      category?: IngredientCategory | null;
      /** A key item: counted every week, watched for price jumps (costing spec Phase 8). */
      countWeekly?: boolean;
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
      /** 'free' = it costs nothing (price set to Rs 0); 'estimate' = a guess. Omitted = kept, or worked out from a new price. */
      priceKind?: PriceKind;
      defaultSupplierId?: string | null;
      sku?: string | null;
      notes?: string | null;
      isActive?: boolean;
      /** A key item: counted every week, watched for price jumps (costing spec Phase 8). */
      countWeekly?: boolean;
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
  /**
   * "Set price" (costing spec Phase 4): a price as it is bought — Rs X per kg
   * (or litre), for a pack of N, or per piece — kept exactly, with a line in
   * the price history. 'free' = it costs nothing (Rs 0); 'estimate' = a
   * guess. Batches made from it take the new price at once. COST_CAPABILITY.
   */
  'inventory:setPrice': {
    request: {
      ingredientId: string;
      per: TypedPricePer;
      /** Rs X, in paisa. Ignored for 'free'. */
      priceCents: number;
      /** N for 'pack': base units in one pack. */
      packSize?: number | null;
      priceKind?: 'set' | 'estimate' | 'free';
      notes?: string | null;
    };
    response: ApiResult<Ingredient>;
  };
  /** An ingredient's price history, newest first (COST_CAPABILITY). */
  'inventory:priceHistory': {
    request: { ingredientId: string; limit?: number };
    response: ApiResult<PriceHistoryEntry[]>;
  };
  /**
   * "Use the sheet's price" (costing spec Phase 6): the price the costing
   * sheet gave it (the menu file's, kept as a reference) becomes its price —
   * a typed ('manual') line in its price history. COST_CAPABILITY.
   */
  'inventory:useSheetPrice': {
    request: { ingredientId: string };
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
  /**
   * Record a batch made: inputs come out of stock, what was made goes in.
   * Whole batches (`batches`), or any amount of the batch item (`amount`, in
   * its base unit), which scales every input. Exactly one of the two. The
   * answer carries no costs: any login may record a batch.
   */
  'inventory:makeBatch': {
    request: { ingredientId: string; batches?: number; amount?: number };
    response: ApiResult<{ made: number; resultingQty: number }>;
  };

  // Inventory — the recipe calculator (read-only; menu.manage). Quantities
  // only: no rupee crosses these channels (costing:recipeCalc has the costs).
  /**
   * How much N of a dish, a deal or a dip (or an amount of a batch) needs:
   * the batches to make first (each once, in order), what comes straight
   * from stock, and every ingredient from scratch, with this till's stock
   * and what is short. Writes nothing.
   */
  'inventory:recipeCalc': {
    request: RecipeCalcRequest;
    response: ApiResult<RecipeCalc>;
  };
  /** A menu item's choice groups and the last 28 days' picks (sale counts only), for "the usual picks". */
  'inventory:typicalPicks': {
    request: { menuItemId: string };
    response: ApiResult<TypicalPicksView>;
  };
  /**
   * The same worked out again and printed on the receipt printer as a prep
   * list (no prices). A failed print is an answer (ok: false), never an
   * error that blocks anything.
   */
  'inventory:printPrepList': {
    request: RecipeCalcRequest;
    response: ApiResult<PrintResult>;
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
  /** A stock change by hand. Not a stock take: every stock take is one (inventory:stockCountOne). */
  'inventory:recordMovement': {
    request: {
      ingredientId: string;
      deltaQty: number;
      reason: 'delivery' | 'waste' | 'adjustment';
      notes?: string | null;
      /** Waste only: why it was thrown away ("other" when not given). */
      wasteReason?: WasteReason;
    };
    response: ApiResult<{ movementId: string; resultingQty: number }>;
  };

  // Inventory — stock takes (costing spec Phase 8). COST_CAPABILITY: they
  // show what stock is worth and what is missing; cashiers are refused.
  /** The stock takes: open ones first, then the newest. */
  'inventory:stockCountList': {
    request: { limit?: number } | undefined;
    response: ApiResult<StockCountSummary[]>;
  };
  /** One stock take with its sheet (and, once finished, its differences). */
  'inventory:stockCountGet': {
    request: { countId: string };
    response: ApiResult<StockCountDetail | null>;
  };
  /** Start one: the whole store room, the key items, or picked ingredients ('custom'). */
  'inventory:stockCountStart': {
    request: { scope: StockCountScope; ingredientIds?: string[]; notes?: string | null };
    response: ApiResult<StockCountDetail>;
  };
  /** What was counted so far (whole base units; null clears a line). */
  'inventory:stockCountSave': {
    request: { countId: string; lines: Array<{ ingredientId: string; countedQty: number | null }> };
    response: ApiResult<{ lineCount: number; countedCount: number }>;
  };
  /**
   * Finish it — one transaction: each counted line against SHOP stock, its
   * value, and a 'count' stock row setting this till's count. Asked again:
   * answers with what was written, writes nothing.
   */
  'inventory:stockCountFinish': {
    request: { countId: string };
    response: ApiResult<StockCountFinish>;
  };
  /** Drop one still being counted: nothing is written to stock. */
  'inventory:stockCountCancel': {
    request: { countId: string };
    response: ApiResult<{ cancelled: boolean }>;
  };
  /** The Stock button's "Stock take": one ingredient, counted and finished at once. */
  'inventory:stockCountOne': {
    request: { ingredientId: string; countedQty: number; notes?: string | null };
    response: ApiResult<StockCountFinish>;
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
  /** Newest first. `open`: only those still open (draft, ordered, part received), whatever their age. */
  'inventory:listPurchaseOrders': {
    request: { status?: PurchaseOrderStatus; open?: boolean; supplierId?: string; limit?: number } | undefined;
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
        /**
         * The price as it is bought (costing spec Phase 5): Rs X per kg /
         * litre, for a pack of N, or per piece — kept exactly as the line's
         * ordered pack. Or, the older way, `unitCostCents` per base unit.
         * Exactly one of the two.
         */
        price?: { per: TypedPricePer; priceCents: number; packSize?: number | null };
        unitCostCents?: number;
        notes?: string | null;
      }>;
    };
    response: ApiResult<PurchaseOrderWithItems>;
  };
  'inventory:setPurchaseOrderStatus': {
    request: { id: string; status: PurchaseOrderStatus };
    response: ApiResult<{ ok: true }>;
  };
  /**
   * Book a delivery in at what its bill says (costing spec Phase 5): per
   * line, what came and the bill amount for it (omitted = the ordered price
   * for that quantity). Whether a bill's price becomes the ingredient's
   * price: `usePrice` per line, as answered on screen; omitted, D1's guard
   * decides (yes for a delivery, within 10% of the usual price or not —
   * outside it the screen asks, with yes picked). `updateCosts` is the older
   * all-lines answer, used for a line that gives none.
   */
  'inventory:receiveDelivery': {
    request: {
      purchaseOrderId: string;
      receipts: Array<{ purchaseOrderItemId: string; qtyReceivedNow: number; billCents?: number; usePrice?: boolean }>;
      invoiceNo?: string | null;
      updateCosts?: boolean;
    };
    response: ApiResult<PurchaseOrderWithItems>;
  };
  /**
   * "Record a purchase" (costing spec Phase 5, kind 'quick'): what was bought
   * and what was paid for it, line by line, received at once. Supplier
   * optional. `paidFromDrawer` takes the total out of this till's open shift
   * as a payout, in the same transaction, so the drawer count reconciles.
   * Whether a line's price becomes the ingredient's price: `usePrice` as
   * answered on screen; omitted, D1's guard decides (yes within 10% of the
   * usual price, NO outside it). COST_CAPABILITY.
   */
  'inventory:recordPurchase': {
    request: {
      supplierId?: string | null;
      invoiceNo?: string | null;
      notes?: string | null;
      paidFromDrawer?: boolean;
      lines: Array<{ ingredientId: string; qty: number; billCents: number; usePrice?: boolean }>;
    };
    response: ApiResult<RecordPurchaseResult>;
  };
  /**
   * "Turn this payout into a purchase" (costing spec Phase 5, managers): a
   * free-text drawer payout becomes a purchase, linked once. The payout's
   * amount, and so the shift's expected cash, never changes. Asked again for
   * a payout already linked, it answers with that purchase and writes
   * nothing. COST_CAPABILITY.
   */
  'inventory:payoutToPurchase': {
    request: {
      cashMovementId: string;
      supplierId?: string | null;
      invoiceNo?: string | null;
      notes?: string | null;
      lines: Array<{ ingredientId: string; qty: number; billCents: number; usePrice?: boolean }>;
    };
    response: ApiResult<RecordPurchaseResult & { alreadyLinked: boolean }>;
  };
  /** Recent cash payouts from this till's drawer, newest first, with the purchase each is linked to (COST_CAPABILITY). */
  'inventory:listDrawerPayouts': {
    request: { sinceIso?: string; limit?: number } | undefined;
    response: ApiResult<DrawerPayout[]>;
  };

  // Costing (menu.manage = COST_CAPABILITY to read; settings.manage to change targets)
  /** Every menu item: cost to make, price, what you keep, food-cost chip; worst first on screen. */
  'costing:menuCosts': {
    request: undefined;
    response: ApiResult<MenuCostsView>;
  };
  /** One item's cost sheet: every line, the customer's picks, paid extras, leave-outs. */
  'costing:itemSheet': {
    request: { menuItemId: string };
    response: ApiResult<ItemCostSheet | null>;
  };
  /** What stops the till costing the menu: unpriced ingredients, items with no recipe, guesses… */
  'costing:missingCosts': {
    request: undefined;
    response: ApiResult<MissingCosts>;
  };
  'costing:getTargets': {
    request: undefined;
    response: ApiResult<CostingTargetsView>;
  };
  /** The owner's targets ("Use these", or edited). Needs settings.manage. */
  'costing:setTargets': {
    request: SetCostingTargetsRequest;
    response: ApiResult<CostingTargetsView>;
  };
  /** The recipe editor's live footer: the recipe as typed, costed, not saved. */
  'costing:recipeCost': {
    request: {
      menuItemId: string;
      lines: Array<{ ingredientId: string; qtyPerUnit: number; modifierId?: string | null }>;
    };
    response: ApiResult<RecipeCostPreview>;
  };
  /** The batch calculator: a batch recipe scaled to any amount, every input costed. */
  'costing:batchCalc': {
    request: { ingredientId: string; amount: number };
    response: ApiResult<BatchCalc>;
  };
  /** The recipe calculator with what it costs: inventory:recipeCalc's answer plus `costs`. COST_CAPABILITY. */
  'costing:recipeCalc': {
    request: RecipeCalcRequest;
    response: ApiResult<CostedRecipeCalc>;
  };
  /**
   * Costing → Alerts (costing spec Phase 6): price jumps, the Monday digest
   * of dishes moved across their target, batches that kept an old price —
   * not seen yet first. COST_CAPABILITY.
   */
  'costing:alerts': {
    request: undefined;
    response: ApiResult<CostAlertsView>;
  };
  /** "Seen": the alerts leave the list's top (managers and the owner). Answers with the list as it now stands. */
  'costing:markAlertsSeen': {
    request: { ids: string[] };
    response: ApiResult<CostAlertsView>;
  };
  /** The alert thresholds and key ingredients (Targets tab). COST_CAPABILITY to read… */
  'costing:getAlertSettings': {
    request: undefined;
    response: ApiResult<CostAlertSettingsView>;
  };
  /** …settings.manage to change (the owner). */
  'costing:setAlertSettings': {
    request: SetCostAlertSettingsRequest;
    response: ApiResult<CostAlertSettingsView>;
  };
  /**
   * How many tills take orders (costing spec Phase 8, owner question 3), with
   * the second-till link as it is now. COST_CAPABILITY to read…
   */
  'costing:getTills': {
    request: undefined;
    response: ApiResult<TillsSettingView>;
  };
  /** …settings.manage to change (the owner). */
  'costing:setTills': {
    request: TillsSetting;
    response: ApiResult<TillsSettingView>;
  };

  // Reports: one channel per tab of the Reports page (costing spec Phase 3),
  // each worked out in the Reports worker thread, not on the till's main
  // thread. The older one-figure channels went with Phase 2; the whole-page
  // `reports:business` with Phase 3.
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
  /** Overview: headline figures (and the comparison period's), payments, website vs till. */
  'reports:overview': {
    request: ReportTabRequest;
    response: ApiResult<ReportOverviewTab>;
  };
  /** When: sales by day and by hour. */
  'reports:when': {
    request: ReportTabRequest;
    response: ApiResult<ReportWhenTab>;
  };
  /** Menu: items and categories. */
  'reports:menu': {
    request: ReportTabRequest;
    response: ApiResult<ReportMenuTab>;
  };
  /** Channels & delivery: order types, riders, delivery areas. */
  'reports:channels': {
    request: ReportTabRequest;
    response: ApiResult<ReportChannelsTab>;
  };
  /** Food cost & stock: costs, so COST_CAPABILITY as well as report.view. */
  'reports:foodStock': {
    request: ReportTabRequest;
    response: ApiResult<ReportFoodStockTab>;
  };
  /** Team & leakage: staff, shifts and cash, discounts, refunds, cancelled orders, drawer opens. */
  'reports:team': {
    request: ReportTabRequest;
    response: ApiResult<ReportTeamTab>;
  };
  // The owner's week (costing spec Phase 7). Worked out in the Reports worker
  // like the tabs; report.view, with the cost lines for COST_CAPABILITY only.
  /**
   * The Dashboard "This week" card and the printed weekly sheet: five
   * numbers against last week and the ranked "Do this" list. Never rupee profit.
   */
  'reports:ownerWeek': {
    request: OwnerWeekRequest | undefined;
    response: ApiResult<OwnerWeek>;
  };
  /** Reports → Overview: today / week / month / year so far against before, and the last 12 months. */
  'reports:trends': {
    request: undefined;
    response: ApiResult<ReportTrends>;
  };
  /** Reports → When: a note for a day (Eid, rain, closed…). report.view; synced and audited. */
  'reports:addDayNote': {
    request: DayNoteInput;
    response: ApiResult<ReportDayNote>;
  };
  /** …and taking one off (kept in the history, marked removed). */
  'reports:removeDayNote': {
    request: { id: string };
    response: ApiResult<{ removed: boolean }>;
  };
  /** The parts of the day Reports → When splits sales into (report.view to read)… */
  'reports:getDayparts': {
    request: undefined;
    response: ApiResult<DaypartsView>;
  };
  /** …changed by the owner (settings.manage) on Costing → Targets. */
  'reports:setDayparts': {
    request: SetDaypartsRequest;
    response: ApiResult<DaypartsView>;
  };
  /**
   * Reports → Food cost & stock, "Between stock takes" (costing spec Phase
   * 8): what was used against what should have been, between two stock
   * takes (omitted: the latest two), and the real food cost when both were
   * full. Worked out in the Reports worker. report.view and COST_CAPABILITY.
   */
  'reports:variance': {
    request: VarianceRequest | undefined;
    response: ApiResult<ReportVariance>;
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

  // Sounds & order alerts (this till only; see shared-types/src/alerts.ts)
  /** Settings → Sounds. No login needed: the PIN screen rings for orders too. */
  'alerts:getSounds': {
    request: undefined;
    response: ApiResult<AlertSoundSettings>;
  };
  /** Save Settings → Sounds (manager or owner). Audited. */
  'alerts:setSounds': {
    request: AlertSoundSettings;
    response: ApiResult<AlertSoundSettings>;
  };
  /**
   * Website orders nobody has looked at yet, and website orders that did not
   * come in. Kept by the main process, so a screen that starts (or restarts)
   * after they arrived still rings. No login needed.
   */
  'alerts:getPending': {
    request: undefined;
    response: ApiResult<PendingAlerts>;
  };
  /** Seen / silenced / closed. Closing a failure card needs a login. */
  'alerts:acknowledge': {
    request: AcknowledgeAlertsRequest;
    response: ApiResult<PendingAlerts>;
  };
  /** Settings → Sounds → "Test the Windows notice" (manager or owner). */
  'alerts:testNotice': {
    request: undefined;
    response: ApiResult<{ shown: boolean }>;
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
