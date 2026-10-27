// Builds Cheese O'Clock's website for Cloudflare Workers, and with --deploy deploys it (27 Oct 2026; DEPLOY-CLOUDFLARE.md).
//
//   node apps/web/scripts/build-cloudflare.mjs test --db-url-file <file> [--deploy]
//   node apps/web/scripts/build-cloudflare.mjs production --db-url-file <file> [--deploy]
//
// <file> holds the database address the BUILD reads (its kept pages are drawn with the database's data, as on Vercel
// they are refreshed on the first heartbeat); the Worker itself reaches the database through Hyperdrive.
// NEXT_PUBLIC_META_PIXEL_ID (production) is read from this shell's environment, as Vercel's build reads its own.
//
// It never builds in this checkout. On Windows the OpenNext build leaves junctions that point at the real packages in
// node_modules/.pnpm, and a delete that follows one empties the real package (20 Oct 2026: next, react … emptied in a
// worktree). So the build runs in a throwaway copy under the temp folder, installed with plain folders (pnpm
// node-linker=hoisted), and every delete there goes through safe-rm (links removed, never followed).
//
// What the copy gets that this checkout does not have (Vercel's build is untouched):
//  - cloudflare/worker.mjs → cf-worker.mjs, cloudflare/open-next.config.ts, cloudflare/wrangler.<target>.jsonc → wrangler.jsonc;
//  - next.config.mjs: postgres.js left to OpenNext's bundler, which takes its Workers build (cloudflare:sockets);
//    bundled by Next it is the Node build, whose connection never opens on Workers (CONNECT_TIMEOUT);
//  - tsconfig.json: the tests left out of the build's type check (some import the till's code, not in the copy);
//  - OpenNext's next/og step given the font and wasm files Next does not trace for the share images (they bring their
//    own font): ENOENT otherwise;
//  - the share images' "….wasm?module" imports as "….wasm": wrangler writes each module under its import name, and
//    Windows allows no "?" in a file name (the same CompiledWasm module to wrangler).
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeRemove } from './safe-rm.mjs';

const target = process.argv[2];
const deploy = process.argv.includes('--deploy');
const dbFlag = process.argv.indexOf('--db-url-file');
const dbUrlFile = dbFlag > 0 ? process.argv[dbFlag + 1] : undefined;
if (!['test', 'production'].includes(target) || !dbUrlFile || !existsSync(dbUrlFile)) {
  console.error('usage: node apps/web/scripts/build-cloudflare.mjs <test|production> --db-url-file <file> [--deploy]');
  process.exit(1);
}

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(WEB, '../..');
const OUT = join(tmpdir(), 'coc-cloudflare');
const OUT_WEB = join(OUT, 'apps', 'web');
// The packages the website imports (by name, or by path from src/lib).
const PACKAGES = ['shared-types', 'shared-schemas', 'pos-domain', 'fbr-core', 'printer-core', 'sync-core'];
const SKIP = new Set(['node_modules', '.next', '.open-next', '.wrangler', '.turbo', 'tsconfig.tsbuildinfo', 'dist', '.vercel', '.dev.vars']);

const run = (cmd, cwd, env = {}) => {
  console.log(`\n$ ${cmd}   (in ${cwd})`);
  execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
};
const lines = (...l) => `${l.join('\n')}\n`;

/** Copies a folder's files except build output and node_modules (sources only: no links in them). */
function copySources(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (SKIP.has(name)) continue;
    cpSync(join(from, name), join(to, name), { recursive: true });
  }
}

