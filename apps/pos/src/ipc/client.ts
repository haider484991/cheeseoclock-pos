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

async function unwrap<T>(p: Promise<ApiResult<T>>): Promise<T> {
  const result = await p;
  if (result.ok) return result.data;
  throw new IpcError(result.error);
}

export const ipc = {
  system: {
    getVersion: () => unwrap(window.api.system.getVersion()),
    getDeviceInfo: () => unwrap(window.api.system.getDeviceInfo()),
    getSetupStatus: () => unwrap(window.api.system.getSetupStatus()),
    completeOnboarding: (input: IpcRequest<'system:completeOnboarding'>) =>
      unwrap(window.api.system.completeOnboarding(input)),
  },
  auth: {
    login: (pin: string) => unwrap(window.api.auth.login({ pin })),
    logout: () => unwrap(window.api.auth.logout()),
    currentSession: () => unwrap(window.api.auth.currentSession()),
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
    get: (id: string) => unwrap(window.api.orders.get({ id })),
    addItem: (input: IpcRequest<'orders:addItem'>) =>
      unwrap(window.api.orders.addItem(input)),
    updateItemQuantity: (input: IpcRequest<'orders:updateItemQuantity'>) =>
      unwrap(window.api.orders.updateItemQuantity(input)),
    removeItem: (input: IpcRequest<'orders:removeItem'>) =>
      unwrap(window.api.orders.removeItem(input)),
    applyDiscount: (input: IpcRequest<'orders:applyDiscount'>) =>
      unwrap(window.api.orders.applyDiscount(input)),
    clearDiscount: (orderId: string) =>
      unwrap(window.api.orders.clearDiscount({ orderId })),
    tender: (input: IpcRequest<'orders:tender'>) => unwrap(window.api.orders.tender(input)),
    void: (input: IpcRequest<'orders:void'>) => unwrap(window.api.orders.void(input)),
    attachCustomer: (input: IpcRequest<'orders:attachCustomer'>) =>
      unwrap(window.api.orders.attachCustomer(input)),
    detachCustomer: (orderId: string) =>
      unwrap(window.api.orders.detachCustomer({ orderId })),
    // Live tracking
    listActive: (input?: IpcRequest<'orders:listActive'>) =>
      unwrap(window.api.orders.listActive(input)),
    markPreparing: (orderId: string) =>
      unwrap(window.api.orders.markPreparing({ orderId })),
    markReady: (orderId: string) => unwrap(window.api.orders.markReady({ orderId })),
    assignRider: (input: IpcRequest<'orders:assignRider'>) =>
      unwrap(window.api.orders.assignRider(input)),
    unassignRider: (orderId: string) =>
      unwrap(window.api.orders.unassignRider({ orderId })),
    markDelivered: (input: IpcRequest<'orders:markDelivered'>) =>
      unwrap(window.api.orders.markDelivered(input)),
  },
  riders: {
    list: (input?: IpcRequest<'riders:list'>) => unwrap(window.api.riders.list(input)),
    create: (input: IpcRequest<'riders:create'>) => unwrap(window.api.riders.create(input)),
    update: (input: IpcRequest<'riders:update'>) => unwrap(window.api.riders.update(input)),
    deactivate: (id: string) => unwrap(window.api.riders.deactivate({ id })),
  },
  customers: {
    list: (input?: IpcRequest<'customers:list'>) => unwrap(window.api.customers.list(input)),
    findByPhone: (phone: string) => unwrap(window.api.customers.findByPhone({ phone })),
    get: (id: string) => unwrap(window.api.customers.get({ id })),
    create: (input: IpcRequest<'customers:create'>) =>
      unwrap(window.api.customers.create(input)),
    update: (input: IpcRequest<'customers:update'>) =>
      unwrap(window.api.customers.update(input)),
    listAddresses: (customerId: string) =>
      unwrap(window.api.customers.listAddresses({ customerId })),
    createAddress: (input: IpcRequest<'customers:createAddress'>) =>
      unwrap(window.api.customers.createAddress(input)),
    setDefaultAddress: (addressId: string) =>
      unwrap(window.api.customers.setDefaultAddress({ addressId })),
    deleteAddress: (addressId: string) =>
      unwrap(window.api.customers.deleteAddress({ addressId })),
    orderHistory: (customerId: string, limit?: number) =>
      unwrap(window.api.customers.orderHistory({ customerId, ...(limit ? { limit } : {}) })),
  },
  sync: {
    getConfig: () => unwrap(window.api.sync.getConfig()),
    setConfig: (input: IpcRequest<'sync:setConfig'>) =>
      unwrap(window.api.sync.setConfig(input)),
    getStatus: () => unwrap(window.api.sync.getStatus()),
    triggerNow: () => unwrap(window.api.sync.triggerNow()),
  },
  backup: {
    list: () => unwrap(window.api.backup.list()),
    create: () => unwrap(window.api.backup.create()),
    export: () => unwrap(window.api.backup.export()),
    stageRestoreFromPicker: () => unwrap(window.api.backup.stageRestoreFromPicker()),
    stageRestoreFromPath: (path: string) =>
      unwrap(window.api.backup.stageRestoreFromPath({ path })),
    delete: (fileName: string) => unwrap(window.api.backup.delete({ fileName })),
    applyAndRelaunch: () => unwrap(window.api.backup.applyAndRelaunch()),
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
    test: () => unwrap(window.api.printer.test()),
    reprint: (orderId: string) => unwrap(window.api.printer.reprint({ orderId })),
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
    salesSummary: (input: IpcRequest<'reports:salesSummary'>) =>
      unwrap(window.api.reports.salesSummary(input)),
    salesByDay: (input: IpcRequest<'reports:salesByDay'>) =>
      unwrap(window.api.reports.salesByDay(input)),
    salesByHour: (input: IpcRequest<'reports:salesByHour'>) =>
      unwrap(window.api.reports.salesByHour(input)),
    salesByCategory: (input: IpcRequest<'reports:salesByCategory'>) =>
      unwrap(window.api.reports.salesByCategory(input)),
    topItems: (input: IpcRequest<'reports:topItems'>) =>
      unwrap(window.api.reports.topItems(input)),
    salesByMode: (input: IpcRequest<'reports:salesByMode'>) =>
      unwrap(window.api.reports.salesByMode(input)),
    salesByPaymentMethod: (input: IpcRequest<'reports:salesByPaymentMethod'>) =>
      unwrap(window.api.reports.salesByPaymentMethod(input)),
    salesByCashier: (input: IpcRequest<'reports:salesByCashier'>) =>
      unwrap(window.api.reports.salesByCashier(input)),
    discounts: (input: IpcRequest<'reports:discounts'>) =>
      unwrap(window.api.reports.discounts(input)),
    lowStock: () => unwrap(window.api.reports.lowStock()),
    cogs: (input: IpcRequest<'reports:cogs'>) => unwrap(window.api.reports.cogs(input)),
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
    getRecipe: (menuItemId: string) =>
      unwrap(window.api.inventory.getRecipe({ menuItemId })),
    setRecipe: (input: IpcRequest<'inventory:setRecipe'>) =>
      unwrap(window.api.inventory.setRecipe(input)),
    listMovements: (input?: IpcRequest<'inventory:listMovements'>) =>
      unwrap(window.api.inventory.listMovements(input)),
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

/** Payload broadcast by the main process when a print job fails permanently. */
export interface PrinterFailedPayload {
  jobKind: string;
  orderId?: string;
  error?: { code: string; message: string };
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
