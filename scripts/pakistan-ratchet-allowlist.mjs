/**
 * Regenerates the Pakistan ratchet's allowlist (international edition, Phase 0).
 *
 *   node scripts/pakistan-ratchet-allowlist.mjs          # report only
 *   node scripts/pakistan-ratchet-allowlist.mjs --write  # rewrite the list
 *
 * Run it after a sweep to CONFIRM THE LIST SHRANK. It is not a way to make a
 * new violation legal: if the count goes up, the sweep added a spelled-out
 * rupee somewhere, and that is the bug.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, sep } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const listFile = resolve(root, 'eslint.pakistan-ratchet.mjs');
const RULE = 'no-restricted-syntax';

// Lint with the allowlist emptied, so every current violation shows up.
const current = readFileSync(listFile, 'utf8');
const emptied = current.replace(
  /export const PAKISTAN_ALLOWLIST = \[[\s\S]*?\];/,
  'export const PAKISTAN_ALLOWLIST = [];',
);
const restore = current !== emptied;
if (restore) writeFileSync(listFile, emptied);

// eslint exits non-zero when it finds errors, and a .CMD shim on Windows does
// not hand stdout back through execFileSync — so have eslint write the JSON to
// a file and read that. The exit code is expected to be non-zero here.
const reportFile = resolve(root, 'node_modules/.cache/pakistan-ratchet.json');
let report;
try {
  mkdirSync(dirname(reportFile), { recursive: true });
  try {
    execFileSync(
      process.execPath,
      [
        resolve(root, 'node_modules/eslint/bin/eslint.js'),
        'apps/**/*.ts',
        'apps/**/*.tsx',
        'packages/**/*.ts',
        'packages/**/*.tsx',
        '--format',
        'json',
        '--output-file',
        reportFile,
      ],
      { cwd: root, encoding: 'utf8', stdio: 'ignore' },
    );
  } catch {
    // Findings mean a non-zero exit; the report file is still written.
  }
  report = JSON.parse(readFileSync(reportFile, 'utf8'));
} finally {
  if (restore) writeFileSync(listFile, current);
}

const files = report
  .filter((f) => f.messages.some((m) => m.ruleId === RULE))
  .map((f) => relative(root, f.filePath).split(sep).join('/'))
  .sort();
const occurrences = report.reduce(
  (n, f) => n + f.messages.filter((m) => m.ruleId === RULE).length,
  0,
);

const isTest = (p) => /\.(test|spec)\.tsx?$|\.fixture\.tsx?$|__fixtures__/.test(p);
const src = files.filter((p) => !isTest(p));
const tests = files.filter(isTest);

console.log(`files      : ${files.length}  (source ${src.length}, test ${tests.length})`);
console.log(`occurrences: ${occurrences}`);

const previous = (current.match(/export const PAKISTAN_ALLOWLIST = \[([\s\S]*?)\];/)?.[1] ?? '')
  .split('\n')
  .filter((l) => l.includes("'"))
  .length;
if (previous) {
  const delta = files.length - previous;
  console.log(`allowlist  : ${previous} -> ${files.length} (${delta > 0 ? '+' : ''}${delta})`);
  if (delta > 0) {
    console.error('\nThe allowlist GREW. A spelled-out Pakistan assumption was added somewhere.');
    console.error('The ratchet only turns one way — fix the new one instead of listing it.');
    if (!process.argv.includes('--force')) process.exitCode = 1;
  }
}

if (process.argv.includes('--write')) {
  const body = files.map((p) => `  '${p}',`).join('\n');
  writeFileSync(
    listFile,
    current.replace(
      /export const PAKISTAN_ALLOWLIST = \[[\s\S]*?\];/,
      `export const PAKISTAN_ALLOWLIST = [\n${body}\n];`,
    ),
  );
  console.log('\nallowlist written.');
}
