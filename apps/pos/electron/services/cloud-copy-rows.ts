/**
 * A cloud copy as rows, not pages.
 *
 * Chunking the SQLite file itself dedups badly: every row added to a table in
 * the middle of the file shifts the pages after it, and the interior b-tree
 * pages that point at them change too — measured on a week of simulated
 * trade, a day's upload re-sent ~30–75% of the file, and that share grows
 * with the file. Written out row by row, table by table in rowid order, the
 * past stays byte-identical and a day's upload is about the day's new rows.
 *
 * The export is exact: every value keeps its SQLite storage class, rowids are
 * kept, and schema objects are replayed verbatim. A rebuild is checked by
 * exporting the rebuilt database again and comparing it byte for byte with
 * what was uploaded (see cloud restore in web-orders-bridge.ts).
 *
 * No driver imports: works on anything that fits `RowSource` / `RowSink`
 * (better-sqlite3 in the app, node:sqlite in tests).
 */

export const ROWS_FORMAT = 'cheeseoclock-rows';
export const ROWS_VERSION = 1;

/** Read side. `rows` must return INTEGERs as bigint, REAL as number, BLOB as bytes. */
export interface RowSource {
  all(sql: string): Array<Record<string, unknown>>;
  rows(sql: string): Iterable<unknown[]>;
  pragma(name: 'user_version' | 'application_id'): number;
}

/** Write side, on an empty database. */
export interface RowSink {
  exec(sql: string): void;
  insert(sql: string): (values: unknown[]) => void;
}

interface SchemaObject {
  type: 'table' | 'index' | 'trigger' | 'view';
  name: string;
  sql: string;
}

interface TableHeader {
  t: string;
  sql: string;
  cols: string[];
  /** The first value of every row is the rowid (a rowid table without an INTEGER PRIMARY KEY alias). */
  rowid: boolean;
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** One SQLite value as JSON, keeping its storage class. */
function encodeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : { i: v.toString() };
  }
  if (typeof v === 'number') {
    // A REAL; a JSON number without a fraction would read back as an INTEGER.
    return Number.isInteger(v) || !Number.isFinite(v) ? { r: String(v) } : v;
  }
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return { b: Buffer.from(v).toString('base64') };
  throw new Error(`Unexpected SQLite value type: ${typeof v}`);
}

function decodeValue(v: unknown): unknown {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : v;
  if (typeof v === 'string') return v;
  const o = v as { i?: string; r?: string; b?: string };
  if (o.i !== undefined) return BigInt(o.i);
  if (o.r !== undefined) return Number(o.r);
  if (o.b !== undefined) return Buffer.from(o.b, 'base64');
  throw new Error('Unrecognised value in the cloud copy');
}

const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Export a database: header line, then per table a header line and one line
 * per row (rowid order), then the indexes, triggers and views to recreate.
 * Yields to the event loop every few thousand rows so the till stays usable.
 */
export async function dumpDatabase(db: RowSource): Promise<Buffer> {
  const parts: string[] = [];
  const line = (o: unknown) => parts.push(`${JSON.stringify(o)}\n`);
  line({
    format: ROWS_FORMAT,
    version: ROWS_VERSION,
    userVersion: db.pragma('user_version'),
    applicationId: db.pragma('application_id'),
  });

  const objects = db.all(
    `SELECT type, name, sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`,
  ) as unknown as SchemaObject[];
  let n = 0;
  for (const t of objects.filter((o) => o.type === 'table')) {
    if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql)) throw new Error(`Virtual table ${t.name} cannot be exported`);
    const info = db.all(`PRAGMA table_info(${q(t.name)})`) as Array<{ name: string; type: string; pk: number }>;
    const pks = info.filter((c) => c.pk > 0);
    const aliased = pks.length === 1 && pks[0]!.type.toUpperCase() === 'INTEGER';
    const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(t.sql);
    const rowid = !aliased && !withoutRowid;
    const cols = info.map((c) => c.name);
    const header: TableHeader = { t: t.name, sql: t.sql, cols, rowid };
    line(header);
    const select = `SELECT ${rowid ? 'rowid, ' : ''}${cols.map(q).join(', ')} FROM ${q(t.name)} ORDER BY ${
      withoutRowid ? pks.sort((a, b) => a.pk - b.pk).map((c) => q(c.name)).join(', ') : 'rowid'
    }`;
    for (const row of db.rows(select)) {
      line(row.map(encodeValue));
      if (++n % 5000 === 0) await yieldToEventLoop();
    }
  }
  // AUTOINCREMENT counters live outside the tables' own rows.
  const hasSeq = db.all(`SELECT 1 AS x FROM sqlite_master WHERE name = 'sqlite_sequence'`).length > 0;
  line({ seq: hasSeq ? db.all(`SELECT name, seq FROM sqlite_sequence ORDER BY name`) : [] });
  line({ objects: objects.filter((o) => o.type !== 'table') });
  return Buffer.from(parts.join(''), 'utf8');
}

/** Build a database from an export, into an empty `sink`. */
export async function rebuildDatabase(dump: Buffer, sink: RowSink): Promise<void> {
  const text = dump.toString('utf8');
  let pos = 0;
  const next = (): unknown => {
    const end = text.indexOf('\n', pos);
    if (end < 0) throw new Error('The cloud copy is truncated');
    const s = text.slice(pos, end);
    pos = end + 1;
    return JSON.parse(s);
  };
  const head = next() as { format?: string; version?: number; userVersion?: number; applicationId?: number };
  if (head.format !== ROWS_FORMAT || head.version !== ROWS_VERSION) {
    throw new Error('This cloud copy was made by a newer app version; update the POS first');
  }
  sink.exec('PRAGMA foreign_keys = OFF');
  sink.exec('BEGIN');
  let n = 0;
  let item = next();
  while (item && typeof item === 'object' && !Array.isArray(item) && 't' in (item as object)) {
    const t = item as TableHeader;
    sink.exec(t.sql);
    const cols = [...(t.rowid ? ['rowid'] : []), ...t.cols.map(q)];
    const insert = sink.insert(`INSERT INTO ${q(t.t)} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    item = next();
    while (Array.isArray(item)) {
      insert(item.map(decodeValue));
      if (++n % 5000 === 0) await yieldToEventLoop();
      item = next();
    }
  }
  const seq = (item as { seq?: Array<{ name: string; seq: unknown }> }).seq;
  if (!seq) throw new Error('The cloud copy is malformed');
  if (seq.length) {
    sink.exec('DELETE FROM sqlite_sequence');
    const put = sink.insert('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)');
    for (const s of seq) put([s.name, decodeValue(s.seq)]);
  }
  const objects = (next() as { objects?: SchemaObject[] }).objects;
  if (!objects) throw new Error('The cloud copy is malformed');
  for (const o of objects) sink.exec(o.sql);
  sink.exec(`PRAGMA user_version = ${Number(head.userVersion) | 0}`);
  sink.exec(`PRAGMA application_id = ${Number(head.applicationId) | 0}`);
  sink.exec('COMMIT');
  if (pos !== text.length) throw new Error('The cloud copy has trailing data');
}
