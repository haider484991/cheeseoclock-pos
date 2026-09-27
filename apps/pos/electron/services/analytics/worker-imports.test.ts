/**
 * The Reports worker thread (costing spec Phase 3) must never load Electron
 * — a worker thread has no Electron APIs, and electron-log/main or
 * `import { BrowserWindow } from 'electron'` would stop it at start — nor
 * better-sqlite3 by name (it is loaded from the path the main process found:
 * the unpacked copy in an installed till). The build refuses such an import
 * too (electron.vite.config.ts); this finds it in the test run, with the
 * chain of files that led to it.
 *
 * Walks the value imports (type-only ones are erased by the build) from
 * worker.ts through this app's files and the workspace packages.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..', '..');
const FORBIDDEN = [/^electron(\/|$)/, /^electron-log(\/|$)/, /^better-sqlite3(\/|$)/];

/** The modules a file loads at run time (import / export … from / import()), not type-only ones. */
function valueImports(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const value =
        !clause ||
        (!clause.isTypeOnly &&
          (clause.name !== undefined ||
            (bindings !== undefined && (ts.isNamespaceImport(bindings) || bindings.elements.some((e) => !e.isTypeOnly)))));
      if (value) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const value = !node.isTypeOnly && (!clause || !ts.isNamedExports(clause) || clause.elements.some((e) => !e.isTypeOnly));
      if (value) out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteral(arg)) out.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

/** A relative or workspace specifier as a file of this repo, or null for an npm / Node module. */
function toFile(spec: string, from: string): string | null {
  if (spec.startsWith('.')) {
    const base = resolve(dirname(from), spec);
    for (const f of [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts'), base]) if (existsSync(f)) return f;
    throw new Error(`Cannot find ${spec} from ${from}`);
  }
  const ws = /^@cheeseoclock\/([^/]+)(?:\/(.+))?$/.exec(spec);
  if (ws) return join(REPO, 'packages', ws[1]!, 'src', ws[2] ? `${ws[2]}.ts` : 'index.ts');
  return null;
}

describe('the Reports worker loads no Electron', () => {
  it('nothing reachable from worker.ts imports electron, electron-log or better-sqlite3', () => {
    const start = join(HERE, 'worker.ts');
    const seen = new Map<string, string | null>([[start, null]]);
    const queue = [start];
    const bad: string[] = [];
    const npm = new Set<string>();
    while (queue.length > 0) {
      const file = queue.shift()!;
      for (const spec of valueImports(file)) {
        const target = toFile(spec, file);
        if (target === null) {
          npm.add(spec);
          if (FORBIDDEN.some((re) => re.test(spec))) {
            const chain: string[] = [];
            for (let f: string | null | undefined = file; f; f = seen.get(f)) chain.unshift(relative(REPO, f));
            bad.push(`${spec} ← ${chain.join(' → ')}`);
          }
          continue;
        }
        if (!seen.has(target)) {
          seen.set(target, file);
          queue.push(target);
        }
      }
    }
    expect(bad).toEqual([]);
    // It did walk the real graph: the builders and the shared packages are in it.
    const files = [...seen.keys()].map((f) => relative(REPO, f).replace(/\\/g, '/'));
    expect(files).toContain('apps/pos/electron/services/business-report.ts');
    expect(files).toContain('packages/pos-domain/src/index.ts');
    // Costing spec Phase 7: the owner's week, its "Do this" sources (the read-only costing service)
    // and the trends run in the worker too — without the write paths (costing-settings.ts, the repositories).
    expect(files).toContain('apps/pos/electron/services/analytics/owner-week.ts');
    expect(files).toContain('apps/pos/electron/services/analytics/trends.ts');
    expect(files).toContain('apps/pos/electron/services/costing-service.ts');
    expect(files).not.toContain('apps/pos/electron/services/costing-settings.ts');
    expect(files.some((f) => f.includes('/repositories/'))).toBe(false);
    // Only small npm packages, bundled into the worker file (nothing native, nothing that needs node_modules beside it).
    expect([...npm].filter((m) => !m.startsWith('node:') && !/^(uuid|zod)$/.test(m))).toEqual([]);
  });

  it('the check sees an Electron import where there is one (the stock repository writes and notifies windows)', () => {
    expect(valueImports(join(HERE, '..', '..', 'db', 'repositories', 'stock-movement-repo.ts'))).toEqual(
      expect.arrayContaining(['electron', 'electron-log/main']),
    );
    // …and ignores a type-only one (connection.ts is only a type here).
    expect(valueImports(join(HERE, 'report-tabs.ts'))).not.toContain('../../db/connection.js');
  });
});
