import { createRequire } from 'node:module';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dumpDatabase, rebuildDatabase, type RowSink, type RowSource } from './cloud-copy-rows.js';

// better-sqlite3 is built for Electron here, so the tests drive node:sqlite
// through the same RowSource / RowSink seam the app uses.
type Stmt = {
  all(): unknown[];
  get(): unknown;
  iterate(): Iterable<Record<string, unknown>>;
  run(...v: unknown[]): unknown;
  setReadBigInts(on: boolean): void;
};
type NodeDb = { exec(sql: string): void; prepare(sql: string): Stmt; close(): void };
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => NodeDb;
};

function source(d: NodeDb): RowSource {
  return {
    all: (sql) => d.prepare(sql).all() as Array<Record<string, unknown>>,
    rows: (sql) => {
      const s = d.prepare(sql);
      s.setReadBigInts(true);
      return (function* () {
        for (const r of s.iterate()) yield Object.values(r);
      })();
    },
    pragma: (name) => Number((d.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name]),
  };
}

function sink(d: NodeDb): RowSink {
  return {
    exec: (sql) => d.exec(sql),
    insert: (sql) => {
      const s = d.prepare(sql);
      return (values) => void s.run(...values);
    },
  };
}

async function roundTrip(d: NodeDb) {
  const first = await dumpDatabase(source(d));
  const copy = new DatabaseSync(':memory:');
  await rebuildDatabase(first, sink(copy));
  const second = await dumpDatabase(source(copy));
  return { first, second, copy };
}

describe('dumpDatabase / rebuildDatabase', () => {
  it('rebuilds a database that exports byte-for-byte the same, awkward values and all', async () => {
    const d = new DatabaseSync(':memory:');
    d.exec(`
      CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER, ratio REAL, pic BLOB, note TEXT);
      CREATE INDEX idx_items_name ON items(name);
      CREATE TABLE counters (n INTEGER PRIMARY KEY, label TEXT);
      CREATE TABLE seqd (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);
      CREATE TABLE pairs (a TEXT, b TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID;
      CREATE TABLE audit (id TEXT PRIMARY KEY, x TEXT);
      CREATE TRIGGER trg_items AFTER INSERT ON items BEGIN INSERT INTO audit VALUES (NEW.id || '-t', 'auto'); END;
      CREATE VIEW v_items AS SELECT name FROM items;
      PRAGMA user_version = 7;
    `);
    const ins = d.prepare('INSERT INTO items VALUES (?, ?, ?, ?, ?, ?)');
    ins.run('a', 'Fajita — Medium', 150000n, 10, Buffer.from([0, 1, 255]), 'line1\nline2 "quoted" \u{1F355}');
    ins.run('b', 'Big', 9007199254740993n, 0.1, null, null);
    ins.run('c', 'Gone', 1n, -2.5e-7, null, null);
    d.exec(`DELETE FROM items WHERE id = 'b'`); // a rowid gap the export must keep
    d.exec(`INSERT INTO counters VALUES (5, 'five'), (42, 'forty-two')`);
    d.exec(`INSERT INTO seqd (v) VALUES ('x'), ('y'), ('z'); DELETE FROM seqd WHERE id = 3`); // counter stays 3
    d.exec(`INSERT INTO pairs VALUES ('b', '1'), ('a', '2')`);

    const { first, second, copy } = await roundTrip(d);
    expect(second.equals(first)).toBe(true);

    const row = copy.prepare(`SELECT rowid, typeof(price) tp, typeof(ratio) tr, * FROM items WHERE id = 'a'`);
    row.setReadBigInts(true);
    expect(row.get()).toMatchObject({ rowid: 1n, tp: 'integer', tr: 'real', price: 150000n, note: 'line1\nline2 "quoted" \u{1F355}' });
    expect((copy.prepare(`SELECT rowid FROM items WHERE id = 'c'`).get() as { rowid: number }).rowid).toBe(3);
    expect((copy.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'seqd'`).get() as { seq: number }).seq).toBe(3);
    // The trigger fired 3 times in the original; recreated after the data, it
    // did not fire again during the rebuild…
    expect((copy.prepare(`SELECT COUNT(*) AS n FROM audit`).get() as { n: number }).n).toBe(3);
    // …but it is there for new rows, and the view and index exist.
    copy.exec(`INSERT INTO items (id, name) VALUES ('d', 'New')`);
    expect((copy.prepare(`SELECT COUNT(*) AS n FROM audit`).get() as { n: number }).n).toBe(4);
    expect((copy.prepare(`SELECT COUNT(*) AS n FROM v_items`).get() as { n: number }).n).toBe(3);
    expect(copy.prepare(`SELECT name FROM sqlite_master WHERE name = 'idx_items_name'`).get()).toBeTruthy();
    expect((copy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(7);
  });

  it('keeps the past byte-identical when rows are added (what makes daily uploads small)', async () => {
    const d = new DatabaseSync(':memory:');
    d.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY, total INTEGER); CREATE TABLE lines (id TEXT PRIMARY KEY, q INTEGER)`);
    for (let i = 0; i < 500; i++) d.exec(`INSERT INTO orders VALUES ('o${i}', ${i}); INSERT INTO lines VALUES ('l${i}', 1)`);
    const before = (await dumpDatabase(source(d))).toString();
    for (let i = 500; i < 520; i++) d.exec(`INSERT INTO orders VALUES ('o${i}', ${i}); INSERT INTO lines VALUES ('l${i}', 1)`);
    const after = (await dumpDatabase(source(d))).toString();
    const ordersBefore = before.slice(0, before.indexOf('{"t":"lines"'));
    expect(after.startsWith(ordersBefore.slice(0, ordersBefore.lastIndexOf('\n')))).toBe(true);
  });

  it('refuses a truncated or foreign export', async () => {
    const d = new DatabaseSync(':memory:');
    d.exec(`CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('x')`);
    const dump = await dumpDatabase(source(d));
    await expect(rebuildDatabase(dump.subarray(0, dump.length - 5), sink(new DatabaseSync(':memory:')))).rejects.toThrow();
    await expect(rebuildDatabase(Buffer.from('{"format":"other"}\n'), sink(new DatabaseSync(':memory:')))).rejects.toThrow(/newer/);
  });

  // A real POS database (after a simulated week of trade), when one is at hand.
  const real = process.env['COC_REAL_DB'];
  it.skipIf(!real || !fs.existsSync(real))('round-trips a real POS database exactly', async () => {
    const d = new DatabaseSync(real!, { readOnly: true });
    const { first, second, copy } = await roundTrip(d);
    expect(second.equals(first)).toBe(true);
    const count = (db: NodeDb, t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    for (const t of ['orders', 'order_items', 'menu_items', 'recipes', 'ingredients', 'stock_movements', 'audit_log', '_migrations']) {
      expect(count(copy, t)).toBe(count(d, t));
    }
    expect((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
  });
});
