// Moving the website to a new Postgres database (27 Oct 2026: from Neon, whose free compute hours ran out on
// 26 Oct, to Supabase's free plan). Run from apps/web. Never prints a database address: each stays in a file under
// the repo's .local/ (gitignored), read here and handed on as it is.
//
//   node scripts/move-website-database.mjs save-url <file> [--from-clipboard]
//       Asks for a database address (typed or pasted, not shown) and keeps it in <file>.
//        - Neon: the project's Connection string (pooled is fine).
//        - Supabase: the project's Connect → "Transaction pooler" URI (port 6543), with the database password in
//          it. The direct address (db.<ref>.supabase.co) is IPv6 only on the free plan: Vercel cannot reach it.
//
//   node scripts/move-website-database.mjs check <db-url-file>
//       Reaches that database and says its host, Postgres version, size, and each table's rows and size.
//       Nothing is changed.
//
//   node scripts/move-website-database.mjs copy --from <db-url-file> --to <db-url-file> [--with-backups]
//       Copies the website's database (FROM, e.g. Neon) into another (TO, e.g. a new Supabase project):
//       1. TO gets db/schema.sql (every statement safe to run again), then whatever FROM has beyond it: a table,
//          a column, a sequence (it stops, writing no rows, if a column's type differs);
//       2. every row of every table, parents before children, read in one consistent snapshot of FROM;
//          only rows TO lacks go in (ON CONFLICT DO NOTHING), so a second run adds just what came in since;
//       3. then FROM's constraints and indexes TO lacks, and every counter (sequence) where FROM's stands;
//       4. each table counted and checksummed on both sides (its rows as JSON, in UTC, sorted).
//       site_identity is copied too: the till sees the same website. The till's own cloud copies
//       (pos_backups, pos_backup_chunks) stay behind unless --with-backups: the till keeps its local copies,
//       and its next cloud copy goes to the website's Blob store.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Rows per insert, and its size (the website's restore uses the same). */
const BATCH_ROWS = 500;
const BATCH_CHARS = 1_000_000;
/** The till's own cloud copies: left behind unless asked. */
const BACKUP_TABLES = ['pos_backups', 'pos_backup_chunks'];
/** One-row state where FROM's row wins over one TO made itself (e.g. its own identity on a first request). */
const FROM_WINS_TABLES = ['site_identity', 'store_status'];

const [command, ...args] = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

function readSecretFile(file, what) {
  if (!file || !existsSync(file)) throw new Error(`No ${what} file at ${file ?? '(none given)'}.`);
  const value = readFileSync(file, 'utf8').trim();
  if (!value) throw new Error(`The ${what} file ${file} is empty.`);
  return value;
}

/** Host, port and user name of a database address — never its password. */
function describeUrl(url) {
  const u = new URL(url);
  return { host: u.hostname, port: u.port || '5432', user: decodeURIComponent(u.username), database: u.pathname.slice(1) };
}

function checkAddress(url) {
  let parts;
  try {
    parts = describeUrl(url);
  } catch {
    throw new Error('That is not a database address (it should start postgresql://).');
  }
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error('That is not a database address (it should start postgresql://).');
  if (/\[YOUR-PASSWORD\]|YOUR-PASSWORD/i.test(url)) throw new Error('The address still has [YOUR-PASSWORD] in it: put the database password there.');
  if (!new URL(url).password) throw new Error('The address has no password in it.');
  const notes = [];
  if (/^db\.[a-z0-9]+\.supabase\.co$/.test(parts.host)) {
    notes.push('This is Supabase’s DIRECT address (IPv6 only on the free plan): Vercel cannot reach it. Use Connect → Transaction pooler.');
  } else if (parts.host.endsWith('.pooler.supabase.com') && parts.port !== '6543') {
    notes.push(`Port ${parts.port}: the session pooler. The website wants the transaction pooler, port 6543.`);
  }
  return { parts, notes };
}

