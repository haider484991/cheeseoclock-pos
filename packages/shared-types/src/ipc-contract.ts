/**
 * IPC contract — single source of truth for every channel between the Electron
 * main process and the renderer. Lives in shared-types so both `preload.ts`
 * (renderer-side façade) and `electron/ipc/handlers/*` (main-side handlers)
 * reference the same type.
 *
 * Convention: 'domain:verb' — e.g. 'auth:login', 'users:create'.
 */

import type { ApiResult } from './ipc.js';
import type { LicenceStatus } from './licence.js';
import type { AuthenticatedUser, User, Role } from './auth.js';
import type {
  Category,
  MenuItem,
  ModifierGroup,
  Modifier,
  Combo,
  TaxCategory,
  PrepStation,
  WebAvailability,
} from './menu.js';
import type {
  Order,
  OrderMode,
  OrderSnapshot,
  OrderStatus,
  PaymentMethod,
  Rider,
} from './order.js';
import type {
  AnyShopSettingCard,
  CameBy,
  CheckoutRules,
  FoodpandaTenderCheck,
  SaveDeliveryZonesRequest,
  SetShopSettingRequest,
  ShopSettingCard,
  ShopSettingKey,
} from './shop-settings.js';
import type { AnyTillSettingCard, OpeningFloatPrefill, SetTillSettingRequest, TillSettingKey } from './till-settings.js';
import type { TillPowerStatus } from './till-power.js';
import type { FoodMade, OrderStockStatus, StockSettlement } from './order-stock.js';
import type { OrderEditOp, OrderEditPreview, OrderEditSaved, OrderEditSaveInput } from './order-edit.js';
import type {
  DeletedTestsPage,
  DeleteTestOrderRequest,
  ListDeletedTestsRequest,
  TestDeletePreview,
  TestDeleteResult,
} from './test-orders.js';

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
  CashCount,
  CashMovement,
  CashMovementType,
  ClosedShift,
  DrawerOpenResult,
  Shift,
  ShiftCloseCheck,
  ShiftReportPrintResult,
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
  ReportProfitTab,
  ReportTabRequest,
  ReportTeamTab,
  DrawerLogPage,
  DrawerLogRequest,
  ReportTrends,
  ReportWhenTab,
  SetDaypartsRequest,
} from './reports.js';
import type {
  ChannelFeesView,
  MenuMapRequest,
  ReportMenuMap,
  SetChannelFeesRequest,
  WhatIfRequest,
  WhatIfResult,
} from './profit.js';
import type {
  PrinterConnectionConfig,
  PrintPolicy,
  PrintResult,
  PrinterTransport,
  ReceiptLogoRasterSet,
  ReceiptLogoStatus,
  ReceiptCopy,
  ReprintResult,
  OrderPapers,
  SystemPrinterInfo,
} from './printer.js';
import type {
  Ingredient,
  Recipe,
  StockMovement,
  StockMovementReason,
  WasteReasonId,
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
import type { MenuDeployKeyMade, MenuDeployView } from './menu-deploy-view.js';
import type { CostedRecipeCalc, RecipeCalc, RecipeCalcRequest, TypicalPicksView } from './recipe-calc.js';
import type { OrderHistoryFilter, OrderHistoryPage, RecentCounterOrder } from './order-history.js';
import type { AcknowledgeAlertsRequest, AlertSoundSettings, AlertWatch, PendingAlerts } from './alerts.js';
import type { PublishMenuSummary, SettingsPublishStatus, WebOrdersShiftPause } from './web-bridge.js';
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
  // Licence (readable before anyone logs in: the banner shows on the PIN screen too)
  'licence:status': {
    request: undefined;
    response: ApiResult<LicenceStatus>;
  };
  /** Paste a key. Owner only. A refused key changes nothing and says why. */
  'licence:activate': {
    request: { token: string };
    response: ApiResult<LicenceStatus>;
  };

  // System
  'system:getVersion': {
    request: undefined;
    response: ApiResult<{ version: string; isDev: boolean }>;
  };
  /**
   * Shop name, tagline and logo for the PIN screen — readable before anyone
   * logs in. `storeName` is this till's receipt name; `shopName` the website's
   * name for the shop ('shop.profile', both tills; public). Absent from an
   * older till.
   */
  'system:getBranding': {
    request: undefined;
    response: ApiResult<{ storeName: string; storeTagline: string | null; logoUrl: string | null; shopName?: string }>;
  };
  'system:getDeviceInfo': {
    request: undefined;
    response: ApiResult<{ deviceId: string; displayName: string; registeredAt: string }>;
  };
  'system:getSetupStatus': {
    request: undefined;
    response: ApiResult<{ completed: boolean; userCount: number }>;
  };
  /** The city for this till's delivery addresses ('delivery.city'); any signed-in user. */
  'system:getDeliveryCity': {
    request: undefined;
    response: ApiResult<{ city: string }>;
  };
  'system:completeOnboarding': {
    request: {
      storeName: string;
      storeTagline?: string;
      branchLine?: string;
      phoneLine?: string;
      footerLine?: string;
      logoUrl?: string;
      /** The shop's own website for the bottom of receipts; none when empty or absent. */
      websiteLine?: string;
      /** The city on this till's delivery addresses ('delivery.city'); absent = unchanged default. */
      deliveryCity?: string;
      /** 'karachi-dha-clifton' saves the built-in Karachi list; 'none' an empty list; absent = nothing saved. */
      deliveryAreas?: 'karachi-dha-clifton' | 'none';
      taxCategories: Array<{ name: string; rateBps: number }>;
      admin: { fullName: string; pin: string };
    };
    response: ApiResult<{ adminUserId: string }>;
  };
  /**
   * "Close the till?" is on screen (system:close-requested, CloseTillAsk).
   * Until the screen says so, the till closes by itself after 5 s (a screen
   * that cannot show the question cannot take orders either). No login
   * needed: the PIN screen asks too. `pending` false = the question is out
   * of date, and the screen drops it.
   */
  'system:closeShown': {
    request: { requestId: string };
    response: ApiResult<{ pending: boolean }>;
  };
  /**
   * The answer to "Close the till?": `close` true tells the website "not
   * accepting" (2 s at most) and then closes the till; false keeps it open.
   * No login needed: anyone at the counter can already press X, so the
   * question stops a slip, it is not a lock. `closing` false = the question
   * was out of date and nothing happens.
   */
  'system:closeAnswer': {
    request: { requestId: string; close: boolean };
    response: ApiResult<{ closing: boolean }>;
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
    /**
     * isOnWebsite: absent = on the website (the default). noDiscount (Category.noDiscount): absent = decided by its
     * name (the default); a value other than the name's answer needs the owner.
     */
    request: { name: string; displayOrder: number; colorHex: string; isOnWebsite?: boolean; noDiscount?: boolean };
    response: ApiResult<Category>;
  };
  'menu:updateCategory': {
    request: {
      id: string;
      name?: string;
      displayOrder?: number;
      colorHex?: string;
      isActive?: boolean;
      /** On the website (Category.isOnWebsite); absent = unchanged. */
      isOnWebsite?: boolean;
      /**
       * Never discounted (Category.noDiscount); absent = unchanged. A change of what the category does now needs the
       * owner. A rename without it keeps what the old name said.
       */
      noDiscount?: boolean;
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
      /** Where it sells on the website; absent = 'on' (the default). */
      webAvailability?: WebAvailability;
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
      /** Where it sells on the website; absent = unchanged. A delivery charge is always 'on'. */
      webAvailability?: WebAvailability;
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

  // Menu files from the costing PC (v0.7.32, shared-types menu-deploy.ts):
  // the website hands the newest file to ONE linked till, which puts it in
  // with the same safe update as menu:importApply (never a fresh start, a
  // backup copy first); the other till gets it through the link.
  /** Where this till stands (menu.manage). No network unless `withHistory` (then the website's last lines). */
  'menuDeploy:getStatus': {
    request: { withHistory?: boolean } | undefined;
    response: ApiResult<MenuDeployView>;
  };
  /** Ask the website now, and put the file in when the rules allow (menu.manage). */
  'menuDeploy:checkNow': {
    request: undefined;
    response: ApiResult<MenuDeployView>;
  };
  /**
   * The owner makes a new upload key for the costing PC (owner login). Only
   * its SHA-256 goes to the website; the key is returned ONCE and never
   * stored on the till. A new key stops the old one at once.
   */
  'menuDeploy:createKey': {
    request: undefined;
    response: ApiResult<MenuDeployKeyMade>;
  };
  /** What putting the website's file in would change — the normal import preview, never a fresh start (menu.manage). */
  'menuDeploy:preview': {
    request: { packageId: string };
    response: ApiResult<MenuImportPreview & { packageId: string }>;
  };
  /**
   * Put the website's file in now (menu.manage): the owner's tap in "Wait for
   * my OK", "Try again" after it failed (`retry`), or taking it over from a
   * till that stopped halfway (`takeOver`: the owner's login — the menu may
   * end up with doubled items).
   */
  'menuDeploy:apply': {
    request: { packageId: string; takeOver?: boolean; retry?: boolean };
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
      /** A counter order: how it came in, when the cashier tapped a chip before the first item. */
      cameBy?: CameBy | null;
    };
    response: ApiResult<Order>;
  };
  /**
   * How a counter order came in (Walk-in · Phone · WhatsApp; null = not
   * said). While the order is being rung up, any login that takes orders
   * sets it and the owner's automatic offers are worked out again. Once it
   * is sent it is locked: changing it needs a manager's PIN or password and
   * is audited (the offer on the order does not change then). Never on a
   * website or foodpanda order (they fill it in themselves).
   */
  'orders:setCameBy': {
    request: { orderId: string; cameBy: CameBy | null; approverPin?: string };
    response: ApiResult<OrderSnapshot>;
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
  /**
   * The counter's "Order notes" box on an order still being rung up with no
   * customer typed in (with one, the note goes with orders:attachCustomer /
   * customers:attachToOrder). Blank clears it. Printed on the kitchen ticket
   * and the bill.
   */
  'orders:setNote': {
    request: { orderId: string; note: string | null };
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
      /**
       * A Free order (v0.7.36): 100% off every line, the value deals and the
       * delivery charge included. Needs a manager's PIN (always) and a
       * reason; `discountType`/`value` must be percent 100.
       */
      free?: boolean;
    };
    response: ApiResult<OrderSnapshot>;
  };
  /**
   * Edit order (v0.7.36): the order the kitchen already has, as `ops` would
   * leave it — worked out inside a transaction that is rolled back, so
   * nothing is written, printed or synced. With no ops: the order as it is
   * and the version an edit starts from. Refused for an order that can't be
   * changed now (pos-domain orderEditBlock), in its words.
   */
  'orders:previewEdit': {
    request: { orderId: string; ops: OrderEditOp[] };
    response: ApiResult<OrderEditPreview>;
  };
  /**
   * Save an edit (v0.7.36): the same ops for real, in one transaction, only
   * while the order's lines and discount are still as `baseKey` says (else
   * "it was changed while you were editing"). A manager's PIN when something the kitchen has comes off,
   * the discount is over the limit, or for a Free order; a reason when
   * something comes off or for a Free order; "Was the food made?" for each
   * line the kitchen had that goes down or comes off. The kitchen gets an
   * ADDED / REMOVED slip after the commit.
   */
  'orders:saveEdit': {
    request: OrderEditSaveInput;
    response: ApiResult<OrderEditSaved>;
  };
  'orders:clearDiscount': {
    /**
     * Taking the shop's foodpanda deal off an order needs a manager's PIN or
     * password. On one of the owner's automatic offers it takes the offer off
     * THIS order (it stays off, Rs 0; no PIN: the bill only goes up); on an
     * offer taken off it puts the offers back.
     */
    request: { orderId: string; approverPin?: string };
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
  /**
   * The delivery area on the till's customer panel changed (owner, 28 Sep
   * 2026: "if delivery area selected the delivery fee should be
   * automatically added"). The main process puts the area's fee item on a
   * delivery order (Settings → Delivery areas), swaps a charge at another
   * fee for it, and takes the charge off when the area is cleared; never a
   * second one, never on foodpanda or a website order. `area` null =
   * cleared. Only when the area CHANGES (a charge taken off by hand stays
   * off); `putBack` = the row's "Put it back": the area's charge whatever.
   * The customer save at Send and Pay (customers:attachToOrder) does the
   * same with the saved address's area, in its own transaction.
   * `phone`: the phone typed on the panel (trimmed, at most 30 characters),
   * for the add-on rule while the order has no phone of its own yet: a
   * counter delivery whose phone has another delivery still in the shop
   * (sent to the kitchen, being made or Ready) goes with it, and no second
   * charge goes on (OrderSnapshot.addOnTo). Null or left out = none typed.
   */
  'orders:setDeliveryArea': {
    request: { orderId: string; area: string | null; putBack?: boolean; phone?: string | null };
    response: ApiResult<OrderSnapshot>;
  };
  'orders:tender': {
    request: {
      orderId: string;
      payments: Array<{
        method: PaymentMethod;
        amountCents: number;
        tenderedCents?: number | null;
        /** On a foodpanda order: foodpanda's order number (Settings → foodpanda → checks). */
        referenceNo?: string | null;
      }>;
      /** A foodpanda order: the total the tablet shows, kept with its channel terms. */
      foodpanda?: FoodpandaTenderCheck | null;
    };
    response: ApiResult<OrderSnapshot>;
  };
  /**
   * Cancel an unpaid order (a manager's PIN). `payRiderForTrip`: an order sent
   * out with an outside rider who keeps a delivery charge, not paid yet and
   * with nothing paid to him yet, must say whether he is paid for the trip
   * (the owner, 2 Oct 2026: "pay the rider's fee if they went"). true = one
   * payout of what he keeps, linked to the order, and the drawer opens (only
   * while a shift is open on this till); false = nothing. Missing on such an
   * order, or true on any other, is refused in plain words.
   */
  'orders:void': {
    request: { orderId: string; reason: string; approverPin: string; payRiderForTrip?: boolean } & OrderStockAnswer;
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
  /**
   * Deleting a TEST order (migration 0043) — the owner (admin) only, with the
   * owner's PIN or password typed again. What the dialog shows first:
   * whether it may be deleted (and why not, in plain words), its stock, its
   * cash per shift, the kitchen slip and the website. Nothing is written.
   */
  'orders:testDeletePreview': {
    request: { orderId: string };
    response: ApiResult<TestDeletePreview>;
  };
  /**
   * Delete it: the order and its payments soft-deleted, its stock put back or
   * booked as waste, its waiting FBR rows skipped — one transaction, synced
   * and audited. It can't be brought back.
   */
  'orders:deleteTest': {
    request: DeleteTestOrderRequest;
    response: ApiResult<TestDeleteResult>;
  };
  /** The owner's list of deleted test orders, by when the order was taken. Read-only. */
  'orders:listDeletedTests': {
    request: ListDeletedTestsRequest;
    response: ApiResult<DeletedTestsPage>;
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
  /**
   * Send out (owner, 2 Oct 2026: "Ready delivery -> Send out"): a delivery
   * the kitchen has goes out with an outside rider: out for delivery, no
   * rider named, and what the rider keeps frozen on the order
   * (order.riderKeepsCents). Any login that takes orders; no manager PIN. The
   * customer's bill prints with it (Settings → Printers), once per order
   * across both tills.
   *
   * `riderAlreadyPaid` (one trip, one fee): true when the box showed the
   * rider was already paid on another order of this customer today
   * (OrderSnapshot.riderPaidEarlier) and nobody tapped 'Charge again'. He
   * then keeps nothing on this order (no payout at Send out, none at
   * Delivered). The till checks it again; with no such order it refuses
   * and nothing is sent. Absent or false: the order's own charge, as before.
   *
   * `payRiderForTrip` (an add-on that now goes alone, OrderSnapshot.goesAlone):
   * true pays the outside rider the area's charge for this trip from the
   * drawer, with a manager's PIN or password (`approverPin`, as a cancel's
   * trip payout has): one payout linked to the order and one drawer row, and
   * the drawer opens. The till checks it again; on an order that does not go
   * alone it refuses and nothing is sent. Absent or false: nothing is paid.
   *
   * `riderPayment` (Send out's "Paid now", e2e fix A): the outside rider pays
   * the shop as the order leaves — what orders:riderPaid takes, in the same
   * step: sent out and paid, or (any refusal, e.g. no shift open) neither,
   * with nothing printed. Only then does the bill print, once, so its SHOP
   * COPY says RIDER PAID THE SHOP. `riderKeepsCents` is what the box showed
   * he keeps; it must be what Send out freezes. Absent: Send out alone.
   */
  'orders:sendOut': {
    request: {
      orderId: string;
      riderAlreadyPaid?: boolean;
      payRiderForTrip?: boolean;
      approverPin?: string;
      riderPayment?: { method: PaymentMethod; referenceNo?: string | null; riderKeepsCents: number };
    };
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
   *
   * `riderKeepsCents`: on an order sent out with an outside rider (Send out),
   * what the window showed he keeps (snap.order.riderKeepsCents, unchanged).
   * It must still be the order's frozen value, or nothing is taken ("This
   * order changed since this window opened…"); absent (or null) for one of
   * the shop's own riders. His payment is still the full total: the till
   * splits a wallet payment itself.
   *
   * `refusedItem`: Delivered + Pay with "Customer refused an item" (outside
   * rider only; refused on any other order). The till records that the
   * item's part refund is still owed (OrderSnapshot.refusedItem) until a
   * refund on the order settles it.
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
      riderKeepsCents?: number | null;
      refusedItem?: boolean;
    };
    response: ApiResult<OrderSnapshot>;
  };
  /**
   * Rider paid (owner, 2 Oct 2026: Send out asks "Has the rider paid the
   * shop?" -> Paid now): an outside rider pays the shop while he is still
   * out. Cash, EasyPaisa or JazzCash (a card is refused); the till records
   * the full total and pays his kept delivery charge out of it in the same
   * step, so the drawer expects what he hands in. The order stays out for
   * delivery (the customer still pays him at the door); Delivered closes it
   * later with no payment. `riderKeepsCents` is what the window showed he
   * keeps (snap.order.riderKeepsCents, unchanged): if the order changed
   * since, nothing is taken. Any login that takes orders; no manager PIN. A
   * shift must be open on this till.
   */
  'orders:riderPaid': {
    request: {
      orderId: string;
      method: PaymentMethod;
      referenceNo?: string | null;
      riderKeepsCents: number;
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
  /**
   * Close the shift with the drawer count. A manager or the owner signed in
   * closes it; on a cashier's login a manager's PIN or password
   * (`approverPin`) does, and the shift is closed by that manager. Unpaid
   * orders on this till are carried over to the next shift only with
   * `carryOverReason` (owner, 2026-09-27); `notes` is the closing note.
   * `carryOverOrderIds`: the unpaid orders the close box showed — a close
   * that would carry over any other (one that came in during the count) is
   * refused. On a manager's PIN the reply leaves out `expectedCashCents`:
   * the cashier's screen never shows the expected cash.
   * `countedNotes`: the drawer counted note by note (Close shift's note
   * counter). When it is sent, `countedCashCents` must equal its sum, or the
   * close is refused; it is kept on the shift (migration 0050).
   * The reply also says what became of the shift report (`reportPrint`: it
   * prints after the close is saved and never holds it up) and, for the
   * manager or owner signed in only, `summary`: the takings as the close
   * saved them. A manager's PIN close gets no summary.
   */
  'shifts:close': {
    request: {
      shiftId: string;
      countedCashCents: number;
      notes?: string | null;
      approverPin?: string;
      carryOverReason?: string | null;
      carryOverOrderIds?: string[];
      countedNotes?: CashCount | null;
    };
    response: ApiResult<ClosedShift>;
  };
  /**
   * Before the count: who closes (a cashier's login needs `approverPin`),
   * the unpaid orders the close will carry over, and whether closing it
   * pauses website orders (`pausesWebsiteOrders`). Never the expected cash.
   */
  'shifts:closeCheck': {
    request: { shiftId: string; approverPin?: string };
    response: ApiResult<ShiftCloseCheck>;
  };
  /**
   * A closed shift's report on this till's receipt printer again (v0.7.35):
   * the figures saved at the close, never worked out again, with this till's
   * section switches now. `again: false` (Try again) prints the ORIGINAL
   * when this till's try at it did not come out; otherwise, and by default,
   * it is a DUPLICATE 'Reprint #N'. The owner prints any closed shift with a
   * saved report, from either till; a manager only this till's shift, within
   * SHIFT_REPORT_AGAIN_MS of its close. A cashier's login needs a manager's
   * PIN or password: refused 'forbidden' with details
   * `{ needs: 'manager_pin' }` (and `wrongSecret: true` for a wrong one),
   * then asked again with `approverPin`; that manager's or owner's rules
   * apply. It waits for the printer and says what came out.
   */
  'shifts:printReport': {
    request: { shiftId: string; again?: boolean; approverPin?: string };
    response: ApiResult<ShiftReportPrintResult>;
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
  /**
   * What the Open shift box starts the float count on (this till's setting:
   * its last count, or the owner's fixed float). Any signed-in login.
   */
  'shifts:openingFloat': {
    request: undefined;
    response: ApiResult<OpeningFloatPrefill>;
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
   * closing the shift ('count' — managers and the owner, or a cashier with a
   * manager's PIN while that manager closes the shift; open shift only). A
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
      /**
       * Website orders paused by the till itself because no shift is open on
       * it (owner, 2026-09-27); null when not paused. The owner's `enabled`
       * switch is untouched by it.
       */
      shiftPause: WebOrdersShiftPause | null;
      /**
       * The owner's settings on the website (the settings block of the menu
       * publish: delivery areas and fees, the pick-up offer): "Website
       * updated 14:02", "Waiting to reach the website", "Website not
       * updated: …". Absent from an older till.
       */
      settingsPublish?: SettingsPublishStatus;
      /**
       * The shop's details, hours, website words and home lineup on the
       * website (THE SHOP BLOCK, web-bridge.ts): the same words as
       * settingsPublish. Absent from an older till.
       */
      shopPublish?: SettingsPublishStatus;
      /**
       * The home page's featured items the website said it can't find on its
       * menu (their cards are hidden); null = it has not said (an older
       * website, or no publish yet). Absent from an older till.
       */
      homeMissing?: string[] | null;
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
  /** Serialize the active menu and PUT it to the website (with the photos it had to leave out). */
  'webBridge:publishMenu': {
    request: undefined;
    response: ApiResult<PublishMenuSummary>;
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
        /** The owner's extra lines under the thank-you line (none to three). */
        extraLines?: string[];
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
      /** Left out: the extra lines stored are kept (they have their own card, settings:setTill). */
      extraLines?: string[];
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
  /**
   * What the order's print button would print now — the bill, the receipt or
   * the cancelled-order slip, how many of it printed before and the DUPLICATE
   * number the press would carry — and every paper the order had on either
   * till, as each was marked. Read-only. Signed in, and the same orders as
   * printer:reprint (a counter login: the board and this shift's).
   */
  'printer:orderPapers': {
    request: { orderId: string };
    response: ApiResult<OrderPapers>;
  };
  /**
   * "Try again" on the failed-print note: the receipt or kitchen job the till
   * gave up on is sent again as it was, so the paper the till prints by
   * itself stays the ORIGINAL. Signed in, and the same orders as
   * printer:reprint. `requeued: false` when there was nothing to try again.
   */
  'printer:retryJob': {
    request: { jobId: string };
    response: ApiResult<{ requeued: boolean }>;
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
      /**
       * Waste only: why it was thrown away ("other" when not given) — the id
       * of a reason shown on the Waste screen (Settings → Kitchen & stock).
       */
      wasteReason?: WasteReasonId;
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
  /** Every menu item: cost to make, price, food-cost chip, and what you keep (profit.view only); worst first on screen. */
  'costing:menuCosts': {
    request: undefined;
    response: ApiResult<MenuCostsView>;
  };
  /** One item's cost sheet: every line, the customer's picks, paid extras, leave-outs (what you keep and the price to hit target: profit.view only). */
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
  /**
   * Costing → Targets & fees (costing spec Phase 9): foodpanda's commission,
   * payment fees and what a delivery costs in rider. COST_CAPABILITY to read…
   */
  'costing:getChannelFees': {
    request: undefined;
    response: ApiResult<ChannelFeesView>;
  };
  /** …settings.manage to change (the owner). */
  'costing:setChannelFees': {
    request: SetChannelFeesRequest;
    response: ApiResult<ChannelFeesView>;
  };
  /**
   * Costing → What-if (costing spec 4.9): new ingredient or menu prices tried
   * against the last 4 weeks' sales — nothing is saved or changed on the
   * till. COST_CAPABILITY and profit.view.
   */
  'costing:whatIf': {
    request: WhatIfRequest;
    response: ApiResult<WhatIfResult>;
  };

  // The owner's shop rules (Settings → foodpanda …; shop-settings.ts). One
  // pair for every key, the key's Zod schema checked in the main process.
  // Owner only (settings.manage): a manager or a cashier is refused in the
  // main process, and nothing is written.
  /** One Settings card: the value in use, who changed it last, its history. */
  'settings:getBusiness': {
    request: { key: ShopSettingKey };
    response: ApiResult<AnyShopSettingCard>;
  };
  /** Save a card (or "Put back the default", which writes the default's values). Synced and audited. Never 'delivery.zones'. */
  'settings:setBusiness': {
    request: SetShopSettingRequest;
    response: ApiResult<AnyShopSettingCard>;
  };
  // The owner's settings that belong to THIS till (till-settings.ts: the
  // receipt's extra lines, the opening float, this computer). Never synced.
  // Owner only (settings.manage), checked in the main process.
  /** One "this till" card: the value in use, who changed it last, its history. */
  'settings:getTill': {
    request: { key: TillSettingKey };
    response: ApiResult<AnyTillSettingCard>;
  };
  /** Save a "this till" card (or put its default back). Audited. */
  'settings:setTill': {
    request: SetTillSettingRequest;
    response: ApiResult<AnyTillSettingCard>;
  };
  // This computer (Settings → Online orders; till-power.ts): what the till is
  // doing with the computer it runs on. Owner only (settings.manage), checked
  // in the main process, like the "this till" cards.
  /** Is this computer held awake now, will Windows open the till at sign-in, when did it last sleep. */
  'power:getStatus': {
    request: undefined;
    response: ApiResult<TillPowerStatus>;
  };
  /**
   * "Turn it back on": puts the start-up entry back on in Windows (also when
   * Task Manager switched it off), and keeps the computer awake again if it
   * should be, per the saved setting.
   */
  'power:turnBackOn': {
    request: undefined;
    response: ApiResult<TillPowerStatus>;
  };
  /**
   * Settings → Delivery areas: save the areas and fees (or put back the
   * default) AND the "Delivery Charge (Rs N)" menu items they need, in ONE
   * transaction: a name-based id per fee, today's items adopted, an item no
   * area uses switched off (never deleted). Owner only; synced and audited.
   * The website gets the areas by themselves, with only their charge items
   * (the block alone) — never the till's unpublished menu changes.
   */
  'settings:saveDeliveryZones': {
    request: SaveDeliveryZonesRequest;
    response: ApiResult<ShopSettingCard<'delivery.zones'>>;
  };
  /**
   * What the counter needs to take an order, for any signed-in login: the
   * foodpanda deal's % and label, what Pay asks. Never commission or costs.
   */
  'checkout:getRules': {
    request: undefined;
    response: ApiResult<CheckoutRules>;
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
  /**
   * Profit (costing spec Phase 9): the waterfall from sales to profit before
   * overheads, by channel and by category. profit.view and COST_CAPABILITY.
   */
  'reports:profit': {
    request: ReportTabRequest;
    response: ApiResult<ReportProfitTab>;
  };
  /**
   * Reports → Menu, the menu map (costing spec 4.8): each category's dishes
   * by how popular and how profitable, in plain words. Omitted dates: the
   * last 28 days. profit.view and COST_CAPABILITY.
   */
  'reports:menuMap': {
    request: MenuMapRequest | undefined;
    response: ApiResult<ReportMenuMap>;
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
  /**
   * The cash drawer log (migration 0042): every time the till opened the
   * drawer — cash sales, refunds, cash in and out, the float, counting, no
   * sale, tests — who, why, for how much, and whether it opened. Newest
   * first, a page at a time. report.view (the owner).
   */
  'reports:drawerLog': {
    request: DrawerLogRequest;
    response: ApiResult<DrawerLogPage>;
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
   * Website orders nobody has looked at yet, website orders that did not
   * come in, and website orders the website cancelled while the kitchen had
   * them. Kept by the main process, so a screen that starts (or restarts)
   * after they arrived still rings; after a restart of the till itself, the
   * unseen website orders (12 hours back) and the open "website cancelled"
   * cards come back from the database. No login needed: while nobody is
   * signed in, every card's customerPhone is null.
   */
  'alerts:getPending': {
    request: undefined;
    response: ApiResult<PendingAlerts>;
  };
  /**
   * Seen / silenced / closed. Seen is kept across a restart
   * (web_order_imports.alert_seen_at), and so is closing a "website
   * cancelled" card (cancel_noted_at). Closing a card needs a login. The
   * answer is the pending list, as alerts:getPending gives it.
   */
  'alerts:acknowledge': {
    request: AcknowledgeAlertsRequest;
    response: ApiResult<PendingAlerts>;
  };
  /**
   * What the PIN screen shows between logins: website orders paused on this
   * till because no shift is open, orders waiting too long, kitchen tickets
   * this till gave up printing, and website orders the website has not
   * confirmed. No login needed (the PIN screen): ids, order numbers,
   * statuses, minutes and times only — never a name, phone, address, website
   * address or password. The main process sends 'alerts:watch-changed' (no
   * payload) when part of it changes; a part it cannot read comes back empty.
   */
  'alerts:getWatch': {
    request: undefined;
    response: ApiResult<AlertWatch>;
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
