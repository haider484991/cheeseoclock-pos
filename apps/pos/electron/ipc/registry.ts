import { ipcMain } from 'electron';
import log from 'electron-log/main';
import type { AppDatabase } from '../db/connection.js';
import type {
  ApiError,
  IpcChannel,
  IpcContract,
  IpcRequest,
  IpcResponse,
} from '@cheeseoclock/shared-types';
import { registerSystemHandlers } from './handlers/system-handlers.js';
import { registerAuthHandlers } from './handlers/auth-handlers.js';
import { registerUsersHandlers } from './handlers/users-handlers.js';
import { registerMenuHandlers } from './handlers/menu-handlers.js';
import { registerOrdersHandlers } from './handlers/orders-handlers.js';
import { registerTablesHandlers } from './handlers/tables-handlers.js';
import { registerPrinterHandlers } from './handlers/printer-handlers.js';
import { registerFbrHandlers } from './handlers/fbr-handlers.js';
import { registerInventoryHandlers } from './handlers/inventory-handlers.js';
import { registerReportsHandlers } from './handlers/reports-handlers.js';
import { registerCustomersHandlers } from './handlers/customers-handlers.js';
import { registerBackupHandlers } from './handlers/backup-handlers.js';
import { registerSyncHandlers } from './handlers/sync-handlers.js';
import { registerRidersHandlers } from './handlers/riders-handlers.js';
import { reapStaleSessions } from '../services/auth-service.js';

export interface HandlerContext {
  db: AppDatabase;
  deviceId: string;
}

export type HandlerFn<C extends IpcChannel> = (
  ctx: HandlerContext,
  payload: IpcRequest<C>,
) => Promise<IpcResponse<C>> | IpcResponse<C>;

/**
 * Sentinel thrown by guard helpers (requireSession, requireMenuManage, etc.)
 * so handler bodies can use the post-guard session value without type narrowing
 * gymnastics. defineHandler catches it and maps to the appropriate ApiResult.
 */
export class IpcGuardError extends Error {
  readonly apiError: ApiError;
  constructor(apiError: ApiError) {
    super(apiError.message);
    this.apiError = apiError;
    this.name = 'IpcGuardError';
  }
}

/**
 * Register a handler with consistent error mapping. Handlers return their
 * own ApiResult<T>; this wrapper catches anything that throws and maps it
 * to { ok: false, error: ... } so the renderer never sees a raw exception.
 */
export function defineHandler<C extends IpcChannel>(
  channel: C,
  ctx: HandlerContext,
  fn: HandlerFn<C>,
): void {
  ipcMain.handle(channel, async (_event, payload: IpcRequest<C>) => {
    try {
      return await fn(ctx, payload);
    } catch (err) {
      if (err instanceof IpcGuardError) {
        return { ok: false, error: err.apiError } as IpcContract[C]['response'];
      }
      // Don't leak internals (SQL constraint names, column names, HTTP URLs
      // with credentials in headers, etc.) to the renderer. Log everything
      // server-side; return a correlation id the operator can quote.
      const correlationId = `err_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      log.error(`IPC handler error [${channel}] (${correlationId})`, err);
      return {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Something went wrong. Reference: ${correlationId}`,
        },
      } as IpcContract[C]['response'];
    }
  });
}

export function registerAllIpcHandlers(ctx: HandlerContext): void {
  reapStaleSessions(ctx.db);
  registerSystemHandlers(ctx);
  registerAuthHandlers(ctx);
  registerUsersHandlers(ctx);
  registerMenuHandlers(ctx);
  registerOrdersHandlers(ctx);
  registerTablesHandlers(ctx);
  registerPrinterHandlers(ctx);
  registerFbrHandlers(ctx);
  registerInventoryHandlers(ctx);
  registerReportsHandlers(ctx);
  registerCustomersHandlers(ctx);
  registerSyncHandlers(ctx);
  registerBackupHandlers(ctx);
  registerRidersHandlers(ctx);
  log.info('IPC handlers registered');
}