async function readHidden(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((done) => {
    let value = '';
    const onData = (s) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return done(value.trim());
        }
        if (ch === '\u0003') process.exit(1); // Ctrl+C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function saveUrl() {
  const file = args[0];
  if (!file || file.startsWith('--')) throw new Error('Say where to keep it: save-url <file>.');
  const url = args.includes('--from-clipboard')
    ? execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'], { encoding: 'utf8' }).trim()
    : await readHidden('Paste the new database address (it is not shown), then Enter: ');
  const { parts, notes } = checkAddress(url);
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, `${url}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`Kept in ${file}: ${url.length} characters, host ${parts.host}, port ${parts.port}, user ${parts.user}.`);
  for (const n of notes) console.log(`⚠ ${n}`);
}

/** As lib/db.ts: the address without its ?… (libpq's sslmode / channel_binding are no Postgres settings), TLS set here. */
function openDb(url) {
  const address = new URL(url);
  const host = address.hostname;
  address.search = '';
  return postgres(address.toString(), {
    prepare: false,
    max: 1,
    connect_timeout: 15,
    ssl: host === 'localhost' || host === '127.0.0.1' ? false : 'require',
    onnotice: () => undefined,
  });
}

async function check() {
  const url = readSecretFile(args[0], 'database address');
  const { parts, notes } = checkAddress(url);
  for (const n of notes) console.log(`⚠ ${n}`);
  const db = openDb(url);
  try {
    const [v] = await db`SELECT version() AS version, current_database() AS database, pg_size_pretty(pg_database_size(current_database())) AS size`;
    const tables = await db`
      SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes, c.relrowsecurity AS rls
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`;
    console.log(`Reached ${parts.host}:${parts.port} as ${parts.user}: ${String(v.version).split(' on ')[0]}, database ${v.database}, ${v.size}.`);
    console.log(`${tables.length} tables in public${tables.length ? ':' : '.'}`);
    for (const t of tables) {
      const [{ n }] = await db.unsafe(`SELECT count(*)::int AS n FROM "${t.name.replace(/"/g, '""')}"`);
      const mb = (Number(t.bytes) / 1048576).toFixed(2);
      console.log(`  ${t.name.padEnd(22)} ${String(n).padStart(7)} rows ${mb.padStart(8)} MB${t.rls ? '  row level security on' : ''}`);
    }
  } finally {
    await db.end();
  }
}

/** What a database's public schema holds: tables, columns, constraints, indexes, sequences. */
async function catalog(db) {
  const tables = await db`
    SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`;
  const columns = await db`
    SELECT c.relname AS "table", a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
           pg_get_expr(d.adbin, d.adrelid) AS default_expr, a.attgenerated::text AS generated, a.attidentity::text AS identity
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum`;
  const constraints = await db`
    SELECT c.relname AS "table", k.conname AS name, k.contype::text AS kind, pg_get_constraintdef(k.oid) AS def, f.relname AS parent
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_class f ON f.oid = k.confrelid
     WHERE n.nspname = 'public' AND k.contype IN ('p', 'u', 'f', 'c', 'x') ORDER BY c.relname, k.conname`;
  const indexes = await db`SELECT tablename AS "table", indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = 'public'`;
  const sequences = await db`
    SELECT sequencename AS name, data_type::text AS type, last_value::text AS last_value FROM pg_sequences WHERE schemaname = 'public'`;
  return { tables, columns, constraints, indexes, sequences };
}

/** A name as a quoted identifier. */
const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
/** Text as a quoted literal. */
const lit = (text) => `'${String(text).replace(/'/g, "''")}'`;

