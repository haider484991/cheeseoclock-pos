/**
 * The IPC contract lives in `@cheeseoclock/shared-types` so both main and
 * renderer can reference the same source of truth. This module re-exports
 * for convenience to keep handler imports terse.
 */

export type {
  IpcContract,
  IpcChannel,
  IpcRequest,
  IpcResponse,
} from '@cheeseoclock/shared-types';
