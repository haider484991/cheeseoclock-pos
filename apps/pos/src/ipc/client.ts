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
import type { SetShopSettingRequest, ShopSettingCard, ShopSettingKey, ShopSettingValues } from '@cheeseoclock/shared-types';
import type { CloseTillAsk, MenuDeployChangedEvent } from '@cheeseoclock/shared-types';
import type { SetTillSettingRequest, TillSettingCard, TillSettingKey, TillSettingValues } from '@cheeseoclock/shared-types';

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
  licence: {
    status: () => unwrap(window.api.licence.status()),
    activate: (token: string) => unwrap(window.api.licence.activate({ token })),
    resetClock: () => unwrap(window.api.licence.resetClock()),
  },
  system: {
    getVersion: () => unwrap(window.api.system.getVersion()),
    getDeviceInfo: () => unwrap(window.api.system.getDeviceInfo()),
    getBranding: () => unwrap(window.api.system.getBranding()),
    getSetupStatus: () => unwrap(window.api.system.getSetupStatus()),
    getDeliveryCity: () => unwrap(window.api.system.getDeliveryCity()),
    completeOnboarding: (input: IpcRequest<'system:completeOnboarding'>) =>
      unwrap(window.api.system.completeOnboarding(input)),
    /** "Close the till?" is on screen; pending false = out of date, drop it. */
    closeShown: (requestId: string) => unwrap(window.api.system.closeShown({ requestId })),
    /** The answer to "Close the till?"; closing false = out of date, nothing happens. */
    closeAnswer: (requestId: string, close: boolean) => unwrap(window.api.system.closeAnswer({ requestId, close })),
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
    /** A manager's PIN or password is needed to take the shop's foodpanda deal off. */
    clearDiscount: (orderId: string, approverPin?: string) =>
      unwrap(window.api.orders.clearDiscount(approverPin ? { orderId, approverPin } : { orderId })),
    /** Edit order: the order the kitchen has, as these changes would leave it (nothing is written). */
    previewEdit: (input: IpcRequest<'orders:previewEdit'>) => unwrap(window.api.orders.previewEdit(input)),
    /** Edit order: save the changes (the kitchen gets an ADDED / REMOVED slip). */
    saveEdit: (input: IpcRequest<'orders:saveEdit'>) => unwrap(window.api.orders.saveEdit(input)),
    setMode: (input: IpcRequest<'orders:setMode'>) => unwrap(window.api.orders.setMode(input)),
    /** The delivery area changed: the main process puts that area's delivery charge on (or swaps / takes it off). */
    setDeliveryArea: (input: IpcRequest<'orders:setDeliveryArea'>) => unwrap(window.api.orders.setDeliveryArea(input)),
    /** "Custom charge": a delivery charge typed in whole rupees, in place of the bill's (owner, 10 Oct 2026). */
    setDeliveryCharge: (input: IpcRequest<'orders:setDeliveryCharge'>) => unwrap(window.api.orders.setDeliveryCharge(input)),
    /** How a counter order came in (Walk-in · Phone · WhatsApp): a manager's PIN once the order has been sent. */
    setCameBy: (input: IpcRequest<'orders:setCameBy'>) => unwrap(window.api.orders.setCameBy(input)),
    resumeDraft: () => unwrap(window.api.orders.resumeDraft()),
    discardDraft: (orderId: string) => unwrap(window.api.orders.discardDraft({ orderId })),
    tender: (input: IpcRequest<'orders:tender'>) => unwrap(window.api.orders.tender(input)),
    /** The owner puts right how a paid order was paid (v0.7.42). */
    changePaymentMethod: (input: IpcRequest<'orders:changePaymentMethod'>) => unwrap(window.api.orders.changePaymentMethod(input)),
    void: (input: IpcRequest<'orders:void'>) => unwrap(window.api.orders.void(input)),
    refund: (input: IpcRequest<'orders:refund'>) => unwrap(window.api.orders.refund(input)),
    /** What cancelling / refunding would do to stock ("Was the food made?"), or what it did. */
    stockStatus: (orderId: string) => unwrap(window.api.orders.stockStatus({ orderId })),
    /** The owner only: what deleting this order as a test would do (nothing is written). */
    testDeletePreview: (orderId: string) => unwrap(window.api.orders.testDeletePreview({ orderId })),
    /** The owner only, with the owner's PIN or password typed again. It can't be brought back. */
    deleteTest: (req: IpcRequest<'orders:deleteTest'>) => unwrap(window.api.orders.deleteTest(req)),
    /** The owner only: deleted test orders taken in the period. */
    listDeletedTests: (req: IpcRequest<'orders:listDeletedTests'>) => unwrap(window.api.orders.listDeletedTests(req)),
    attachCustomer: (input: IpcRequest<'orders:attachCustomer'>) =>
      unwrap(window.api.orders.attachCustomer(input)),
    detachCustomer: (orderId: string) =>
      unwrap(window.api.orders.detachCustomer({ orderId })),
    /** The counter's "Order notes" on an order with no customer typed in (blank clears it). */
    setNote: (input: IpcRequest<'orders:setNote'>) => unwrap(window.api.orders.setNote(input)),
    // Live tracking
    listActive: (input?: IpcRequest<'orders:listActive'>) =>
      unwrap(window.api.orders.listActive(input)),
    sendToKitchen: (orderId: string) =>
      unwrap(window.api.orders.sendToKitchen({ orderId })),
    markPreparing: (orderId: string) =>
      unwrap(window.api.orders.markPreparing({ orderId })),
    markReady: (orderId: string) => unwrap(window.api.orders.markReady({ orderId })),
    /**
     * Send out: an outside rider takes the order; the customer's bill prints with it.
     * riderAlreadyPaid: he was already paid for this trip on a refunded order of the customer (keeps nothing here).
     * riderPayment ("Paid now"): his money is taken in the same step; the bill prints after it.
     */
    sendOut: (input: IpcRequest<'orders:sendOut'>) => unwrap(window.api.orders.sendOut(input)),
    assignRider: (input: IpcRequest<'orders:assignRider'>) =>
      unwrap(window.api.orders.assignRider(input)),
    unassignRider: (orderId: string) =>
      unwrap(window.api.orders.unassignRider({ orderId })),
    markServed: (input: IpcRequest<'orders:markServed'>) =>
      unwrap(window.api.orders.markServed(input)),
    markDelivered: (input: IpcRequest<'orders:markDelivered'>) =>
      unwrap(window.api.orders.markDelivered(input)),
    /** Rider paid: an outside rider pays the shop while still out (riderKeepsCents as the window showed it). */
    riderPaid: (input: IpcRequest<'orders:riderPaid'>) => unwrap(window.api.orders.riderPaid(input)),
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
    /** Who closes, and the unpaid orders the close carries over (a cashier's login: the manager's PIN). */
    closeCheck: (input: IpcRequest<'shifts:closeCheck'>) => unwrap(window.api.shifts.closeCheck(input)),
    /**
     * The shift report again (again: false is Try again: the original when it
     * did not come out). A cashier's login is refused with needs 'manager_pin'
     * until a manager's PIN or password comes with it.
     */
    printReport: (input: IpcRequest<'shifts:printReport'>) => unwrap(window.api.shifts.printReport(input)),
    list: (input?: IpcRequest<'shifts:list'>) => unwrap(window.api.shifts.list(input)),
    summary: (shiftId: string) => unwrap(window.api.shifts.summary({ shiftId })),
    lastCount: () => unwrap(window.api.shifts.lastCount()),
    /** What the Open shift box starts the count on (this till's last count, or the owner's fixed float). */
    openingFloat: () => unwrap(window.api.shifts.openingFloat()),
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
    /** What the PIN screen shows between logins (no login needed; numbers, statuses and minutes only). */
    getWatch: () => unwrap(window.api.alerts.getWatch()),
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
      delete: (id: string) => unwrap(window.api.customers.delete({ id })),
      exportCsv: () => unwrap(window.api.customers.exportCsv()),
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
    pickSecondCopyFolder: () => unwrap(window.api.backup.pickSecondCopyFolder()),
    clearSecondCopy: () => unwrap(window.api.backup.clearSecondCopy()),
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
    /** What the print button would print (original or DUPLICATE), and every paper the order had. */
    orderPapers: (orderId: string) => unwrap(window.api.printer.orderPapers({ orderId })),
    /** "Try again" on the failed-print note: that very job again (the till's own paper stays the original). */
    retryJob: (jobId: string) => unwrap(window.api.printer.retryJob({ jobId })),
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
    /** Every time the till opened the cash drawer, newest first, a page at a time (the owner). */
    drawerLog: (req: IpcRequest<'reports:drawerLog'>) => unwrap(window.api.reports.drawerLog(req)),
    /** Profit (costing spec Phase 9): the waterfall, by channel and by category (profit.view). */
    profit: (input: IpcRequest<'reports:profit'>) => unwrap(window.api.reports.profit(input)),
    /** The menu map: the last 28 days unless a period is given (profit.view). */
    menuMap: (input?: IpcRequest<'reports:menuMap'>) => unwrap(window.api.reports.menuMap(input)),
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
    /** The recipe calculator: batches to make, from stock, from scratch — quantities only. */
    recipeCalc: (input: IpcRequest<'inventory:recipeCalc'>) => unwrap(window.api.inventory.recipeCalc(input)),
    /** A menu item's choices and the last 28 days' picks (counts only), for "the usual picks". */
    typicalPicks: (menuItemId: string) => unwrap(window.api.inventory.typicalPicks({ menuItemId })),
    /** The prep list on the receipt printer; a failed print comes back as ok: false. */
    printPrepList: (input: IpcRequest<'inventory:printPrepList'>) => unwrap(window.api.inventory.printPrepList(input)),
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
    /** The recipe calculator with its costs (COST_CAPABILITY). */
    recipeCalc: (input: IpcRequest<'costing:recipeCalc'>) => unwrap(window.api.costing.recipeCalc(input)),
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
    /** foodpanda's commission, payment fees and the rider cost (Phase 9). */
    getChannelFees: () => unwrap(window.api.costing.getChannelFees()),
    /** The owner's answer (settings.manage). */
    setChannelFees: (input: IpcRequest<'costing:setChannelFees'>) => unwrap(window.api.costing.setChannelFees(input)),
    /** New prices tried against the last 4 weeks — nothing is saved (profit.view). */
    whatIf: (input: IpcRequest<'costing:whatIf'>) => unwrap(window.api.costing.whatIf(input)),
  },
  /** The owner's shop rules (Settings → foodpanda …): the owner only. */
  settings: {
    /** One card: the value in use, who changed it last, its history. */
    getBusiness: <K extends ShopSettingKey>(key: K) =>
      unwrap(window.api.settings.getBusiness({ key })) as Promise<ShopSettingCard<K>>,
    /** Save a card; answers with it as it now stands. */
    setBusiness: <K extends ShopSettingKey>(key: K, value: ShopSettingValues[K]) =>
      unwrap(window.api.settings.setBusiness({ key, value } as SetShopSettingRequest)) as Promise<ShopSettingCard<K>>,
    /** "Put back the default": writes the default's values. */
    putBackDefault: <K extends ShopSettingKey>(key: K) =>
      unwrap(window.api.settings.setBusiness({ key, useDefault: true } as SetShopSettingRequest)) as Promise<ShopSettingCard<K>>,
    /** Settings → Delivery areas: the areas and fees, and the delivery-charge items they need (one transaction). */
    saveDeliveryZones: (input: IpcRequest<'settings:saveDeliveryZones'>) => unwrap(window.api.settings.saveDeliveryZones(input)),
    /** Settings → Delivery areas & fees → "Tax on the delivery charge": the charges' tax now and the food's. */
    deliveryChargeTax: () => unwrap(window.api.settings.deliveryChargeTax()),
    /** …its Save: every delivery charge item onto one tax (one transaction); the website gets it with the areas. */
    saveDeliveryChargeTax: (input: IpcRequest<'settings:saveDeliveryChargeTax'>) =>
      unwrap(window.api.settings.saveDeliveryChargeTax(input)),
    /** One "this till" card (the receipt's extra lines, the opening float, this computer). */
    getTill: <K extends TillSettingKey>(key: K) => unwrap(window.api.settings.getTill({ key })) as Promise<TillSettingCard<K>>,
    /** Save a "this till" card; answers with it as it now stands. */
    setTill: <K extends TillSettingKey>(key: K, value: TillSettingValues[K]) =>
      unwrap(window.api.settings.setTill({ key, value } as SetTillSettingRequest)) as Promise<TillSettingCard<K>>,
    /** "Put back the default" on a "this till" card. */
    putBackTillDefault: <K extends TillSettingKey>(key: K) =>
      unwrap(window.api.settings.setTill({ key, useDefault: true })) as Promise<TillSettingCard<K>>,
  },
  /** This computer (Settings → Online orders): the owner only. */
  power: {
    /** Held awake now? Will Windows open the till? When did it last sleep? */
    getStatus: () => unwrap(window.api.power.getStatus()),
    /** "Turn it back on": the start-up entry on again in Windows, and awake again if it should be. */
    turnBackOn: () => unwrap(window.api.power.turnBackOn()),
  },
  /** What the counter needs to take an order: the foodpanda deal, Pay's checks. */
  checkout: {
    getRules: () => unwrap(window.api.checkout.getRules()),
  },
  // Menu files from the costing PC (v0.7.32).
  menuDeploy: {
    getStatus: (withHistory = false) => unwrap(window.api.menuDeploy.getStatus({ withHistory })),
    checkNow: () => unwrap(window.api.menuDeploy.checkNow()),
    /** The owner's new upload key: shown once, never kept (component state only). */
    createKey: () => unwrap(window.api.menuDeploy.createKey()),
    preview: (packageId: string) => unwrap(window.api.menuDeploy.preview({ packageId })),
    apply: (input: IpcRequest<'menuDeploy:apply'>) => unwrap(window.api.menuDeploy.apply(input)),
  },
  /** The owner's phone dashboard: this till's sending, and the people who can sign in (owner only). */
  dashboard: {
    getStatus: () => unwrap(window.api.dashboard.getStatus()),
    setOn: (on: boolean) => unwrap(window.api.dashboard.setOn({ on })),
    pushNow: () => unwrap(window.api.dashboard.pushNow()),
    listLogins: () => unwrap(window.api.dashboard.listLogins()),
    /** A new person; the setup code comes back once (component state only, never kept). */
    addLogin: (input: IpcRequest<'dashboard:addLogin'>) => unwrap(window.api.dashboard.addLogin(input)),
    updateLogin: (input: IpcRequest<'dashboard:updateLogin'>) => unwrap(window.api.dashboard.updateLogin(input)),
    newCode: (id: string) => unwrap(window.api.dashboard.newCode({ id })),
    signOutAll: (id: string) => unwrap(window.api.dashboard.signOutAll({ id })),
    removeLogin: (id: string) => unwrap(window.api.dashboard.removeLogin({ id })),
  },
};

