/// <reference types="vite/client" />

import type { RendererApi } from '@cheeseoclock/shared-types';

declare global {
  interface Window {
    api: RendererApi;
  }
}

export {};
