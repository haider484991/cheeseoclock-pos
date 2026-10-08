// Development only: answers the Neon serverless driver's HTTP protocol from
// an in-process Postgres (PGlite), so `next dev` runs every page and route
// against a real database without a Neon project. Never used in production
// (lib/db.ts only points the driver here when NODE_ENV is not production and
// DEV_NEON_ENDPOINT is set).
//
//   node scripts/dev-neon-shim.mjs            (port 4444, data in memory)
//   DEV_PGLITE_DIR=C:\some\dir node scripts/dev-neon-shim.mjs   (kept on disk)
//
// then run the site with
//   DATABASE_URL=postgresql://dev:dev@localhost:4444/dev
//   DEV_NEON_ENDPOINT=http://localhost:4444/sql
//
// The driver posts { query, params } with "Neon-Raw-Text-Output: true" and
// "Neon-Array-Mode: true", and reads { fields: [{ name, dataTypeID }], rows:
// [[text, …]], command, rowCount } — every value in Postgres text form, which
// the driver then parses by type exactly as it does against Neon.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { PGlite, types } from '@electric-sql/pglite';

const PORT = Number(process.env.DEV_NEON_PORT ?? 4444);
const dir = process.env.DEV_PGLITE_DIR;
const pg = dir ? new PGlite(dir) : new PGlite();
await pg.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));

// Every type comes back as the text Postgres sent (the driver parses it).
const raw = (value) => value;
const parsers = {};
for (const oid of Object.values(types)) if (typeof oid === 'number') parsers[oid] = raw;
for (const oid of [1000, 1005, 1007, 1009, 1015, 1016, 1021, 1022, 1028, 1115, 1182, 1185, 199, 3807, 1231]) parsers[oid] = raw;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/sql')) {
    res.writeHead(404).end();
    return;
  }
  try {
    const { query, params } = JSON.parse(await readBody(req));
    const r = await pg.query(query, params ?? [], { rowMode: 'array', parsers });
    const body = {
      command: (query.trim().split(/\s+/)[0] ?? '').toUpperCase(),
      rowCount: r.affectedRows ?? r.rows.length,
      fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      rows: r.rows.map((row) => row.map((v) => (v === null || v === undefined ? null : typeof v === 'string' ? v : String(v)))),
    };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ message: e.message, code: e.code }));
  }
}).listen(PORT, () => console.log(`dev Neon stand-in on http://localhost:${PORT}/sql${dir ? ` (data in ${dir})` : ' (data in memory)'}`));