/** One exact text swap in a copied file (written with \n; the checkout may have Windows line ends); stops if absent. */
function swap(path, from, to) {
  const text = readFileSync(path, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const [a, b] = [from, to].map((s) => s.replace(/\r?\n/g, eol));
  if (!text.includes(a)) throw new Error(`${path}: anchor not found:\n${from}`);
  writeFileSync(path, text.replace(a, b));
}

console.log(`Building the ${target} Worker in ${OUT}`);
mkdirSync(OUT, { recursive: true });

// 1. Fresh sources over the kept node_modules (an install there is slow; the sources are not).
safeRemove(join(OUT, 'apps', 'pos'));
for (const p of [OUT_WEB, ...PACKAGES.map((p) => join(OUT, 'packages', p))]) {
  if (!existsSync(p)) continue;
  for (const name of readdirSync(p)) if (name !== 'node_modules') safeRemove(join(p, name));
}
for (const f of ['package.json', 'pnpm-lock.yaml', 'tsconfig.base.json']) cpSync(join(ROOT, f), join(OUT, f));
copySources(WEB, OUT_WEB);
for (const p of PACKAGES) copySources(join(ROOT, 'packages', p), join(OUT, 'packages', p));
writeFileSync(join(OUT, 'pnpm-workspace.yaml'), lines('packages:', ...['apps/web', ...PACKAGES.map((p) => `packages/${p}`)].map((p) => `  - '${p}'`)));
writeFileSync(join(OUT, '.npmrc'), lines('auto-install-peers=true', 'strict-peer-dependencies=false', 'node-linker=hoisted'));
// The Cloudflare build tools, in this copy only: @opennextjs/cloudflare 1.15 is the last one for Next 14.2.
const webPkgPath = join(OUT_WEB, 'package.json');
const webPkg = JSON.parse(readFileSync(webPkgPath, 'utf8'));
webPkg.devDependencies = { ...webPkg.devDependencies, '@opennextjs/cloudflare': '1.15.1', wrangler: '4.59.3' };
writeFileSync(webPkgPath, lines(JSON.stringify(webPkg, null, 2)));
run('pnpm install --no-frozen-lockfile', OUT);

// 2. The Worker's own files and the copy's changes (see the top of this file).
cpSync(join(WEB, 'cloudflare', 'worker.mjs'), join(OUT_WEB, 'cf-worker.mjs'));
cpSync(join(WEB, 'cloudflare', 'open-next.config.ts'), join(OUT_WEB, 'open-next.config.ts'));
cpSync(join(WEB, 'cloudflare', `wrangler.${target}.jsonc`), join(OUT_WEB, 'wrangler.jsonc'));
swap(
  join(OUT_WEB, 'next.config.mjs'),
  "  transpilePackages: ['@cheeseoclock/shared-types'],\n",
  "  transpilePackages: ['@cheeseoclock/shared-types'],\n  experimental: { serverComponentsExternalPackages: ['postgres'] },\n",
);
swap(join(OUT_WEB, 'tsconfig.json'), '"exclude": ["node_modules", "cloudflare"]', '"exclude": ["node_modules", "cloudflare", "**/*.test.ts", "**/*.test.tsx"]');
const ogStep = join(OUT, 'node_modules/@opennextjs/cloudflare/dist/cli/build/patches/ast/patch-vercel-og-library.js');
const ogText = readFileSync(ogStep, 'utf8');
if (!ogText.includes('[cheeseoclock]')) {
  const anchor = '        const outputDir = getOutputDir({ functionsPath, packagePath });\n';
  if (!ogText.includes(anchor)) throw new Error('OpenNext og step: anchor not found (OpenNext changed?)');
  const insert = [
    '        // [cheeseoclock] Next did not trace these here (the site brings its own font): copy what is missing.',
    '        for (const f of ["noto-sans-v27-latin-regular.ttf", "resvg.wasm", "yoga.wasm"]) {',
    '            const dst = path.join(outputDir, f);',
    '            const src = path.join(path.dirname(createRequire(import.meta.url).resolve("next/package.json")), "dist/compiled/@vercel/og", f);',
    '            if (!existsSync(dst) && !existsSync(`${dst}.bin`)) copyFileSync(src, dst);',
    '        }',
    '',
  ].join('\n');
  writeFileSync(ogStep, `import { createRequire } from "node:module";\n${ogText.replace(anchor, anchor + insert)}`);
}

// 3. Build (the kept pages drawn from the database), then the wasm imports, then the size check.
const env = { DATABASE_URL: readFileSync(dbUrlFile, 'utf8').trim(), NEXT_TELEMETRY_DISABLED: '1' };
if (target === 'production' && !process.env['NEXT_PUBLIC_META_PIXEL_ID']) {
  console.error('NEXT_PUBLIC_META_PIXEL_ID is not set in this shell: the production build would have no Meta pixel.');
  process.exit(1);
}
safeRemove(join(OUT_WEB, '.next'));
safeRemove(join(OUT_WEB, '.open-next'));
run('npx opennextjs-cloudflare build', OUT_WEB, env);
for (const f of ['server-functions/default/apps/web/handler.mjs', 'server-functions/default/node_modules/next/dist/compiled/@vercel/og/index.edge.js']) {
  const path = join(OUT_WEB, '.open-next', f);
  if (existsSync(path)) writeFileSync(path, readFileSync(path, 'utf8').split('.wasm?module').join('.wasm'));
}
// OpenNext's page loader picks a page's module by how its path ENDS, the home page's check first:
// "…/app/dashboard/whatsapp/page.js" ends in "app/page.js" too, so /dashboard/whatsapp got the home page (27 Oct 2026).
// Every app check names the server folder before it ("server/app/page.js"), which only the home page's path ends in.
{
  const path = join(OUT_WEB, '.open-next/server-functions/default/apps/web/handler.mjs');
  const text = readFileSync(path, 'utf8');
  const check = /(pagePath\.replaceAll\("\\\\","\/"\)\.endsWith\(")app\//g;
  const found = text.match(check)?.length ?? 0;
  if (found === 0) throw new Error('OpenNext page loader: no "app/" checks found (OpenNext changed?): see the page-path fix in this script');
  const fixed = text.replace(check, '$1server/app/');
  if (/\.endsWith\("app\//.test(fixed)) throw new Error('OpenNext page loader: an "app/" check is left after the page-path fix');
  writeFileSync(path, fixed);
  console.log(`page loader: ${found} app page checks now name server/app/`);
}
run('npx wrangler deploy --dry-run', OUT_WEB, env);

// 4. Deploy: the build's kept pages into the KV page cache, then the Worker. OpenNext's helper starts a local Miniflare,
//    which this wrangler refuses a Hyperdrive binding in, and it ignores --configPath: wrangler.jsonc itself goes
//    without that line for that step only (it writes KV only).
if (deploy) {
  const configPath = join(OUT_WEB, 'wrangler.jsonc');
  const config = readFileSync(configPath, 'utf8');
  const withoutHyperdrive = config.replace(/^[ \t]*"hyperdrive":.*\r?\n/m, '');
  writeFileSync(configPath, withoutHyperdrive);
  try {
    run('npx opennextjs-cloudflare populateCache remote', OUT_WEB, { NEXT_TELEMETRY_DISABLED: '1' });
  } finally {
    writeFileSync(configPath, config);
  }
  run('npx wrangler deploy', OUT_WEB, { NEXT_TELEMETRY_DISABLED: '1' });
} else {
  console.log(`\nBuilt. Deploy with: node apps/web/scripts/build-cloudflare.mjs ${target} --db-url-file <file> --deploy`);
}
writeFileSync(join(OUT, 'LAST_BUILD.txt'), `${target} ${new Date().toISOString()} deploy=${deploy}\n`);
