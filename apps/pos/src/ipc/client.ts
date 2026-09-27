/**
 * Renderer-side IPC client. Wraps `window.api` so React Query / components
 * deal with promises that resolve to plain data or throw on error,
 * rather than the raw ApiResult discriminated union.
 *
 * Components should never reach into window.api directly — use this client.
 */

import type {
  ApiResult,
  ApiError,
  IpcRequest,
} from '@cheeseoclock/shared-types';
import { STEP_IN_HELD } from '@cheeseoclock/shared-types';

export class IpcError extends Error {
  readonly code: ApiError['code'];
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
  constructor(error: ApiError) {
    super(error.message);
    this.code = error.code;
    if (error.details) this.details = error.details;
    this.retryable = error.retryable ?? false;
    this.name = 'IpcError';
  }
}

/** Fired when the till says nobody is logged in any more (idle timeout, 12 h cap, user switched off). */
export const SESSION_ENDED_EVENT = 'coc:session-ended';
/**
 * Fired when the till is holding a manager's stepping-in login until their
 * PIN is typed again (AuthenticatedUser.stepInHeld): the page stays, a PIN
 * box goes over it.
 */
export const STEP_IN_HELD_EVENT = 'coc:step-in-held';

async function unwrap<T>(p: Promise<ApiResult<T>>): Promise<T> {
  const result = await p;
  if (result.ok) return result.data;
  if (result.error.code === 'unauthenticated' && typeof window !== 'undefined') {
    const held = result.error.details?.['stepIn'] === STEP_IN_HELD;
    window.dispatchEvent(new CustomEvent(held ? STEP_IN_HELD_EVENT : SESSION_ENDED_EVENT));
  }
  throw new IpcError(result.error);
}

