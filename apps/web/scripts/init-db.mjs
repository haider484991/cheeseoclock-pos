// One-time DB setup: applies db/schema.sql to the Neon database in
// DATABASE_URL. Idempotent (CREATE IF NOT EXISTS throughout).
//
//   DATABASE_URL="postgresql://..." pnpm --filter @cheeseoclock/web db:init
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example and fill it in.');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(path.join(here, '..', 'db', 'schema.sql'), 'utf8');

const sql = neon(url);
// Split on semicolons at line ends — fine for this simple schema file.
const statements = schema
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.startsWith('--'));

for (const stmt of statements) {
  await sql.query(stmt);
}
console.log(`Applied ${statements.length} statements. Database ready.`);
