import { neon, neonConfig, type NeonQueryFunction } from '@neondatabase/serverless';
import { unstable_noStore as noStore } from 'next/cache';
import postgres from 'postgres';

// Development only: scripts/dev-neon-shim.mjs answers the driver's HTTP
// protocol from an in-process Postgres, so `next dev` runs every page and
// route on a real database without a Neon project. Never in production.
if (process.env.NODE_ENV !== 'production' && process.env['DEV_NEON_ENDPOINT']) {
  neonConfig.fetchEndpoint = process.env['DEV_NEON_ENDPOINT'];
}

/**
 * The SQL client for DATABASE_URL, called the same two ways whichever
 * database is behind it: as a tagged template (sql()`SELECT … ${value}`) and
 * with a plain statement and its $1… values (sql()(text, [values])).
 *
 * A Neon address (and the dev stand-in) gets Neon's serverless HTTP driver:
 * each query is an HTTP round-trip, no connection pool to leak.
 * `cache: 'no-store'` is critical there: the driver issues each query as a
 * fetch, and Next.js will otherwise cache that fetch keyed by the SQL string.
 * That cached a query's first (empty) result forever — e.g. the bridge
 * order-pull kept returning `[]` from before any orders existed, and
 * `/api/menu` kept saying "not published" after publishing. no-store makes
 * every query hit the live database.
 *
 * Any other Postgres (27 Oct 2026: Supabase's free plan, which has no
 * compute-hour allowance to run out like Neon's did on 26 Oct) gets
 * postgres.js over TCP, set up to hand back exactly what the Neon driver does
 * (db-driver.test.ts runs the same queries through both).
 */
export function sql(): NeonQueryFunction<false, false> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not configured');
  logRegionsOnce(url);
  if (usesNeonDriver(url)) return neon(url, { fetchOptions: { cache: 'no-store' } });
  return tcpClient(url);
}

/** Neon's own addresses and the dev stand-in; anything that is not a URL stays on Neon's driver as before. */
function usesNeonDriver(url: string): boolean {
  if (process.env.NODE_ENV !== 'production' && process.env['DEV_NEON_ENDPOINT']) return true;
  try {
    return new URL(url).hostname.endsWith('.neon.tech');
  } catch {
    return true;
  }
}

/** One small pool per database and server instance (a function instance serves many requests). */
const pools = new Map<string, postgres.Sql>();

/**
 * One statement at a time on a connection. postgres.js otherwise sends the next query before the one ahead has
 * answered, and through Supabase's transaction pooler that later query never answers: the pooler hands the server
 * connection on when the first one ends. The dashboard's pages (eight queries at once) hung until Vercel's 300 s
 * limit (27 Oct 2026; reproduced against the pooler, and gone with this). postgres.js reads max_pipeline
 * (src/index.js), but its type definitions leave it out, hence a spread rather than a line in the options.
 */
const ONE_STATEMENT_AT_A_TIME = { max_pipeline: 0 };

/** Values arrive here already as Postgres text (asText): sent as they are, never encoded a second time. */
const passText = (value: unknown) => (typeof value === 'string' ? value : String(value));

function tcpClient(url: string): NeonQueryFunction<false, false> {
  let pool = pools.get(url);
  if (!pool) {
    const address = new URL(url);
    const host = address.hostname;
    // Without its ?…: words there for libpq or Prisma (sslmode, channel_binding — in every Neon address —,
    // pgbouncer) are not Postgres settings, and postgres.js would send each to the server as one, which refuses
    // the login. TLS is set below instead.
    address.search = '';
    pool = postgres(address.toString(), {
      // Supabase's transaction pooler (port 6543) hands each statement to any
      // server connection, so a prepared statement would not be there next time.
      prepare: false,
      ...ONE_STATEMENT_AT_A_TIME,
      max: 5,
      // Let go of idle connections, so a sleeping function instance holds none.
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: host === 'localhost' || host === '127.0.0.1' ? false : 'require',
      // postgres.js encodes a value by the type Postgres expects: JSON text
      // would be JSON-encoded again (the website sends ${JSON.stringify(x)}::jsonb
      // everywhere), 'false' would become 't'. Parsing stays postgres.js's own,
      // which gives what the Neon driver gives (db-driver.test.ts).
      types: {
        bool: { to: 16, from: [16], serialize: passText, parse: (x: string) => x === 't' },
        bytea: { to: 17, from: [17], serialize: passText, parse: (x: string) => Buffer.from(x.slice(2), 'hex') },
        json: { to: 114, from: [114, 3802], serialize: passText, parse: (x: string) => JSON.parse(x) as unknown },
        date: { to: 1184, from: [1082, 1114, 1184], serialize: passText, parse: (x: string) => new Date(x) },
        // Arrays too: postgres.js's own reader takes a NULL element for the text "NULL".
        textArray: { to: 1009, from: [1009, 1015, 1016, 2951], serialize: passText, parse: (x: string) => arrayOf(x, (s) => s) },
        intArray: { to: 1007, from: [1005, 1007], serialize: passText, parse: (x: string) => arrayOf(x, Number) },
        boolArray: { to: 1000, from: [1000], serialize: passText, parse: (x: string) => arrayOf(x, (s) => s === 't') },
        dateArray: { to: 1185, from: [1115, 1182, 1185], serialize: passText, parse: (x: string) => arrayOf(x, (s) => new Date(s)) },
        jsonArray: { to: 3807, from: [199, 3807], serialize: passText, parse: (x: string) => arrayOf(x, (s) => JSON.parse(s) as unknown) },
      },
      // Notices (e.g. "relation already exists, skipping" from CREATE … IF NOT EXISTS) are not errors.
      onnotice: () => undefined,
    });
    pools.set(url, pool);
  }
  const db = pool;
  const query = (first: TemplateStringsArray | string, ...rest: unknown[]) => {
    // What the Neon driver's no-store fetch told Next.js: whatever reads the database is rendered on
    // request — unless the route says otherwise (every public page is force-static with a revalidate,
    // and that wins over both). The order tracker and the share images have no such line.
    noStore();
    return (
      typeof first === 'string'
        ? db.unsafe(first, ((rest[0] as unknown[] | undefined) ?? []).map(asText))
        : db(first, ...rest.map(asText))
    ).then((rows) => rows.map((row) => ({ ...row })));
  };
  return query as unknown as NeonQueryFunction<false, false>;
}