export const ipc = {
  system: {
    getVersion: () => unwrap(window.api.system.getVersion()),
    getDeviceInfo: () => unwrap(window.api.system.getDeviceInfo()),
    getBranding: () => unwrap(window.api.system.getBranding()),
    getSetupStatus: () => unwrap(window.api.system.getSetupStatus()),
    completeOnboarding: (input: IpcRequest<'system:completeOnboarding'>) =>
      unwrap(window.api.system.completeOnboarding(input)),
  },
  auth: {
    login: (pin: string) => unwrap(window.api.auth.login({ pin })),
    logout: () => unwrap(window.api.auth.logout()),
    currentSession: () => unwrap(window.api.auth.currentSession()),
    activity: () => unwrap(window.api.auth.activity()),
    /** A manager stepping in keeps their login with their own PIN or password. */
    keepStepIn: (pin: string) => unwrap(window.api.auth.keepStepIn({ pin })),
    verifyManagerPin: (pin: string) =>
      unwrap(window.api.auth.verifyManagerPin({ pin })),
  },
  users: {
    list: () => unwrap(window.api.users.list()),
    create: (input: IpcRequest<'users:create'>) => unwrap(window.api.users.create(input)),
    update: (input: IpcRequest<'users:update'>) => unwrap(window.api.users.update(input)),
    deactivate: (id: string) => unwrap(window.api.users.deactivate({ id })),
  },
  menu: {
    listCategories: (input?: IpcRequest<'menu:listCategories'>) =>
      unwrap(window.api.menu.listCategories(input)),
    createCategory: (input: IpcRequest<'menu:createCategory'>) =>
      unwrap(window.api.menu.createCategory(input)),
    updateCategory: (input: IpcRequest<'menu:updateCategory'>) =>
      unwrap(window.api.menu.updateCategory(input)),
    deleteCategory: (id: string) => unwrap(window.api.menu.deleteCategory({ id })),
    listItems: (input?: IpcRequest<'menu:listItems'>) =>
      unwrap(window.api.menu.listItems(input)),
    findItemByBarcode: (barcode: string) =>
      unwrap(window.api.menu.findItemByBarcode({ barcode })),
    createItem: (input: IpcRequest<'menu:createItem'>) =>
      unwrap(window.api.menu.createItem(input)),
    updateItem: (input: IpcRequest<'menu:updateItem'>) =>
      unwrap(window.api.menu.updateItem(input)),
    deleteItem: (id: string) => unwrap(window.api.menu.deleteItem({ id })),
    listModifierGroupsForItem: (menuItemId: string) =>
      unwrap(window.api.menu.listModifierGroupsForItem({ menuItemId })),
    setItemModifierGroups: (input: IpcRequest<'menu:setItemModifierGroups'>) =>
      unwrap(window.api.menu.setItemModifierGroups(input)),
    listModifierGroups: () => unwrap(window.api.menu.listModifierGroups()),
    createModifierGroup: (input: IpcRequest<'menu:createModifierGroup'>) =>
      unwrap(window.api.menu.createModifierGroup(input)),
    updateModifierGroup: (input: IpcRequest<'menu:updateModifierGroup'>) =>
      unwrap(window.api.menu.updateModifierGroup(input)),
    deleteModifierGroup: (id: string) =>
      unwrap(window.api.menu.deleteModifierGroup({ id })),
    createModifier: (input: IpcRequest<'menu:createModifier'>) =>
      unwrap(window.api.menu.createModifier(input)),
    updateModifier: (input: IpcRequest<'menu:updateModifier'>) =>
      unwrap(window.api.menu.updateModifier(input)),
    deleteModifier: (id: string) => unwrap(window.api.menu.deleteModifier({ id })),
    listCombos: (input?: IpcRequest<'menu:listCombos'>) =>
      unwrap(window.api.menu.listCombos(input)),
    importPick: () => unwrap(window.api.menu.importPick()),
    importPreview: (fresh: boolean) => unwrap(window.api.menu.importPreview({ fresh })),
    importApply: (fresh = false) => unwrap(window.api.menu.importApply({ fresh })),
    listTaxCategories: () => unwrap(window.api.menu.listTaxCategories()),
    createTaxCategory: (input: IpcRequest<'menu:createTaxCategory'>) =>
      unwrap(window.api.menu.createTaxCategory(input)),
    updateTaxCategory: (input: IpcRequest<'menu:updateTaxCategory'>) =>
      unwrap(window.api.menu.updateTaxCategory(input)),
    deleteTaxCategory: (id: string) =>
      unwrap(window.api.menu.deleteTaxCategory({ id })),
  },
  orders: {
    create: (input: IpcRequest<'orders:create'>) => unwrap(window.api.orders.create(input)),
    list: (input?: IpcRequest<'orders:list'>) => unwrap(window.api.orders.list(input)),
    history: (input?: IpcRequest<'orders:history'>) => unwrap(window.api.orders.history(input)),
    /** This till's orders of the shift open now, for the counter's Recent Orders; or the one with this whole number. */
    recentAtCounter: (orderNumber?: string) =>
      unwrap(window.api.orders.recentAtCounter(orderNumber ? { orderNumber } : undefined)),
    get: (id: string) => unwrap(window.api.orders.get({ id })),
    addItem: (input: IpcRequest<'orders:addItem'>) =>
      unwrap(window.api.orders.addItem(input)),
    updateItemQuantity: (input: IpcRequest<'orders:updateItemQuantity'>) =>
      unwrap(window.api.orders.updateItemQuantity(input)),
    removeItem: (input: IpcRequest<'orders:removeItem'>) =>
      unwrap(window.api.orders.removeItem(input)),
    updateItemOptions: (input: IpcRequest<'orders:updateItemOptions'>) =>
      unwrap(window.api.orders.updateItemOptions(input)),
    applyDiscount: (input: IpcRequest<'orders:applyDiscount'>) =>
      unwrap(window.api.orders.applyDiscount(input)),
    clearDiscount: (orderId: string) =>
      unwrap(window.api.orders.clearDiscount({ orderId })),
    setMode: (input: IpcRequest<'orders:setMode'>) => unwrap(window.api.orders.setMode(input)),
    resumeDraft: () => unwrap(window.api.orders.resumeDraft()),
    discardDraft: (orderId: string) => unwrap(window.api.orders.discardDraft({ orderId })),
    tender: (input: IpcRequest<'orders:tender'>) => unwrap(window.api.orders.tender(input)),
    void: (input: IpcRequest<'orders:void'>) => unwrap(window.api.orders.void(input)),
    refund: (input: IpcRequest<'orders:refund'>) => unwrap(window.api.orders.refund(input)),
    /** What cancelling / refunding would do to stock ("Was the food made?"), or what it did. */
    stockStatus: (orderId: string) => unwrap(window.api.orders.stockStatus({ orderId })),
    attachCustomer: (input: IpcRequest<'orders:attachCustomer'>) =>
      unwrap(window.api.orders.attachCustomer(input)),
    detachCustomer: (orderId: string) =>
      unwrap(window.api.orders.detachCustomer({ orderId })),
    // Live tracking
    listActive: (input?: IpcRequest<'orders:listActive'>) =>
      unwrap(window.api.orders.listActive(input)),
    sendToKitchen: (orderId: string) =>
      unwrap(window.api.orders.sendToKitchen({ orderId })),
    markPreparing: (orderId: string) =>
      unwrap(window.api.orders.markPreparing({ orderId })),
    markReady: (orderId: string) => unwrap(window.api.orders.markReady({ orderId })),
    assignRider: (input: IpcRequest<'orders:assignRider'>) =>
      unwrap(window.api.orders.assignRider(input)),
    unassignRider: (orderId: string) =>
      unwrap(window.api.orders.unassignRider({ orderId })),
    markServed: (input: IpcRequest<'orders:markServed'>) =>
      unwrap(window.api.orders.markServed(input)),
    markDelivered: (input: IpcRequest<'orders:markDelivered'>) =>
      unwrap(window.api.orders.markDelivered(input)),
  },
  riders: {
    list: (input?: IpcRequest<'riders:list'>) => unwrap(window.api.riders.list(input)),
    create: (input: IpcRequest<'riders:create'>) => unwrap(window.api.riders.create(input)),
    update: (input: IpcRequest<'riders:update'>) => unwrap(window.api.riders.update(input)),
    deactivate: (id: string) => unwrap(window.api.riders.deactivate({ id })),
  },
  shifts: {
    current: () => unwrap(window.api.shifts.current()),
    open: (input: IpcRequest<'shifts:open'>) => unwrap(window.api.shifts.open(input)),
    close: (input: IpcRequest<'shifts:close'>) => unwrap(window.api.shifts.close(input)),
    list: (input?: IpcRequest<'shifts:list'>) => unwrap(window.api.shifts.list(input)),
    summary: (shiftId: string) => unwrap(window.api.shifts.summary({ shiftId })),
    lastCount: () => unwrap(window.api.shifts.lastCount()),
    recordCashMovement: (input: IpcRequest<'shifts:recordCashMovement'>) =>
      unwrap(window.api.shifts.recordCashMovement(input)),
    listCashMovements: (shiftId: string) =>
      unwrap(window.api.shifts.listCashMovements({ shiftId })),
    openDrawer: (input: IpcRequest<'shifts:openDrawer'>) => unwrap(window.api.shifts.openDrawer(input)),
  },
  webBridge: {
    getConfig: () => unwrap(window.api.webBridge.getConfig()),
    setConfig: (input: IpcRequest<'webBridge:setConfig'>) =>
      unwrap(window.api.webBridge.setConfig(input)),
    getStatus: () => unwrap(window.api.webBridge.getStatus()),
    publishMenu: () => unwrap(window.api.webBridge.publishMenu()),
    pollNow: () => unwrap(window.api.webBridge.pollNow()),
    diagnose: () => unwrap(window.api.webBridge.diagnose()),
    backupNow: () => unwrap(window.api.webBridge.backupNow()),
    listCloudBackups: () => unwrap(window.api.webBridge.listCloudBackups()),
    restoreCloudBackup: (id: string) =>
      unwrap(window.api.webBridge.restoreCloudBackup({ id })),
    previewCloudBackups: (input: IpcRequest<'webBridge:previewCloudBackups'>) =>
      unwrap(window.api.webBridge.previewCloudBackups(input)),
    restoreCloudBackupWith: (input: IpcRequest<'webBridge:restoreCloudBackupWith'>) =>
      unwrap(window.api.webBridge.restoreCloudBackupWith(input)),
  },
  audit: {
    verifyChain: () => unwrap(window.api.audit.verifyChain()),
  },
  alerts: {
    getSounds: () => unwrap(window.api.alerts.getSounds()),
    setSounds: (input: IpcRequest<'alerts:setSounds'>) => unwrap(window.api.alerts.setSounds(input)),
    getPending: () => unwrap(window.api.alerts.getPending()),
    acknowledge: (input: IpcRequest<'alerts:acknowledge'>) => unwrap(window.api.alerts.acknowledge(input)),
    testNotice: () => unwrap(window.api.alerts.testNotice()),
  },
  customers: {
    list: (input?: IpcRequest<'customers:list'>) => unwrap(window.api.customers.list(input)),
    page: (input: IpcRequest<'customers:page'>) => unwrap(window.api.customers.page(input)),
    areaUsage: (limit?: number) =>
      unwrap(window.api.customers.areaUsage(limit ? { limit } : undefined)),
    findByPhone: (phone: string) => unwrap(window.api.customers.findByPhone({ phone })),
    get: (id: string) => unwrap(window.api.customers.get({ id })),
    create: (input: IpcRequest<'customers:create'>) =>
      unwrap(window.api.customers.create(input)),
    update: (input: IpcRequest<'customers:update'>) =>
      unwrap(window.api.customers.update(input)),
    listAddresses: (customerId: string) =>
      unwrap(window.api.customers.listAddresses({ customerId })),
    searchAddresses: (query: string, limit?: number) =>
      unwrap(window.api.customers.searchAddresses({ query, ...(limit ? { limit } : {}) })),
    createAddress: (input: IpcRequest<'customers:createAddress'>) =>
      unwrap(window.api.customers.createAddress(input)),
    setDefaultAddress: (addressId: string) =>
      unwrap(window.api.customers.setDefaultAddress({ addressId })),
    deleteAddress: (addressId: string) =>
      unwrap(window.api.customers.deleteAddress({ addressId })),
    orderHistory: (customerId: string, limit?: number) =>
      unwrap(window.api.customers.orderHistory({ customerId, ...(limit ? { limit } : {}) })),
    attachToOrder: (input: IpcRequest<'customers:attachToOrder'>) =>
      unwrap(window.api.customers.attachToOrder(input)),
  },
  sync: {
    getConfig: () => unwrap(window.api.sync.getConfig()),
    setConfig: (input: IpcRequest<'sync:setConfig'>) =>
      unwrap(window.api.sync.setConfig(input)),
    getStatus: () => unwrap(window.api.sync.getStatus()),
    triggerNow: () => unwrap(window.api.sync.triggerNow()),
    sendEverything: () => unwrap(window.api.sync.sendEverything()),
    clearNotSaved: () => unwrap(window.api.sync.clearNotSaved()),
  },
  backup: {
    list: () => unwrap(window.api.backup.list()),
    create: () => unwrap(window.api.backup.create()),
    export: () => unwrap(window.api.backup.export()),
    stageRestoreFromPicker: () => unwrap(window.api.backup.stageRestoreFromPicker()),
    stageRestoreFromPath: (path: string) =>
      unwrap(window.api.backup.stageRestoreFromPath({ path })),
    delete: (fileName: string) => unwrap(window.api.backup.delete({ fileName })),
    applyAndRelaunch: (input?: IpcRequest<'backup:applyAndRelaunch'>) =>
      unwrap(window.api.backup.applyAndRelaunch(input)),
    cancelStagedRestore: () => unwrap(window.api.backup.cancelStagedRestore()),
    health: () => unwrap(window.api.backup.health()),
  },
  tables: {
    listSections: () => unwrap(window.api.tables.listSections()),
    list: (sectionId?: string) =>
      unwrap(window.api.tables.list(sectionId ? { sectionId } : undefined)),
  },
  printer: {
    getConfig: () => unwrap(window.api.printer.getConfig()),
    setConfig: (input: IpcRequest<'printer:setConfig'>) =>
      unwrap(window.api.printer.setConfig(input)),
    setBranding: (input: IpcRequest<'printer:setBranding'>) =>
      unwrap(window.api.printer.setBranding(input)),
    setLogoRaster: (input: IpcRequest<'printer:setLogoRaster'>) =>
      unwrap(window.api.printer.setLogoRaster(input)),
    setPolicy: (input: IpcRequest<'printer:setPolicy'>) =>
      unwrap(window.api.printer.setPolicy(input)),
    setKitchenPrinter: (input: IpcRequest<'printer:setKitchenPrinter'>) =>
      unwrap(window.api.printer.setKitchenPrinter(input)),
    test: (station?: 'receipt' | 'kitchen') =>
      unwrap(window.api.printer.test(station ? { station } : undefined)),
    testDrawer: () => unwrap(window.api.printer.testDrawer()),
    listSystemPrinters: () => unwrap(window.api.printer.listSystemPrinters()),
    /** Use features/printing/reprint.ts: it asks for a manager's PIN when the till needs one. */
    reprint: (orderId: string, opts: { copy?: 'customer' | 'shop'; approverPin?: string } = {}) =>
      unwrap(window.api.printer.reprint({ orderId, ...opts })),
    reprintKitchen: (orderId: string) =>
      unwrap(window.api.printer.reprintKitchen({ orderId })),
    reprintCounts: (orderIds: string[]) =>
      unwrap(window.api.printer.reprintCounts({ orderIds })),
  },
  fbr: {
    getConfig: () => unwrap(window.api.fbr.getConfig()),
    setConfig: (input: IpcRequest<'fbr:setConfig'>) =>
      unwrap(window.api.fbr.setConfig(input)),
    getQueueStats: () => unwrap(window.api.fbr.getQueueStats()),
    retryFailed: () => unwrap(window.api.fbr.retryFailed()),
    getInvoiceStatus: (orderId: string) =>
      unwrap(window.api.fbr.getInvoiceStatus({ orderId })),
  },
  reports: {
    lowStock: () => unwrap(window.api.reports.lowStock()),
    // One channel per Reports tab (costing spec Phase 3); each is worked out off the till's main thread.
    overview: (input: IpcRequest<'reports:overview'>) => unwrap(window.api.reports.overview(input)),
    when: (input: IpcRequest<'reports:when'>) => unwrap(window.api.reports.when(input)),
    menu: (input: IpcRequest<'reports:menu'>) => unwrap(window.api.reports.menu(input)),
    channels: (input: IpcRequest<'reports:channels'>) => unwrap(window.api.reports.channels(input)),
    foodStock: (input: IpcRequest<'reports:foodStock'>) => unwrap(window.api.reports.foodStock(input)),
    team: (input: IpcRequest<'reports:team'>) => unwrap(window.api.reports.team(input)),
    // The owner's week (costing spec Phase 7).
    ownerWeek: (input?: IpcRequest<'reports:ownerWeek'>) => unwrap(window.api.reports.ownerWeek(input)),
    trends: () => unwrap(window.api.reports.trends()),
    addDayNote: (input: IpcRequest<'reports:addDayNote'>) => unwrap(window.api.reports.addDayNote(input)),
    removeDayNote: (id: string) => unwrap(window.api.reports.removeDayNote({ id })),
    getDayparts: () => unwrap(window.api.reports.getDayparts()),
    setDayparts: (input: IpcRequest<'reports:setDayparts'>) => unwrap(window.api.reports.setDayparts(input)),
    /** Used vs should have used between two stock takes (the latest two when none are named). */
    variance: (input?: IpcRequest<'reports:variance'>) => unwrap(window.api.reports.variance(input)),
  },
  inventory: {
    listIngredients: (input?: IpcRequest<'inventory:listIngredients'>) =>
      unwrap(window.api.inventory.listIngredients(input)),
    createIngredient: (input: IpcRequest<'inventory:createIngredient'>) =>
      unwrap(window.api.inventory.createIngredient(input)),
    updateIngredient: (input: IpcRequest<'inventory:updateIngredient'>) =>
      unwrap(window.api.inventory.updateIngredient(input)),
    deleteIngredient: (id: string) =>
      unwrap(window.api.inventory.deleteIngredient({ id })),
    convertIngredientUnit: (id: string) =>
      unwrap(window.api.inventory.convertIngredientUnit({ id })),
    /** "Set price": per kg / litre, per pack of N or per piece, kept exactly, with a line in the price history. */
    setPrice: (input: IpcRequest<'inventory:setPrice'>) => unwrap(window.api.inventory.setPrice(input)),
    /** An ingredient's price history, newest first. */
    priceHistory: (ingredientId: string, limit?: number) =>
      unwrap(window.api.inventory.priceHistory(limit === undefined ? { ingredientId } : { ingredientId, limit })),
    /** "Use the sheet's price" (costing Phase 6): a typed line in its price history. */
    useSheetPrice: (ingredientId: string) => unwrap(window.api.inventory.useSheetPrice({ ingredientId })),
    getRecipe: (menuItemId: string) =>
      unwrap(window.api.inventory.getRecipe({ menuItemId })),
    setRecipe: (input: IpcRequest<'inventory:setRecipe'>) =>
      unwrap(window.api.inventory.setRecipe(input)),
    listRecipeLineCounts: () => unwrap(window.api.inventory.listRecipeLineCounts()),
    getBatchRecipe: (ingredientId: string) =>
      unwrap(window.api.inventory.getBatchRecipe({ ingredientId })),
    setBatchRecipe: (input: IpcRequest<'inventory:setBatchRecipe'>) =>
      unwrap(window.api.inventory.setBatchRecipe(input)),
    makeBatch: (input: IpcRequest<'inventory:makeBatch'>) =>
      unwrap(window.api.inventory.makeBatch(input)),
    listMovements: (input?: IpcRequest<'inventory:listMovements'>) =>
      unwrap(window.api.inventory.listMovements(input)),
    searchMovements: (input?: IpcRequest<'inventory:searchMovements'>) =>
      unwrap(window.api.inventory.searchMovements(input)),
    recordMovement: (input: IpcRequest<'inventory:recordMovement'>) =>
      unwrap(window.api.inventory.recordMovement(input)),
    listSuppliers: (input?: IpcRequest<'inventory:listSuppliers'>) =>
      unwrap(window.api.inventory.listSuppliers(input)),
    createSupplier: (input: IpcRequest<'inventory:createSupplier'>) =>
      unwrap(window.api.inventory.createSupplier(input)),
    updateSupplier: (input: IpcRequest<'inventory:updateSupplier'>) =>
      unwrap(window.api.inventory.updateSupplier(input)),
    listPurchaseOrders: (input?: IpcRequest<'inventory:listPurchaseOrders'>) =>
      unwrap(window.api.inventory.listPurchaseOrders(input)),
    getPurchaseOrder: (id: string) =>
      unwrap(window.api.inventory.getPurchaseOrder({ id })),
    createPurchaseOrder: (input: IpcRequest<'inventory:createPurchaseOrder'>) =>
      unwrap(window.api.inventory.createPurchaseOrder(input)),
    setPurchaseOrderStatus: (input: IpcRequest<'inventory:setPurchaseOrderStatus'>) =>
      unwrap(window.api.inventory.setPurchaseOrderStatus(input)),
    receiveDelivery: (input: IpcRequest<'inventory:receiveDelivery'>) =>
      unwrap(window.api.inventory.receiveDelivery(input)),
    /** "Record a purchase" (costing Phase 5): what was bought and paid, at once; paid from the drawer or not. */
    recordPurchase: (input: IpcRequest<'inventory:recordPurchase'>) =>
      unwrap(window.api.inventory.recordPurchase(input)),
    /** "Turn this payout into a purchase": linked once; the drawer's figures never change. */
    payoutToPurchase: (input: IpcRequest<'inventory:payoutToPurchase'>) =>
      unwrap(window.api.inventory.payoutToPurchase(input)),
    /** Recent cash payouts from this till's drawer, with the purchase each is linked to. */
    listDrawerPayouts: (input?: IpcRequest<'inventory:listDrawerPayouts'>) =>
      unwrap(window.api.inventory.listDrawerPayouts(input)),
    // Stock takes (costing Phase 8).
    stockCountList: (input?: IpcRequest<'inventory:stockCountList'>) => unwrap(window.api.inventory.stockCountList(input)),
    stockCountGet: (countId: string) => unwrap(window.api.inventory.stockCountGet({ countId })),
    stockCountStart: (input: IpcRequest<'inventory:stockCountStart'>) => unwrap(window.api.inventory.stockCountStart(input)),
    stockCountSave: (input: IpcRequest<'inventory:stockCountSave'>) => unwrap(window.api.inventory.stockCountSave(input)),
    /** One transaction; asked again it writes nothing. */
    stockCountFinish: (countId: string) => unwrap(window.api.inventory.stockCountFinish({ countId })),
    /** Nothing is written to stock. */
    stockCountCancel: (countId: string) => unwrap(window.api.inventory.stockCountCancel({ countId })),
    /** The Stock button's one-line stock take. */
    stockCountOne: (input: IpcRequest<'inventory:stockCountOne'>) => unwrap(window.api.inventory.stockCountOne(input)),
  },
  /** The Costing page and the costs shown in Menu and Inventory (managers and the owner only). */
  costing: {
    menuCosts: () => unwrap(window.api.costing.menuCosts()),
    itemSheet: (menuItemId: string) => unwrap(window.api.costing.itemSheet({ menuItemId })),
    missingCosts: () => unwrap(window.api.costing.missingCosts()),
    getTargets: () => unwrap(window.api.costing.getTargets()),
    setTargets: (input: IpcRequest<'costing:setTargets'>) => unwrap(window.api.costing.setTargets(input)),
    recipeCost: (input: IpcRequest<'costing:recipeCost'>) => unwrap(window.api.costing.recipeCost(input)),
    batchCalc: (input: IpcRequest<'costing:batchCalc'>) => unwrap(window.api.costing.batchCalc(input)),
    /** Costing → Alerts (Phase 6): not seen yet first. */
    alerts: () => unwrap(window.api.costing.alerts()),
    /** "Seen": answers with the list as it now stands. */
    markAlertsSeen: (ids: string[]) => unwrap(window.api.costing.markAlertsSeen({ ids })),
    getAlertSettings: () => unwrap(window.api.costing.getAlertSettings()),
    /** The owner's alert thresholds (settings.manage). */
    setAlertSettings: (input: IpcRequest<'costing:setAlertSettings'>) => unwrap(window.api.costing.setAlertSettings(input)),
    /** How many tills take orders, with the link as it is now (Phase 8). */
    getTills: () => unwrap(window.api.costing.getTills()),
    /** The owner's answer (settings.manage). */
    setTills: (input: IpcRequest<'costing:setTills'>) => unwrap(window.api.costing.setTills(input)),
  },
};

