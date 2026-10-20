/**
 * Second pass of the rupee sweep (international edition, Phase 1a).
 *
 *   node scripts/sweep-en-pk-2.mjs --dry | --write
 *
 * Handles the three shapes the first pass could not do as a prefix swap,
 * because the options have to move AFTER the value:
 *
 *   new Intl.NumberFormat('en-PK', { OPTS }).format(X)  ->  formatNumber(X, { OPTS })
 *   X.toLocaleString('en-PK', { OPTS })                 ->  formatNumber(X, { OPTS })
 *   X.toLocaleString('en-PK')                           ->  formatNumber(X)
 *
 * Values are scanned with balanced brackets rather than a regex, so a nested
 * call like Math.abs(bps) / 100 survives. Anything it cannot read cleanly is
 * reported and left alone for a human rather than guessed at.
 *
 * Date and time calls are skipped: they belong to the shop clock in 1c.
 * apps/web is skipped: the website is phase 2 and stays as it is.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');

const OPT_MAP = {
  maximumFractionDigits: 'maxFractionDigits',
  minimumFractionDigits: 'minFractionDigits',
  useGrouping: 'useGrouping',
};

/** Rewrite an Intl options object literal to formatNumber's option names. */
function mapOptions(text) {
  const inner = text.trim().replace(/^\{|\}$/g, '').trim();
  if (!inner) return null;
  const parts = [];
  for (const piece of inner.split(',')) {
    const t = piece.trim();
    if (!t) continue;
    const m = t.match(/^(\w+)\s*:\s*(.+)$/);
    if (!m) return null;
    const mapped = OPT_MAP[m[1]];
    if (!mapped) return null; // an option we do not model — leave the site alone
    parts.push(`${mapped}: ${m[2].trim()}`);
  }
  return parts.length ? `{ ${parts.join(', ')} }` : null;
}

/** Read forwards from `i` (at an opening bracket) to its match. */
function matchForward(s, i) {
  const open = s[i];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j;
  }
  return -1;
}

/** Read backwards from `end` (exclusive) to the start of the value expression. */
function valueStart(s, end) {
  let j = end - 1;
  let depth = 0;
  while (j >= 0) {
    const c = s[j];
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') {
      if (depth === 0) return j + 1;
      depth--;
    } else if (depth === 0 && c === '>' && s[j - 1] === '=') return j + 1; // an arrow: =>
    else if (depth === 0 && /[,;={}`]/.test(c)) return j + 1;
    // A keyword the value cannot reach back past. `return (x).toLocaleString()`
    // otherwise swallows the `return` itself and moves it inside the call.
    else if (depth === 0 && /\s/.test(c) && /\b(return|case|typeof|await|in|of)$/.test(s.slice(Math.max(0, j - 8), j)))
      return j + 1;
    else if (depth === 0 && c === '$' && s[j + 1] === '{') return j + 2;
    j--;
  }
  return 0;
}

const files = execFileSync('git', ['ls-files', 'apps/pos', 'packages'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((p) => /\.tsx?$/.test(p))
  .filter((p) => !/\.(test|spec)\.tsx?$|__fixtures__|__oracle__|\.fixture\./.test(p));

let totalSites = 0;
const skipped = [];
const touched = [];

for (const rel of files) {
  const abs = resolve(root, rel.split('/').join(sep));
  let s = readFileSync(abs, 'utf8');
  const before = s;
  let n = 0;

  // Shape 1: new Intl.NumberFormat('en-PK'[, {opts}]).format(X)
  for (;;) {
    const i = s.indexOf("new Intl.NumberFormat('en-PK'");
    if (i < 0) break;
    const argOpen = s.indexOf('(', i);
    const argClose = matchForward(s, argOpen);
    const args = s.slice(argOpen + 1, argClose);
    const comma = args.indexOf(',');
    const optText = comma < 0 ? '' : args.slice(comma + 1).trim();
    const after = s.slice(argClose + 1);
    const fm = after.match(/^\s*\.format\(/);
    if (!fm) { skipped.push(`${rel}: hoisted formatter, left for a human`); break; }
    const vOpen = argClose + 1 + fm[0].length - 1;
    const vClose = matchForward(s, vOpen);
    const value = s.slice(vOpen + 1, vClose);
    const opts = optText ? mapOptions(optText) : null;
    if (optText && !opts) { skipped.push(`${rel}: options not modelled: ${optText}`); break; }
    s = s.slice(0, i) + `formatNumber(${value}${opts ? `, ${opts}` : ''})` + s.slice(vClose + 1);
    n++;
  }

  // Shape 2: X.toLocaleString('en-PK'[, {opts}])
  for (;;) {
    const i = s.indexOf(".toLocaleString('en-PK'");
    if (i < 0) break;
    const argOpen = s.indexOf('(', i);
    const argClose = matchForward(s, argOpen);
    const args = s.slice(argOpen + 1, argClose);
    const comma = args.indexOf(',');
    const optText = comma < 0 ? '' : args.slice(comma + 1).trim();
    // Dates format through the shop clock in 1c, not here.
    if (/day|month|year|hour|minute|second|weekday|timeZone/i.test(optText)) {
      skipped.push(`${rel}: a date — left for phase 1c`);
      break;
    }
    const vs = valueStart(s, i);
    const value = s.slice(vs, i);
    const opts = optText ? mapOptions(optText) : null;
    if (optText && !opts) { skipped.push(`${rel}: options not modelled: ${optText}`); break; }
    s = s.slice(0, vs) + `formatNumber(${value}${opts ? `, ${opts}` : ''})` + s.slice(argClose + 1);
    n++;
  }

  if (!n) continue;

  // Make sure the file can see formatNumber.
  if (!/import[^;]*\bformatNumber\b/.test(s)) {
    const from = rel.startsWith('packages/shared-schemas/')
      ? "'@cheeseoclock/shared-types'"
      : rel.startsWith('packages/pos-domain/')
        ? "'./money.js'"
        : rel.startsWith('packages/shared-types/')
          ? "'./money-format.js'"
          : "'@cheeseoclock/pos-domain'";
    const imports = [...s.matchAll(/^import [\s\S]*?;$/gm)];
    const last = imports.at(-1);
    const line = `\nimport { formatNumber } from ${from};`;
    s = last ? s.slice(0, last.index + last[0].length) + line + s.slice(last.index + last[0].length) : `import { formatNumber } from ${from};\n` + s;
  }

  totalSites += n;
  touched.push(`  ${String(n).padStart(2)}  ${rel}`);
  if (write && s !== before) writeFileSync(abs, s);
}

console.log(touched.join('\n'));
console.log(`\n${touched.length} files, ${totalSites} sites${write ? ' — written' : ' (dry run)'}`);
if (skipped.length) {
  console.log('\nleft alone on purpose:');
  [...new Set(skipped)].forEach((x) => console.log('  ' + x));
}