/** Listen for news about the menu files from the costing PC (main 'menuDeploy:changed'). */
export function onMenuDeployChanged(cb: (payload: MenuDeployChangedEvent) => void): () => void {
  const w = window as unknown as {
    menuDeployEvents?: { onChanged: (cb: (p: MenuDeployChangedEvent) => void) => () => void };
  };
  return w.menuDeployEvents?.onChanged(cb) ?? (() => {});
}

/** Listen for system:close-requested (X, Alt+F4 or the taskbar's Close while website orders are on). */
export function onCloseTillRequested(cb: (payload: CloseTillAsk) => void): () => void {
  const w = window as unknown as {
    tillWindowEvents?: { onCloseRequested: (cb: (p: CloseTillAsk) => void) => () => void };
  };
  return w.tillWindowEvents?.onCloseRequested(cb) ?? (() => {});
}

/** Listen for the owner's shop rules changing (saved here, or from the other till). */
export function onShopSettingsChanged(cb: () => void): () => void {
  const w = window as unknown as {
    shopSettingsEvents?: { onChanged: (cb: () => void) => () => void };
  };
  return w.shopSettingsEvents?.onChanged(cb) ?? (() => {});
}

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
  reason?: 'gave_up' | 'stale' | 'error' | 'cancelled_on_site';
  /** The till's order number (cancelled_on_site: the website cancelled an order the kitchen has). */
  orderNumber?: string | null;
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
  /** The job that failed ("Try again" sends it again: printer:retryJob). */
  jobId?: string;
  jobKind: string;
  orderId?: string;
  /** Which paper of which order, e.g. "Receipt for Order #0041" (absent: not known). */
  what?: string;
  /** The shift whose report did not print (jobKind 'shift_report': no jobId, no orderId). */
  shiftId?: string;
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

/** Listen for alerts:watch-changed (part of the PIN screen's watch changed: read alerts:getWatch again). */
export function onAlertWatchChanged(cb: () => void): () => void {
  const w = window as unknown as {
    alertEvents?: { onWatchChanged?: (cb: () => void) => () => void };
  };
  return w.alertEvents?.onWatchChanged?.(cb) ?? (() => {});
}