/** Listen for fbr:queue-changed broadcasts from the worker. */
export function onFbrQueueChanged(cb: () => void): () => void {
  const w = window as unknown as {
    fbrEvents?: { onQueueChanged: (cb: () => void) => () => void };
  };
  return w.fbrEvents?.onQueueChanged(cb) ?? (() => {});
}

/** Listen for sync:status-changed broadcasts from the worker. */
export function onSyncStatusChanged(cb: () => void): () => void {
  const w = window as unknown as {
    syncEvents?: { onStatusChanged: (cb: () => void) => () => void };
  };
  return w.syncEvents?.onStatusChanged(cb) ?? (() => {});
}

/** Payload broadcast when the web bridge imports a new online order. */
export interface WebOrderReceivedPayload {
  orderId: string;
  orderNumber: string;
  customerName: string;
  /** The website's own id for the order (older builds leave it out). */
  webOrderId?: string;
  /** Delivery or pick-up (older builds leave it out). */
  fulfilment?: 'delivery' | 'pickup';
  /** What the till bills (older builds leave it out). */
  totalCents?: number | null;
  /** Set when the till's total is not what the website showed the customer. */
  totalMismatch?: { webTotalCents: number; tillTotalCents: number };
}

/** Listen for web-order:received broadcasts from the website bridge. */
export function onWebOrderReceived(
  cb: (payload: WebOrderReceivedPayload) => void,
): () => void {
  const w = window as unknown as {
    webOrderEvents?: {
      onReceived: (cb: (p: WebOrderReceivedPayload) => void) => () => void;
    };
  };
  return w.webOrderEvents?.onReceived(cb) ?? (() => {});
}

