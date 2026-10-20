/**
 * Pixel & Oak POS — the till client shops download (shared-types edition.ts,
 * electron-builder.pixelandoak.yml) — built on this PC and, with --publish,
 * put on github.com/haider484991/pixelandoak-pos as the release the client
 * tills update from. Cheese O'Clock is never touched: not its tills (their
 * own app id, data folder and update feed), not its repository's releases or
 * tags, not its website.
 *
 *   node scripts/release-pixelandoak.mjs             build → release/pixelandoak/
 *   node scripts/release-pixelandoak.mjs --publish   build, then publish v<version>
 *
 * The version is apps/pos/package.json's: bump it before each new release
 * (a version is published once). --publish needs a clean, committed tree (the
 * release names the commit it was built from) and `gh auth login`.
 *
 * Like the CI build (.github/workflows/release.yml), electron-builder runs
 * with the workspace packages' links out of node_modules/@cheeseoclock
 * (electron-vite has bundled them; electron-builder refuses links that point
 * outside apps/pos). Here they are put back afterwards, and only the LINKS go:
 * nothing is ever deleted through one (a recursive delete that follows a
 * junction empties the real package).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASES_REPO = 'haider484991/pixelandoak-pos';
const CONFIG = 'electron-builder.pixelandoak.yml';
const OUT = join(APP, 'release', 'pixelandoak');
const INSTALLER = 'PixelAndOak-POS-Setup.exe';
const FILES = [INSTALLER, `${INSTALLER}.blockmap`, 'latest.yml'];
const publish = process.argv.includes('--publish');

/** Run a command in apps/pos, its output on this console; throw when it fails. */
function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: APP, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`);
}
/** A command's output (trimmed); throws when it fails. */
const output = (cmd, args) => execFileSync(cmd, args, { cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** Whether a command succeeds (its output thrown away). */
const succeeds = (cmd, args) => spawnSync(cmd, args, { cwd: APP, stdio: 'ignore' }).status === 0;
function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')).version;
const tag = `v${version}`;
const commit = output('git', ['rev-parse', 'HEAD']);
const branch = output('git', ['branch', '--show-current']) || '(detached)';
console.log(`Pixel & Oak POS ${version} from ${branch} @ ${commit.slice(0, 7)}${publish ? ` → ${RELEASES_REPO} ${tag}` : ' (build only)'}`);

if (publish) {
  if (output('git', ['status', '--porcelain'])) fail('The tree has changes that are not committed: commit them first (the release names the commit it was built from).');
  if (!succeeds('gh', ['repo', 'view', RELEASES_REPO])) fail(`${RELEASES_REPO} is not there (or gh is not signed in: gh auth login).`);
  if (succeeds('gh', ['release', 'view', tag, '--repo', RELEASES_REPO])) fail(`${tag} is already published on ${RELEASES_REPO}: bump apps/pos/package.json's version first.`);
}
if (!existsSync(join(APP, 'brand', 'pixelandoak', 'icon.ico'))) fail('brand/pixelandoak/icon.ico is missing: node scripts/generate-icon.mjs brand/pixelandoak');

// 1. The app, with this edition's names baked in (electron.vite.config.ts __EDITION__).
run('pnpm', ['exec', 'electron-vite', 'build'], { COC_EDITION: 'pixelandoak' });

// 2. The installer, with the workspace links out of the way and back afterwards.
const linksDir = join(APP, 'node_modules', '@cheeseoclock');
const links = existsSync(linksDir)
  ? readdirSync(linksDir)
      .map((name) => join(linksDir, name))
      .filter((p) => lstatSync(p).isSymbolicLink())
      .map((p) => ({ path: p, target: readlinkSync(p) }))
  : [];
try {
  for (const l of links) unlinkSync(l.path); // the link only, never what it points at
  run('pnpm', ['exec', 'electron-builder', '--config', CONFIG, '--win', '--x64', '--publish', 'never']);
} finally {
  for (const l of links) if (!existsSync(l.path)) symlinkSync(l.target, l.path, 'junction');
}

// 3. What the build made, checked before anything leaves this PC.
for (const f of FILES) if (!existsSync(join(OUT, f))) fail(`release/pixelandoak/${f} was not made.`);
const latest = readFileSync(join(OUT, 'latest.yml'), 'utf8');
if (!latest.includes(`version: ${version}`) || !latest.includes(`path: ${INSTALLER}`)) fail(`latest.yml does not name ${version} and ${INSTALLER}.`);
const feed = readFileSync(join(OUT, 'win-unpacked', 'resources', 'app-update.yml'), 'utf8');
if (!/owner: haider484991/.test(feed) || !/repo: pixelandoak-pos/.test(feed) || /cheeseoclock/i.test(feed)) {
  fail(`The installed till would update from somewhere else:\n${feed}`);
}
const main = readdirSync(join(APP, 'out', 'main'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(join(APP, 'out', 'main', f), 'utf8'))
  .join('\n');
if (!main.includes('"pixelandoak"')) fail('The built app is not Pixel & Oak POS (out/main has no "pixelandoak" edition).');
if (!readFileSync(join(APP, 'out', 'renderer', 'index.html'), 'utf8').includes('<title>Pixel &amp; Oak POS</title>')) {
  fail('The window title is not "Pixel & Oak POS".');
}
console.log(`\n✓ Built release/pixelandoak/${INSTALLER} (${version}); it updates from ${RELEASES_REPO}.`);

if (!publish) process.exit(0);

// 4. A draft with all three files, published only once they are all there: a till never finds half a release.
run('gh', [
  'release', 'create', tag, '--repo', RELEASES_REPO, '--draft', '--title', version,
  '--notes', `"Pixel & Oak POS ${version}. Built from ${branch} @ ${commit}."`,
  ...FILES.map((f) => `"${join(OUT, f)}"`),
]);
run('gh', ['release', 'edit', tag, '--repo', RELEASES_REPO, '--draft=false', '--latest']);
const release = JSON.parse(output('gh', ['release', 'view', tag, '--repo', RELEASES_REPO, '--json', 'isDraft,isPrerelease,assets']));
const uploaded = release.assets.filter((a) => a.size > 0).map((a) => a.name);
const missing = FILES.filter((f) => !uploaded.includes(f));
if (release.isDraft || release.isPrerelease || missing.length > 0) fail(`${tag} is not complete: draft ${release.isDraft}, missing ${missing.join(', ') || 'nothing'}.`);
console.log(`\n✓ Published ${tag}. Download link for any client (always the newest):`);
console.log(`  https://github.com/${RELEASES_REPO}/releases/latest/download/${INSTALLER}`);
