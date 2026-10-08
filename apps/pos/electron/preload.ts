import { contextBridge, ipcRenderer } from 'electron';
import type {
  CloseTillAsk,
  IpcChannel,
  IpcRequest,
  IpcResponse,
  MenuDeployChangedEvent,
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
  licence: {
    status: () => invoke('licence:status', undefined),
    activate: (req) => invoke('licence:activate', req),
    resetClock: () => invoke('licence:resetClock', undefined),
  },
  system: {
    getVersion: () => invoke('system:getVersion', undefined),
    getDeviceInfo: () => invoke('system:getDeviceInfo', undefined),
    getBranding: () => invoke('system:getBranding', undefined),
    getSetupStatus: () => invoke('system:getSetupStatus', undefined),
    getDeliveryCity: () => invoke('system:getDeliveryCity', undefined),
    completeOnboarding: (req) => invoke('system:completeOnboarding', req),
    // "Close the till?": on screen, and the answer (no login: the PIN screen asks too).
    closeShown: (req) => invoke('system:closeShown', req),
    closeAnswer: (req) => invoke('system:closeAnswer', req),
  },
  auth: {
    login: (req) => invoke('auth:login', req),
    logout: () => invoke('auth:logout', undefined),
    currentSession: () => invoke('auth:currentSession', undefined),
    activity: () => invoke('auth:activity', undefined),
    keepStepIn: (req) => invoke('auth:keepStepIn', req),
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
    importPick: () => invoke('menu:importPick', undefined),
    importPreview: (payload: IpcRequest<'menu:importPreview'>) => invoke('menu:importPreview', payload),
    importApply: (payload?: IpcRequest<'menu:importApply'>) => invoke('menu:importApply', payload),
    listTaxCategories: () => invoke('menu:listTaxCategories', undefined),
    createTaxCategory: (req) => invoke('menu:createTaxCategory', req),
    updateTaxCategory: (req) => invoke('menu:updateTaxCategory', req),
    deleteTaxCategory: (req) => invoke('menu:deleteTaxCategory', req),
  },
  orders: {
    create: (req) => invoke('orders:create', req),
    list: (req) => invoke('orders:list', req),
    history: (req) => invoke('orders:history', req),
    recentAtCounter: (req) => invoke('orders:recentAtCounter', req),
    get: (req) => invoke('orders:get', req),
    addItem: (req) => invoke('orders:addItem', req),
    updateItemQuantity: (req) => invoke('orders:updateItemQuantity', req),
    removeItem: (req) => invoke('orders:removeItem', req),
    updateItemOptions: (req) => invoke('orders:updateItemOptions', req),
    applyDiscount: (req) => invoke('orders:applyDiscount', req),
    clearDiscount: (req) => invoke('orders:clearDiscount', req),
    previewEdit: (req) => invoke('orders:previewEdit', req),
    saveEdit: (req) => invoke('orders:saveEdit', req),
    setMode: (req) => invoke('orders:setMode', req),
    setDeliveryArea: (req) => invoke('orders:setDeliveryArea', req),
    setCameBy: (req) => invoke('orders:setCameBy', req),
    resumeDraft: () => invoke('orders:resumeDraft', undefined),
    discardDraft: (req) => invoke('orders:discardDraft', req),
    tender: (req) => invoke('orders:tender', req),
    changePaymentMethod: (req) => invoke('orders:changePaymentMethod', req),
    void: (req) => invoke('orders:void', req),
    refund: (req) => invoke('orders:refund', req),
    stockStatus: (req) => invoke('orders:stockStatus', req),
    testDeletePreview: (req) => invoke('orders:testDeletePreview', req),
    deleteTest: (req) => invoke('orders:deleteTest', req),
    listDeletedTests: (req) => invoke('orders:listDeletedTests', req),
    attachCustomer: (req) => invoke('orders:attachCustomer', req),
    detachCustomer: (req) => invoke('orders:detachCustomer', req),
    setNote: (req) => invoke('orders:setNote', req),
    listActive: (req) => invoke('orders:listActive', req),
    sendToKitchen: (req) => invoke('orders:sendToKitchen', req),
    markPreparing: (req) => invoke('orders:markPreparing', req),
    markReady: (req) => invoke('orders:markReady', req),
    sendOut: (req) => invoke('orders:sendOut', req),
    assignRider: (req) => invoke('orders:assignRider', req),
    unassignRider: (req) => invoke('orders:unassignRider', req),
    markServed: (req) => invoke('orders:markServed', req),
    markDelivered: (req) => invoke('orders:markDelivered', req),
    riderPaid: (req) => invoke('orders:riderPaid', req),
  },
  sync: {
    getConfig: () => invoke('sync:getConfig', undefined),
    setConfig: (req) => invoke('sync:setConfig', req),
    getStatus: () => invoke('sync:getStatus', undefined),
    triggerNow: () => invoke('sync:triggerNow', undefined),
    sendEverything: () => invoke('sync:sendEverything', undefined),
    clearNotSaved: () => invoke('sync:clearNotSaved', undefined),
  },
  backup: {
    list: () => invoke('backup:list', undefined),
    create: () => invoke('backup:create', undefined),
    export: () => invoke('backup:export', undefined),
    pickSecondCopyFolder: () => invoke('backup:pickSecondCopyFolder', undefined),
    clearSecondCopy: () => invoke('backup:clearSecondCopy', undefined),
    stageRestoreFromPicker: () => invoke('backup:stageRestoreFromPicker', undefined),
    stageRestoreFromPath: (req) => invoke('backup:stageRestoreFromPath', req),
    delete: (req) => invoke('backup:delete', req),
    applyAndRelaunch: (req) => invoke('backup:applyAndRelaunch', req),
    cancelStagedRestore: () => invoke('backup:cancelStagedRestore', undefined),
    health: () => invoke('backup:health', undefined),
  },
  customers: {
    list: (req) => invoke('customers:list', req),
    page: (req) => invoke('customers:page', req),
    areaUsage: (req) => invoke('customers:areaUsage', req),
    findByPhone: (req) => invoke('customers:findByPhone', req),
    get: (req) => invoke('customers:get', req),
    create: (req) => invoke('customers:create', req),
    update: (req) => invoke('customers:update', req),
    listAddresses: (req) => invoke('customers:listAddresses', req),
    searchAddresses: (req) => invoke('customers:searchAddresses', req),
    createAddress: (req) => invoke('customers:createAddress', req),
    setDefaultAddress: (req) => invoke('customers:setDefaultAddress', req),
    deleteAddress: (req) => invoke('customers:deleteAddress', req),
    delete: (req) => invoke('customers:delete', req),
    exportCsv: () => invoke('customers:exportCsv', undefined),
    orderHistory: (req) => invoke('customers:orderHistory', req),
    attachToOrder: (req) => invoke('customers:attachToOrder', req),
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
  shifts: {
    current: () => invoke('shifts:current', undefined),
    open: (req) => invoke('shifts:open', req),
    close: (req) => invoke('shifts:close', req),
    closeCheck: (req) => invoke('shifts:closeCheck', req),
    printReport: (req) => invoke('shifts:printReport', req),
    list: (req) => invoke('shifts:list', req),
    summary: (req) => invoke('shifts:summary', req),
    lastCount: () => invoke('shifts:lastCount', undefined),
    openingFloat: () => invoke('shifts:openingFloat', undefined),
    recordCashMovement: (req) => invoke('shifts:recordCashMovement', req),
    listCashMovements: (req) => invoke('shifts:listCashMovements', req),
    openDrawer: (req) => invoke('shifts:openDrawer', req),
  },
  webBridge: {
    getConfig: () => invoke('webBridge:getConfig', undefined),
    setConfig: (req) => invoke('webBridge:setConfig', req),
    getStatus: () => invoke('webBridge:getStatus', undefined),
    publishMenu: () => invoke('webBridge:publishMenu', undefined),
    pollNow: () => invoke('webBridge:pollNow', undefined),
    diagnose: () => invoke('webBridge:diagnose', undefined),
    backupNow: () => invoke('webBridge:backupNow', undefined),
    listCloudBackups: () => invoke('webBridge:listCloudBackups', undefined),
    restoreCloudBackup: (req) => invoke('webBridge:restoreCloudBackup', req),
    previewCloudBackups: (req) => invoke('webBridge:previewCloudBackups', req),
    restoreCloudBackupWith: (req) => invoke('webBridge:restoreCloudBackupWith', req),
  },
  audit: {
    verifyChain: () => invoke('audit:verifyChain', undefined),
  },
  alerts: {
    getSounds: () => invoke('alerts:getSounds', undefined),
    setSounds: (req) => invoke('alerts:setSounds', req),
    getPending: () => invoke('alerts:getPending', undefined),
    acknowledge: (req) => invoke('alerts:acknowledge', req),
    getWatch: () => invoke('alerts:getWatch', undefined),
    testNotice: () => invoke('alerts:testNotice', undefined),
  },
  printer: {
    getConfig: () => invoke('printer:getConfig', undefined),
    setConfig: (req) => invoke('printer:setConfig', req),
    setBranding: (req) => invoke('printer:setBranding', req),
    setLogoRaster: (req) => invoke('printer:setLogoRaster', req),
    setPolicy: (req) => invoke('printer:setPolicy', req),
    setKitchenPrinter: (req) => invoke('printer:setKitchenPrinter', req),
    test: (req) => invoke('printer:test', req),
    testDrawer: () => invoke('printer:testDrawer', undefined),
    listSystemPrinters: () => invoke('printer:listSystemPrinters', undefined),
    reprint: (req) => invoke('printer:reprint', req),
    reprintKitchen: (req) => invoke('printer:reprintKitchen', req),
    reprintCounts: (req) => invoke('printer:reprintCounts', req),
    orderPapers: (req) => invoke('printer:orderPapers', req),
    retryJob: (req) => invoke('printer:retryJob', req),
  },
  fbr: {
    getConfig: () => invoke('fbr:getConfig', undefined),
    setConfig: (req) => invoke('fbr:setConfig', req),
    getQueueStats: () => invoke('fbr:getQueueStats', undefined),
    retryFailed: () => invoke('fbr:retryFailed', undefined),
    getInvoiceStatus: (req) => invoke('fbr:getInvoiceStatus', req),
  },
  reports: {
    lowStock: () => invoke('reports:lowStock', undefined),
    // One channel per Reports tab (costing spec Phase 3).
    overview: (req) => invoke('reports:overview', req),
    when: (req) => invoke('reports:when', req),
    menu: (req) => invoke('reports:menu', req),
    channels: (req) => invoke('reports:channels', req),
    foodStock: (req) => invoke('reports:foodStock', req),
    team: (req) => invoke('reports:team', req),
    // The owner's week (costing spec Phase 7).
    ownerWeek: (req) => invoke('reports:ownerWeek', req),
    trends: () => invoke('reports:trends', undefined),
    addDayNote: (req) => invoke('reports:addDayNote', req),
    removeDayNote: (req) => invoke('reports:removeDayNote', req),
    getDayparts: () => invoke('reports:getDayparts', undefined),
    setDayparts: (req) => invoke('reports:setDayparts', req),
    // Stock takes: used vs should have used (costing spec Phase 8).
    variance: (req) => invoke('reports:variance', req),
    drawerLog: (req) => invoke('reports:drawerLog', req),
    // Profit and the menu map (costing spec Phase 9).
    profit: (req) => invoke('reports:profit', req),
    menuMap: (req) => invoke('reports:menuMap', req),
  },
  inventory: {
    listIngredients: (req) => invoke('inventory:listIngredients', req),
    createIngredient: (req) => invoke('inventory:createIngredient', req),
    updateIngredient: (req) => invoke('inventory:updateIngredient', req),
    deleteIngredient: (req) => invoke('inventory:deleteIngredient', req),
    convertIngredientUnit: (req) => invoke('inventory:convertIngredientUnit', req),
    setPrice: (req) => invoke('inventory:setPrice', req),
    priceHistory: (req) => invoke('inventory:priceHistory', req),
    useSheetPrice: (req) => invoke('inventory:useSheetPrice', req),
    getRecipe: (req) => invoke('inventory:getRecipe', req),
    setRecipe: (req) => invoke('inventory:setRecipe', req),
    listRecipeLineCounts: () => invoke('inventory:listRecipeLineCounts', undefined),
    getBatchRecipe: (req) => invoke('inventory:getBatchRecipe', req),
    setBatchRecipe: (req) => invoke('inventory:setBatchRecipe', req),
    makeBatch: (req) => invoke('inventory:makeBatch', req),
    // The recipe calculator (quantities only).
    recipeCalc: (req) => invoke('inventory:recipeCalc', req),
    typicalPicks: (req) => invoke('inventory:typicalPicks', req),
    printPrepList: (req) => invoke('inventory:printPrepList', req),
    listMovements: (req) => invoke('inventory:listMovements', req),
    searchMovements: (req) => invoke('inventory:searchMovements', req),
    recordMovement: (req) => invoke('inventory:recordMovement', req),
    listSuppliers: (req) => invoke('inventory:listSuppliers', req),
    createSupplier: (req) => invoke('inventory:createSupplier', req),
    updateSupplier: (req) => invoke('inventory:updateSupplier', req),
    listPurchaseOrders: (req) => invoke('inventory:listPurchaseOrders', req),
    getPurchaseOrder: (req) => invoke('inventory:getPurchaseOrder', req),
    createPurchaseOrder: (req) => invoke('inventory:createPurchaseOrder', req),
    setPurchaseOrderStatus: (req) => invoke('inventory:setPurchaseOrderStatus', req),
    receiveDelivery: (req) => invoke('inventory:receiveDelivery', req),
    recordPurchase: (req) => invoke('inventory:recordPurchase', req),
    payoutToPurchase: (req) => invoke('inventory:payoutToPurchase', req),
    listDrawerPayouts: (req) => invoke('inventory:listDrawerPayouts', req),
    // Stock takes (costing spec Phase 8).
    stockCountList: (req) => invoke('inventory:stockCountList', req),
    stockCountGet: (req) => invoke('inventory:stockCountGet', req),
    stockCountStart: (req) => invoke('inventory:stockCountStart', req),
    stockCountSave: (req) => invoke('inventory:stockCountSave', req),
    stockCountFinish: (req) => invoke('inventory:stockCountFinish', req),
    stockCountCancel: (req) => invoke('inventory:stockCountCancel', req),
    stockCountOne: (req) => invoke('inventory:stockCountOne', req),
  },
  costing: {
    menuCosts: () => invoke('costing:menuCosts', undefined),
    itemSheet: (req) => invoke('costing:itemSheet', req),
    missingCosts: () => invoke('costing:missingCosts', undefined),
    getTargets: () => invoke('costing:getTargets', undefined),
    setTargets: (req) => invoke('costing:setTargets', req),
    recipeCost: (req) => invoke('costing:recipeCost', req),
    batchCalc: (req) => invoke('costing:batchCalc', req),
    recipeCalc: (req) => invoke('costing:recipeCalc', req),
    alerts: () => invoke('costing:alerts', undefined),
    markAlertsSeen: (req) => invoke('costing:markAlertsSeen', req),
    getAlertSettings: () => invoke('costing:getAlertSettings', undefined),
    setAlertSettings: (req) => invoke('costing:setAlertSettings', req),
    getTills: () => invoke('costing:getTills', undefined),
    setTills: (req) => invoke('costing:setTills', req),
    // Profit (costing spec Phase 9).
    getChannelFees: () => invoke('costing:getChannelFees', undefined),
    setChannelFees: (req) => invoke('costing:setChannelFees', req),
    whatIf: (req) => invoke('costing:whatIf', req),
  },
  // The owner's shop rules (Settings → foodpanda …): the owner only, checked in the main process.
  settings: {
    getBusiness: (req) => invoke('settings:getBusiness', req),
    setBusiness: (req) => invoke('settings:setBusiness', req),
    saveDeliveryZones: (req) => invoke('settings:saveDeliveryZones', req),
    // This till's own (the receipt's extra lines, the opening float, this computer): the owner only too.
    getTill: (req) => invoke('settings:getTill', req),
    setTill: (req) => invoke('settings:setTill', req),
  },
  // This computer (Settings → Online orders): the owner only.
  power: {
    getStatus: () => invoke('power:getStatus', undefined),
    turnBackOn: () => invoke('power:turnBackOn', undefined),
  },
  // What the counter needs to take an order (the foodpanda deal, Pay's checks).
  checkout: {
    getRules: () => invoke('checkout:getRules', undefined),
  },
  // Menu files from the costing PC (v0.7.32).
  menuDeploy: {
    getStatus: (req) => invoke('menuDeploy:getStatus', req),
    checkNow: () => invoke('menuDeploy:checkNow', undefined),
    createKey: () => invoke('menuDeploy:createKey', undefined),
    preview: (req) => invoke('menuDeploy:preview', req),
    apply: (req) => invoke('menuDeploy:apply', req),
  },
  dashboard: {
    getStatus: () => invoke('dashboard:getStatus', undefined),
    setOn: (req) => invoke('dashboard:setOn', req),
    pushNow: () => invoke('dashboard:pushNow', undefined),
    listLogins: () => invoke('dashboard:listLogins', undefined),
    addLogin: (req) => invoke('dashboard:addLogin', req),
    updateLogin: (req) => invoke('dashboard:updateLogin', req),
    newCode: (req) => invoke('dashboard:newCode', req),
    signOutAll: (req) => invoke('dashboard:signOutAll', req),
    removeLogin: (req) => invoke('dashboard:removeLogin', req),
  },
};

contextBridge.exposeInMainWorld('api', api);

// Subscribe to printer failure events (one-way main → renderer) so the renderer
// can surface a toast. Unsubscribe handle is returned so React effects clean up.
type PrinterFailedEvent = {
  jobId?: string;
  jobKind: string;
  orderId?: string;
  what?: string;
  /** jobKind 'shift_report': the shift whose report did not print. */
  shiftId?: string;
  error?: { code: string; message: string };
  retrying?: boolean;
};
contextBridge.exposeInMainWorld('printerEvents', {
  onFailed: (cb: (payload: PrinterFailedEvent) => void) => {
    const listener = (_e: unknown, payload: PrinterFailedEvent) => cb(payload);
    ipcRenderer.on('printer:failed', listener);
    return () => ipcRenderer.removeListener('printer:failed', listener);
  },
});

// Stock that just dropped below its low-stock level (sent once, on the way down).
contextBridge.exposeInMainWorld('inventoryEvents', {
  onLowStock: (
    cb: (items: Array<{ ingredientId: string; name: string; unit: string; resultingQty: number; threshold: number }>) => void,
  ) => {
    const listener = (
      _e: unknown,
      items: Array<{ ingredientId: string; name: string; unit: string; resultingQty: number; threshold: number }>,
    ) => cb(items);
    ipcRenderer.on('inventory:low-stock', listener);
    return () => ipcRenderer.removeListener('inventory:low-stock', listener);
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

// The owner's shop rules changed (saved here, or arrived from the other till).
contextBridge.exposeInMainWorld('shopSettingsEvents', {
  onChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('shop-settings:changed', listener);
    return () => ipcRenderer.removeListener('shop-settings:changed', listener);
  },
});

// A menu file from the costing PC: where this till stands, and a note when it is news (v0.7.32).
contextBridge.exposeInMainWorld('menuDeployEvents', {
  onChanged: (cb: (payload: MenuDeployChangedEvent) => void) => {
    const listener = (_e: unknown, payload: MenuDeployChangedEvent) => cb(payload);
    ipcRenderer.on('menuDeploy:changed', listener);
    return () => ipcRenderer.removeListener('menuDeploy:changed', listener);
  },
});

// X, Alt+F4 or the taskbar's Close while website orders come in through this
// till: the main process holds the close and asks "Close the till?" here first.
contextBridge.exposeInMainWorld('tillWindowEvents', {
  onCloseRequested: (cb: (payload: CloseTillAsk) => void) => {
    const listener = (_e: unknown, payload: CloseTillAsk) => cb(payload);
    ipcRenderer.on('system:close-requested', listener);
    return () => ipcRenderer.removeListener('system:close-requested', listener);
  },
});

contextBridge.exposeInMainWorld('syncEvents', {
  onStatusChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('sync:status-changed', listener);
    return () => ipcRenderer.removeListener('sync:status-changed', listener);
  },
});

// New online orders arriving from the website bridge → banner, chime + board refresh.
type WebOrderReceivedEvent = {
  orderId: string;
  orderNumber: string;
  customerName: string;
  webOrderId?: string;
  fulfilment?: 'delivery' | 'pickup';
  totalCents?: number | null;
  totalMismatch?: { webTotalCents: number; tillTotalCents: number };
};
type WebOrderImportFailedEvent = {
  webOrderId: string;
  customerName: string;
  message: string;
  customerPhone?: string | null;
  /** The till stopped trying: someone has to call the customer. */
  final?: boolean;
  reason?: 'gave_up' | 'stale' | 'error' | 'cancelled_on_site';
  /** The till's order number (cancelled_on_site: the website cancelled an order the kitchen has). */
  orderNumber?: string | null;
};
contextBridge.exposeInMainWorld('webOrderEvents', {
  onReceived: (cb: (payload: WebOrderReceivedEvent) => void) => {
    const listener = (_e: unknown, payload: WebOrderReceivedEvent) => cb(payload);
    ipcRenderer.on('web-order:received', listener);
    return () => ipcRenderer.removeListener('web-order:received', listener);
  },
  onImportFailed: (cb: (payload: WebOrderImportFailedEvent) => void) => {
    const listener = (_e: unknown, payload: WebOrderImportFailedEvent) => cb(payload);
    ipcRenderer.on('web-order:import-failed', listener);
    return () => ipcRenderer.removeListener('web-order:import-failed', listener);
  },
});

// A click on the till's Windows notice (new online order, order not in):
// the main process has already brought the window to the front. And part of
// the PIN screen's watch changed (website orders paused or started again):
// read alerts:getWatch again.
contextBridge.exposeInMainWorld('alertEvents', {
  onOpen: (cb: (payload: { kind: 'newOrder' | 'importFailed' | 'test' }) => void) => {
    const listener = (_e: unknown, payload: { kind: 'newOrder' | 'importFailed' | 'test' }) => cb(payload);
    ipcRenderer.on('alerts:open', listener);
    return () => ipcRenderer.removeListener('alerts:open', listener);
  },
  onWatchChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('alerts:watch-changed', listener);
    return () => ipcRenderer.removeListener('alerts:watch-changed', listener);
  },
});
