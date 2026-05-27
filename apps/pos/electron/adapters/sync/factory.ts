import { LocalOnlySyncAdapter, type SyncAdapter } from '@cheeseoclock/sync-core';
import { MockSyncAdapter } from './mock-sync-adapter.js';
import { HttpSyncAdapter } from './http-sync-adapter.js';

export type SyncMode = 'off' | 'mock' | 'http';

export interface SyncAdapterOptions {
  mode: SyncMode;
  baseUrl?: string;
  deviceSecret?: string;
  deviceId: string;
}

export function makeSyncAdapter(opts: SyncAdapterOptions): SyncAdapter {
  switch (opts.mode) {
    case 'off':
      return new LocalOnlySyncAdapter();
    case 'mock':
      return new MockSyncAdapter();
    case 'http':
      if (!opts.baseUrl) throw new Error('http sync requires a base URL');
      if (!opts.deviceSecret) throw new Error('http sync requires a device secret');
      return new HttpSyncAdapter({
        baseUrl: opts.baseUrl,
        deviceId: opts.deviceId,
        deviceSecret: opts.deviceSecret,
      });
  }
}
