/**
 * One-shot codemod for the rupee sweep (international edition, Phase 1a).
 *
 *   node scripts/sweep-en-pk.mjs --dry     # report only
 *   node scripts/sweep-en-pk.mjs --write
 *
 * Replaces the plain `new Intl.NumberFormat('en-PK').format(x)` calls with
 * formatNumber(x), which reads the shop's locale. Only that one shape: the
 * calls carrying options move their options after the value, so they are not
 * a prefix swap and are done by hand. Date and time calls are left alone --
 * they belong to the shop clock in phase 1c.
 *
 * apps/web is skipped on purpose. The Cheese O'Clock website is phase 2 and
 * the owner has asked twice that it not be touched; it formats money with its
 * own lib/format.ts and does not import pos-domain at all.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, sep } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');

const PLAIN = "new Intl.NumberFormat('en-PK').format(";

const files = execFileSync('git', ['ls-files', 'apps/pos', 'packages'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((p) => /\.tsx?$/.test(p))
  .filter((p) => !/\.(test|spec)\.tsx?$|__fixtures__|__oracle__|\.fixture\./.test(p));

let changed = 0;
let sites = 0;
for (const rel of files) {
  const abs = resolve(root, rel.split('/').join(sep));
  const before = readFileSync(abs, 'utf8');
  if (!before.includes(PLAIN)) continue;
  const n = before.split(PLAIN).length - 1;
  let after = before.split(PLAIN).join('formatNumber(');

  // Give the file the import if it does not already have one.
  if (!/\bformatNumber\b/.test(before)) {
    const posDomain = after.match(/^import \{([^}]*)\} from '@cheeseoclock\/pos-domain';$/m);
    const relMoney = after.match(/^import \{([^}]*)\} from '(\.{1,2}[^']*\/)?money\.js';$/m);
    if (relMoney) {
      after = after.replace(relMoney[0], relMoney[0].replace(/\{([^}]*)\}/, (_m, g) => `{${g.trimEnd()}, formatNumber }`.replace('{ ,', '{')));
    } else if (posDomain) {
      after = after.replace(posDomain[0], posDomain[0].replace(/\{([^}]*)\}/, (_m, g) => `{${g.trimEnd()}, formatNumber }`.replace('{ ,', '{')));
    } else {
      // No existing import to extend: add one after the last import line.
      const imports = [...after.matchAll(/^import .*;$/gm)];
      const last = imports.at(-1);
      const spec = rel.startsWith('packages/pos-domain/') ? "'./money.js'" : "'@cheeseoclock/pos-domain'";
      const line = `\nimport { formatNumber } from ${spec};`;
      if (last) after = after.slice(0, last.index + last[0].length) + line + after.slice(last.index + last[0].length);
      else after = `import { formatNumber } from ${spec};\n` + after;
    }
  }

  sites += n;
  changed++;
  console.log(`  ${String(n).padStart(2)}  ${rel}`);
  if (write) writeFileSync(abs, after);
}
console.log(`\n${changed} files, ${sites} sites${write ? ' — written' : ' (dry run)'}`);