/** db/schema.sql as single statements (as lib/website-copy.ts schemaStatements: no functions or quoted semicolons). */
function schemaStatements() {
  return readFileSync(resolve(WEB, 'db', 'schema.sql'), 'utf8')
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Tables in an order where every parent (FOREIGN KEY … REFERENCES) comes before its children. */
function parentsFirst(names, constraints) {
  const parents = new Map(names.map((n) => [n, new Set()]));
  for (const k of constraints) {
    if (k.kind === 'f' && k.parent && k.parent !== k.table && parents.has(k.table)) parents.get(k.table).add(k.parent);
  }
  const out = [];
  const seen = new Set();
  const visit = (n, path = new Set()) => {
    if (seen.has(n) || path.has(n)) return;
    path.add(n);
    for (const p of parents.get(n) ?? []) visit(p, path);
    seen.add(n);
    out.push(n);
  };
  for (const n of names) visit(n);
  return out;
}

/** A table's rows on one side as a count and a checksum: each row as JSON (UTC, the given columns only), sorted byte-wise. */
async function tableSum(db, table, columns) {
  return db.begin(async (tx) => {
    await tx`SET LOCAL TIME ZONE 'UTC'`;
    // jsonb_build_object takes at most 100 arguments: pieces of 40 columns, joined.
    const parts = [];
    for (let i = 0; i < columns.length; i += 40) {
      parts.push(`jsonb_build_object(${columns.slice(i, i + 40).map((c) => `${lit(c)}, x.${q(c)}`).join(', ')})`);
    }
    const row = parts.length ? parts.join(' || ') : `'{}'::jsonb`;
    const [r] = await tx.unsafe(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(j::text, '|' ORDER BY j::text COLLATE "C"), '')) AS sum
         FROM (SELECT ${row} AS j FROM ${q(table)} x) s`,
    );
    return r;
  });
}

async function copy() {
  const fromUrl = readSecretFile(opt('from'), 'FROM database address');
  const toUrl = readSecretFile(opt('to'), 'TO database address');
  const withBackups = args.includes('--with-backups');
  const fromParts = describeUrl(fromUrl);
  const { parts: toParts, notes } = checkAddress(toUrl);
  for (const n of notes) console.log(`⚠ ${n}`);
  if (fromParts.host === toParts.host && fromParts.port === toParts.port && fromParts.database === toParts.database) {
    throw new Error('FROM and TO are the same database.');
  }
  console.log(`Copying the database at ${fromParts.host} → ${toParts.host}.`);
  const from = openDb(fromUrl);
  const to = openDb(toUrl);
  try {
    // 1. The schema: db/schema.sql, then what FROM has beyond it.
    for (const statement of schemaStatements()) await to.unsafe(statement);
    const src = await catalog(from);
    let dst = await catalog(to);
    const dstColumns = new Map(dst.columns.map((c) => [`${c.table}.${c.name}`, c]));
    const dstTables = new Set(dst.tables.map((t) => t.name));
    const dstSequences = new Set(dst.sequences.map((s) => s.name));
    const clash = src.columns.filter((c) => dstColumns.get(`${c.table}.${c.name}`) && dstColumns.get(`${c.table}.${c.name}`).type !== c.type);
    if (clash.length) {
      throw new Error(
        `Column types differ — nothing copied:\n  ${clash.map((c) => `${c.table}.${c.name}: ${c.type} in FROM, ${dstColumns.get(`${c.table}.${c.name}`).type} in TO`).join('\n  ')}`,
      );
    }
    const made = [];
    for (const s of src.sequences) {
      if (dstSequences.has(s.name)) continue;
      await to.unsafe(`CREATE SEQUENCE IF NOT EXISTS ${q(s.name)} AS ${s.type}`);
      made.push(`sequence ${s.name}`);
    }
    const columnSql = (c) =>
      `${q(c.name)} ${c.type}` +
      (c.generated === 's' ? ` GENERATED ALWAYS AS (${c.default_expr}) STORED` : c.default_expr ? ` DEFAULT ${c.default_expr}` : '') +
      (c.identity === 'a' ? ' GENERATED ALWAYS AS IDENTITY' : c.identity === 'd' ? ' GENERATED BY DEFAULT AS IDENTITY' : '') +
      (c.not_null ? ' NOT NULL' : '');
    for (const t of src.tables) {
      if (dstTables.has(t.name)) continue;
      const cols = src.columns.filter((c) => c.table === t.name);
      await to.unsafe(`CREATE TABLE IF NOT EXISTS ${q(t.name)} (${cols.map(columnSql).join(', ')})`);
      dstTables.add(t.name);
      made.push(`table ${t.name}`);
    }
    dst = await catalog(to);
    const haveColumns = new Set(dst.columns.map((c) => `${c.table}.${c.name}`));
    for (const c of src.columns) {
      if (haveColumns.has(`${c.table}.${c.name}`)) continue;
      await to.unsafe(`ALTER TABLE ${q(c.table)} ADD COLUMN IF NOT EXISTS ${columnSql(c)}`);
      made.push(`column ${c.table}.${c.name}`);
    }
    dst = await catalog(to);
    const dstConstraints = new Set(dst.constraints.map((k) => `${k.table}.${k.name}`));
    // Keys and checks before the rows (a second run's ON CONFLICT needs the keys); foreign keys after them.
    for (const k of src.constraints.filter((k) => k.kind !== 'f')) {
      if (dstConstraints.has(`${k.table}.${k.name}`)) continue;
      await to.unsafe(`ALTER TABLE ${q(k.table)} ADD CONSTRAINT ${q(k.name)} ${k.def}`);
      made.push(`constraint ${k.table}.${k.name}`);
    }
    console.log(made.length ? `Beyond db/schema.sql, made: ${made.join(', ')}.` : 'db/schema.sql already holds every table and column.');

    // 2. The rows, parents first, from one snapshot of FROM.
    const copied = src.tables.map((t) => t.name).filter((n) => withBackups || !BACKUP_TABLES.includes(n));
    const left = src.tables.filter((t) => !copied.includes(t.name));
    const order = parentsFirst(copied, src.constraints);
    const inserted = {};
    for (const table of order.filter((t) => FROM_WINS_TABLES.includes(t))) await to.unsafe(`DELETE FROM ${q(table)}`);
    await from.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
      await tx`SET LOCAL TIME ZONE 'UTC'`;
      for (const table of order) {
        const cols = src.columns.filter((c) => c.table === table && c.generated !== 's');
        const list = cols.map((c) => q(c.name)).join(', ');
        const overriding = cols.some((c) => c.identity === 'a') ? ' OVERRIDING SYSTEM VALUE' : '';
        inserted[table] = 0;
        let batch = [];
        let chars = 0;
        const flush = async () => {
          if (!batch.length) return;
          const [r] = await to.unsafe(
            `WITH ins AS (
               INSERT INTO ${q(table)} (${list})${overriding}
               SELECT ${list} FROM json_populate_recordset(NULL::${q(table)}, $1::text::json)
               ON CONFLICT DO NOTHING RETURNING 1)
             SELECT count(*)::int AS n FROM ins`,
            [`[${batch.join(',')}]`],
          );
          inserted[table] += r.n;
          batch = [];
          chars = 0;
        };
        for await (const rows of tx.unsafe(`SELECT row_to_json(x)::text AS r FROM ${q(table)} x`).cursor(200)) {
          for (const { r } of rows) {
            if (batch.length > 0 && (chars + r.length > BATCH_CHARS || batch.length >= BATCH_ROWS)) await flush();
            batch.push(r);
            chars += r.length;
          }
        }
        await flush();
      }
    });

    // 3. Foreign keys, indexes and counters.
    for (const k of src.constraints.filter((k) => k.kind === 'f')) {
      if (dstConstraints.has(`${k.table}.${k.name}`) || !copied.includes(k.table) || !copied.includes(k.parent ?? k.table)) continue;
      await to.unsafe(`ALTER TABLE ${q(k.table)} ADD CONSTRAINT ${q(k.name)} ${k.def}`);
      console.log(`Added foreign key ${k.table}.${k.name}.`);
    }
    dst = await catalog(to);
    const dstIndexes = new Set(dst.indexes.map((i) => i.name));
    for (const i of src.indexes) {
      if (dstIndexes.has(i.name)) continue;
      await to.unsafe(i.def.replace(/^CREATE (UNIQUE )?INDEX /, (m) => `${m}IF NOT EXISTS `));
      console.log(`Added index ${i.name}.`);
    }
    for (const s of src.sequences) {
      if (s.last_value === null) continue;
      await to.unsafe(`SELECT setval(${lit(q(s.name))}, ${BigInt(s.last_value)}, true)`);
    }

    // 4. Every table counted and checksummed on both sides, on FROM's columns.
    let bad = 0;
    console.log(`\n${'table'.padEnd(22)} ${'from'.padStart(7)} ${'to'.padStart(7)} ${'added'.padStart(7)}  same rows`);
    for (const table of order) {
      const cols = src.columns.filter((c) => c.table === table).map((c) => c.name);
      const a = await tableSum(from, table, cols);
      const b = await tableSum(to, table, cols);
      const same = a.n === b.n && a.sum === b.sum;
      if (!same) bad++;
      const verdict = same ? 'yes' : a.n === b.n ? '⚠ NO (values differ)' : '⚠ NO';
      console.log(`${table.padEnd(22)} ${String(a.n).padStart(7)} ${String(b.n).padStart(7)} ${String(inserted[table]).padStart(7)}  ${verdict}`);
    }
    for (const t of left) console.log(`${t.name.padEnd(22)} not copied (${(Number(t.bytes) / 1048576).toFixed(1)} MB; --with-backups copies it)`);
    console.log(bad ? `\n⚠ ${bad} table(s) differ.` : '\nEvery copied table holds the same rows on both sides.');
    if (bad) process.exitCode = 2;
  } finally {
    await from.end();
    await to.end();
  }
}

const commands = { 'save-url': saveUrl, check, copy };
if (!commands[command]) {
  console.log('Use: save-url <file> [--from-clipboard] | check <db-url-file> | copy --from <db-url-file> --to <db-url-file> [--with-backups]');
  process.exit(1);
}
commands[command]().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
