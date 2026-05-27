import { contextBridge, ipcRenderer } from 'electron';
import type {
  IpcChannel,
  IpcRequest,
  IpcResponse,
  RendererApi,
} from '@cheeseoclock/shared-types';

/**
 * One typed `window.api` namespace, organized by domain.
 *
 * The shape mirrors the IpcContract: every method takes the channel's request
 * payload (an object) and returns its response. The client at src/ipc/client.ts
 * wraps these with friendlier signatures for components.
 */

async function invoke<C extends IpcChannel>(
  channel: C,
  payload: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResponse<C>>;
}

const api: RendererApi = {
  system: {
    getVersion: () => invoke('system:getVersion', undefined),
    getDeviceInfo: () => invoke('system:getDeviceInfo', undefined),
    getSetupStatus: () => invoke('system:getSetupStatus', undefined),
    completeOnboarding: (req) => invoke('system:completeOnboarding', req),
  },
  auth: {
    login: (req) => invoke('auth:login', req),
    logout: () => invoke('auth:logout', undefined),
    currentSession: () => invoke('auth:currentSession', undefined),
    verifyManagerPin: (req) => invoke('auth:verifyManagerPin', req),
  },
  users: {
    list: () => invoke('users:list', undefined),
    create: (req) => invoke('users:create', req),
    update: (req) => invoke('users:update', req),
    deactivate: (req) => invoke('users:deactivate', req),
  },
  menu: {
    listCategories: (req) => invoke('menu:listCategories', req),
    createCategory: (req) => invoke('menu:createCategory', req),
    updateCategory: (req) => invoke('menu:updateCategory', req),
    deleteCategory: (req) => invoke('menu:deleteCategory', req),
    listItems: (req) => invoke('menu:listItems', req),
    findItemByBarcode: (req) => invoke('menu:findItemByBarcode', req),
    createItem: (req) => invoke('menu:createItem', req),
    updateItem: (req) => invoke('menu:updateItem', req),
    deleteItem: (req) => invoke('menu:deleteItem', req),
    listModifierGroupsForItem: (req) => invoke('menu:listModifierGroupsForItem', req),
    setItemModifierGroups: (req) => invoke('menu:setItemModifierGroups', req),
    listModifierGroups: () => invoke('menu:listModifierGroups', undefined),
    createModifierGroup: (req) => invoke('menu:createModifierGroup', req),
    updateModifierGroup: (req) => invoke('menu:updateModifierGroup', req),
    deleteModifierGroup: (req) => invoke('menu:deleteModifierGroup', req),
    createModifier: (req) => invoke('menu:createModifier', req),
    updateModifier: (req) => invoke('menu:updateModifier', req),
    deleteModifier: (req) => invoke('menu:deleteModifier', req),
    listCombos: (req) => invoke('menu:listCombos', req),
    listTaxCategories: () => invoke('menu:listTaxCategories', undefined),
    createTaxCategory: (req) => invoke('menu:createTaxCategory', req),
    updateTaxCategory: (req) => invoke('menu:updateTaxCategory', req),
    deleteTaxCategory: (req) => invoke('menu:deleteTaxCategory', req),
  },
  orders: {
    create: (req) => invoke('orders:create', req),
    list: (req) => invoke('orders:list', req),
    history: (req) => invoke('orders:history', req),
    get: (req) => invoke('orders:get', req),
    addItem: (req) => invoke('orders:addItem', req),
    updateItemQuantity: (req) => invoke('orders:updateItemQuantity', req),
    removeItem: (req) => invoke('orders:removeItem', req),
    applyDiscount: (req) => invoke('orders:applyDiscount', req),
    clearDiscount: (req) => invoke('orders:clearDiscount', req),
    tender: (req) => invoke('orders:tender', req),
    void: (req) => invoke('orders:void', req),
    refund: (req) => invoke('orders:refund', req),
    attachCustomer: (req) => invoke('orders:attachCustomer', req),
    detachCustomer: (req) => invoke('orders:detachCustomer', req),
    listActive: (req) => invoke('orders:listActive', req),
    sendToKitchen: (req) => invoke('orders:sendToKitchen', req),
    markPreparing: (req) => invoke('orders:markPreparing', req),
    markReady: (req) => invoke('orders:markReady', req),
    assignRider: (req) => invoke('orders:assignRider', req),
    unassignRider: (req) => invoke('orders:unassignRider', req),
    markServed: (req) => invoke('orders:markServed', req),
    markDelivered: (req) => invoke('orders:markDelivered', req),
  },
  sync: {
    getConfig: () => invoke('sync:getConfig', undefined),
    setConfig: (req) => invoke('sync:setConfig', req),
    getStatus: () => invoke('sync:getStatus', undefined),
    triggerNow: () => invoke('sync:triggerNow', undefined),
  },
  backup: {
    list: () => invoke('backup:list', undefined),
    create: () => invoke('backup:create', undefined),
    export: () => invoke('backup:export', undefined),
    stageRestoreFromPicker: () => invoke('backup:stageRestoreFromPicker', undefined),
    stageRestoreFromPath: (req) => invoke('backup:stageRestoreFromPath', req),
    delete: (req) => invoke('backup:delete', req),
    applyAndRelaunch: () => invoke('backup:applyAndRelaunch', undefined),
  },
  customers: {
    list: (req) => invoke('customers:list', req),
    findByPhone: (req) => invoke('customers:findByPhone', req),
    get: (req) => invoke('customers:get', req),
    create: (req) => invoke('customers:create', req),
    update: (req) => invoke('customers:update', req),
    listAddresses: (req) => invoke('customers:listAddresses', req),
    createAddress: (req) => invoke('customers:createAddress', req),
    setDefaultAddress: (req) => invoke('customers:setDefaultAddress', req),
    deleteAddress: (req) => invoke('customers:deleteAddress', req),
    orderHistory: (req) => invoke('customers:orderHistory', req),
  },
  tables: {
    listSections: () => invoke('tables:listSections', undefined),
    list: (req) => invoke('tables:list', req),
  },
  riders: {
    list: (req) => invoke('riders:list', req),
    create: (req) => invoke('riders:create', req),
    update: (req) => invoke('riders:update', req),
    deactivate: (req) => invoke('riders:deactivate', req),
  },
  printer: {
    getConfig: () => invoke('printer:getConfig', undefined),
    setConfig: (req) => invoke('printer:setConfig', req),
    setBranding: (req) => invoke('printer:setBranding', req),
    test: () => invoke('printer:test', undefined),
    reprint: (req) => invoke('printer:reprint', req),
  },
  fbr: {
    getConfig: () => invoke('fbr:getConfig', undefined),
    setConfig: (req) => invoke('fbr:setConfig', req),
    getQueueStats: () => invoke('fbr:getQueueStats', undefined),
    retryFailed: () => invoke('fbr:retryFailed', undefined),
    getInvoiceStatus: (req) => invoke('fbr:getInvoiceStatus', req),
  },
  reports: {
    salesSummary: (req) => invoke('reports:salesSummary', req),
    salesByDay: (req) => invoke('reports:salesByDay', req),
    salesByHour: (req) => invoke('reports:salesByHour', req),
    salesByCategory: (req) => invoke('reports:salesByCategory', req),
    topItems: (req) => invoke('reports:topItems', req),
    salesByMode: (req) => invoke('reports:salesByMode', req),
    salesByPaymentMethod: (req) => invoke('reports:salesByPaymentMethod', req),
    salesByCashier: (req) => invoke('reports:salesByCashier', req),
    discounts: (req) => invoke('reports:discounts', req),
    lowStock: () => invoke('reports:lowStock', undefined),
    cogs: (req) => invoke('reports:cogs', req),
  },
  inventory: {
    listIngredients: (req) => invoke('inventory:listIngredients', req),
    createIngredient: (req) => invoke('inventory:createIngredient', req),
    updateIngredient: (req) => invoke('inventory:updateIngredient', req),
    deleteIngredient: (req) => invoke('inventory:deleteIngredient', req),
    getRecipe: (req) => invoke('inventory:getRecipe', req),
    setRecipe: (req) => invoke('inventory:setRecipe', req),
    listMovements: (req) => invoke('inventory:listMovements', req),
    recordMovement: (req) => invoke('inventory:recordMovement', req),
    listSuppliers: (req) => invoke('inventory:listSuppliers', req),
    createSupplier: (req) => invoke('inventory:createSupplier', req),
    updateSupplier: (req) => invoke('inventory:updateSupplier', req),
    listPurchaseOrders: (req) => invoke('inventory:listPurchaseOrders', req),
    getPurchaseOrder: (req) => invoke('inventory:getPurchaseOrder', req),
    createPurchaseOrder: (req) => invoke('inventory:createPurchaseOrder', req),
    setPurchaseOrderStatus: (req) => invoke('inventory:setPurchaseOrderStatus', req),
    receiveDelivery: (req) => invoke('inventory:receiveDelivery', req),
  },
};

