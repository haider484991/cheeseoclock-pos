import type { FbrAdapter, FbrAdapterConfig } from '@cheeseoclock/fbr-core';
import { NoopFbrAdapter } from './noop-fbr-adapter.js';
import { HttpFbrAdapter } from './http-fbr-adapter.js';

export function makeFbrAdapter(config: FbrAdapterConfig): FbrAdapter {
  if (config.mode === 'noop') return new NoopFbrAdapter(config);
  return new HttpFbrAdapter(config);
}