/** Payload broadcast when the web bridge could not import an online order. */
export interface WebOrderImportFailedPayload {
  webOrderId: string;
  customerName: string;
  message: string;
  customerPhone?: string | null;
  /** The till stopped trying (true) or will try again (false / left out by older builds). */
  final?: boolean;
  reason?: 'gave_up' | 'stale' | 'error';
}

/** Listen for web-order:import-failed broadcasts from the website bridge. */
export function onWebOrderImportFailed(
  cb: (payload: WebOrderImportFailedPayload) => void,
): () => void {
  const w = window as unknown as {
    webOrderEvents?: {
      onImportFailed: (cb: (p: WebOrderImportFailedPayload) => void) => () => void;
    };
  };
  return w.webOrderEvents?.onImportFailed(cb) ?? (() => {});
}

/** One ingredient that just dropped below its low-stock level. */
export interface LowStockItem {
  ingredientId: string;
  name: string;
  unit: string;
  resultingQty: number;
  threshold: number;
}

/** Listen for inventory:low-stock broadcasts (sent when an order takes stock below the line). */
export function onLowStock(cb: (items: LowStockItem[]) => void): () => void {
  const w = window as unknown as {
    inventoryEvents?: { onLowStock: (cb: (items: LowStockItem[]) => void) => () => void };
  };
  return w.inventoryEvents?.onLowStock(cb) ?? (() => {});
}

/** Payload broadcast by the main process when a print job fails permanently. */
export interface PrinterFailedPayload {
  jobKind: string;
  orderId?: string;
  error?: { code: string; message: string };
  /** First miss: the till keeps trying on its own. Absent/false: it gave up. */
  retrying?: boolean;
}

/** Listen for printer:failed broadcasts from the main process. */
export function onPrinterFailed(
  cb: (payload: PrinterFailedPayload) => void,
): () => void {
  const w = window as unknown as {
    printerEvents?: { onFailed: (cb: (p: PrinterFailedPayload) => void) => () => void };
  };
  return w.printerEvents?.onFailed(cb) ?? (() => {});
}

/** Someone clicked the till's Windows notice; the window is already in front. */
export interface AlertOpenPayload {
  kind: 'newOrder' | 'importFailed' | 'test';
}

/** Listen for alerts:open (a click on the Windows notice for a new or failed online order). */
export function onAlertOpen(cb: (payload: AlertOpenPayload) => void): () => void {
  const w = window as unknown as {
    alertEvents?: { onOpen: (cb: (p: AlertOpenPayload) => void) => () => void };
  };
  return w.alertEvents?.onOpen(cb) ?? (() => {});
}
