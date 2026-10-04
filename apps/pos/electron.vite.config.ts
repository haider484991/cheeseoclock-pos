import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { build as viteBuild, type Plugin } from 'vite';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { WORKER_FILE } from './electron/services/analytics/worker-protocol';

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

/**
 * What the Reports worker must never load: Electron (a worker thread has no
 * Electron APIs), and better-sqlite3 by name (it is loaded at run time from
 * the path the main process found, the unpacked copy in an installed till).
 */
const WORKER_FORBIDDEN = [/^electron(\/|$)/, /^electron-log(\/|$)/, /^better-sqlite3(\/|$)/];

/**
 * Build the Reports worker thread (costing spec Phase 3) to
 * `<outDir>/analytics-worker.cjs`: one self-contained CommonJS file, every
 * package bundled in (workspace and npm alike), only Node's own modules
 * left out. Self-contained because an installed till loads it from
 * app.asar.unpacked (electron-builder.yml asarUnpack), where no
 * node_modules but better-sqlite3's sit beside it. A separate build, not a
 * second input of the main build: that would split shared chunks between
 * the two and leave npm packages external. Also used by the bench
 * (electron/services/bench-reports.db.test.ts).
 */
export async function buildAnalyticsWorker(opts: { outDir: string }): Promise<void> {
  const forbid: Plugin = {
    name: 'coc-analytics-worker-forbidden-imports',
    enforce: 'pre',
    resolveId(source, importer) {
      if (WORKER_FORBIDDEN.some((re) => re.test(source))) {
        this.error(
          `The Reports worker must not import "${source}" (from ${importer ?? '?'}). ` +
            'Keep Electron and the write paths out of services/analytics and what it loads.',
        );
      }
      return null;
    },
  };
  await viteBuild({
    configFile: false,
    root: __dirname,
    logLevel: 'warn',
    mode: 'production',
    plugins: [forbid],
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'electron'),
      },
    },
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: resolve(__dirname, 'electron/services/analytics/worker.ts'),
      outDir: opts.outDir,
      emptyOutDir: false,
      target: 'node20',
      minify: false,
      sourcemap: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      rollupOptions: {
        external: [/^node:/, ...builtinModules],
        output: {
          format: 'cjs',
          entryFileNames: WORKER_FILE,
          inlineDynamicImports: true,
        },
      },
    },
  });
}

/** Builds the Reports worker next to the main bundle, each time the main bundle is written (dev too). */
function analyticsWorkerPlugin(): Plugin {
  return {
    name: 'coc-analytics-worker',
    apply: 'build',
    async writeBundle(output) {
      await buildAnalyticsWorker({ outDir: output.dir ?? resolve(__dirname, 'out/main') });
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES }), analyticsWorkerPlugin()],
    // Baked in at build time: true when this build is code-signed (CI sets
    // WIN_CSC_LINK from its secret). A signed build keeps electron-updater's
    // Authenticode check on; an unsigned one has to switch it off or every
    // update would stall (services/auto-updater.ts).
    define: {
      __SIGNED_BUILD__: JSON.stringify(Boolean(process.env['WIN_CSC_LINK'] || process.env['CSC_LINK'])),
    },
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