contextBridge.exposeInMainWorld('api', api);

// Subscribe to printer failure events (one-way main → renderer) so the renderer
// can surface a toast. Unsubscribe handle is returned so React effects clean up.
contextBridge.exposeInMainWorld('printerEvents', {
  onFailed: (cb: (payload: { jobKind: string; orderId?: string; error?: { code: string; message: string } }) => void) => {
    const listener = (_e: unknown, payload: { jobKind: string; orderId?: string; error?: { code: string; message: string } }) => cb(payload);
    ipcRenderer.on('printer:failed', listener);
    return () => ipcRenderer.removeListener('printer:failed', listener);
  },
});

// Subscribe to FBR queue-changed broadcasts so the dashboard badge refreshes.
contextBridge.exposeInMainWorld('fbrEvents', {
  onQueueChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('fbr:queue-changed', listener);
    return () => ipcRenderer.removeListener('fbr:queue-changed', listener);
  },
});

// Subscribe to auto-updater broadcasts so the UpdateBanner can react.
contextBridge.exposeInMainWorld('updaterEvents', {
  onAvailable: (cb: (payload: { version: string | null }) => void) => {
    const listener = (_e: unknown, payload: { version: string | null }) => cb(payload);
    ipcRenderer.on('updater:available', listener);
    return () => ipcRenderer.removeListener('updater:available', listener);
  },
  onReady: (cb: (payload: { version: string | null }) => void) => {
    const listener = (_e: unknown, payload: { version: string | null }) => cb(payload);
    ipcRenderer.on('updater:ready', listener);
    return () => ipcRenderer.removeListener('updater:ready', listener);
  },
  // Pull the cached state on mount so a renderer that mounted *after* the
  // broadcast still shows the banner (e.g. user was still on onboarding when
  // the download finished).
  getState: () =>
    ipcRenderer.invoke('updater:getState') as Promise<
      | { kind: 'idle' }
      | { kind: 'downloading'; version: string | null }
      | { kind: 'ready'; version: string | null }
    >,
  // Diagnostics: returns a snapshot of init state, last check result, last
  // error, and feed URL. Use from DevTools to debug why the updater is idle.
  getDiagnostics: () => ipcRenderer.invoke('updater:getDiagnostics') as Promise<unknown>,
  // Manually trigger a check now. Resolves with { ok, result | error }.
  checkNow: () => ipcRenderer.invoke('updater:checkNow') as Promise<unknown>,
  installNow: () => {
    ipcRenderer.send('updater:install-now');
  },
});

contextBridge.exposeInMainWorld('syncEvents', {
  onStatusChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('sync:status-changed', listener);
    return () => ipcRenderer.removeListener('sync:status-changed', listener);
  },
});
