import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Workspace packages export raw .ts files (no build step). Node cannot load .ts
 * at runtime, so we must bundle them into the main + preload outputs by
 * EXCLUDING them from externalize. Real npm deps stay externalized so native
 * modules (better-sqlite3, @node-rs/argon2) load from node_modules at runtime.
 */
const WORKSPACE_PACKAGES = [
  '@cheeseoclock/shared-types',
  '@cheeseoclock/shared-schemas',
  '@cheeseoclock/pos-domain',
  '@cheeseoclock/printer-core',
  '@cheeseoclock/fbr-core',
  '@cheeseoclock/sync-core',
  '@cheeseoclock/ui',
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve(__dirname, 'electron/index.ts'),
      },
      rollupOptions: {
        external: [
          'better-sqlite3',
          '@node-rs/argon2',
          'electron-log',
          'pino',
          'umzug',
          // Optional deps loaded via dynamic import + try/catch. Externalize so
          // the build doesn't error when they're not installed — the runtime
          // `import('...')` resolves from node_modules if present, throws to
          // our catch otherwise.
          'electron-updater',
          '@sentry/electron/main',
        ],
      },
    },
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'electron'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
    build: {
      outDir: 'out/preload',
      lib: {
        entry: resolve(__dirname, 'electron/preload.ts'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname),
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    server: {
      port: 5173,
    },
  },
});