/**
 * A value as the text the Neon driver sends for it (node-postgres's prepareValue, which it uses): Postgres then
 * reads it by the type the statement gives it, the same on both drivers. NULL for null and undefined.
 */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return dateText(value);
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return arrayText(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** An array as a Postgres array literal, each element quoted (node-postgres arrayString). */
function arrayText(values: readonly unknown[]): string {
  const parts = values.map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return arrayText(v);
    if (v instanceof Uint8Array) return `\\\\x${Buffer.from(v).toString('hex')}`;
    return `"${(asText(v) ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${parts.join(',')}}`;
}

/** A Postgres array literal read back ({a,"b c",NULL} or nested), each element by `element`, NULL as null. */
function arrayOf(text: string, element: (s: string) => unknown): unknown[] {
  let i = Math.max(0, text.indexOf('{'));
  const level = (): unknown[] => {
    const out: unknown[] = [];
    i++; // past '{'
    while (i < text.length) {
      const c = text[i];
      if (c === '}') {
        i++;
        break;
      }
      if (c === ',') {
        i++;
      } else if (c === '{') {
        out.push(level());
      } else if (c === '"') {
        let s = '';
        for (i++; i < text.length && text[i] !== '"'; i++) s += text[i] === '\\' ? text[++i] : text[i];
        i++;
        out.push(element(s));
      } else {
        let end = i;
        while (end < text.length && text[end] !== ',' && text[end] !== '}') end++;
        const raw = text.slice(i, end);
        i = end;
        out.push(raw === 'NULL' ? null : element(raw));
      }
    }
    return out;
  };
  return level();
}

/** A date in the server's local time with its offset (node-postgres dateToString): 2026-10-26T18:32:00.123+00:00. */
function dateText(date: Date): string {
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  let offset = -date.getTimezoneOffset();
  let year = date.getFullYear();
  const bc = year < 1;
  if (bc) year = Math.abs(year) + 1;
  let text =
    `${pad(year, 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}` +
    `T${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`;
  const sign = offset < 0 ? '-' : '+';
  offset = Math.abs(offset);
  text += `${sign}${pad(Math.floor(offset / 60), 2)}:${pad(offset % 60, 2)}`;
  return bc ? `${text} BC` : text;
}

/**
 * Once per server instance, the runtime log says where the database and this function run (24 Oct 2026:
 * every query is a round trip between them, so they belong in the same region). Only the region names, never
 * the address or anything else in DATABASE_URL.
 */
let regionsLogged = false;
function logRegionsOnce(url: string): void {
  if (regionsLogged || process.env.NODE_ENV !== 'production') return;
  regionsLogged = true;
  let database = 'unknown';
  try {
    // ep-….ap-southeast-1.aws.neon.tech (Neon), aws-0-ap-southeast-1.pooler.supabase.com (Supabase).
    database = /(?:^|[.-])([a-z]{2}-[a-z]+-\d)\./i.exec(new URL(url).hostname)?.[1] ?? 'unknown';
  } catch {
    // Not a URL: say nothing more about it.
  }
  console.warn(`regions: database ${database}, function ${process.env['VERCEL_REGION'] ?? 'unknown'}`);
}
